// Hytte – blokkarkiv: innholdsadresserte 4 MiB-blokker komprimert med zstd, deduplisert på tvers av jobber.
// Snapshots er manifester (filtre → blokkliste). Filer kan leses uten å pakke ut arkivet.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const BLOCK = 4 * 1024 * 1024;
if (typeof zlib.zstdCompressSync !== 'function') throw new Error('Node 22.15+ kreves (zstd i zlib)');

class Store {
  constructor(root) {
    this.root = root; this.bdir = path.join(root, 'blocks'); this.sdir = path.join(root, 'snaps');
    fs.mkdirSync(this.bdir, { recursive: true }); fs.mkdirSync(this.sdir, { recursive: true });
    this.have = new Map(); this.bytes = 0; this.mcache = new Map();
    for (const d of fs.readdirSync(this.bdir)) {
      const dd = path.join(this.bdir, d); if (!/^[0-9a-f]{2}$/.test(d)) continue;
      for (const f of fs.readdirSync(dd)) { if (f.endsWith('.tmp')) { try { fs.unlinkSync(path.join(dd, f)) } catch (e) {} continue }
        const s = fs.statSync(path.join(dd, f)).size; this.have.set(f, s); this.bytes += s }
    }
  }
  bpath(h) { return path.join(this.bdir, h.slice(0, 2), h) }
  // Lagrer en blokk hvis den er ny. Returnerer [hash, komprimert lengde, lengde, ny?]
  put(buf, level) {
    const h = crypto.createHash('sha256').update(buf).digest('hex');
    if (this.have.has(h)) return [h, this.have.get(h), buf.length, false];
    const c = zlib.zstdCompressSync(buf, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } });
    const p = this.bpath(h); fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p + '.tmp', c); fs.renameSync(p + '.tmp', p);
    this.have.set(h, c.length); this.bytes += c.length; return [h, c.length, buf.length, true];
  }
  get(h) { return zlib.zstdDecompressSync(fs.readFileSync(this.bpath(h))) }
  // ── Snapshots ──
  snapFile(job, id) { return path.join(this.sdir, job, id + '.json.zst') }
  saveSnap(m) {
    const f = this.snapFile(m.job, m.id); fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f + '.tmp', zlib.zstdCompressSync(Buffer.from(JSON.stringify(m)))); fs.renameSync(f + '.tmp', f);
    const meta = { id: m.id, job: m.job, createdAt: m.createdAt, level: m.level, src: m.src, stats: m.stats, warnings: m.warnings || 0 };
    fs.writeFileSync(f.replace(/\.json\.zst$/, '.meta.json'), JSON.stringify(meta));
  }
  listSnaps(job) {
    const d = path.join(this.sdir, job); let out = [];
    try { out = fs.readdirSync(d).filter(f => f.endsWith('.meta.json')).map(f => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))) } catch (e) {}
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }
  jobsWithSnaps() { try { return fs.readdirSync(this.sdir) } catch (e) { return [] } }
  loadSnap(job, id) {
    const k = job + '/' + id; if (this.mcache.has(k)) { const v = this.mcache.get(k); this.mcache.delete(k); this.mcache.set(k, v); return v }
    const m = JSON.parse(zlib.zstdDecompressSync(fs.readFileSync(this.snapFile(job, id))).toString());
    // Indeks: sti → oppføring, mappe → barn og summer
    m.byPath = new Map(); m.dirs = new Map([['', { kids: new Set(), size: 0, csize: 0, files: 0, mtime: 0 }]]);
    const dir = p => { let d = m.dirs.get(p); if (!d) { d = { kids: new Set(), size: 0, csize: 0, files: 0, mtime: 0 }; m.dirs.set(p, d) } return d };
    for (const e of m.entries) {
      const [p, t, size, mtime] = e; m.byPath.set(p, e);
      const parts = p.split('/'), csize = t === 'f' ? e[5].reduce((a, b) => a + b[1], 0) : 0;
      for (let i = 0; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/'), d = dir(parent); d.kids.add(parts[i]);
        if (t === 'f') { d.size += size; d.csize += csize; d.files++; if (mtime > d.mtime) d.mtime = mtime }
      }
      if (t === 'd') dir(p);
    }
    this.mcache.set(k, m); if (this.mcache.size > 4) this.mcache.delete(this.mcache.keys().next().value);
    return m;
  }
  dropSnap(job, id) {
    for (const f of [this.snapFile(job, id), this.snapFile(job, id).replace(/\.json\.zst$/, '.meta.json')]) try { fs.unlinkSync(f) } catch (e) {}
    this.mcache.delete(job + '/' + id);
  }
  // Fjerner blokker som ingen snapshot bruker lenger
  gc() {
    const used = new Set();
    for (const j of this.jobsWithSnaps()) for (const s of this.listSnaps(j)) {
      const m = JSON.parse(zlib.zstdDecompressSync(fs.readFileSync(this.snapFile(j, s.id))).toString());
      for (const e of m.entries) if (e[1] === 'f') for (const b of e[5]) used.add(b[0]);
    }
    let n = 0, freed = 0;
    for (const [h, s] of this.have) if (!used.has(h)) { try { fs.unlinkSync(this.bpath(h)) } catch (e) {} this.have.delete(h); this.bytes -= s; freed += s; n++ }
    return { blocks: n, bytes: freed };
  }
  // Strømmer en fil fra blokkene (bare de blokkene som trengs)
  *readFile(e, limit = Infinity) { let sent = 0; for (const b of e[5]) { if (sent >= limit) return; const buf = this.get(b[0]); sent += buf.length; yield sent > limit ? buf.subarray(0, buf.length - (sent - limit)) : buf } }
}

// ── Tar ───────────────────────────────────────────────────────────────────────
// Leser en tar-strøm (GNU/ustar/pax) og kaller onFile(name, size) → {data(buf), end()}
class TarReader {
  constructor(onFile) { this.onFile = onFile; this.buf = Buffer.alloc(0); this.state = 'hdr'; this.left = 0; this.pad = 0; this.longName = null; this.pax = null; this.cur = null; this.meta = null }
  write(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.state === 'hdr') {
        if (this.buf.length < 512) return; const h = this.buf.subarray(0, 512); this.buf = this.buf.subarray(512);
        if (h.every(x => x === 0)) continue;
        const str = (o, l) => { const s = h.subarray(o, o + l); const z = s.indexOf(0); return s.subarray(0, z < 0 ? l : z).toString('utf8') };
        let size; if (h[124] & 0x80) { size = 0; for (let i = 125; i < 136; i++) size = size * 256 + h[i] } else size = parseInt(str(124, 12).trim() || '0', 8);
        const type = String.fromCharCode(h[156] || 48), magic = str(257, 6);
        let name = str(0, 100); if (magic.startsWith('ustar')) { const pre = str(345, 155); if (pre) name = pre + '/' + name }
        if (this.longName != null) { name = this.longName; this.longName = null }
        if (this.pax && this.pax.path) { name = this.pax.path } this.pax = null;
        this.left = size; this.pad = (512 - size % 512) % 512;
        if (type === 'L' || type === 'x' || type === 'g' || type === 'K') { this.state = 'meta'; this.meta = { type, chunks: [] } }
        else if (type === '0' || type === '7') { this.cur = this.onFile(name.replace(/^\.\//, ''), size); this.state = 'data' }
        else this.state = 'skip';
        if (this.left === 0) this.finishEntry();
      } else if (this.state === 'pad') {
        if (!this.buf.length) return;
        const n = Math.min(this.pad, this.buf.length); this.buf = this.buf.subarray(n); this.pad -= n; if (this.pad === 0) this.state = 'hdr';
      } else {
        if (!this.buf.length) return;
        const n = Math.min(this.left, this.buf.length), part = this.buf.subarray(0, n); this.buf = this.buf.subarray(n); this.left -= n;
        if (this.state === 'data' && this.cur) this.cur.data(part); else if (this.state === 'meta') this.meta.chunks.push(Buffer.from(part));
        if (this.left === 0) this.finishEntry();
      }
    }
  }
  finishEntry() {
    if (this.state === 'data' && this.cur) { this.cur.end(); this.cur = null }
    if (this.state === 'meta') { const b = Buffer.concat(this.meta.chunks), s = b.toString('utf8');
      if (this.meta.type === 'L') this.longName = s.replace(/\0+$/, '');
      else if (this.meta.type === 'x') { const o = {}; let i = 0; while (i < b.length) { const sp = b.indexOf(32, i); if (sp < 0) break; const len = +b.subarray(i, sp).toString(); const kv = b.subarray(sp + 1, i + len - 1).toString('utf8'); const eq = kv.indexOf('='); o[kv.slice(0, eq)] = kv.slice(eq + 1); i += len } this.pax = o } }
    this.state = this.pad > 0 ? 'pad' : 'hdr';
  }
}
// Lager tar-hoder (GNU, med ././@LongLink for lange navn)
function tarHeader(name, { size = 0, mode = 0o644, mtime = Date.now() / 1000, type = '0', link = '' } = {}) {
  const out = [];
  const hdr = (n, sz, ty, ln) => {
    const h = Buffer.alloc(512);
    h.write(n.slice(0, 100), 0, 'utf8'); h.write((mode & 0o7777).toString(8).padStart(7, '0') + '\0', 100);
    h.write('0000000\0', 108); h.write('0000000\0', 116);
    if (sz > 0o77777777777) { h[124] = 0x80; let v = sz; for (let i = 135; i > 124; i--) { h[i] = v % 256; v = Math.floor(v / 256) } } else h.write(sz.toString(8).padStart(11, '0') + '\0', 124);
    h.write(Math.floor(mtime).toString(8).padStart(11, '0') + '\0', 136); h.write('        ', 148); h.write(ty, 156); h.write(ln.slice(0, 100), 157, 'utf8');
    h.write('ustar  \0', 257); let sum = 0; for (const x of h) sum += x; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148); return h;
  };
  const long = (s, ty) => { const b = Buffer.from(s + '\0', 'utf8'); out.push(hdr('././@LongLink', b.length, ty, ''), b, Buffer.alloc((512 - b.length % 512) % 512)) };
  if (Buffer.byteLength(link) > 100) long(link, 'K');
  if (Buffer.byteLength(name) > 100) long(name, 'L');
  out.push(hdr(name, size, type, link)); return Buffer.concat(out);
}
const tarPad = size => Buffer.alloc((512 - size % 512) % 512);

module.exports = { Store, TarReader, tarHeader, tarPad, BLOCK };
