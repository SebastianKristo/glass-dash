// Hytte Backup – web-GUI for rsync-backup fra Unraid (eller annen SSH-vert) til en ZFS-mappe.
// Ingen avhengigheter. Henter (pull) over SSH, så nøkkelen ligger her og Unraid trenger bare authorized_keys.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const PORT = +process.env.PORT || 8090;
const DATA = process.env.DATA_DIR || '/opt/backup-gui/data';
const DEST_ROOT = process.env.DEST_ROOT || '/mnt/unraid';
const PUB = path.join(__dirname, 'public');
const KEY = path.join(DATA, 'id_ed25519'), KNOWN = path.join(DATA, 'known_hosts');
const CFG_F = path.join(DATA, 'config.json'), HIST_F = path.join(DATA, 'history.json');
fs.mkdirSync(DATA, { recursive: true });

const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { return d } };
const wr = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o, null, 2)); fs.renameSync(f + '.tmp', f) };
let cfg = rd(CFG_F, {}); cfg.remote = cfg.remote || { host: '', user: 'root', port: 22 }; cfg.jobs = cfg.jobs || [];
let hist = rd(HIST_F, []);
const saveCfg = () => wr(CFG_F, cfg), saveHist = () => wr(HIST_F, hist.slice(-300));

// ── SSH-nøkkel ────────────────────────────────────────────────────────────────
if (!fs.existsSync(KEY)) execFile('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'hytte-backup', '-f', KEY], () => {});
const pubKey = () => { try { return fs.readFileSync(KEY + '.pub', 'utf8').trim() } catch (e) { return '' } };
const sshArgs = () => ['-i', KEY, '-p', String(cfg.remote.port || 22), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
  '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + KNOWN];
const target = () => (cfg.remote.user || 'root') + '@' + cfg.remote.host;
const q = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
function ssh(cmd, ms = 20000) {
  return new Promise((ok, no) => {
    if (!cfg.remote.host) return no(new Error('Ingen Unraid-adresse satt'));
    execFile('ssh', [...sshArgs(), target(), cmd], { timeout: ms, maxBuffer: 8e6 }, (e, out, err) =>
      e ? no(new Error((err || e.message).trim().split('\n').pop())) : ok(out));
  });
}

// ── Innlogging ────────────────────────────────────────────────────────────────
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const sessions = new Map(); // token -> utløp
const authed = req => { const m = /(?:^|;\s*)bsid=([a-f0-9]+)/.exec(req.headers.cookie || ''); const t = m && sessions.get(m[1]); return !!(t && t > Date.now()) };
function login(res, pw) {
  if (!cfg.auth) { const salt = crypto.randomBytes(16).toString('hex'); cfg.auth = { salt, hash: hash(pw, salt) }; saveCfg() }
  else if (!crypto.timingSafeEqual(Buffer.from(hash(pw, cfg.auth.salt), 'hex'), Buffer.from(cfg.auth.hash, 'hex'))) return json(res, 401, { error: 'Feil passord' });
  const tok = crypto.randomBytes(24).toString('hex'); sessions.set(tok, Date.now() + 30 * 864e5);
  res.setHeader('Set-Cookie', `bsid=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}`); json(res, 200, { ok: true });
}

// ── Kjøring ───────────────────────────────────────────────────────────────────
let running = null; const queue = [];
const safeDest = d => String(d || '').replace(/\.\./g, '').replace(/^\/+|\/+$/g, '').replace(/[^\w\-./ æøåÆØÅ]/g, '_') || 'backup';
function enqueue(job, why) {
  if ((running && running.id === job.id) || queue.some(x => x.id === job.id)) return false;
  queue.push({ id: job.id, why }); next(); return true;
}
function next() {
  if (running || !queue.length) return;
  const { id, why } = queue.shift(), job = cfg.jobs.find(j => j.id === id); if (!job) return next();
  const dest = path.join(DEST_ROOT, safeDest(job.dest)); fs.mkdirSync(dest, { recursive: true });
  const args = ['-aHX', '--partial', '--numeric-ids', '--info=progress2,stats2', '--no-inc-recursive', '--human-readable'];
  if (job.mirror) args.push('--delete', '--delete-excluded');
  if (job.bwlimit) args.push('--bwlimit=' + job.bwlimit);
  for (const x of job.excludes || []) if (x.trim()) args.push('--exclude', x.trim());
  args.push('-e', 'ssh ' + sshArgs().map(a => /\s/.test(a) ? q(a) : a).join(' '));
  args.push('-s', target() + ':' + job.src.replace(/\/?$/, '/'), dest + '/');
  const run = { id: job.id, name: job.name, why, start: Date.now(), pct: 0, speed: '', eta: '', done: '', log: [] };
  running = run;
  const p = spawn('rsync', args); run.proc = p;
  let buf = '';
  const onData = d => {
    buf += d.toString(); const parts = buf.split(/[\r\n]/); buf = parts.pop();
    for (const l of parts) {
      const m = /^\s*([\d.,]+\w*)\s+(\d+)%\s+(\S+\/s)\s+(\d+:\d+:\d+)/.exec(l);
      if (m) { run.done = m[1]; run.pct = +m[2]; run.speed = m[3]; run.eta = m[4]; continue }
      if (l.trim()) { run.log.push(l); if (run.log.length > 400) run.log.shift() }
    }
  };
  p.stdout.on('data', onData); p.stderr.on('data', onData);
  p.on('close', code => {
    const L = run.log.join('\n'), num = re => { const m = re.exec(L); return m ? m[1] : '' };
    const ok = code === 0 || code === 24; // 24 = filer forsvant underveis (normalt)
    const rec = { id: crypto.randomBytes(4).toString('hex'), job: job.id, name: job.name, why, start: run.start, end: Date.now(), ok, code,
      stopped: run.stopped || false, files: num(/Number of regular files transferred:\s*([\d,.]+)/), size: num(/Total file size:\s*([\d.,]+\s*\w*)/),
      sent: num(/Total transferred file size:\s*([\d.,]+\s*\w*)/),
      error: ok ? '' : (run.stopped ? 'Stoppet' : run.log.filter(x => /error|failed|denied|refused|No such/i.test(x)).slice(-3).join(' · ') || 'rsync avsluttet med kode ' + code),
      tail: run.log.slice(-25) };
    hist.push(rec); saveHist();
    job.last = { ok, end: rec.end, start: rec.start, size: rec.size, error: rec.error }; saveCfg();
    running = null; next();
  });
}

// ── Planlegging ───────────────────────────────────────────────────────────────
// schedule: {type:'manual'|'hourly'|'daily'|'weekly', time:'03:00', day:0-6 (0=søndag)}
function dueKey(job, now) {
  const s = job.schedule || {}; if (!job.enabled || s.type === 'manual' || !s.type) return null;
  const [h, m] = String(s.time || '03:00').split(':').map(Number), d = new Date(now);
  if (s.type === 'hourly') return d.getMinutes() >= (m || 0) ? 'h' + d.toISOString().slice(0, 13) : null;
  if (d.getHours() < h || (d.getHours() === h && d.getMinutes() < m)) return null;
  if (s.type === 'weekly' && d.getDay() !== +(s.day || 0)) return null;
  return 'd' + d.toLocaleDateString('sv');
}
setInterval(() => {
  const now = Date.now(); let ch = false;
  for (const j of cfg.jobs) { const k = dueKey(j, now); if (k && j.lastKey !== k) { j.lastKey = k; ch = true; enqueue(j, 'plan') } }
  if (ch) saveCfg();
}, 30000);
// Ikke kjør alt som «skulle gått» første gang serveren starter: marker dagens nøkkel som tatt hvis jobben allerede har kjørt i dag.
for (const j of cfg.jobs) { const k = dueKey(j, Date.now()); if (k && j.last && new Date(j.last.start).toLocaleDateString('sv') === new Date().toLocaleDateString('sv')) j.lastKey = k }

// ── Hjelpere ──────────────────────────────────────────────────────────────────
function disk() {
  return new Promise(ok => execFile('df', ['-B1', '--output=size,used,avail', DEST_ROOT], (e, out) => {
    if (e) return ok(null); const [s, u, a] = out.trim().split('\n').pop().trim().split(/\s+/).map(Number); ok({ size: s, used: u, avail: a });
  }));
}
function snapshots() {
  const dir = path.join(DEST_ROOT, '.zfs', 'snapshot');
  try { return fs.readdirSync(dir).map(n => { let t = 0; try { t = fs.statSync(path.join(dir, n)).mtimeMs } catch (e) {} return { name: n, t } }).sort((a, b) => b.t - a.t) }
  catch (e) { return null }
}
const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)) };
const body = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy() }); req.on('end', () => { try { r(JSON.parse(b || '{}')) } catch (e) { r({}) } }) });
const pubJob = j => ({ ...j, lastKey: undefined, queued: queue.some(x => x.id === j.id) });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  try {
    if (!p.startsWith('/api/')) {
      const f = path.join(PUB, p === '/' ? 'index.html' : path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!f.startsWith(PUB) || !fs.existsSync(f)) { res.writeHead(404); return res.end() }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); return fs.createReadStream(f).pipe(res);
    }
    if (p === '/api/login' && req.method === 'POST') { const b = await body(req); if (!b.password || b.password.length < 6) return json(res, 400, { error: 'Minst 6 tegn' }); return login(res, b.password) }
    if (p === '/api/whoami') return json(res, 200, { authed: authed(req), setup: !cfg.auth });
    if (!authed(req)) return json(res, 401, { error: 'Ikke logget inn' });
    if (p === '/api/logout') { const m = /bsid=([a-f0-9]+)/.exec(req.headers.cookie || ''); if (m) sessions.delete(m[1]); return json(res, 200, { ok: true }) }

    if (p === '/api/state') return json(res, 200, {
      remote: cfg.remote, pubkey: pubKey(), destRoot: DEST_ROOT, disk: await disk(), jobs: cfg.jobs.map(pubJob),
      running: running && { id: running.id, name: running.name, start: running.start, pct: running.pct, speed: running.speed, eta: running.eta, done: running.done, log: running.log.slice(-12) },
      snapshots: (snapshots() || []).length, hasSnapshots: snapshots() !== null,
    });
    if (p === '/api/settings' && req.method === 'POST') {
      const b = await body(req); cfg.remote = { host: String(b.host || '').trim(), user: String(b.user || 'root').trim(), port: +b.port || 22 }; saveCfg(); return json(res, 200, { ok: true });
    }
    if (p === '/api/test' && req.method === 'POST') {
      try { const out = await ssh('echo OK; hostname; rsync --version | head -1'); const [, host, rs] = out.trim().split('\n'); return json(res, 200, { ok: true, host, rsync: rs }) }
      catch (e) { return json(res, 200, { ok: false, error: e.message }) }
    }
    if (p === '/api/browse') {
      const dir = (url.searchParams.get('path') || '/mnt/user').replace(/\/+$/, '') || '/';
      try {
        const out = await ssh(`cd ${q(dir)} && find . -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\\n' | sort -f`);
        return json(res, 200, { path: dir, dirs: out.split('\n').filter(Boolean) });
      } catch (e) { return json(res, 200, { path: dir, dirs: [], error: e.message }) }
    }
    if (p === '/api/size') {
      const dir = url.searchParams.get('path') || '';
      try { const out = await ssh(`du -sb ${q(dir)} 2>/dev/null | cut -f1`, 600000); return json(res, 200, { bytes: +out.trim() || 0 }) }
      catch (e) { return json(res, 200, { error: e.message }) }
    }
    if (p === '/api/jobs' && req.method === 'POST') {
      const b = await body(req); if (!b.src) return json(res, 400, { error: 'Velg en mappe' });
      let j = b.id && cfg.jobs.find(x => x.id === b.id);
      if (!j) { j = { id: crypto.randomBytes(4).toString('hex'), created: Date.now() }; cfg.jobs.push(j) }
      Object.assign(j, {
        name: String(b.name || path.basename(b.src)).slice(0, 60), src: String(b.src), dest: safeDest(b.dest || path.basename(b.src)),
        excludes: (b.excludes || []).map(String).filter(Boolean).slice(0, 50), mirror: !!b.mirror, enabled: b.enabled !== false,
        bwlimit: String(b.bwlimit || '').replace(/[^\dkKmM]/g, ''), schedule: { type: b.schedule?.type || 'daily', time: b.schedule?.time || '03:00', day: +(b.schedule?.day || 0) },
      });
      j.lastKey = dueKey(j, Date.now()); // ikke start med en gang bare fordi tidspunktet er passert i dag
      saveCfg(); return json(res, 200, { ok: true, job: pubJob(j) });
    }
    let m;
    if ((m = /^\/api\/jobs\/(\w+)$/.exec(p)) && req.method === 'DELETE') { cfg.jobs = cfg.jobs.filter(j => j.id !== m[1]); saveCfg(); return json(res, 200, { ok: true }) }
    if ((m = /^\/api\/jobs\/(\w+)\/run$/.exec(p)) && req.method === 'POST') {
      const j = cfg.jobs.find(x => x.id === m[1]); if (!j) return json(res, 404, { error: 'Fant ikke jobben' });
      return json(res, 200, { ok: enqueue(j, 'manuell') });
    }
    if (p === '/api/stop' && req.method === 'POST') { if (running && running.proc) { running.stopped = true; running.proc.kill('SIGTERM') } queue.length = 0; return json(res, 200, { ok: true }) }
    if (p === '/api/history') { const id = url.searchParams.get('job'); return json(res, 200, hist.filter(h => !id || h.job === id).slice(-100).reverse()) }
    if (p === '/api/snapshots') return json(res, 200, snapshots() || []);
    if (p === '/api/password' && req.method === 'POST') { const b = await body(req); if (!b.password || b.password.length < 6) return json(res, 400, { error: 'Minst 6 tegn' }); const salt = crypto.randomBytes(16).toString('hex'); cfg.auth = { salt, hash: hash(b.password, salt) }; saveCfg(); return json(res, 200, { ok: true }) }
    json(res, 404, { error: 'Ukjent' });
  } catch (e) { json(res, 500, { error: e.message }) }
}).listen(PORT, () => console.log('Hytte Backup på port ' + PORT + ', mål ' + DEST_ROOT));
