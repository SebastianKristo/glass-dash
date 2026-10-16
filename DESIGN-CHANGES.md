# Prompt til Claude Code – endringer siden første handoff

Prototypen `Homelab Dashboard.dc.html` i denne mappen er oppdatert og er fasit. Implementer følgende endringer i tillegg til README.md. All henting skal gå via backend (CORS + secrets server-side).

## 1. Favicon
- Bruk `favicon.svg` (2×2-rutelogo: muted/accent på #141416, radius 7). `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`, `<title>Labdeck</title>`.

## 2. Weather – hover
- Hover over en time-søyle: søylen uthevet (samme gradient som nåværende time), temperatur vises over søylen, klokkeslett under.
- Bunnlinjen bytter fra «⌖ Sted» til «14:00 · 7° · 60% nedbør» (nedbør kun hvis > 0). Mouseleave → tilbake til nåværende time.

## 3. Server stats – ekte data
- Opsjoner: `source` (glances | proxmox), `url` (default `${GLANCES_URL}`), `key` (Proxmox-token `user@pam!id=secret`), `node` (default `pve`), `name` (visningsnavn), `disk` (Glances mountpoint, default `/`).
- Glances: `/api/4/{quicklook,mem,fs,uptime,load}` (fallback `/api/3/`). CPU = quicklook.cpu, RAM = mem.percent/used/total, Disk = fs-entry med valgt mnt_point, uptime parses fra string.
- Proxmox: `GET /api2/json/nodes/{node}/status` med header `Authorization: PVEAPIToken=<token>`. cpu*100, memory, rootfs, uptime, cpuinfo.cpus.
- UI: navn + statusprikk (grønn ok / rød feil), «13d 4h uptime», 3 søyler CPU/RAM/DISK med `grid-template-columns: repeat(3, minmax(0,1fr))` og `min-width:0` (ikke overflow i 200px-kolonne). Søylefarge: >90 % neg, >75 % accent, ellers #55565c. Undertekst kort: «16 cores», «39/64 GB», «18.4/24 TB» (ellipsis). Full verdi i tooltip.
- Oppdater hvert 15. sekund uten å blinke «Laster…» (behold forrige verdi mens ny hentes).
- Nye secrets: GLANCES_URL, PROXMOX_URL, PROXMOX_TOKEN.

## 4. Kalender – light mode fix
- Dagens dato bruker `var(--line)` som bakgrunn (ikke hardkodet mørk farge). Valgt dag `var(--line2)`. Sjekk at ingen widget har hardkodede mørke farger – alt via tema-variabler.

## 5. DNS stats (ny widget, erstatter ERROR-kortet «DNS stats»)
- Opsjoner: `service` (adguard | pihole), `url` `${DNS_URL}`, `user` `${DNS_USER}`, `key` `${DNS_PASSWORD}`, `top` (vis top blocked, bool).
- AdGuard Home: `GET /control/stats` med Basic auth. `num_dns_queries`, `num_blocked_filtering`, `avg_processing_time` (s → ms), `dns_queries[]` + `blocked_filtering[]` (24 timer), `top_blocked_domains`.
- Pi-hole v6: `POST /api/auth {password}` → `session.sid`; så `/api/stats/summary`, `/api/history` (summer 10-min bøtter til 24 timer), `/api/stats/top_domains?blocked=true&count=5` med header `sid`. Cache sid server-side.
- UI: tre tall (QUERIES, BLOCKED % i neg-farge, LATENCY – Pi-hole: BLOCKED #). 24 stablede søyler (totalt `--line2`, blokkert-andel neg 70 %). Hover på søyle: uthev + bunnlinje «14:00 · 1.2k spørringer · 180 blokkert». Under: «TOP BLOCKED» med 5 domener + antall.
- Migrer eksisterende widget `type:error, title:"DNS stats"` → `type:dns`.

## 6. Søk – velg søkemotor
- Søkemotor velges i **hamburgermenyen ☰** (nederst, egen rad «Søkemotor» med select: Google, DuckDuckGo, Bing, Startpage). **Ikke** i søkefeltet.
- Valget lagres globalt (brukerinnstilling) og overstyrer widgetens `engine`-opsjon. Klikk i select skal ikke lukke menyen.

## 7. Secrets – navigasjon og lagring
- Klikk på en fane eller på logoen fra secrets-siden → tilbake til dashbordet. Logo går alltid til fanen «Hjem».
- Secrets redigeres i et **utkast**. Ingenting lagres før «lagre». Header på siden: `SECRETS` … statustekst («Ulagrede endringer» / «Lagret ✓» i 2 s) … `lukk` (forkaster utkast, går til dashbordet) … `lagre` (accent-knapp, `PUT /api/secrets`).
- Forlater man siden via fane/logo forkastes utkastet. Valgfritt: bekreftelsesdialog hvis ulagrede endringer.
- Når en widget legges til fra biblioteket, opprettes manglende `${VAR}` umiddelbart i secrets (tom verdi), som før.

## 8. Øvrig fra tidligere runder (sjekk at det er med)
- qBittorrent-widget (basic/detailed, default/upload), Prowlarr indexers (privacy-pill, collapse), Portainer, Immich, Cloudflare, Random fact/verse, kategori-kolonner (auto/1–4), «Rediger tjeneste»-panel for én tjeneste, scrollbart innstillingspanel med sticky «Ferdig», plakat i kalender-dagliste.

## Akseptkriterier
- Alle widgets fungerer i alle 5 temaer (Amber, Frost, Moss, Rose, Paper) uten hardkodede farger.
- Ingen secrets i nettleseren etter lagring (maskert visning, backend erstatter `${...}`).
- Ingen layout-overflow i sidekolonner på 200px.


## Minecraft Java server-widget (type: `minecraft`)

**Secret:** `MINECRAFT_HOST` (host eller host:port, default port 25565).
**Opts:** `url` (default `${MINECRAFT_HOST}`), `name` (visningsnavn, tom = host), `players` (bool, vis spillerliste).
**Viser:** server-ikon (favicon fra status), navn, MOTD, ONLINE/OFFLINE-prikk, spillere nå/maks + progressbar, versjon, spillerliste med hoder (`https://mc-heads.net/avatar/<navn>/16`).
**Demo:** vises når MINECRAFT_HOST er tom.

### Backend (må implementeres)
Prototypen bruker `https://api.mcsrvstat.us/3/<host>`, som ikke når servere på LAN. I Docker: backend-endepunkt `GET /api/widgets/minecraft?host=...` som pinger serveren direkte med Minecraft Server List Ping (TCP, handshake + status-request, protokoll -1). Node: f.eks. `minecraft-server-util` (`status(host, port, {timeout:5000})`). Håndter SRV-oppslag (`_minecraft._tcp.<host>`). Cache 30–60 s.

Respons (det frontend forventer):
```json
{"host":"mc.example.no","online":true,"now":3,"max":20,"version":"Paper 1.21.4","motd":"A Minecraft Server","icon":"data:image/png;base64,...","list":["sebastiankristo","Notch"]}
```
Offline/timeout → `{"host":"...","online":false,"now":0,"max":0,"version":"—","motd":"","icon":"","list":[]}` (ikke feil).

### Referanse-backend (Node/Express)
```js
import { status } from 'minecraft-server-util';
const cache = new Map();
app.get('/api/widgets/minecraft', async (req, res) => {
  const raw = (req.query.host || process.env.MINECRAFT_HOST || '').replace(/^\w+:\/\//, '');
  const [host, p] = raw.split(':'); const port = +p || 25565;
  const hit = cache.get(raw); if (hit && Date.now() - hit.t < 30000) return res.json(hit.v);
  let v;
  try {
    const s = await status(host, port, { timeout: 5000, enableSRV: true });
    v = { host: raw, online: true, now: s.players.online, max: s.players.max, version: s.version.name,
      motd: s.motd.clean.replace(/\n/g, ' · '), icon: s.favicon || '', list: (s.players.sample || []).map(x => x.name) };
  } catch { v = { host: raw, online: false, now: 0, max: 0, version: '—', motd: '', icon: '', list: [] }; }
  cache.set(raw, { t: Date.now(), v }); res.json(v);
});
```
Merk: `players.sample` er maks ~12 navn og kan være tom hvis serveren skjuler den.

### Frontend-loader (bytt i produksjon)
```js
async function loadMc(o){ const r = await fetch('/api/widgets/minecraft?host=' + encodeURIComponent(o.url)); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }
```
Template-blokk: `<sc-if value="{{w.isMinecraft}}">` i Homelab Dashboard.dc.html; formattering i `fmtData` (`w.type==='minecraft'`).
