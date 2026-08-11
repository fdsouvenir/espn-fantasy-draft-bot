# Contributing

Thanks for helping improve Draftside. The project values small, reviewable changes; deterministic behavior; and a strict read-only boundary with fantasy platforms.

## Before opening a pull request

1. Open an issue for substantial architecture, provider-transport, data-model, or ranking changes.
2. Keep changes focused. Avoid mixing broad formatting, generated files, and behavior changes.
3. Add or update tests for observable behavior.
4. Run the full local check:

```bash
npm ci
python3 -m pip install -e './companion[dev,keyring]'
npm run check
```

## Development conventions

- TypeScript Worker code lives in `src/`.
- Browser assets live in `web/` and use no framework build step.
- Python ingestion and data tools live in `scripts/`.
- TypeScript tests use Vitest; Python tests use `unittest`.
- Prefer versioned, explicit data contracts at network and persistence boundaries.
- Preserve determinism in ranking and simulation code. Any randomness must be seeded from stable inputs.
- Treat exact duplicates as idempotent and conflicts as hard failures.
- Preserve signed provider identifiers; do not assume a negative player ID is invalid.

## Read-only provider boundary

Contributions must not add features that:

- submit, queue, nominate, claim, drop, trade, or otherwise transact on a fantasy platform;
- change league, team, roster, or draft settings;
- capture passwords, session cookies, authenticated socket URLs, or unrelated browser traffic;
- bypass authentication, authorization, rate limits, CAPTCHAs, or other access controls;
- disguise the project as an official ESPN integration.

If a proposed capability crosses that boundary, discuss it first. It will usually be rejected.

## Fixtures and privacy

External responses, screenshots, and browser traffic are untrusted and frequently private. Before committing a fixture:

- replace league, team, owner, account, draft, and player data with clearly synthetic values unless the player data is legitimately redistributable;
- remove cookies, headers, tokens, socket URLs, query signatures, email addresses, and local filesystem paths;
- preserve only the smallest shape needed to reproduce the behavior;
- verify the file with a text and history search before opening the pull request;
- document the source format without publishing authenticated raw payloads.

Never commit `.env`, `.dev.vars`, checkpoints, evidence logs, production catalogs, credentials, or private draft initializers.

## Ranking changes

A ranking pull request should include:

- the reason for the change;
- the exact features and weights affected;
- deterministic regression tests;
- behavior on missing inputs and low-confidence sources;
- evidence that the change does not turn experimental return estimates into implied guarantees;
- benchmark results if draft-time latency changes materially.

Avoid optimizing a model against one memorable draft room. Prefer documented assumptions and holdout evaluation.

## Security-sensitive changes

Changes to authentication, signatures, replay protection, request bounds, Durable Object transactions, provider observation, credentials, or logging require focused security tests. Do not open a public issue for an unpatched vulnerability; follow [SECURITY.md](SECURITY.md).

## Pull-request checklist

- [ ] The change keeps provider interaction read-only.
- [ ] Tests cover happy paths and failure behavior.
- [ ] `npm run check` passes.
- [ ] New logs and errors contain no secrets or private identifiers.
- [ ] Fixtures and screenshots are sanitized.
- [ ] Documentation describes limitations accurately.
- [ ] No generated credentials or environment-specific endpoints are included.

By contributing, you agree that your contribution is licensed under the repository's [MIT License](LICENSE).
