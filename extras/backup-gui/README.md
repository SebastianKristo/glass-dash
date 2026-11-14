# Hytte Backup

Web-GUI for backup fra Unraid (eller en annen SSH-vert) til en ZFS-mappe på Proxmox.
Backup-containeren *henter* filene med rsync over SSH, så Unraid trenger bare en SSH-nøkkel.

- Velg mapper på Unraid i en mappevelger, ingen stier å skrive
- Daglig, ukentlig, hver time eller manuelt
- Live fremdrift, stopp/fortsett, historikk og logg per kjøring
- Unntak (Immich: `thumbs/` og `encoded-video/` legges til automatisk)
- Speiling av slettinger, båndbreddegrense
- Viser ledig plass og ZFS-snapshots (sanoid på verten)
- Passordbeskyttet, ingen avhengigheter (Node + rsync + ssh)

## Installere

På Proxmox-verten (CT 103 = backup-containeren med `/mnt/unraid` montert):

```bash
CTID=103 bash -c "$(curl -fsSL https://raw.githubusercontent.com/SebastianKristo/glass-dash/backup-gui/extras/backup-gui/install.sh)"
```

Åpne `http://<CT-IP>:8090`, velg passord, og følg stegene under **Innstillinger**.
Oppdatere: `pct exec 103 -- update-backup-gui`.
