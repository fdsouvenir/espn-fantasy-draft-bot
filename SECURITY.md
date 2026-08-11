# Security Policy

Draftside observes an authenticated browser session and accepts live draft events, so secure deployment matters even though the application is read-only.

## Supported versions

This project is pre-1.0. Security fixes are applied to the current default branch. Older commits and forks are not supported unless their maintainers say otherwise.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Security → Report a vulnerability** feature for this repository.

Include:

- the affected commit or version;
- impact and realistic attack scenario;
- minimal reproduction steps;
- relevant sanitized logs or requests;
- any suggested mitigation.

Do not include live credentials, browser cookies, authenticated socket URLs, personal data, or private league data. If GitHub private vulnerability reporting is unavailable, open a public issue requesting a private contact channel without disclosing technical details.

Please allow maintainers a reasonable opportunity to investigate and release a fix before public disclosure. Good-faith research that respects privacy, access controls, and the read-only boundary is welcome.

## Deployment expectations

A secure live deployment should:

- protect the dashboard and all device-administration routes with an identity-aware proxy such as Cloudflare Access;
- disable alternate public Worker URLs and preview URLs;
- expose only the bounded companion registration and ingestion routes needed by the app;
- give every companion installation its own revocable device identity;
- require an HMAC signature over every exact ingestion body;
- enforce timestamp windows, nonce replay protection, request-size limits, schema validation, and bounded event counts;
- store device tokens only in the operating system credential store and only token verifiers server-side;
- use sanitized structured logging and avoid raw request bodies;
- keep real draft routes, fixtures, checkpoints, catalogs, and evidence out of the public repository;
- verify anonymous denial and authenticated access before each live draft.

Cloudflare Access protects the human dashboard and device controls. Per-device authentication and HMAC protect the narrow laptop API. Revoking one laptop must not affect browser access or other devices.

## Secret-handling rules

Never place any of the following in Git, command-line arguments, URLs, screenshots, logs, crash reports, dashboard JavaScript, or support bundles:

- ESPN passwords or session cookies;
- authenticated draft socket URLs or security tokens;
- Cloudflare API credentials;
- companion device tokens;
- real environment files;
- private league, owner, or account identifiers.

If a secret is exposed, stop using it, revoke or rotate it, remove it from current artifacts, and review history and logs for additional copies. Rewriting Git history does not make an already published secret safe; rotation is mandatory.

## Browser trust boundary

The companion should attach only to the user-selected draft tab and filter only the expected draft-room network stream. It must not:

- scrape password fields or browser credential stores;
- export cookies to the cloud;
- inspect unrelated tabs;
- send draft-room socket messages;
- click or submit draft actions;
- bypass provider authentication or access controls.

Unexpected message formats or draft identity mismatches must fail closed.

## Public demos

Use the built-in mock mode and synthetic fixtures for public demos. A public repository does not imply that a live draft deployment should be public. Do not expose authenticated snapshots, live league state, real player-data releases whose license does not permit redistribution, or diagnostic evidence from a real session.

## Scope

Particularly valuable reports include:

- authentication or Access bypass;
- HMAC verification or replay-protection flaws;
- Durable Object consistency, idempotency, or conflict-handling failures;
- secret leakage in logs, responses, static assets, checkpoints, or exceptions;
- cross-draft state exposure;
- browser observation escaping the selected draft tab or expected network origin;
- malicious event or catalog input causing unauthorized behavior or resource exhaustion.

Reports that require attacking ESPN, bypassing its controls, accessing another person's account, social engineering, denial of service, or violating applicable law are out of scope.

## Disclaimer

No software is perfectly secure. Operate Draftside as a private decision-support tool, keep a manual fallback, and verify the live board before acting on a recommendation.
