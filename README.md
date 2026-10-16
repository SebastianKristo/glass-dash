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

### Unraid-template (uten Portainer)
Kopier `unraid/labdeck.xml` til `/boot/config/plugins/dockerMan/templates-user/` og legg til via
**Docker → Add Container → Template**.

## Data
- `/app/data/config.json` – boards, layout, tema
- `/app/data/secrets.json` – secrets (sendes aldri til nettleseren; vises som `${NAVN}`)

Secrets kan også settes som miljøvariabler (f.eks. `PLEX_TOKEN=...`) for de kjente navnene.

## Merk
Backend-proxyen kan nå alt containeren kan nå i LAN-et ditt. Ikke eksponer port 7575 direkte mot internett
uten autentisering foran (f.eks. Authelia/Cloudflare Access).

Designspesifikasjonen ligger i `DESIGN.md`.
