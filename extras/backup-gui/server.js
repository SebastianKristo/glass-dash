// Hytte 3 – selvhostet backup over Tailscale.
// Henter filer fra noder over SSH (tar-strøm), lagrer dem som zstd-komprimerte, deduplisert 4 MiB-blokker,
// og lar deg bla i og gjenopprette fra hvert snapshot uten å pakke ut arkivet.
// Ingen avhengigheter: Node 22.15+, ssh, tailscale (valgfritt).
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { Store, TarReader, tarHeader, tarPad, BLOCK } = require('./store');

const VERSION = '3.0.0';
const PORT = +process.env.PORT || 8090;
const DATA = process.env.DATA_DIR || '/opt/backup-gui/data';
const DEST_ROOT = process.env.DEST_ROOT || '/mnt/unraid';
const PUB = path.join(__dirname, 'public');
const KEY = path.join(DATA, 'id_ed25519'), KNOWN = path.join(DATA, 'known_hosts');
const CFG_F = path.join(DATA, 'config.json');
fs.mkdirSync(DATA, { recursive: true });
const store = new Store(path.join(DEST_ROOT, '.hytte-store'));

const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { return d } };
const wr = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o, null, 2)); fs.renameSync(f + '.tmp', f) };
let cfg = rd(CFG_F, {});
cfg.nodes = cfg.nodes || {};                       // navn → {user, port, loc, host?}
cfg.jobs = cfg.jobs || [];
cfg.settings = { emailSummary: false, notifyOnFail: true, verifyAfterRun: true, autoPrune: true, ...(cfg.settings || {}) };
cfg.history = cfg.history || [];
const saveCfg = () => { cfg.history = cfg.history.slice(-500); wr(CFG_F, cfg) };
const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'jobb';

// ── Logg (koordineringslogg) + SSE ──────────────────────────────────────────
const logBuf = [], clients = new Set();
function emit(type, data) { const s = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(s) }
function log(node, msg, kind = 'info') { const l = { t: Date.now(), node, msg, kind }; logBuf.push(l); if (logBuf.length > 200) logBuf.shift(); emit('coord.log', l) }
let selfName = 'hytte';

// ── Tailscale ────────────────────────────────────────────────────────────────
let tailnet = { ok: false, self: null, peers: [], version: null, suffix: null, t: 0 };
const pings = {};                                    // ip → {ms, tunnel, t}
function tsJSON() {
  return new Promise(ok => execFile('tailscale', ['status', '--json'], { timeout: 8000, maxBuffer: 8e6 }, (e, out) => { try { ok(e ? null : JSON.parse(out)) } catch (x) { ok(null) } }));
}
const shortName = p => (p.DNSName || '').split('.')[0] || p.HostName;
function tunnelOf(p) { if (!p.Online) return 'Frakoblet'; if (p.CurAddr) return 'Direkte'; return p.Relay ? 'DERP · ' + p.Relay : 'Direkte' }
async function refreshTailnet() {
  const j = await tsJSON(); if (!j || !j.Self) { tailnet.ok = false; return }
  const mk = (p, isSelf) => ({ name: shortName(p), host: p.HostName, dns: (p.DNSName || '').replace(/\.$/, ''), ip: (p.TailscaleIPs || [])[0] || '', os: p.OS || '', online: isSelf ? true : !!p.Online,
    lastSeen: p.LastSeen && !p.LastSeen.startsWith('0001') ? Date.parse(p.LastSeen) : null, tunnel: isSelf ? 'Lokal' : tunnelOf(p), relay: p.Relay || '', self: !!isSelf });
  const prevOnline = Object.fromEntries(tailnet.peers.map(p => [p.name, p.online]));
  tailnet = { ok: true, self: mk(j.Self, true), peers: Object.values(j.Peer || {}).map(p => mk(p)), version: (j.Version || '').split('-')[0], suffix: j.MagicDNSSuffix || '', t: Date.now() };
  selfName = tailnet.self.name;
  for (const p of tailnet.peers) if (p.name in prevOnline && prevOnline[p.name] !== p.online) log(p.name, p.online ? 'kom online' : 'gikk offline', p.online ? 'ok' : 'warn');
}
function tsPing(ip) {
  return new Promise(ok => execFile('tailscale', ['ping', '--c', '1', '--timeout', '5s', ip], { timeout: 9000 }, (e, out) => {
    const m = /via (\S+) in ([\d.]+)ms/.exec(out || ''); if (!m) return ok(null);
    const derp = /^DERP\((\w+)\)/.exec(m[1]); const r = { ms: Math.round(+m[2]), tunnel: derp ? 'DERP · ' + derp[1] : 'Direkte', t: Date.now() }; pings[ip] = r; ok(r);
  }));
}
async function pingAll() { for (const p of tailnet.peers) if (p.online) await tsPing(p.ip) }
setInterval(refreshTailnet, 30000); setInterval(pingAll, 180000);
refreshTailnet().then(pingAll);

// Alle kjente noder: tailnet-peers + manuelt lagt til (host uten tailscale)
function nodeList() {
  const peers = tailnet.peers.map(p => ({ ...p, ...(cfg.nodes[p.name] || {}), ping: pings[p.ip] || null }));
  for (const [name, n] of Object.entries(cfg.nodes)) if (n.host && !peers.some(p => p.name === name)) peers.push({ name, host: n.host, dns: n.host, ip: n.host, os: n.os || '', online: n.online ?? true, tunnel: 'Uten tailscale', lastSeen: null, ...n, ping: null, manual: true });
  return peers;
}
const nodeByName = n => nodeList().find(x => x.name === n);

// ── SSH ──────────────────────────────────────────────────────────────────────
if (!fs.existsSync(KEY)) execFile('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'hytte', '-f', KEY], () => {});
const pubKey = () => { try { return fs.readFileSync(KEY + '.pub', 'utf8').trim() } catch (e) { return '' } };
const q = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
function sshTarget(name) {
  const n = nodeByName(name) || { name, ip: name }, c = cfg.nodes[name] || {};
  return { addr: (c.user || 'root') + '@' + (n.ip || n.host || name), port: String(c.port || 22) };
}
const sshArgs = t => ['-i', KEY, '-p', t.port, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=30', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + KNOWN, t.addr];
function ssh(node, cmd, ms = 20000) {
  return new Promise((ok, no) => execFile('ssh', [...sshArgs(sshTarget(node)), cmd], { timeout: ms, maxBuffer: 64e6 }, (e, out, err) =>
    e ? no(new Error((err || e.message).trim().split('\n').pop() || 'SSH feilet')) : ok(out)));
}
function notify(subject, desc, level = 'normal') {
  const n = cfg.settings.notifyNode; if (!n) return Promise.resolve();
  return ssh(n, `/usr/local/emhttp/webGui/scripts/notify -e ${q('Hytte')} -s ${q(subject)} -d ${q(desc)} -i ${q(level)}`).catch(() => {});
}

// ── Innlogging ───────────────────────────────────────────────────────────────
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const sessions = new Map();
const authed = req => { const m = /(?:^|;\s*)bsid=([a-f0-9]+)/.exec(req.headers.cookie || ''); const t = m && sessions.get(m[1]); return !!(t && t > Date.now()) };

// ── Unntak ───────────────────────────────────────────────────────────────────
function excluder(list) {
  const rx = (list || []).filter(Boolean).map(p => {
    const dir = p.endsWith('/'), pat = p.replace(/\/$/, ''), re = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    return pat.includes('/') ? new RegExp('^' + re + (dir ? '(/|$)' : '$')) : new RegExp('(^|/)' + re + (dir ? '(/|$)' : '$'));
  });
  return p => rx.some(r => r.test(p));
}

// ── Kjøring ──────────────────────────────────────────────────────────────────
let running = null; const queue = [];
function enqueue(job, why) {
  if ((running && running.id === job.id) || queue.some(x => x.id === job.id)) return false;
  const n = nodeByName(job.node); if (n && !n.online) { job.waiting = true; saveCfg(); log(job.node, `${job.id} venter på node`, 'warn'); return 'waiting' }
  job.waiting = false; queue.push({ id: job.id, why }); setImmediate(next); emit('job.status', { id: job.id, status: 'queued' }); return true;
}
const snapId = d => { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` };
async function runJob(job, run) {
  const exc = excluder(job.excludes), src = job.path.replace(/\/+$/, '') || '/';
  // 1. Liste over filer på noden
  run.phase = 'liste';
  const out = await ssh(job.node, `cd ${q(src)} && find . -xdev -mindepth 1 \\( -type f -o -type d -o -type l \\) -printf '%y\\t%s\\t%T@\\t%m\\t%l\\t%P\\0'`, 900000);
  const prev = store.listSnaps(job.id).pop(), prevM = prev ? store.loadSnap(job.id, prev.id) : null;
  const entries = [], changed = []; let total = 0;
  for (const rec of out.split('\0')) {
    if (!rec) continue; const parts = rec.split('\t'); if (parts.length < 6) continue;
    const [y, s, t, m, l] = parts, p = parts.slice(5).join('\t'); if (!p || exc(p)) continue;
    const mtime = Math.floor(+t), mode = parseInt(m, 8), size = +s;
    if (y === 'd') entries.push([p, 'd', 0, mtime, mode]);
    else if (y === 'l') entries.push([p, 'l', 0, mtime, mode, l]);
    else { const pe = prevM && prevM.byPath.get(p);
      if (pe && pe[1] === 'f' && pe[2] === size && pe[3] === mtime) entries.push([p, 'f', size, mtime, mode, pe[5], pe[6]]);
      else { const e = [p, 'f', size, mtime, mode, [], null]; entries.push(e); changed.push(e); total += size } }
  }
  // 2. Hent endrede filer som én tar-strøm og del dem i blokker
  run.phase = 'sync'; run.total = total; run.done = 0; let newBytes = 0, newBlocks = 0;
  const byName = new Map(changed.map(e => [e[0], e])), got = new Set();
  if (changed.length) await new Promise((resolve, reject) => {
    const t = sshTarget(job.node);
    const p = spawn('ssh', [...sshArgs(t), `cd ${q(src)} && tar -cf - --null --no-recursion --ignore-failed-read -T - 2>/dev/null; true`]); run.proc = p;
    const tr = new TarReader((name, size) => {
      const e = byName.get(name); let buf = [], blen = 0; const sha = crypto.createHash('sha256'), blocks = [];
      const flush = () => { if (!blen) return; const b = buf.length === 1 ? buf[0] : Buffer.concat(buf, blen); buf = []; blen = 0;
        const r = store.put(b, job.level || 6); blocks.push([r[0], r[1], r[2]]); if (r[3]) { newBytes += r[1]; newBlocks++ } };
      return { data(d) { sha.update(d); run.done += d.length; let o = 0;
          while (o < d.length) { const n = Math.min(BLOCK - blen, d.length - o); buf.push(Buffer.from(d.subarray(o, o + n))); blen += n; o += n; if (blen === BLOCK) flush() }
          run.pct = total ? Math.min(99, Math.floor(run.done / total * 100)) : 99 },
        end() { flush(); if (e) { e[5] = blocks; e[6] = sha.digest('hex'); e[2] = blocks.reduce((a, b) => a + b[2], 0); got.add(name) } } };
    });
    p.stdout.on('data', d => { try { tr.write(d) } catch (x) { p.kill(); reject(x) } });
    let err = ''; p.stderr.on('data', d => err += d);
    p.on('close', c => run.stopped ? reject(new Error('Stoppet manuelt')) : c === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || 'SSH brutt (kode ' + c + ')')));
    p.on('error', reject);
    p.stdin.end(changed.map(e => e[0]).join('\0') + '\0');
  });
  const vanished = changed.filter(e => !got.has(e[0])).length;
  const final = entries.filter(e => e[1] !== 'f' || e[6] != null);
  // 3. Snapshot-manifest
  run.phase = 'snapshot';
  const uniq = new Map(); let orig = 0, files = 0;
  for (const e of final) if (e[1] === 'f') { files++; orig += e[2]; for (const b of e[5]) uniq.set(b[0], b[1]) }
  const stored = [...uniq.values()].reduce((a, b) => a + b, 0), now = new Date();
  const m = { v: 1, id: snapId(now), job: job.id, createdAt: now.getTime(), level: job.level || 6, src: { node: job.node, path: src }, entries: final, warnings: vanished,
    stats: { files, orig, stored, blocks: uniq.size, newBytes, newBlocks, changed: changed.length, full: !prev } };
  store.saveSnap(m);
  return { m, vanished };
}
async function verify(job, m) {
  const files = m.entries.filter(e => e[1] === 'f' && e[2] > 0 && e[2] < 200e6); if (!files.length) return { checked: 0, bad: 0 };
  const pick = []; for (let i = 0, n = Math.min(25, files.length); i < n; i++) pick.push(files.splice(Math.floor(Math.random() * files.length), 1)[0]);
  const outp = await ssh(job.node, `cd ${q(m.src.path)} && sha256sum -- ${pick.map(e => q(e[0])).join(' ')} 2>/dev/null`, 180000).catch(() => '');
  const remote = {}; for (const l of outp.split('\n')) { const r = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(l); if (r) remote[r[2]] = r[1] }
  // Sjekk også at blokkene i arkivet gir samme sjekksum
  let bad = 0, checked = 0;
  for (const e of pick) { if (!remote[e[0]]) continue; checked++; const h = crypto.createHash('sha256'); for (const b of store.readFile(e)) h.update(b); const d = h.digest('hex'); if (d !== e[6] || remote[e[0]] !== e[6]) bad++ }
  return { checked, bad };
}
async function next() {
  if (running || !queue.length) return;
  const { id, why } = queue.shift(), job = cfg.jobs.find(j => j.id === id); if (!job) return next();
  const run = { id: job.id, why, start: Date.now(), pct: 0, done: 0, total: 0, phase: 'liste' }; running = run;
  log(selfName, `starter ${job.id} (${job.node} → ${selfName})`, 'run'); emit('job.status', { id: job.id, status: 'running' });
  let status = 'ok', msg = '', m = null;
  try {
    const r = await runJob(job, run); m = r.m;
    msg = `${fmtB(m.stats.newBytes)} nye data · ${m.stats.changed} endrede filer`;
    if (r.vanished) { status = 'warn'; msg = `${r.vanished} ${r.vanished === 1 ? 'fil' : 'filer'} kunne ikke leses (låst eller slettet underveis). Resten er sikret.` }
    if (cfg.settings.verifyAfterRun) { run.phase = 'verifiserer'; const v = await verify(job, m); if (v.bad) { status = 'warn'; msg = `Verifisering: ${v.bad} av ${v.checked} filer avviker` } else if (v.checked) msg += ` · ${v.checked} sjekksummer OK` }
  } catch (e) { status = 'fail'; msg = e.message }
  const rec = { id: crypto.randomBytes(4).toString('hex'), job: job.id, start: run.start, end: Date.now(), status, message: msg, snap: m && m.id, newBytes: m ? m.stats.newBytes : 0 };
  cfg.history.push(rec); job.last = { status, end: rec.end, message: msg }; saveCfg();
  log(selfName, status === 'fail' ? `${job.id} feilet: ${msg}` : `${job.id} ferdig · snapshot ${m.id} · ${fmtB(m.stats.newBytes)} nye blokker`, status);
  if (status === 'fail' && cfg.settings.notifyOnFail) notify(`Backup feilet: ${job.id}`, msg, 'alert');
  running = null; emit('job.status', { id: job.id, status });
  if (cfg.settings.autoPrune && status !== 'fail') prune();
  next();
}
const fmtB = b => b == null ? '—' : b >= 1e12 ? (b / 1e12).toFixed(2) + ' TB' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? Math.round(b / 1e6) + ' MB' : b >= 1e3 ? Math.round(b / 1e3) + ' kB' : b + ' B';

// ── Opprydding ───────────────────────────────────────────────────────────────
function prune() {
  if (running) return; let removed = 0;
  for (const j of cfg.jobs) { const snaps = store.listSnaps(j.id), keep = (j.retentionDays || 30) * 864e5;
    for (const s of snaps.slice(0, -1)) if (Date.now() - s.createdAt > keep) { store.dropSnap(j.id, s.id); removed++ } }
  if (removed) { const g = store.gc(); log(selfName, `opprydding: ${removed} snapshots og ${g.blocks} blokker fjernet (${fmtB(g.bytes)})`, 'ok') }
}

// ── Planlegging ──────────────────────────────────────────────────────────────
const stamp = d => { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}` };
function slotKey(job, d) {
  const s = job.schedule || {}; if (job.enabled === false) return null;
  const [h, m] = String(s.time || '02:00').split(':').map(Number);
  if (s.type === 'hourly') return d.getMinutes() >= (m || 0) ? 'h' + stamp(d).slice(0, 13) : null;
  if (s.type === '6h') { const back = ((d.getHours() - (h % 6)) % 6 + 6) % 6, st = new Date(d.getTime() - back * 3600e3); st.setMinutes(m, 0, 0); return st > d ? null : 's' + stamp(st).slice(0, 13) }
  if (d.getHours() < h || (d.getHours() === h && d.getMinutes() < m)) return null;
  if (s.type === 'weekly' && d.getDay() !== +(s.day || 0)) return null;
  return 'd' + stamp(d).slice(0, 10);
}
function nextRun(job) {
  if (job.enabled === false) return null; const now = Date.now(), cur = slotKey(job, new Date(now));
  for (let i = 1; i <= 8 * 24 * 60; i++) { const t = new Date(now + i * 60000); t.setSeconds(0, 0); const k = slotKey(job, t); if (k && k !== cur && k !== job.lastKey) return t.getTime() }
  return null;
}
setInterval(() => {
  const d = new Date(); let ch = false;
  for (const j of cfg.jobs) { const k = slotKey(j, d); if (k && j.lastKey !== k) { j.lastKey = k; ch = true; enqueue(j, 'plan') }
    if (j.waiting) { const n = nodeByName(j.node); if (n && n.online) { log(j.node, `${j.id}: noden er tilbake`, 'ok'); enqueue(j, 'plan'); ch = true } } }
  const today = stamp(d).slice(0, 10);
  if (cfg.settings.emailSummary && d.getHours() === 7 && cfg.lastSummary !== today) {
    cfg.lastSummary = today; ch = true; const h = cfg.history.filter(x => x.start > Date.now() - 864e5), bad = h.filter(x => x.status !== 'ok');
    notify(bad.length ? `Hytte: ${bad.length} med advarsel/feil` : 'Hytte: alt OK siste døgn', `${h.length} kjøringer, ${fmtB(h.reduce((a, x) => a + (x.newBytes || 0), 0))} nye data.`, bad.length ? 'warning' : 'normal');
  }
  if (ch) saveCfg();
}, 30000);
for (const j of cfg.jobs) if (!j.lastKey) j.lastKey = slotKey(j, new Date());

// ── Migrering fra v2 (rsync-jobber) ──────────────────────────────────────────
if (cfg.remote && cfg.remote.host && !cfg.migratedV3) {
  const name = cfg.remote.host; cfg.nodes[name] = { ...(cfg.nodes[name] || {}), user: cfg.remote.user || 'root', port: cfg.remote.port || 22 };
  cfg.jobs = cfg.jobs.map(j => j.node ? j : { id: slug(j.dest || j.name), node: name, path: j.src, schedule: j.schedule, level: 6, retentionDays: j.retentionDays || 30, excludes: j.excludes || [], enabled: j.enabled !== false, created: j.created || Date.now() });
  cfg.settings.notifyNode = cfg.settings.notifyNode || name; cfg.migratedV3 = true; saveCfg();
}
// Når tailscale har svart: bytt IP-navn på noder til tailnet-navn
setTimeout(() => { let ch = false; for (const j of cfg.jobs) { const p = tailnet.peers.find(x => x.ip === j.node); if (p) { cfg.nodes[p.name] = { ...(cfg.nodes[j.node] || {}), ...(cfg.nodes[p.name] || {}) }; if (cfg.settings.notifyNode === j.node) cfg.settings.notifyNode = p.name; j.node = p.name; ch = true } } if (ch) saveCfg() }, 5000);

// ── Visningsdata ─────────────────────────────────────────────────────────────
function jobView(j) {
  const snaps = store.listSnaps(j.id), last = snaps[snaps.length - 1], r = running && running.id === j.id;
  return { id: j.id, node: j.node, path: j.path, dests: [selfName], schedule: j.schedule, level: j.level || 6, retentionDays: j.retentionDays, excludes: j.excludes || [], enabled: j.enabled !== false,
    orig: last ? last.stats.orig : null, stored: last ? last.stats.stored : null, snapshots: snaps.length, last: j.last || null, nextRun: nextRun(j),
    status: r ? 'running' : queue.some(x => x.id === j.id) ? 'queued' : j.waiting ? 'waiting' : j.last ? j.last.status : 'scheduled',
    progress: r ? running.pct : null, phase: r ? running.phase : null };
}
function disk() { return new Promise(ok => execFile('df', ['-B1', '--output=size,used,avail', DEST_ROOT], (e, out) => { if (e) return ok(null); const [s, u, a] = out.trim().split('\n').pop().trim().split(/\s+/).map(Number); ok({ size: s, used: u, avail: a }) })) }

// ── HTTP ─────────────────────────────────────────────────────────────────────
const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)) };
const body = req => new Promise(r => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy() }); req.on('end', () => { try { r(JSON.parse(b || '{}')) } catch (e) { r({}) } }) });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
const rest = {}; // gjenoppretting-progresjon

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  try {
    if (!p.startsWith('/api/')) {
      const f = path.join(PUB, /^\/(backupsteder|filer)?\/?$/.test(p) ? 'index.html' : path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end() }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': f.includes('/vendor/') ? 'max-age=604800' : 'no-cache' }); return fs.createReadStream(f).pipe(res);
    }
    if (p === '/api/health') return json(res, 200, { ok: true, app: 'hytte', version: VERSION });
    if (p === '/api/whoami') return json(res, 200, { authed: authed(req), setup: !cfg.auth });
    if (p === '/api/login' && req.method === 'POST') {
      const b = await body(req); if (!b.password || b.password.length < 6) return json(res, 400, { error: 'Minst 6 tegn' });
      if (!cfg.auth) { const salt = crypto.randomBytes(16).toString('hex'); cfg.auth = { salt, hash: hash(b.password, salt) }; saveCfg() }
      else if (!crypto.timingSafeEqual(Buffer.from(hash(b.password, cfg.auth.salt), 'hex'), Buffer.from(cfg.auth.hash, 'hex'))) return json(res, 401, { error: 'Feil passord' });
      const tok = crypto.randomBytes(24).toString('hex'); sessions.set(tok, Date.now() + 30 * 864e5);
      res.setHeader('Set-Cookie', `bsid=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}`); return json(res, 200, { ok: true });
    }
    if (!authed(req)) return json(res, 401, { error: 'Ikke logget inn' });
    if (p === '/api/logout') { const m = /bsid=([a-f0-9]+)/.exec(req.headers.cookie || ''); if (m) sessions.delete(m[1]); return json(res, 200, { ok: true }) }

    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' }); res.write(': ok\n\n');
      clients.add(res); const iv = setInterval(() => { res.write(': ping\n\n'); if (running) emit('job.progress', { id: running.id, pct: running.pct, phase: running.phase }) }, 2000);
      req.on('close', () => { clearInterval(iv); clients.delete(res) }); return;
    }
    if (p === '/api/state') {
      const d = await disk(), jobs = cfg.jobs.map(jobView);
      return json(res, 200, {
        version: VERSION, self: tailnet.self || { name: selfName, ip: '', os: 'linux', online: true, tunnel: 'Lokal' }, tailnet: { ok: tailnet.ok, version: tailnet.version, suffix: tailnet.suffix },
        nodes: nodeList(), jobs, disk: d, store: { bytes: store.bytes, blocks: store.have.size }, settings: cfg.settings, pubkey: pubKey(), destRoot: DEST_ROOT,
        running: running && { id: running.id, pct: running.pct, phase: running.phase, done: running.done, total: running.total }, log: logBuf.slice(-40), history: cfg.history.slice(-100),
        restores: rest,
      });
    }
    if (p === '/api/settings' && req.method === 'POST') { const b = await body(req); for (const k of ['emailSummary', 'notifyOnFail', 'verifyAfterRun', 'autoPrune']) if (k in b) cfg.settings[k] = !!b[k]; if ('notifyNode' in b) cfg.settings.notifyNode = b.notifyNode || null; saveCfg(); return json(res, 200, { ok: true }) }
    if (p === '/api/password' && req.method === 'POST') { const b = await body(req); if (!b.password || b.password.length < 6) return json(res, 400, { error: 'Minst 6 tegn' }); const salt = crypto.randomBytes(16).toString('hex'); cfg.auth = { salt, hash: hash(b.password, salt) }; saveCfg(); return json(res, 200, { ok: true }) }
    let m;
    if ((m = /^\/api\/nodes\/([^/]+)\/ping$/.exec(p)) && req.method === 'POST') {
      const n = nodeByName(decodeURIComponent(m[1])); if (!n) return json(res, 404, { error: 'Ukjent node' });
      if (n.manual) { const t = Date.now(); try { await ssh(n.name, 'true', 10000); return json(res, 200, { ms: Date.now() - t, loss: 0, via: 'ssh' }) } catch (e) { return json(res, 200, { ms: null, loss: 100, error: e.message }) } }
      const r = await tsPing(n.ip); log(n.name, r ? `ping ${r.ms} ms · ${r.tunnel}` : 'ping: ingen svar', r ? 'info' : 'warn'); return json(res, 200, r ? { ms: r.ms, loss: 0, tunnel: r.tunnel } : { ms: null, loss: 100 });
    }
    if ((m = /^\/api\/nodes\/([^/]+)$/.exec(p)) && req.method === 'PATCH') {
      const name = decodeURIComponent(m[1]), b = await body(req); cfg.nodes[name] = { ...(cfg.nodes[name] || {}) };
      for (const k of ['user', 'loc', 'host', 'os']) if (k in b) cfg.nodes[name][k] = String(b[k] || '').trim() || undefined; if ('port' in b) cfg.nodes[name].port = +b.port || 22; saveCfg(); return json(res, 200, { ok: true });
    }
    if ((m = /^\/api\/nodes\/([^/]+)\/test$/.exec(p)) && req.method === 'POST') {
      const name = decodeURIComponent(m[1]); try { const o = await ssh(name, 'hostname; (tar --version | head -1); (sha256sum --version | head -1)'); return json(res, 200, { ok: true, info: o.trim().split('\n') }) } catch (e) { return json(res, 200, { ok: false, error: e.message }) }
    }
    if (p === '/api/browse') {
      const node = url.searchParams.get('node'), dir = (url.searchParams.get('path') || '/').replace(/\/+$/, '') || '/';
      try { const o = await ssh(node, `cd ${q(dir)} && find . -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\\n' | sort -f`); const dirs = o.split('\n').filter(Boolean); return json(res, 200, { path: dir, dirs: dirs.map(d => ({ name: d, path: (dir === '/' ? '' : dir) + '/' + d })) }) }
      catch (e) { return json(res, 200, { path: dir, dirs: [], error: e.message }) }
    }
    if (p === '/api/jobs' && req.method === 'POST') {
      const b = await body(req); if (!b.node || !b.path) return json(res, 400, { error: 'Velg node og mappe' });
      let j = b.orig && cfg.jobs.find(x => x.id === b.orig); const id = slug(b.id || (b.node + '-' + path.basename(b.path)));
      if (cfg.jobs.some(x => x !== j && x.id === id)) return json(res, 400, { error: `Jobb-id «${id}» finnes allerede` });
      if (j && j.id !== id && store.listSnaps(j.id).length) return json(res, 400, { error: 'Id kan ikke endres når jobben har snapshots' });
      if (!j) { j = { created: Date.now() }; cfg.jobs.push(j) }
      const sc = b.schedule || {};
      Object.assign(j, { id, node: String(b.node), path: String(b.path), level: [1, 3, 6, 9, 19].includes(+b.level) ? +b.level : 6, retentionDays: [7, 30, 90, 365].includes(+b.retentionDays) ? +b.retentionDays : 30,
        excludes: (b.excludes || []).map(String).filter(Boolean).slice(0, 50), enabled: b.enabled !== false,
        schedule: { type: ['hourly', '6h', 'daily', 'weekly'].includes(sc.type) ? sc.type : 'daily', time: /^\d\d:\d\d$/.test(sc.time) ? sc.time : '02:00', day: +(sc.day || 0) } });
      j.lastKey = slotKey(j, new Date()); saveCfg(); log(selfName, `jobb ${id} lagret (${j.node}:${j.path})`);
      if (b.runNow) enqueue(j, 'manuell'); return json(res, 200, { ok: true, job: jobView(j) });
    }
    if ((m = /^\/api\/jobs\/([\w-]+)$/.exec(p)) && req.method === 'DELETE') { cfg.jobs = cfg.jobs.filter(j => j.id !== m[1]); saveCfg(); log(selfName, `jobb ${m[1]} slettet (arkivet beholdes)`); return json(res, 200, { ok: true }) }
    if ((m = /^\/api\/jobs\/([\w-]+)\/run$/.exec(p)) && req.method === 'POST') { const j = cfg.jobs.find(x => x.id === m[1]); if (!j) return json(res, 404, { error: 'Fant ikke jobben' }); return json(res, 200, { ok: enqueue(j, 'manuell') }) }
    if (p === '/api/jobs/run-all' && req.method === 'POST') { let n = 0, w = 0; for (const j of cfg.jobs) if (j.enabled !== false) { const r = enqueue(j, 'manuell'); if (r === true) n++; else if (r === 'waiting') w++ } return json(res, 200, { ok: true, queued: n, waiting: w }) }
    if (p === '/api/stop' && req.method === 'POST') { if (running && running.proc) { running.stopped = true; running.proc.kill('SIGTERM') } queue.length = 0; return json(res, 200, { ok: true }) }
    if ((m = /^\/api\/jobs\/([\w-]+)\/snapshots$/.exec(p))) {
      const list = store.listSnaps(m[1]);
      return json(res, 200, list.map(s => ({ id: s.id, createdAt: s.createdAt, level: s.level, stats: s.stats, warnings: s.warnings, src: s.src })).reverse());
    }
    // Arkiv: ls / stat / file
    if ((m = /^\/api\/archive\/([\w-]+)\/([\w-]+)\/(ls|stat|file)$/.exec(p))) {
      const [, job, sid, op] = m; let man; try { man = store.loadSnap(job, sid) } catch (e) { return json(res, 404, { error: 'Fant ikke snapshotet' }) }
      const rel = (url.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '');
      if (op === 'ls') {
        const d = man.dirs.get(rel); if (!d) return json(res, 404, { error: 'Fant ikke mappen' });
        const items = [...d.kids].map(name => { const fp = rel ? rel + '/' + name : name, e = man.byPath.get(fp), sub = man.dirs.get(fp);
          if (sub && (!e || e[1] === 'd')) return { name, dir: true, size: sub.size, csize: sub.csize, children: sub.kids.size, mtime: sub.mtime || (e && e[3]) };
          if (!e) return null; return { name, dir: false, link: e[1] === 'l' ? e[5] : undefined, size: e[2], csize: e[1] === 'f' ? e[5].reduce((a, b) => a + b[1], 0) : 0, mtime: e[3] } }).filter(Boolean)
          .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'nb'));
        return json(res, 200, { path: rel, items, blocks: man.stats.blocks, level: man.level, src: man.src });
      }
      const e = man.byPath.get(rel); if (!e || e[1] !== 'f') return json(res, 404, { error: 'Fant ikke filen' });
      if (op === 'stat') return json(res, 200, { size: e[2], csize: e[5].reduce((a, b) => a + b[1], 0), blocks: e[5].length, sha256: e[6], mtime: e[3], mode: e[4] });
      const head = +url.searchParams.get('head') || 0, dl = url.searchParams.has('download');
      res.writeHead(200, { 'Content-Type': dl ? 'application/octet-stream' : 'text/plain; charset=utf-8', 'Content-Length': head ? Math.min(head, e[2]) : e[2],
        ...(dl ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(rel))}` } : {}) });
      for (const b of store.readFile(e, head || Infinity)) { if (!res.write(b)) await new Promise(r => res.once('drain', r)) }
      return res.end();
    }
    if (p === '/api/restore' && req.method === 'POST') {
      const b = await body(req); let man; try { man = store.loadSnap(b.job, b.snap) } catch (e) { return json(res, 404, { error: 'Fant ikke snapshotet' }) }
      const rel = String(b.path || '').replace(/^\/+|\/+$/g, ''), target = String(b.targetPath || '').trim(), node = String(b.node || '');
      if (!node || !target.startsWith('/')) return json(res, 400, { error: 'Velg node og en absolutt målsti' });
      const list = man.entries.filter(e => rel === '' || e[0] === rel || e[0].startsWith(rel + '/'));
      if (!list.length) return json(res, 404, { error: 'Ingenting å gjenopprette' });
      const single = list.length === 1 && list[0][1] === 'f' && list[0][0] === rel;
      const total = list.reduce((a, e) => a + (e[1] === 'f' ? e[2] : 0), 0), key = crypto.randomBytes(4).toString('hex');
      rest[key] = { job: b.job, path: rel, node, target, pct: 0, done: 0, total, status: 'running', start: Date.now() };
      json(res, 200, { ok: true, key });
      // Målmappe: for én fil er target full filsti, ellers mappen innholdet legges i
      const base = single ? path.posix.dirname(target) : target, strip = single ? path.posix.dirname(rel) : rel;
      const t = sshTarget(node), proc = spawn('ssh', [...sshArgs(t), `mkdir -p ${q(base)} && tar -xf - -C ${q(base)}`]);
      let err = ''; proc.stderr.on('data', d => err += d);
      const done = new Promise(r => proc.on('close', r));
      const w = async buf => { if (!proc.stdin.write(buf)) await new Promise(r => proc.stdin.once('drain', r)) };
      try {
        log(selfName, `gjenoppretter ${b.job}:${rel || '/'} → ${node}:${target}`, 'run');
        for (const e of list) {
          let name = strip && strip !== '.' ? e[0].slice(strip.length + 1) : e[0]; if (single) name = path.posix.basename(target); if (!name) continue;
          if (e[1] === 'd') await w(tarHeader(name, { type: '5', mode: e[4], mtime: e[3] }));
          else if (e[1] === 'l') await w(tarHeader(name, { type: '2', mode: e[4], mtime: e[3], link: e[5] }));
          else { await w(tarHeader(name, { size: e[2], mode: e[4], mtime: e[3] })); for (const buf of store.readFile(e)) { await w(buf); rest[key].done += buf.length; rest[key].pct = total ? Math.floor(rest[key].done / total * 100) : 100; emit('restore.progress', { key, pct: rest[key].pct }) } await w(tarPad(e[2])) }
        }
        await w(Buffer.alloc(1024)); proc.stdin.end(); const code = await done;
        if (code) throw new Error(err.trim().split('\n').pop() || 'tar feilet på noden');
        let check = '';
        if (single && list[0][6]) { const o = await ssh(node, `sha256sum -- ${q(target)}`).catch(() => ''); check = o.startsWith(list[0][6]) ? 'sjekksum OK' : 'sjekksum avviker' }
        Object.assign(rest[key], { status: 'ok', pct: 100, check }); log(node, `gjenopprettet ${fmtB(total)} fra ${selfName}${check ? ' · ' + check : ''}`, 'ok');
      } catch (e) { try { proc.kill() } catch (x) {} Object.assign(rest[key], { status: 'fail', error: e.message }); log(node, `gjenoppretting feilet: ${e.message}`, 'fail') }
      emit('restore.progress', { key, pct: rest[key].pct, status: rest[key].status }); return;
    }
    if (p === '/api/prune' && req.method === 'POST') { prune(); return json(res, 200, { ok: true }) }
    json(res, 404, { error: 'Ukjent' });
  } catch (e) { if (!res.headersSent) json(res, 500, { error: e.message }); else res.end() }
}).listen(PORT, () => { console.log('Hytte ' + VERSION + ' på port ' + PORT + ', arkiv i ' + store.root); log(selfName, `Hytte ${VERSION} startet · ${store.have.size} blokker i arkivet`, 'ok') });
