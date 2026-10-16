# glass-dash (Labdeck)

Homelab-dashboard med GUI-editor (fra Claude Design), pakket som én Docker-container.
En liten Node-backend (ingen avhengigheter) serverer dashbordet, lagrer layout og secrets i `/app/data`,
og proxyer alle API-kall (Plex, Sonarr, Radarr, qBittorrent, …) så du slipper CORS-feil og
API-nøkler aldri sendes til nettleseren.

## Installere i Portainer på Unraid

### Alternativ A – bygg direkte fra GitHub (enklest, ingen registry nødvendig)
1. Portainer → **Stacks** → **Add stack** → **Repository**.
2. Repository URL: `https://github.com/sebastiankristo/glass-dash`, reference: `refs/heads/main`
   (eller branchen du vil bruke). Er repoet privat, skru på *Authentication* med et GitHub-token.
3. Compose path: `docker-compose.build.yml`
4. **Deploy the stack**. Åpne `http://<unraid-ip>:7575`.

### Alternativ B – ferdig image fra GHCR
GitHub Actions (`.github/workflows/docker.yml`) bygger og publiserer
`ghcr.io/sebastiankristo/glass-dash:latest` ved push til `main`.
Lim inn innholdet i `docker-compose.yml` i en ny stack i Portainer (Web editor) og deploy.
(Er pakken privat: legg til ghcr.io som registry i Portainer, eller gjør pakken public på GitHub.)

### Unraid (Docker-fanen, uten Portainer)

**Med template (anbefalt):**
1. Last ned templaten til Unraid via terminalen (eller kopier fila manuelt):
   ```
   wget -O /boot/config/plugins/dockerMan/templates-user/my-labdeck.xml \
     https://raw.githubusercontent.com/sebastiankristo/glass-dash/main/unraid/labdeck.xml
   ```
2. **Docker → Add Container → Template:** velg `labdeck`.
3. Fyll inn verdiene (klikk *Show more settings* for alle secrets). Tomme felt kan stå tomme.
4. **Apply**. Åpne via *WebUI* i Docker-fanen.

**Manuelt (Add Container):**
| Felt | Verdi |
|---|---|
| Name | `Labdeck` |
| Repository | `ghcr.io/sebastiankristo/glass-dash:latest` |
| Network Type | `Bridge` (enklest) **eller** `Custom: br0` med egen IP |
| Fixed IP (kun br0) | f.eks. `10.69.1.50` – ledig IP i `10.69.1.0/24` |

Deretter *Add another Path, Port, Variable…*:
- **Path:** Container path `/app/data` → Host path `/mnt/user/appdata/labdeck`
- **Port** (kun Bridge): Container port `7575` → Host port `7575`
- **Variable** for hver secret: Key = navnet (f.eks. `PLEX_TOKEN`), Value = verdien. Se lista i `unraid/labdeck.xml`.

Åpne `http://<unraid-ip>:7575` (Bridge) eller `http://<fast-ip>:7575` (br0).
Med br0 fungerer port-mapping ikke – containeren lytter direkte på 7575 på sin egen IP.

Secrets kan også legges inn senere på **☰ → Secrets** i dashbordet i stedet for som variabler.

**Oppdatere:** Docker-fanen → klikk ikonet → *Force update* (eller *Check for updates*).

## Data
- `/app/data/config.json` – boards, layout, tema
- `/app/data/secrets.json` – secrets (sendes aldri til nettleseren; vises som `${NAVN}`)

Secrets kan også settes som miljøvariabler (f.eks. `PLEX_TOKEN=...`) for de kjente navnene.

## Merk
Backend-proxyen kan nå alt containeren kan nå i LAN-et ditt. Ikke eksponer port 7575 direkte mot internett
uten autentisering foran (f.eks. Authelia/Cloudflare Access).

Designspesifikasjonen ligger i `DESIGN.md`.
