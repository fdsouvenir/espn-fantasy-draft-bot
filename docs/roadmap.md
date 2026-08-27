# Roadmap

The repository intentionally separates shipped behavior from future work.

## Shipped

- Read-only draft-room frame observation through local Chrome DevTools Protocol.
- Signed, idempotent ingestion into a SQLite-backed Durable Object.
- Gap, duplicate, conflict, reconnect, and stale-ingestor handling.
- Half-screen War Room organized around Verl-authored role inventory, ESPN-order availability, and
  a focused evidence inspector.
- Atomic, independently signed research publication with versioned profiles, team closure,
  last-known-good retention, audit warnings, and no effect on deterministic ranking scores.
- Live Google Sheet research database with strict shared fields, six position schemas, team
  snapshots, role vocabulary `2026.1`, and an exception-based publication review.
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
