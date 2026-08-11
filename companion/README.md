# Draftside Companion

Draftside Companion is the small Ubuntu app that connects the ESPN draft room on your laptop to a private Draftside dashboard. It observes draft events only; it cannot queue players, submit picks, or change league settings.

## What using it feels like

1. Install the `.deb` and open **Draftside Companion**.
2. Draftside opens its private dashboard and the ESPN draft room in a dedicated Chrome profile.
3. Sign into ESPN normally if Chrome asks.
4. The status window turns **Ready** when picks are flowing.

There is no pairing code, configuration editor, API key, TOML file, or terminal workflow. On first launch the app creates a random device identity in Ubuntu Secret Service and enrolls itself with the configured private Draftside deployment. The dashboard shows the laptop and provides **Revoke** and **Re-enable** controls.

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
journalctl --user -u draftside-companion.service
```

Runtime state is owner-only under `~/.local/state/draftside-companion`. The dedicated Chrome profile lives under `~/.local/share/draftside-companion`. Neither location belongs in source control or cloud sync.

## Security model

- The dashboard and device controls remain behind Cloudflare Access.
- The narrow companion registration/ingestion paths accept per-device credentials.
- Each installation generates its own token; only its SHA-256 verifier is stored server-side.
- Event bodies are HMAC-signed with timestamps and unique nonces.
- Revocation is immediate and does not affect ESPN credentials.
- No shared Cloudflare service token, global ingest key, ESPN cookie, or league secret is packaged or committed.

The endpoint URL is intentionally not treated as a secret. This is a personal fantasy-football tool, not a general-purpose identity platform.

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

Release maintainers can bake in their deployment's non-secret endpoint with
`DRAFTSIDE_DASHBOARD_URL=https://draftside.example.com packaging/debian/build-deb.sh`.
