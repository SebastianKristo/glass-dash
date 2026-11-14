// Hytte Backup – rsync-backup fra Unraid til ZFS, med et ZFS-snapshot etter hver kjøring.
// Kjører i en LXC uten ZFS-tilgang. Snapshots lages av en liten hjelper på Proxmox-verten
// (hytte-zfs), som leser forespørsler fra DEST_ROOT/.hytte/req og svarer i .hytte/res.
// Ingen avhengigheter: Node + rsync + ssh.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const VERSION = '2.4';
const PORT = +process.env.PORT || 8090;
const DATA = process.env.DATA_DIR || '/opt/backup-gui/data';
const DEST_ROOT = process.env.DEST_ROOT || '/mnt/unraid';
const PUB = path.join(__dirname, 'public');
const KEY = path.join(DATA, 'id_ed25519'), KNOWN = path.join(DATA, 'known_hosts');
const CFG_F = path.join(DATA, 'config.json'), HIST_F = path.join(DATA, 'history.json');
const HY = path.join(DEST_ROOT, '.hytte'), REQ = path.join(HY, 'req'), RES = path.join(HY, 'res');
fs.mkdirSync(DATA, { recursive: true });
try { fs.mkdirSync(REQ, { recursive: true }); fs.mkdirSync(RES, { recursive: true }) } catch (e) {}

const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { return d } };
const wr = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o, null, 2)); fs.renameSync(f + '.tmp', f) };
let cfg = rd(CFG_F, {});
cfg.remote = cfg.remote || { host: '', user: 'root', port: 22 };
cfg.jobs = cfg.jobs || [];
cfg.settings = { emailSummary: false, notifyOnFail: true, verifyAfterRun: true, autoPrune: true, ...(cfg.settings || {}) };
cfg.shareSizes = cfg.shareSizes || {};
let hist = rd(HIST_F, []);
const saveCfg = () => wr(CFG_F, cfg), saveHist = () => wr(HIST_F, hist.slice(-1000));
// Eldre jobber (v1) får nye felt
for (const j of cfg.jobs) { j.retentionDays = j.retentionDays || 30; if (j.schedule && j.schedule.type === 'manual') j.schedule.type = 'daily' }
for (const h of hist) if (!h.status) { h.status = h.stopped ? 'fail' : h.ok ? 'ok' : 'fail'; h.message = h.message || h.error || '' }

// ── SSH ──────────────────────────────────────────────────────────────────────
if (!fs.existsSync(KEY)) execFile('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'hytte-backup', '-f', KEY], () => {});
const pubKey = () => { try { return fs.readFileSync(KEY + '.pub', 'utf8').trim() } catch (e) { return '' } };
const sshArgs = () => ['-i', KEY, '-p', String(cfg.remote.port || 22), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
  '-o', 'ServerAliveInterval=30', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + KNOWN];
const target = () => (cfg.remote.user || 'root') + '@' + cfg.remote.host;
const q = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
function ssh(cmd, ms = 20000) {
  return new Promise((ok, no) => {
    if (!cfg.remote.host) return no(new Error('Ingen Unraid-adresse satt'));
    execFile('ssh', [...sshArgs(), target(), cmd], { timeout: ms, maxBuffer: 16e6 }, (e, out, err) =>
      e ? no(new Error((err || e.message).trim().split('\n').pop() || 'SSH feilet')) : ok(out));
  });
}
let conn = { online: false, pingMs: null, checked: 0, error: '' };
async function ping() {
  if (!cfg.remote.host) { conn = { online: false, pingMs: null, checked: Date.now(), error: 'Ikke satt opp' }; return conn }
  const t = Date.now();
  try { await ssh('true', 12000); conn = { online: true, pingMs: Date.now() - t, checked: Date.now(), error: '' } }
  catch (e) { conn = { online: false, pingMs: null, checked: Date.now(), error: e.message } }
  return conn;
}
setInterval(ping, 60000); setTimeout(ping, 1500);
// Unraid-varsel (følger varslingsinnstillingene i Unraid, f.eks. e-post)
function notify(subject, desc, level = 'normal') {
  const cmd = `/usr/local/emhttp/webGui/scripts/notify -e ${q('Hytte Backup')} -s ${q(subject)} -d ${q(desc)} -i ${q(level)}`;
  return ssh(cmd).catch(() => {});
}

// ── Innlogging ───────────────────────────────────────────────────────────────
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const sessions = new Map();
const authed = req => { const m = /(?:^|;\s*)bsid=([a-f0-9]+)/.exec(req.headers.cookie || ''); const t = m && sessions.get(m[1]); return !!(t && t > Date.now()) };
function login(res, pw) {
  if (!cfg.auth) { const salt = crypto.randomBytes(16).toString('hex'); cfg.auth = { salt, hash: hash(pw, salt) }; saveCfg() }
  else if (!crypto.timingSafeEqual(Buffer.from(hash(pw, cfg.auth.salt), 'hex'), Buffer.from(cfg.auth.hash, 'hex'))) return json(res, 401, { error: 'Feil passord' });
  const tok = crypto.randomBytes(24).toString('hex'); sessions.set(tok, Date.now() + 30 * 864e5);
  res.setHeader('Set-Cookie', `bsid=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}`); json(res, 200, { ok: true });
}

// ── ZFS via vert-hjelperen ───────────────────────────────────────────────────
const helperMeta = () => rd(path.join(HY, 'meta.json'), null);       // {dataset, zfsVersion, t}
const snapList = () => rd(path.join(HY, 'snapshots.json'), []);      // [{name, creation, written}]
const helperOk = () => { const m = helperMeta(); return !!(m && Date.now() - m.t * 1000 < 10 * 60e3) };
function zfsReq(op, args = {}, ms = 60000) {
  return new Promise((ok, no) => {
    if (!helperOk()) return no(new Error('ZFS-hjelperen på Proxmox svarer ikke (kjør installasjonen på nytt fra Proxmox-verten)'));
    const id = Date.now() + '-' + crypto.randomBytes(3).toString('hex');
    fs.writeFileSync(path.join(REQ, id + '.json.tmp'), JSON.stringify({ op, ...args }));
    fs.renameSync(path.join(REQ, id + '.json.tmp'), path.join(REQ, id + '.json'));
    const f = path.join(RES, id + '.json'), t0 = Date.now();
    const iv = setInterval(() => {
      if (fs.existsSync(f)) { clearInterval(iv); const r = rd(f, {}); try { fs.unlinkSync(f) } catch (e) {} r.ok ? ok(r) : no(new Error(r.error || 'ZFS-feil')) }
      else if (Date.now() - t0 > ms) { clearInterval(iv); no(new Error('Tidsavbrudd mot ZFS-hjelperen')) }
    }, 500);
  });
}
const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'jobb';
const stamp = d => { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}` };
const snapPrefix = j => 'hytte-' + slug(j.dest) + '-';

// ── Kjøring ──────────────────────────────────────────────────────────────────
let running = null; const queue = [];
const safeDest = d => String(d || '').replace(/\.\./g, '').replace(/^\/+|\/+$/g, '').replace(/[^\w\-./ æøåÆØÅ]/g, '_') || 'backup';
const fmtB = b => b == null ? '—' : b >= 1e12 ? (b / 1e12).toFixed(2) + ' TB' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? Math.round(b / 1e6) + ' MB' : b >= 1e3 ? Math.round(b / 1e3) + ' kB' : b + ' B';
function enqueue(job, why) {
  if ((running && running.id === job.id) || queue.some(x => x.id === job.id)) return false;
  queue.push({ id: job.id, why }); setImmediate(next); return true;
}
function rsyncRun(args, run) {
  return new Promise(resolve => {
    const p = spawn('rsync', args); run.proc = p; let buf = '';
    const onData = d => {
      buf += d.toString(); const parts = buf.split(/[\r\n]/); buf = parts.pop();
      for (const l of parts) {
        const m = /^\s*([\d,]+)\s+(\d+)%\s+(\S+\/s)\s+(\d+:\d+:\d+)/.exec(l);
        if (m) { run.doneBytes = +m[1].replace(/,/g, ''); run.pct = +m[2]; run.speed = m[3]; run.eta = m[4]; continue }
        if (l.trim()) { run.log.push(l); if (run.log.length > 500) run.log.shift() }
      }
    };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('close', code => resolve(code)); p.on('error', e => { run.log.push(e.message); resolve(127) });
  });
}
async function verify(job, dest) {
  // Sammenlign sjekksummer for et tilfeldig utvalg filer (opptil 25)
  const files = await new Promise(ok => execFile('find', [dest, '-type', 'f', '-size', '-200M', '-not', '-path', '*/.*'], { maxBuffer: 64e6, timeout: 120000 }, (e, out) => ok((out || '').split('\n').filter(Boolean))));
  if (!files.length) return { checked: 0, bad: [] };
  const pick = [], n = Math.min(25, files.length); for (let i = 0; i < n; i++) pick.push(files.splice(Math.floor(Math.random() * files.length), 1)[0]);
  const rel = pick.map(f => path.relative(dest, f));
  const sum = f => new Promise(ok => { const h = crypto.createHash('sha256'); fs.createReadStream(f).on('data', d => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', () => ok('')) });
  const local = await Promise.all(pick.map(sum));
  const out = await ssh(`cd ${q(job.src)} && sha256sum -- ${rel.map(q).join(' ')} 2>/dev/null`, 180000).catch(e => e.message ? '' : '');
  const remote = {}; for (const l of out.split('\n')) { const m = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(l); if (m) remote[m[2]] = m[1] }
  const bad = rel.filter((r, i) => remote[r] && remote[r] !== local[i]);
  return { checked: Object.keys(remote).length, bad };
}
async function next() {
  if (running || !queue.length) return;
  const { id, why } = queue.shift(), job = cfg.jobs.find(j => j.id === id); if (!job) return next();
  const dest = path.join(DEST_ROOT, safeDest(job.dest)); fs.mkdirSync(dest, { recursive: true });
  const run = { id: job.id, name: job.name, why, start: Date.now(), pct: 0, speed: '', eta: '', doneBytes: 0, log: [], phase: 'sync' };
  running = run;
  const args = ['-aHX', '--partial', '--numeric-ids', '--info=progress2,stats2', '--no-inc-recursive', '-s'];
  if (job.mirror) args.push('--delete', '--delete-excluded');
  if (job.bwlimit) args.push('--bwlimit=' + job.bwlimit);
  for (const x of job.excludes || []) if (x.trim()) args.push('--exclude', x.trim());
  args.push('-e', 'ssh ' + sshArgs().map(a => /\s/.test(a) ? q(a) : a).join(' '));
  args.push(target() + ':' + job.src.replace(/\/?$/, '/'), dest + '/');
  let code = await rsyncRun(args, run);
  // Ett nytt forsøk ved brutt forbindelse (kode 12/30/35/255)
  if (!run.stopped && [12, 30, 35, 255].includes(code)) { run.log.push('Tilkobling brutt – prøver igjen om 60 s'); run.retried = true; await new Promise(r => setTimeout(r, 60000)); if (!run.stopped) code = await rsyncRun(args, run) }
  const L = run.log.join('\n'), num = re => { const m = re.exec(L); return m ? +m[1].replace(/,/g, '') : null };
  const total = num(/Total file size:\s*([\d,]+)/), sent = num(/Total transferred file size:\s*([\d,]+)/), files = num(/Number of regular files transferred:\s*([\d,]+)/);
  let status = run.stopped ? 'fail' : code === 0 ? 'ok' : (code === 23 || code === 24) ? 'warn' : 'fail', msg = '';
  if (status === 'warn') { const n = run.log.filter(l => /^rsync: |vanished|Permission denied|failed:/.test(l)).length; msg = `${n || 'Noen'} ${n === 1 ? 'fil' : 'filer'} ble hoppet over (låst eller endret underveis). Data er ellers sikret.` }
  if (status === 'fail') msg = run.stopped ? 'Stoppet manuelt' : (run.log.filter(x => /error|failed|denied|refused|No such|timed out/i.test(x)).slice(-2).join(' · ') || 'rsync avsluttet med kode ' + code);
  let snap = null;
  if (status !== 'fail') {
    run.phase = 'snapshot';
    try { const r = await zfsReq('snapshot', { name: snapPrefix(job) + stamp(new Date()) }); snap = r.name; msg = msg || 'Snapshot opprettet' }
    catch (e) { if (status === 'ok') status = 'warn'; msg = (msg ? msg + ' ' : '') + 'Snapshot ikke tatt: ' + e.message }
  }
  if (status !== 'fail' && cfg.settings.verifyAfterRun) {
    run.phase = 'verify';
    try { const v = await verify(job, dest); if (v.bad.length) { status = 'warn'; msg = `Verifisering: ${v.bad.length} av ${v.checked} filer avviker` } else if (v.checked) msg += ` · ${v.checked} filer verifisert` } catch (e) {}
  }
  if (run.retried && status !== 'fail') msg += ' · tilkobling brutt, prøvde igjen';
  const rec = { id: crypto.randomBytes(4).toString('hex'), job: job.id, name: job.name, why, start: run.start, end: Date.now(), status,
    bytes: sent, total, files, snapshot: snap, message: msg, tail: run.log.slice(-30) };
  hist.push(rec); saveHist();
  job.last = { status, start: rec.start, end: rec.end, message: msg }; if (total != null) job.sizeBytes = total; saveCfg();
  if (status === 'fail' && cfg.settings.notifyOnFail) notify(`Backup feilet: ${job.name}`, msg, 'alert');
  running = null;
  if (cfg.settings.autoPrune) prune().catch(() => {});
  next();
}

// ── Opprydding ───────────────────────────────────────────────────────────────
let pruning = false;
async function prune(force) {
  if (pruning || (!force && !helperOk())) return; pruning = true;
  try {
    const keep = cfg.jobs.map(j => ({ prefix: snapPrefix(j), days: j.retentionDays || 30 }));
    const t = Date.now(), r = await zfsReq('prune', { keep }, 300000);
    if (r.removed && r.removed.length) {
      hist.push({ id: crypto.randomBytes(4).toString('hex'), job: 'system', name: 'Opprydding', start: t, end: Date.now(), status: 'ok', bytes: null,
        message: `${r.removed.length} ${r.removed.length === 1 ? 'snapshot' : 'snapshots'} fjernet` }); saveHist();
    }
  } finally { pruning = false }
}

// ── Planlegging ──────────────────────────────────────────────────────────────
// schedule.type: hourly | 6h | daily | weekly. time 'HH:MM' (daily/weekly; for 6h gir timen startfasen), day 0-6 (0=søndag)
function slotKey(job, d) {
  const s = job.schedule || {}; if (job.enabled === false) return null;
  const [h, m] = String(s.time || '02:00').split(':').map(Number);
  if (s.type === 'hourly') return d.getMinutes() >= (m || 0) ? 'h' + stamp(d).slice(0, 13) : null;
  if (s.type === '6h') { // kl. h, h+6, h+12, h+18
    const back = ((d.getHours() - (h % 6)) % 6 + 6) % 6, start = new Date(d.getTime() - back * 3600e3); start.setMinutes(m, 0, 0);
    if (start > d) return null; return 's' + stamp(start).slice(0, 13) }
  if (d.getHours() < h || (d.getHours() === h && d.getMinutes() < m)) return null;
  if (s.type === 'weekly' && d.getDay() !== +(s.day || 0)) return null;
  return 'd' + stamp(d).slice(0, 10);
}
function nextRun(job) {
  if (job.enabled === false) return null;
  const now = Date.now(), cur = slotKey(job, new Date(now));
  for (let i = 1; i <= 8 * 24 * 12; i++) { const t = new Date(now + i * 5 * 60000); t.setSeconds(0, 0); const k = slotKey(job, t); if (k && k !== cur && k !== job.lastKey) {
    // finn første minutt i dette vinduet
    for (let b = 0; b < 5; b++) { const tb = new Date(t.getTime() - (4 - b) * 60000); if (slotKey(job, tb) === k) return tb.getTime() } return t.getTime() } }
  return null;
}
let lastSummary = cfg.lastSummary || '';
setInterval(() => {
  const d = new Date(); let ch = false;
  for (const j of cfg.jobs) { const k = slotKey(j, d); if (k && j.lastKey !== k) { j.lastKey = k; ch = true; enqueue(j, 'plan') } }
  const today = stamp(d).slice(0, 10);
  if (cfg.settings.emailSummary && d.getHours() === 7 && lastSummary !== today) {
    lastSummary = cfg.lastSummary = today; ch = true;
    const since = Date.now() - 864e5, h = hist.filter(x => x.start > since && x.job !== 'system');
    const bad = h.filter(x => x.status !== 'ok'), bytes = h.reduce((a, x) => a + (x.bytes || 0), 0);
    notify(bad.length ? `Backup: ${bad.length} med advarsel/feil siste døgn` : 'Backup: alt OK siste døgn',
      `${h.length} kjøringer, ${fmtB(bytes)} overført.` + (bad.length ? ' ' + bad.map(x => x.name + ': ' + x.message).join(' | ') : ''), bad.length ? 'warning' : 'normal');
  }
  if (ch) saveCfg();
}, 30000);
for (const j of cfg.jobs) { const k = slotKey(j, new Date()); if (k && !j.lastKey) j.lastKey = k }

// ── Shares på Unraid ─────────────────────────────────────────────────────────
let sizing = false;
async function sizeShares(paths) {
  if (sizing) return; sizing = true;
  try { for (const p of paths) { const c = cfg.shareSizes[p]; if (c && Date.now() - c.t < 864e5) continue;
    try { const out = await ssh(`nice -n 19 du -sb ${q(p)} 2>/dev/null | cut -f1`, 1800000); cfg.shareSizes[p] = { b: +out.trim() || 0, t: Date.now() }; saveCfg() } catch (e) {} } }
  finally { sizing = false }
}

// ── Hjelpere ─────────────────────────────────────────────────────────────────
function disk() {
  return new Promise(ok => execFile('df', ['-B1', '--output=size,used,avail', DEST_ROOT], (e, out) => {
    if (e) return ok(null); const [s, u, a] = out.trim().split('\n').pop().trim().split(/\s+/).map(Number); ok({ size: s, used: u, avail: a });
  }));
}
const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)) };
const body = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy() }); req.on('end', () => { try { r(JSON.parse(b || '{}')) } catch (e) { r({}) } }) });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const ourSnaps = () => snapList().filter(s => /@hytte-/.test(s.name));
function snapsFor(j) { const p = snapPrefix(j); return ourSnaps().filter(s => s.name.split('@')[1].startsWith(p)) }
function pubJob(j) {
  const r = running && running.id === j.id, snaps = snapsFor(j);
  return { id: j.id, name: j.name, src: j.src, dest: j.dest, schedule: j.schedule, retentionDays: j.retentionDays, excludes: j.excludes || [], mirror: !!j.mirror,
    bwlimit: j.bwlimit || '', enabled: j.enabled !== false, last: j.last || null, sizeBytes: j.sizeBytes ?? null, versionCount: snaps.length,
    status: r ? 'running' : queue.some(x => x.id === j.id) ? 'queued' : j.last ? j.last.status : 'new', progress: r ? running.pct : null,
    phase: r ? running.phase : null, nextRun: nextRun(j) };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  try {
    if (!p.startsWith('/api/')) {
      const f = path.join(PUB, /^\/(versjoner|historikk|innstillinger)?\/?$/.test(p) ? 'index.html' : path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end() }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(res);
    }
    if (p === '/api/health') return json(res, 200, { ok: true, app: 'hytte-backup', version: VERSION });
    if (p === '/api/login' && req.method === 'POST') { const b = await body(req); if (!b.password || b.password.length < 6) return json(res, 400, { error: 'Minst 6 tegn' }); return login(res, b.password) }
    if (p === '/api/whoami') return json(res, 200, { authed: authed(req), setup: !cfg.auth });
    if (!authed(req)) return json(res, 401, { error: 'Ikke logget inn' });
    if (p === '/api/logout') { const m = /bsid=([a-f0-9]+)/.exec(req.headers.cookie || ''); if (m) sessions.delete(m[1]); return json(res, 200, { ok: true }) }

    if (p === '/api/state') {
      const meta = helperMeta(), ours = ourSnaps();
      return json(res, 200, {
        version: VERSION, remote: cfg.remote, destRoot: DEST_ROOT, pubkey: pubKey(), settings: cfg.settings, disk: await disk(),
        connection: { ...conn, zfsVersion: meta && meta.zfsVersion || null, dataset: meta && meta.dataset || null, helper: helperOk() },
        jobs: cfg.jobs.map(pubJob), snapshotCount: ours.length,
        oldestSnapshot: ours.length ? Math.min(...ours.map(s => s.creation * 1000)) : null,
        running: running && { id: running.id, pct: running.pct, speed: running.speed, eta: running.eta, doneBytes: running.doneBytes, phase: running.phase },
        history: hist.slice(-400).map(h => ({ ...h, tail: undefined })),
      });
    }
    if (p === '/api/settings' && req.method === 'POST') {
      const b = await body(req);
      if (b.remote) { cfg.remote = { host: String(b.remote.host || '').trim(), user: String(b.remote.user || 'root').trim(), port: +b.remote.port || 22 }; ping() }
      if (b.settings) for (const k of ['emailSummary', 'notifyOnFail', 'verifyAfterRun', 'autoPrune']) if (k in b.settings) cfg.settings[k] = !!b.settings[k];
      saveCfg(); return json(res, 200, { ok: true });
    }
    if (p === '/api/test' && req.method === 'POST') {
      try { const out = await ssh('echo OK; hostname; rsync --version | head -1'); const [, host, rs] = out.trim().split('\n'); await ping(); return json(res, 200, { ok: true, host, rsync: rs, pingMs: conn.pingMs }) }
      catch (e) { return json(res, 200, { ok: false, error: e.message }) }
    }
    if (p === '/api/notify-test' && req.method === 'POST') { await notify('Testvarsel fra Hytte Backup', 'Varsling fungerer.'); return json(res, 200, { ok: true }) }
    if (p === '/api/browse') {
      const dir = (url.searchParams.get('path') || '/mnt/user').replace(/\/+$/, '') || '/';
      try {
        const out = await ssh(`cd ${q(dir)} && find . -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\\n' | sort -f`);
        const dirs = out.split('\n').filter(Boolean), full = dirs.map(d => (dir === '/' ? '' : dir) + '/' + d);
        if (dir === '/mnt/user') sizeShares(full);
        return json(res, 200, { path: dir, dirs: dirs.map((d, i) => ({ name: d, path: full[i], size: cfg.shareSizes[full[i]]?.b ?? null })) });
      } catch (e) { return json(res, 200, { path: dir, dirs: [], error: e.message }) }
    }
    if (p === '/api/size') {
      const dir = url.searchParams.get('path') || '';
      try { const out = await ssh(`nice -n 19 du -sb ${q(dir)} 2>/dev/null | cut -f1`, 900000); const b = +out.trim() || 0; cfg.shareSizes[dir] = { b, t: Date.now() }; saveCfg(); return json(res, 200, { bytes: b }) }
      catch (e) { return json(res, 200, { error: e.message }) }
    }
    if (p === '/api/jobs' && req.method === 'POST') {
      const b = await body(req); if (!b.src) return json(res, 400, { error: 'Velg en mappe' });
      let j = b.id && cfg.jobs.find(x => x.id === b.id); const isNew = !j;
      const base = path.basename(b.src), destName = safeDest(b.dest || (isNew ? base : j.dest));
      if (cfg.jobs.some(x => x !== j && x.dest === destName)) return json(res, 400, { error: `Mappen «${destName}» brukes allerede av en annen jobb` });
      if (!j) { j = { id: crypto.randomBytes(4).toString('hex'), created: Date.now() }; cfg.jobs.push(j) }
      const sc = b.schedule || {};
      Object.assign(j, {
        name: String(b.name || base.charAt(0).toUpperCase() + base.slice(1)).slice(0, 60), src: String(b.src), dest: destName,
        excludes: (b.excludes || []).map(String).filter(Boolean).slice(0, 50), mirror: b.mirror !== false, enabled: b.enabled !== false,
        bwlimit: String(b.bwlimit || '').replace(/[^\dkKmM]/g, ''), retentionDays: [7, 30, 90, 365].includes(+b.retentionDays) ? +b.retentionDays : 30,
        schedule: { type: ['hourly', '6h', 'daily', 'weekly'].includes(sc.type) ? sc.type : 'daily', time: /^\d\d:\d\d$/.test(sc.time) ? sc.time : '02:00', day: +(sc.day || 0) },
      });
      j.lastKey = slotKey(j, new Date());
      saveCfg(); if (b.runNow) enqueue(j, 'manuell');
      return json(res, 200, { ok: true, job: pubJob(j) });
    }
    let m;
    if ((m = /^\/api\/jobs\/(\w+)$/.exec(p)) && req.method === 'DELETE') { cfg.jobs = cfg.jobs.filter(j => j.id !== m[1]); saveCfg(); return json(res, 200, { ok: true }) }
    if ((m = /^\/api\/jobs\/(\w+)\/run$/.exec(p)) && req.method === 'POST') {
      const j = cfg.jobs.find(x => x.id === m[1]); if (!j) return json(res, 404, { error: 'Fant ikke jobben' });
      return json(res, 200, { ok: enqueue(j, 'manuell') });
    }
    if (p === '/api/run-all' && req.method === 'POST') { let n = 0; for (const j of cfg.jobs) if (j.enabled !== false && enqueue(j, 'manuell')) n++; return json(res, 200, { ok: true, queued: n }) }
    if (p === '/api/stop' && req.method === 'POST') { if (running && running.proc) { running.stopped = true; running.proc.kill('SIGTERM') } queue.length = 0; return json(res, 200, { ok: true }) }
    if (p === '/api/snapshots') {
      const list = ourSnaps().map(s => {
        const sn = s.name.split('@')[1], j = cfg.jobs.find(x => sn.startsWith(snapPrefix(x)));
        return { name: s.name, snap: sn, jobId: j ? j.id : null, job: j ? j.name : sn.replace(/^hytte-|-\d{4}-\d\d-\d\d_\d{4}$/g, ''), createdAt: s.creation * 1000, deltaBytes: s.written ?? null };
      }).sort((a, b) => b.createdAt - a.createdAt);
      return json(res, 200, { snapshots: list, helper: helperOk() });
    }
    if (p === '/api/restore' && req.method === 'POST') {
      const b = await body(req), s = snapList().find(x => x.name === b.name); if (!s) return json(res, 404, { error: 'Fant ikke snapshotet' });
      const sn = s.name.split('@')[1], j = cfg.jobs.find(x => sn.startsWith(snapPrefix(x))); if (!j) return json(res, 400, { error: 'Jobben til snapshotet finnes ikke lenger' });
      const from = path.join(DEST_ROOT, '.zfs', 'snapshot', sn, safeDest(j.dest));
      if (!fs.existsSync(from)) return json(res, 400, { error: 'Snapshot-mappen er ikke synlig i containeren (' + from + ')' });
      if (running) return json(res, 409, { error: 'Vent til jobben som kjører er ferdig' });
      const to = b.mode === 'inplace' ? j.src.replace(/\/?$/, '/') : j.src.replace(/\/?$/, '') + '_gjenopprettet_' + sn.slice(-15) + '/';
      const run = { id: 'restore', name: 'Gjenoppretting ' + j.name, start: Date.now(), pct: 0, log: [], phase: 'restore' }; running = run;
      const args = ['-aHX', '--numeric-ids', '--info=progress2,stats2', '-s', '-e', 'ssh ' + sshArgs().map(a => /\s/.test(a) ? q(a) : a).join(' '), from + '/', target() + ':' + to];
      const code = await rsyncRun(args, run);
      const sent = (/Total transferred file size:\s*([\d,]+)/.exec(run.log.join('\n')) || [])[1];
      const st = code === 0 ? 'ok' : code === 23 || code === 24 ? 'warn' : 'fail';
      hist.push({ id: crypto.randomBytes(4).toString('hex'), job: j.id, name: 'Gjenoppretting · ' + j.name, start: run.start, end: Date.now(), status: st,
        bytes: sent ? +sent.replace(/,/g, '') : null, message: st !== 'fail' ? `${sn} → ${to}` : 'rsync kode ' + code, tail: run.log.slice(-30) }); saveHist();
      running = null; setImmediate(next);
      return json(res, 200, { ok: st !== 'fail', to, error: st === 'fail' ? run.log.slice(-2).join(' · ') : undefined });
    }
    if (p === '/api/prune' && req.method === 'POST') { try { await prune(true); return json(res, 200, { ok: true }) } catch (e) { return json(res, 200, { ok: false, error: e.message }) } }
    if (p === '/api/log') { const h = hist.find(x => x.id === url.searchParams.get('id')); return json(res, 200, h || {}) }
    if (p === '/api/password' && req.method === 'POST') { const b = await body(req); if (!b.password || b.password.length < 6) return json(res, 400, { error: 'Minst 6 tegn' }); const salt = crypto.randomBytes(16).toString('hex'); cfg.auth = { salt, hash: hash(b.password, salt) }; saveCfg(); return json(res, 200, { ok: true }) }
    json(res, 404, { error: 'Ukjent' });
  } catch (e) { if (!res.headersSent) json(res, 500, { error: e.message }) }
}).listen(PORT, () => console.log('Hytte Backup ' + VERSION + ' på port ' + PORT + ', mål ' + DEST_ROOT));
