# Roadmap

The repository intentionally separates shipped behavior from future work.

## Shipped

- Read-only draft-room frame observation through local Chrome DevTools Protocol.
- Signed, idempotent ingestion into a SQLite-backed Durable Object.
- Gap, duplicate, conflict, reconnect, and stale-ingestor handling.
- Responsive dashboard with deterministic recommendations and explicit health state.
- Frozen catalog and reviewed editorial-release tooling.
- Cross-platform laptop companion that shares the user's existing draft-room session.

## Next

- Historical calibration and Brier-score reporting for return estimates.
- One-click signed installers for Windows and macOS.
- Rehearsal tooling that verifies the exact laptop, browser, and network setup.
- Optional application-level authorization in addition to Cloudflare Access.
- A synthetic public demo deployment with no live league data.

## Deliberately out of scope

- Automated drafting or queue manipulation.
- League-setting mutations.
- Distribution of provider-owned player datasets, logos, projections, or raw protocol captures.
- Support for salary-cap drafts in the first release.
