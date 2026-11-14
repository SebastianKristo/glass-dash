# Hytte 3

Selvhostet backup over Tailscale. Hytte henter filer fra nodene dine over SSH, lagrer dem som
zstd-komprimerte og deduplisert 4 MiB-blokker, og lar deg bla i og gjenopprette fra hvert snapshot
uten å pakke ut arkivet.

- **Oversikt & Noder:** tailnet-topologi fra `tailscale status` med ping og direkte/DERP, jobber med plan, nivå, original/lagret/spart og status
- **Backupsteder & Synk:** dette backupstedet, kapasitet og koordineringslogg (live via SSE)
- **Komprimert Filutforsker:** arkiver per jobb, snapshots, filtre, forhåndsvisning, nedlasting og gjenoppretting til valgfri node
- Endrede filer hentes som én tar-strøm over SSH. Uendrede filer gjenbrukes fra forrige snapshot
- Oppbevaring 7/30/90/365 dager, opprydding frigjør blokker ingen snapshot bruker
- Verifisering med sjekksummer, varsler via Unraid
- Ingen avhengigheter: Node 22.15+ (zstd i zlib), ssh, tar, tailscale (valgfritt)

## Installere

På Proxmox-verten (CT 103 = backup-containeren med `/mnt/unraid` montert):

```bash
CTID=103 bash -c "$(curl -fsSL https://raw.githubusercontent.com/SebastianKristo/glass-dash/backup-gui/extras/backup-gui/install.sh)"
```

Åpne `http://<CT-IP>:8090`, velg passord, kopier SSH-nøkkelen fra Innstillinger (tannhjulet nede til venstre)
og legg den inn på nodene du vil ta backup av.

## Lagring

`DEST_ROOT/.hytte-store/blocks/xx/<sha256>`: komprimerte blokker. `snaps/<jobb>/<id>.json.zst`: manifester.

## Neste versjon

Flere backupsteder med leder, kvorum og replikering mellom seg (Backupsteder & Synk).
