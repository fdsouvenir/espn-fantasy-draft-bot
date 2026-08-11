# Draftside Companion

Draftside Companion is the small Ubuntu app that connects the ESPN draft room on your laptop to a private Draftside dashboard. It observes draft events only; it cannot queue players, submit picks, or change league settings.

## What using it feels like

1. Install the `.deb` and open **Draftside Companion**.
2. Enter the HTTPS address of your private Draftside dashboard.
3. Draftside opens the dashboard with your desktop's default link handler and opens ESPN Fantasy Football in a dedicated Chrome profile.
4. Sign into ESPN in that Draftside Chrome window and open the draft room.
5. The status window turns **Ready** when picks are flowing.

There is no pairing code, API key, TOML editing, or terminal setup. The dashboard URL is entered on first launch and stored only in the user's owner-only local configuration. The app creates a random device identity in Ubuntu Secret Service and enrolls itself with that private Draftside deployment. The dashboard shows the laptop and provides **Revoke** and **Re-enable** controls.

The status window separately reports the private dashboard, Draftside Chrome, and ESPN draft-room connections. **Private dashboard connected** means enrollment succeeded; **Ready** means the draft-room observer is also attached and can deliver picks.

## Install on Ubuntu 24.04 amd64

```bash
sha256sum -c draftside-companion_0.2.0-1_amd64.deb.sha256
sudo apt install ./draftside-companion_0.2.0-1_amd64.deb
```

Then open **Draftside Companion** from the application grid.

## Recovery behavior

- Chrome reload: the complete ESPN `INIT` board fills anything missed.
- Wi-Fi interruption: local state is retained and replayed after reconnect.
- App restart: the same device identity and checkpoint are reused.
- Revoked laptop: ingestion stops and the status window says **Access revoked**.
- Duplicate events: the backend acknowledges them without double-counting.

Keep the laptop awake, online, and signed into the ESPN draft room during the draft.

## Advanced diagnostics

The CLI remains available for support and development:

```bash
draftside-companion status
draftside-companion preflight
draftside-companion-service restart
journalctl --user -u draftside-companion.service -f
```

The system journal records redacted status transitions without dashboard URLs, device credentials, or ESPN data. Runtime state is owner-only under `~/.local/state/draftside-companion`. The dedicated Chrome profile lives under `~/.local/share/draftside-companion`. Neither location belongs in source control or cloud sync.

## Security model

- The dashboard and device controls remain behind Cloudflare Access.
- The narrow companion registration/ingestion paths accept per-device credentials.
- Each installation generates its own token; only its SHA-256 verifier is stored server-side.
- Event bodies are HMAC-signed with timestamps and unique nonces.
- Revocation is immediate and does not affect ESPN credentials.
- No shared Cloudflare service token, global ingest key, ESPN cookie, or league secret is packaged or committed.

The package contains no deployment URL. The user supplies it at runtime, while access remains protected by Cloudflare Access and the per-device credential.

## Development

```bash
python -m venv .venv
. .venv/bin/activate
pip install -e './companion[dev,keyring]'
pytest companion/tests
ruff check companion/src companion/tests
```

Build the Ubuntu package from the repository root:

```bash
packaging/debian/test-package.sh
```
