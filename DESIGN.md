# Handoff: Labdeck – selvhostet homelab-dashboard med GUI-editor

## Overview
Labdeck er et homelab-dashboard (inspirert av Glance og Homarr) som kjøres som én Docker-container på Unraid eller Proxmox (LXC). Alt konfigureres i GUI: drag-and-drop av widgets, tjenestekategorier, ikoner, status-sjekk, secrets og tema. Ingen YAML kreves, men widget-opsjonene speiler Glance `custom-api`-oppsettene brukeren har gitt (se «Widgets»).

## About the Design Files
`Homelab Dashboard.dc.html` er en **designreferanse laget i HTML** – en fungerende prototype som viser utseende og oppførsel, ikke produksjonskode. Åpne den i en nettleser (krever `support.js` i samme mappe). Oppgaven er å **gjenskape dette som en ekte app**. Ingen eksisterende kodebase finnes; anbefalt stack:

- **Frontend:** React + TypeScript + Vite (eller SvelteKit). Inline-stilene i prototypen kan oversettes til CSS-variabler + CSS modules/Tailwind.
- **Backend:** Node (Fastify/Hono) eller Go. **Påkrevd** – prototypen henter data direkte fra nettleseren, noe som feiler pga. CORS og lekker tokens. Backend må proxye alle integrasjoner, cache svar og holde secrets server-side.
- **Lagring:** `/app/data/config.json` (layout/boards) + `/app/data/secrets.env` (aldri sendt til klient). SQLite er OK alternativ.
- **Docker:** én image, port `7575`, volum `/app/data`, valgfri read-only `/var/run/docker.sock`.

## Fidelity
**High-fidelity.** Farger, typografi, spacing og interaksjoner er endelige. Gjenskap pikselnært.

## Layout
- Full bredde. Desktop: 3 kolonner `minmax(200px,1fr) minmax(0,2.75fr) minmax(200px,1fr)`, gap 16px, `align-items:start`. Padding 16px, vertikal gap 18px mellom widgets.
- **Skalering:** hele dashbordet skaleres med `zoom = clamp(1, innerWidth/1180, 1.6)` (bredde justeres så det fyller skjermen). Regn ut på nytt ved resize (ResizeObserver).
- **Mobil** (toggle i meny, og bør også trigges < 768px): én kolonne, max-width 420px, rekkefølge: søk → høyre kolonne → resten av midten → venstre.
- Widget = tittel (uppercase, 10.5px, letter-spacing .06em, `--muted`, padding-left 4px) over et kort (`--card`, 1px `--line`, radius 4px, padding 10–14px).

## Header
40px høy bar (`--bg2`, 1px `--line`, radius 4px, padding 0 12px):
- Logo: 14×14 2×2-rutenett (muted/accent).
- Faner (boards): Hjem, Strømstad, Toten, Skole. Aktiv = `--text` + 2px underline `--accent`.
- Høyre: «lagre»-knapp (kun i edit mode), **temavelger** (3 fargeprikker 6×6 radius 1; popover med alle temaer), **hamburgermeny ☰** med: ✎ Rediger, Secrets, Mobil-/Desktopvisning, Docker-oppsett.

## Edit mode
- Banner (dashed accent-kant) med «+ ny seksjon», «+ venstre/midt/høyre» (åpner widgetbibliotek for kolonnen), «reset».
- Widgets: HTML5 drag-and-drop. Dra hvor som helst på widgeten; drop-indikator = 3px accent box-shadow over/under (avhenger av musens y vs. midten). Tomme kolonner tar imot drop (min-height 120px, svak accent-bakgrunn).
- Hver widget har ⠿-håndtak, ⚙ (innstillinger) og ✕ (slett) i tittelraden; dashed outline.
- Tjenester i kategorier kan dras innen og mellom kategorier (drop-indikator inset 2px øverst).
- Klikk på tjeneste i edit mode → panel «Rediger tjeneste» med kun den tjenesten. ⚙ på kategori → hele oppsettet.
- Innstillingspanel: høyre drawer 320px, scroller hele veien, «Ferdig» sticky nederst.
- Widgetbibliotek: høyre drawer med alle widgettyper. Når en widget legges til, opprettes manglende `${VAR}` fra dens default-opsjoner automatisk i Secrets.

## Tjenester (apps-widget)
Felt per tjeneste: `name`, `url`, `icon` (custom data-URL/fil), `status` (`auto` | `up` | `down` | `off`).
- Ikon: `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/{slug}.svg` → fallback `/png/{slug}.png` → fallback initialer på farget rute. Slug = navn lowercase, ikke-alfanumerisk → `-` (med overstyringer, f.eks. HomeAssistant→home-assistant, ESP Home→esphome). Bruker kan laste opp PNG/SVG (lagre som fil i `/app/data/icons/`).
- Status: `auto` = **backend** pinger URL hvert 60s (HTTP-status, latency, timeout 6s → «OK · 31ms», «ERROR», «Timed Out»). `up`/`down` = manuell overstyring. `off` = skjul prikk.
- Prikk: OK = 12px sirkel `--accent` med ✓; feil = rød ⚠ (13px) uten bakgrunn.
- Kategori-opsjon `cols`: auto | 1 | 2 | 3 | 4 (auto = `repeat(auto-fill,minmax(180px,1fr))`).
- Klikk (ikke edit) → åpner URL i ny fane (legg til `http://` om mangler).

## Søk
- Fokus med `S` eller `/`. Live-resultater i dropdown: tjenester (navn/URL, alle boards, viser «url · fane / kategori»), direkte URL/IP, og alltid «Søk etter …» med valgt motor (duckduckgo/google/bing/startpage). Bangs: `!yt !gh !r !w`. ↑↓ Enter Esc. Opsjon «Åpne i ny fane».

## Widgets
Alle med API henter via backend og bruker `${SECRET}`-referanser. Uten secrets → demo-data merket «Demo-data · sett secrets for å koble til». Feil → Glance-stil ERROR-kort (rød header `color-mix(neg 14%, card)`, melding i 9.5px break-all).

| Type | Kilde / endepunkt | Opsjoner |
|---|---|---|
| calendar | Sonarr `/api/v3/calendar?includeSeries=true`, Radarr `/api/v3/calendar` (inCinemas/digitalRelease/physicalRelease) | sonarrUrl/Key, radarrUrl/Key. Måned-nav ‹ ›, dagens dato uthevet, prikker (Sonarr blå `oklch(.72 .12 240)`, Radarr accent). Klikk dag → liste med plakat (34×50, `/api/v3/mediacover/{id}/poster-500.jpg`), tittel, episode/type, tid, «✓ lastet ned». |
| weather | open-meteo geocoding + forecast | location («By, Region, Land» – match admin1/country), units metric/imperial, hour 12h/24h. 12 søyler (hver 2. time), nåværende uthevet m/ temp, dagslys-felt, regnprikker ved >40 %. |
| speed | Speedtest Tracker `/api/v1/results/latest` + `/api/v1/stats` (Bearer) | showPct. Ned/opp Mbps, ping; %-endring vs snitt (ping: lavere = grønt). |
| apps | — | se Tjenester |
| search | — | engine, newTab |
| history | Plex `/status/sessions/history/all`+`/accounts`, Tautulli `get_history`, Jellyfin/Emby `/Users/{id}/Items` | server, url, key, user, length, compact, thumb, showUser. Horisontal karusell 130px kort. |
| nowplaying | Plex `/status/sessions`, Tautulli `get_activity`, Jellyfin/Emby `/Sessions?activeWithinSeconds=30` | server, url, key, compact, playState indicator/text/none, thumb, fullThumb, showPaused, bar, info, hour. «Nothing is playing right now.» |
| releases | Sonarr/Radarr/Lidarr upcoming/recent/missing | service, type, size small/medium/large/huge, collapse, interval (dager). |
| qbit | qBittorrent `/api/v2/transfer/info`, `torrents/info?filter=seeding|downloading` | url (IP:port), view basic/detailed, mode default/upload. Statusikoner ✔ ↓ ❚❚ ! … ⟳ ↑. |
| prowlarr | `/api/v1/indexer` (X-Api-Key) | url (lenke), apiUrl, key, collapse. Privacy-pill + ✓/!. |
| portainer | `/api/endpoints/{id}` (X-API-Key) | url, endpoint, key. Containers/volumes/networks + Running/Healthy/Stopped/Unhealthy. |
| immich | `/api/server/statistics` (x-api-key) | url, key. Photos/Videos/Usage GB. |
| cloudflare | Cloudflare GraphQL Analytics (zone) | requests, bandwidth, visitors, threats 24t + timesøyler (#f38020). |
| dns | AdGuard/Pi-hole stats | spørringer 24t, % blokkert, søyler. |
| server | Docker/Glance-lignende server stats | CPU/RAM/DISK bars. |
| fact | uselessfacts.jsph.pl `/api/v2/facts/random` | cache 3h |
| verse | bible-api.com `/data/web/random` | cache 3h, «Book C:V» + tekst |
| progress | lokal | Day/Month/Year passert, gradient-bar |
| text / error / empty | lokal | fri tekst |

Cache-tider fra Glance-oppsettene: history 5m, releases 30m, speed 1h, nowplaying 5m, qbit 10s, prowlarr 1m, portainer 1h, immich 1d.

## Secrets-side
Egen side (meny → Secrets). Rader: navn (uppercase `A-Z0-9_`, accent), verdi (password-input, vis/skjul), «brukes av: …», slett. «+ legg til secret». Standard: PLEX_URL, PLEX_TOKEN, SONARR_URL/KEY, RADARR_URL/KEY, SPEEDTEST_URL, SPEEDTEST_TRACKER_API_TOKEN, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID, IMMICH_URL, IMMICH_API_KEY, QBITTORRENT_IP, PROWLARR_URL, PROWLARR_API_URL, PROWLARR_KEY, PORTAINER_URL, PORTAINER_ENDPOINT_ID, PORTAINER_API_KEY. Backend erstatter `${NAVN}` server-side; klienten ser aldri verdiene etter lagring (vis maskert).

## Docker-oppsett (modal)
Tabs Unraid / Proxmox med compose:
```yaml
services:
  labdeck:
    image: ghcr.io/labdeck/labdeck:latest
    ports: ["7575:7575"]
    volumes:
      - /mnt/user/appdata/labdeck:/app/data   # Proxmox: ./data
      - /var/run/docker.sock:/var/run/docker.sock:ro
    restart: unless-stopped
```
Lag også Unraid Community Applications-template (XML) og en Proxmox LXC helper-script.

## State / datamodell
```ts
type Board = [Widget[], Widget[], Widget[]];           // venstre, midt, høyre
type Config = { boards: Record<string, Board>; theme: number };
type Widget = { id: string; type: string; title: string; opts?: Record<string, any>;
  apps?: Service[]; text?: string; city?: string };
type Service = { name: string; url: string; icon: string; status: 'auto'|'up'|'down'|'off' };
```
UI-state: editing, page (board|secrets), tab, mobile, selId + selSvc (panel), libCol, theme/menu open, drag (dragW, dropW, svcDrag, svcDrop), calOff/calSel per widget, exp (collapse) per widget, søk (q, qi, qFocus).
Prototypen lagrer i localStorage (`labdeck-v4`, `labdeck-secrets`, `labdeck-theme`) – erstatt med backend-API (`GET/PUT /api/config`, `GET/PUT /api/secrets`, `GET /api/widget/:id/data`, `GET /api/status`).

## Design Tokens
Font: **JetBrains Mono** 400/500/700 overalt. Størrelser: 8–8.5 (labels), 9–9.5 (meta), 10.5–11 (body), 12–13 (verdier/titler), 14 (store tall).
Radius: 3px knapper, 4px kort, 5px app-ikoner (22px), 50% prikker.

Temaer (CSS-variabler):
| var | Amber | Frost | Moss | Rose | Paper |
|---|---|---|---|---|---|
| bg | #141416 | #11141a | #121513 | #161214 | #f4f2ee |
| bg2 | #18181a | #151922 | #161a17 | #1b1619 | #ece9e3 |
| card | #1b1b1e | #181d27 | #191e1a | #1f191c | #fbfaf8 |
| line | #232326 | #222935 | #232a24 | #2a2226 | #e2ded6 |
| line2 | #2a2a2e | #2a3240 | #2b332c | #33292e | #d6d1c7 |
| line3 | #3a3a3e | #3a4456 | #3b453c | #45383e | #c2bcb0 |
| accent | #e8c46a | #7fb2f0 | #9fd08a | #f0a0c0 | #b07a12 |
| text | #e6e4df | #e3e8f0 | #e4ebe2 | #efe4e8 | #1e1d1a |
| text2 | #c9c7c2 | #c3cad6 | #c5cec3 | #d3c5cb | #34322e |
| soft | #a9a7a2 | #a2abba | #a5aea3 | #b3a5ab | #55524c |
| muted | #8a877f | #7f8a9c | #848d82 | #93858b | #6f6b63 |
| dim | #6d6b66 | #636d7e | #687066 | #75686e | #8a867d |
| dim2 | #55544f | #4c5566 | #525950 | #5d5257 | #a6a197 |
| neg | #e0716a | #e57a7a | #e2786e | #ef7d6e | #c2453a |
| stripe1/2 | #1f1f23/#232327 | #1b212c/#1f2531 | #1c221d/#202721 | #231c20/#272024 | #efece6/#e8e4dc |
| hover | #212124 | #1d2330 | #1e241f | #251e22 | #f0ede7 |
Positiv: #7fc98a. Bildeplassholdere: `repeating-linear-gradient(135deg, stripe1 0 6px, stripe2 6px 12px)`.

## Assets
- Ikoner: homarr-labs/dashboard-icons via jsDelivr (+ brukeropplastede).
- Plakater: fra Sonarr/Radarr/Plex/Jellyfin via backend-proxy (ikke eksponer API-nøkler i bilde-URLer).
- Ingen andre bilder.

## Files
- `Homelab Dashboard.dc.html` – hele prototypen (template + logikk i `<script data-dc-script>`). All oppførsel, demo-data og API-mapping står i klassen `Component` (søk etter `load*`-funksjonene for hver integrasjon).
- `support.js` – runtime kun for å kunne åpne prototypen; skal ikke brukes i produksjon.
