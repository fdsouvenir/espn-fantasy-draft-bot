# Draftside

### A read-only, real-time fantasy football draft copilot

Draftside observes an ESPN fantasy football draft, reconstructs the board in a strongly consistent Cloudflare Durable Object, and serves explainable, roster-aware recommendations through a responsive web dashboard.

It is deliberately a **copilot, not an autopilot**: Draftside never submits a pick, edits a queue, or changes league settings.

![Draftside's live decision desk showing recommendations, player tiers, and roster needs](docs/images/dashboard.png)

> **Project status:** the cloud application, cross-platform CLI, and reproducible Ubuntu 24.04 amd64 `.deb` are implemented. The package still requires private draft enrollment and rehearsal on the actual laptop; see [Laptop Companion](docs/laptop-companion.md).

## Why this exists

Most draft tools start with a static rankings list and gradually become wrong as the room moves. Draftside instead treats the live draft as a state-coordination problem:

- ingest selections from the draft room through a low-latency live path;
- keep one authoritative, replayable board;
- update every roster and the available-player pool atomically;
- rank the next decision using the actual roster, tier landscape, roles, workload, and market cost;
- stop giving advice when the source is stale, incomplete, or conflicted.

## What it does

- **Read-only browser observation.** A local companion attaches to an already-signed-in Chrome draft tab and observes the draft room's network events. It does not read passwords, submit ESPN commands, or automate selections.
- **Resilient live ingestion.** Live selection events provide the fast path; the draft room's initialization state provides a complete board after reconnects.
- **Strongly consistent state.** One SQLite-backed Cloudflare Durable Object owns each draft's picks, rosters, availability, health, and recommendations.
- **Deterministic recommendations.** The same versioned catalog and draft state always produce the same ranking, including explainable roster need, tier, role, workload, injury, and value signals.
- **Fail-closed guidance.** Gaps, conflicts, stale ingestion, and unknown players suppress recommendations instead of producing confident nonsense.
- **Designed for private operation.** The dashboard remains behind Cloudflare Access. The laptop auto-enrolls with a revocable per-device identity and signs every ingestion request.
- **Responsive dashboard.** The live board, best available players, roster needs, health, and experimental return estimates work across desktop and mobile layouts.

## How it fits together

```mermaid
flowchart LR
    ESPN[ESPN draft room<br/>signed-in Chrome tab]
    Companion[Laptop companion<br/>read-only observer]
    Access[Cloudflare Access<br/>service identity]
    Worker[Cloudflare Worker<br/>validation + API + UI]
    DO[SQLite Durable Object<br/>one per draft]
    Browser[Private dashboard]

    ESPN -->|live selections + reconnect state| Companion
    Companion -->|revocable device identity + signed events| Worker
    Access --> Worker
    Worker --> DO
    DO -->|snapshot + revision notifications| Browser
```

The dashboard's WebSocket is a notification channel, not the database. Clients fetch a complete authoritative snapshot on first load and after reconnecting.

Read the detailed [architecture](docs/architecture.md) and [laptop companion design](docs/laptop-companion.md).

## Proven behavior

A controlled, disposable 64-pick draft validated the end-to-end path:

- 19 consecutive selections reached committed cloud state through the live path with an observed frame-receipt-to-commit p95 and maximum latency of **739 ms**;
- after a deliberate browser reload, the complete **64/64** board was recovered from reconnect state in **164 ms**;
- all selections were reconciled with zero gaps or conflicts, including defense/special-teams entries that use signed negative ESPN IDs.

These figures describe one controlled validation run, not a general ESPN service-level guarantee. Browser, network, and upstream behavior can vary.

## Ranking philosophy

Draftside does not ask only, “Who has the highest projection?” Its deterministic scoring model combines:

- value over replacement and projection;
- current role, expected workload, and role certainty;
- tier scarcity and market value;
- injury and environment adjustments;
- roster construction, starting requirements, and position needs;
- contingent upside;
- deterministic simulations estimating whether a player may survive to the user's next pick.

Every recommendation carries reasons. “Likely to return” values are explicitly **experimental urgency estimates**, not calibrated probabilities or guarantees.

## Local development

### Requirements

- Node.js 20 or newer
- npm
- Python 3.11 or newer
- [`websocket-client`](https://pypi.org/project/websocket-client/) for the browser-ingestion scripts
- A Cloudflare account only if you want to deploy the Worker

### Install and verify

```bash
npm ci
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m pip install -e './companion[dev,keyring]'
npm run check
python -m pytest companion/tests
```

`npm run check` generates Worker bindings, type-checks, lints, runs the Worker and data-pipeline suites, checks browser JavaScript syntax, and performs a Cloudflare deployment dry run. The final command separately verifies the installable laptop companion.

Windows installation and draft-night commands are documented in the [companion guide](companion/README.md).

### Run locally

```bash
npm run dev -- --port 8787
```

Open <http://localhost:8787/?mock=1> for a sanitized dashboard fixture. Mock mode contains no real league data or credentials.

Useful focused commands:

```bash
npm test                 # TypeScript / Worker tests
npm run test:python      # Python ingestion and data-pipeline tests
npm run typecheck
npm run lint
```

## Repository map

```text
src/       Worker routes, validation, security, ranking, Durable Object state
web/       Responsive dashboard
companion/ Installable laptop agent, CLI, browser observer, and secure delivery
packaging/ Reproducible Ubuntu package, desktop launcher, and user service
scripts/   Catalog, draft initialization, ingestion, and recovery tools
tests/     Worker integration, ranking, validation, and Python pipeline tests
docs/      Architecture and companion design
```

## Repository and deployment boundary

Draftside uses one source repository for development and releases. Production does **not** need a second repository: a deployment is a private, configured instance of this code, not a separate codebase.

The repository may be public; the deployed application and real draft data must remain access-controlled.

- Use `?mock=1` or sanitized fixtures for screenshots, demos, and portfolio material.
- Keep real league IDs, team names, draft keys, catalog releases, evidence files, checkpoints, and source payloads out of Git.
- Never expose ESPN cookies, device tokens, shared operator credentials, authenticated socket details, or environment files.
- Supply environment-specific routes, Access policy, secrets, and real draft initializers through private deployment configuration—not a second production repository.
- Keep every deployed draft route behind an identity-aware access policy and disable alternate public Worker URLs.
- Do not use the project to automate drafting or bypass access controls.

See [SECURITY.md](SECURITY.md) before deploying or publishing a fork.

## Operational caveats

- ESPN's draft-room transport is undocumented and may change without notice.
- The companion laptop must remain awake and online during the draft; reconnect state recovers missed selections after an interruption.
- Use one ESPN draft-room session on the drafting laptop rather than depending on concurrent sessions for the same manager.
- Keep a manual board-update fallback and verify the live board before acting on recommendations.
- Return estimates are decision-support signals, not calibrated guarantees.

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), especially the fixture-sanitization and read-only rules.

## License and affiliation

Released under the [MIT License](LICENSE).

This is an independent, unofficial project. It is not affiliated with, endorsed by, or sponsored by ESPN, Disney, the NFL, or any fantasy sports platform. ESPN and related marks are trademarks of their respective owners.
