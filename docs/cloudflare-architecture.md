# Cloudflare architecture and test plan

Status: implemented reference architecture  
Reviewed: 2026-08-11

## Decision

Build one TypeScript Cloudflare Worker with static assets and one SQLite-backed Durable Object class, `DraftSession`, instantiated once per draft. Put the only deployed hostname behind Cloudflare Access and disable the `workers.dev` route. The local ESPN ingestor reaches the same hostname with an Access service token and signs each bounded JSON body with a separate HMAC key. Browser clients use Access's normal interactive identity policy.

For the first live proof, do **not** add D1, R2, KV, Queues, Workflows, Pages, Agents SDK, Workers AI, Analytics Engine, or a second Worker. None solves a current coordination or reliability problem:

- Durable Object SQLite is the authoritative draft event store and live state.
- Worker static assets are sufficient for the dashboard.
- WebSocket hibernation provides live fan-out without a separate realtime product.
- The ingestor already owns ESPN polling and retries; a Cloudflare Queue would merely add delay and another at-least-once boundary.

Add D1 only when the versioned player/scouting/ADP import is implemented. D1 is justified then as a shared catalog across drafts, not as live draft state. At draft initialization, copy the selected immutable catalog snapshot needed for recommendations into the draft's Durable Object so that a live recommendation never depends on a cross-product read or a mutable Sheet. R2 is not needed unless sanitized replay files outgrow the repository or D1; that is not expected for staging.

This design is intentionally smaller than the earlier Worker + DO + D1 + R2 description while preserving its useful boundary: ESPN credentials and polling remain local; Cloudflare receives only normalized, signed draft events.

## Request flow

```text
Local ESPN ingestor
  -> Access service-token check
  -> Worker HMAC/timestamp/body validation
  -> DraftSession RPC
  -> SQLite transaction: nonce + events + derived state
  -> WebSocket broadcast after commit

Access-authenticated browser
  -> Worker API or static assets
  -> DraftSession snapshot/health RPC
  -> DraftSession WebSocket upgrade
```

The WebSocket is a notification channel, not the source of truth. A client fetches a complete snapshot on initial load and after every reconnect. Every message contains the new `revision`; if a client sees a gap, it discards incremental assumptions and refetches the snapshot.

## Resource layout

### Worker

One ES-module Worker owns:

- request routing, bounded JSON parsing, schema validation, HMAC verification, and security headers;
- Access-protected HTTP and WebSocket entry points;
- deterministic routing to `env.DRAFT_SESSION.getByName(draftKey)`;
- static dashboard assets through the `ASSETS` binding;
- structured request logging and safe error mapping.

Use `wrangler.jsonc`, a current compatibility date at implementation time, a SQLite Durable Object migration, generated binding types from `wrangler types`, and Workers observability. Enable `nodejs_compat` only if an actual selected dependency needs it; Web Crypto, JSON, static assets, RPC, and the DO APIs do not require Node compatibility by themselves.

The Worker must not call Cloudflare REST APIs at runtime. It uses bindings only. It holds no mutable request state at module scope. Every promise is awaited, returned, or explicitly passed to `ctx.waitUntil()`.

### Durable Object identity

Use one coordination atom per draft:

```text
draftKey = "<environment>:<provider>:<season>:<leagueId>:<draftId>"
stub = env.DRAFT_SESSION.getByName(draftKey)
```

`draftId` must be the stable ESPN draft identifier when present. If the live endpoint does not expose one, use an explicit configured draft epoch/version rather than league ID alone, so a reset or later season cannot collide with old state.

Do not create a global Durable Object. A draft's picks, rosters, recommendation state, revision, replay protection, and sockets require mutual coordination with one another and belong together.

### Durable Object API

Use typed RPC for state operations (compatibility date newer than 2024-04-03):

- `initializeDraft(config, pinnedCatalog): InitResult`
- `ingestBatch(envelope, verifiedAuth): IngestAck`
- `recordManualPick(command, actor): IngestAck`
- `getSnapshot(): DraftSnapshot`
- `getHealth(): DraftHealth`

Use the DO `fetch()` handler only for the WebSocket upgrade because the Hibernation API is request/response based. The outer Worker authenticates and validates the request before forwarding it. The DO is never directly exposed by a public route.

Initialize/migrate SQLite in the constructor with `ctx.blockConcurrencyWhile()`. Never hold that gate across external I/O or normal request handling. Public RPC methods validate inputs again at the trust boundary.

### Durable Object storage

Minimum tables:

- `_sql_schema_migrations(id, applied_at)`
- `draft_meta(draft_key, schema_version, revision, status, initialized_at, updated_at, pinned_catalog_version, expected_teams, expected_rounds)`
- `picks(event_id PRIMARY KEY, overall_pick UNIQUE, round, round_pick, team_id, player_id, source, provider_observed_at, ingestor_observed_at, received_at, payload_hash)`
- `teams(team_id PRIMARY KEY, slot, display_name)`
- `roster_slots(team_id, player_id, overall_pick, PRIMARY KEY(team_id, player_id))`
- `seen_nonces(nonce PRIMARY KEY, seen_at)`
- `catalog_players(player_id PRIMARY KEY, position, nfl_team, bye_week, tier, adp, ranking_payload_json)`
- `manual_audit(command_id PRIMARY KEY, actor_id, action, created_at, payload_hash)`

The exact ranking payload can evolve behind a versioned schema, but the pinned snapshot version cannot change during a live draft. Store only fields required by the deterministic ranking engine; do not copy arbitrary Sheet cells.

Within `ingestBatch`, use synchronous DO SQLite statements without an `await` between related writes:

1. reject an already-seen nonce;
2. validate draft identity and event ordering;
3. insert the nonce and each event using unique constraints;
4. distinguish an exact duplicate from a conflicting duplicate using the stable pick identity fields (draft, overall pick, team, and player), not observation timestamps;
5. update roster/availability and recompute deterministic recommendations;
6. increment `revision` once for the committed batch;
7. commit before updating any in-memory cache or broadcasting.

An exact replay is an idempotent success and is counted as `deduped`. Reuse of an overall-pick number with a different player or team is a `409 conflict`, is logged without the payload, and changes no state. Accept a valid internally ordered batch even if it reveals an earlier gap, but set `health.hasGap=true`, return the missing numbers, and suppress recommendations that assume a complete board until backfill closes the gap. The ingestor must immediately backfill and must never silently renumber events. A conflict makes the whole batch fail atomically.

`seen_nonces` can be pruned after 24 hours during a normal ingest transaction. No DO alarm is required for staging.

### WebSockets

Use the Durable Objects WebSocket Hibernation API (`ctx.acceptWebSocket`, `getWebSockets`, and `webSocketMessage`/`webSocketClose`) rather than standard in-memory WebSockets. This allows the DO to hibernate while clients remain connected.

On connection:

- verify the outer Worker has authenticated the upgrade;
- accept the socket and attach only non-sensitive metadata such as client ID and connected revision;
- immediately send a `snapshot_required` message containing the current revision.

After a committed change, broadcast a small envelope:

```json
{
  "type": "draft.updated",
  "draftKey": "staging:espn:2026:123456789:<draft-id>",
  "revision": 42,
  "lastOverallPick": 17,
  "changed": ["picks", "availability", "recommendations"],
  "serverTime": "2026-08-11T12:00:00.000Z"
}
```

Do not broadcast full catalogs or trust client-provided state. Failed socket sends are isolated and the stale socket is closed; they cannot roll back a committed pick.

## Data contracts

### Normalized pick event

Lock this interface before parallel implementation:

```ts
type DraftPickEventV1 = {
  schemaVersion: 1;
  eventId: string;            // deterministic across retries
  overallPick: number;        // positive, 1-based
  round: number;
  roundPick: number;
  teamId: string;
  playerId: string;
  source: "espn" | "manual";
  providerObservedAt: string | null;
  ingestorObservedAt: string;
};
```

For ESPN events, derive `eventId` deterministically from provider, draft key, overall pick, team ID, and player ID. Never use a random retry ID as the idempotency key.

### Ingest envelope

```ts
type IngestBatchV1 = {
  schemaVersion: 1;
  draftKey: string;
  ingestorInstanceId: string;
  capturedAt: string;
  cursor: { lastOverallPick: number };
  events: DraftPickEventV1[]; // bounded to 100 events / 256 KiB body
};
```

Success response:

```ts
type IngestAck = {
  revision: number;
  accepted: number;
  deduped: number;
  lastOverallPick: number;
  missingOverallPicks: number[];
  serverTime: string;
};
```

Reject unknown schema versions. Validate IDs, timestamps, event count, body size, integer ranges, and that the path draft ID matches the envelope draft key before calling the DO.

## HTTP surface

All routes are under the Access-protected staging hostname. Responses use `Cache-Control: no-store` unless explicitly listed.

- `GET /healthz` — process health only; returns build/version, no league or draft data.
- `GET /api/v1/drafts/:draftKey/snapshot` — authoritative state, current recommendations, pinned catalog version, and health summary.
- `GET /api/v1/drafts/:draftKey/health` — last ingest time, last overall pick, missing picks, duplicate/conflict counters, revision, build version, and connection count.
- `GET /api/v1/drafts/:draftKey/ws` — authenticated WebSocket upgrade forwarded to the named DO.
- `POST /api/v1/drafts/:draftKey/ingest` — Access service token plus valid HMAC; accepts `IngestBatchV1`.
- `POST /api/v1/drafts/:draftKey/manual-picks` — interactive Access user only; audited manual fallback command. Do not expose this until actor identity is reliably available and tested.
- `POST /api/v1/catalog-snapshots` — deferred D1-backed admin import; interactive Access admin only, immutable version creation.

No permissive CORS. The dashboard uses same-origin requests. Reject unsupported methods with `405` and an `Allow` header. Use generic public errors plus a request ID; never return stack traces, signatures, secret names, SQL, or raw upstream data.

The ingest route accepts only `source="espn"`. The manual route creates `source="manual"` server-side after interactive authorization; clients cannot select their own trust source.

Static files are served through the Worker `ASSETS` binding after API routing. Use an SPA fallback only for dashboard navigation routes, never for `/api/*` or unknown asset paths.

## Authentication and ingestion integrity

### Cloudflare Access

Create one self-hosted Access application for the staging hostname:

- interactive allow policy restricted to approved operator identities;
- service-token allow policy for the ingestor;
- no public bypass policy;
- `workers_dev = false` and no alternate unprotected route.

The service-token client ID and secret stay in the local operator vault and are sent in Cloudflare's service-token headers. They never enter browser code, source, fixtures, or logs. Access protects the hostname; the Worker does not need to reimplement interactive login for staging.

Before acceptance, verify both the intended browser identity and the ingestor service token, and verify anonymous requests fail. Also inspect all configured routes so Access cannot be bypassed through a default Worker URL.

### HMAC

HMAC protects the application message independently of the Access credential. Store the HMAC key as a Worker secret and a local vault reference; use different values for local tests and staging.

Required headers:

- `X-Draft-Timestamp`: Unix seconds
- `X-Draft-Nonce`: UUID
- `X-Draft-Signature`: `v1=<lowercase hex HMAC-SHA256>`

Canonical bytes:

```text
<timestamp>\n<nonce>\n<UPPERCASE_METHOD>\n<pathname>\n<lowercase_hex_sha256_of_exact_body_bytes>
```

Verify against the raw bounded body bytes before JSON parsing. Require a timestamp within 60 seconds of Worker time, reject missing/invalid headers, and compare signatures with a timing-safe primitive. After cryptographic verification, let the DO atomically claim the nonce and apply the batch. This avoids a race between separate replay-check and event-write operations. The ingestor generates a fresh nonce and signature for each HTTP attempt; if an acknowledgement is lost, it retries the same event IDs under a new nonce and receives an idempotent event-level acknowledgement.

Key rotation uses two secret bindings temporarily (`INGEST_HMAC_CURRENT` and `INGEST_HMAC_PREVIOUS`) and an explicit key ID header. Stop accepting the previous key after the ingestor has switched. Never log signatures, Access headers, HMAC material, cookies, or raw request bodies.

Access authentication without HMAC is insufficient because a leaked service token could submit arbitrary picks. HMAC without Access would leave the public endpoint exposed to unauthenticated load. Both are proportionate for private staging and operationally simple.

## D1 and R2 decision

### D1: deferred but planned

D1 becomes useful for immutable, versioned shared data:

- `catalog_snapshots(version, created_at, source_hash, schema_version, status)`
- `players(snapshot_version, player_id, name, position, nfl_team, bye_week, ...)`
- `rank_inputs(snapshot_version, player_id, tier, role, workload, contingent_upside, adp, confidence, source_date, ...)`

The Google Sheet is editorial input, never a live dependency. Import validates the entire snapshot and creates a new immutable version. Draft initialization pins one version and copies the required rows into the DO. Updates create a new version; they do not mutate the active draft's catalog.

Do not add D1 merely to duplicate `picks`. Cross-product transactions do not exist between D1 and a DO, so that would weaken the live consistency model.

### R2: not approved by necessity

Keep sanitized replay fixtures in the repository while they remain small and reviewable. Add R2 only if evidence files become materially large or need retention independent of releases. If added later, R2 stores immutable sanitized objects; it never stores ESPN cookies, Access secrets, or raw authenticated responses.

## Observability

Enable Workers Logs and traces in staging. Because traffic is tiny and time-bounded, use 100% log sampling during the disposable proof; traces may use a lower documented rate if needed. Reassess before production.

Every HTTP log is structured JSON with:

- event name and severity;
- request ID, build version, route template, method, status, duration;
- redacted/hashed draft identifier when the raw ID is unnecessary;
- revision, event count, accepted/deduped/conflict counts;
- ingest-to-commit latency and provider-observed-to-commit latency when available;
- safe error code, never stack trace in the response.

DO health exposes operational counters, not secrets. The dashboard clearly shows:

- connected / reconnecting / stale;
- last successful ingest and its age;
- last overall pick and current revision;
- detected gaps or conflicts;
- pinned catalog/build version;
- manual-mode indicator.

Do not add Tail Workers, Logpush, or Analytics Engine for staging. Worker logs plus the local ingestor's structured logs are enough. Use one request ID through Worker and DO logs so a pick can be traced without logging its payload.

## Local development and verification

Use Vitest with `@cloudflare/vitest-pool-workers`, configured from `wrangler.jsonc`, so tests execute inside the Workers runtime. Use generated `Env` types. Keep local secrets in ignored local configuration and inject deterministic test secrets through the test environment.

Test layers:

1. Pure unit tests: schema validation, canonical HMAC construction, constant-time verification wrapper, deterministic event IDs, snake-draft roster mapping, ranking inputs, gap detection, and response error mapping.
2. Direct DO tests: RPC through `env.DRAFT_SESSION.getByName`, SQLite constraints, initialization idempotency, exact duplicate behavior, conflicting duplicates, atomic batch failure, monotonic revisions, manual/ESPN reconciliation, and instance isolation.
3. Worker integration tests through `SELF.fetch`: routing, body limits, HMAC, timestamp window, nonce replay, API/asset separation, security headers, error redaction, snapshots, and health.
4. WebSocket tests: initial resync instruction, update broadcast after commit, multiple clients, stale client failure, disconnect/reconnect, revision gap, and DO eviction/hibernation behavior supported by the local runtime.
5. Replay tests: run a sanitized completed ESPN fixture one event at a time and in batches; final picks, availability, every roster, draft status, and recommendations must match the fixture oracle exactly.
6. Staging checks: Access policy, anonymous denial, service-token ingress, HMAC denial cases, WebSocket through Access, desktop/mobile render, rollback, and end-to-end latency.

Do not mock the DO for Worker integration tests. Mock only the local ESPN source boundary when testing the ingestor. The replay fixture is sanitized and contains no headers, cookies, display-name secrets, or raw authenticated response.

## Failure behavior

- **Duplicate delivery:** return idempotent success; no second roster mutation or broadcast revision.
- **Conflicting event:** return `409`, preserve state, set conflict health flag, and require operator review.
- **Missing pick/gap:** commit valid later events only if explicitly designed to tolerate gaps, mark stale/unhealthy, request backfill, and suppress recommendations that assume complete state. Preferred behavior is to return an ack listing the gap and have the ingestor immediately resend the missing range.
- **Out-of-order batch:** sort is not implicit. Reject an internally inconsistent batch; accept a valid historical backfill through normal idempotent event insertion and then recompute from ordered stored picks.
- **Ingestor or ESPN outage:** existing state stays readable; health becomes stale based on elapsed time. The UI displays stale data prominently and permits audited manual fallback.
- **Expired Access service token/HMAC key:** ingestion fails closed with no mutation; local preflight must detect this before draft time.
- **DO eviction/restart:** SQLite is authoritative; reconstruct caches on activation. Clients refetch after reconnect.
- **WebSocket loss:** polling fallback fetches snapshot periodically; reconnect uses exponential backoff with jitter and revision resync.
- **D1 unavailable:** an initialized live draft continues from its pinned catalog copy. New draft initialization/import fails closed.
- **Malformed or oversized input:** reject before DO call.
- **Worker exception:** return a generic `500` with request ID and structured error log; do not use `passThroughOnException`.
- **Cloudflare outage:** local ingestor retains its last acknowledged cursor and bounded unsent event queue on disk, then replays idempotently. The dashboard is unavailable, but no ESPN action occurs and no picks are lost once connectivity returns.

## Deployment and rollback

The designated operator owns all Cloudflare mutations and deployment. Contributors do not deploy from unreviewed branches.

Deployment order:

1. pass type, lint, unit, DO, Worker integration, replay, and local startup tests;
2. create private staging resources and secrets without printing them;
3. deploy Worker, SQLite DO migration, and assets as one versioned release;
4. disable the default Worker URL and apply Access before sending draft data;
5. verify anonymous denial, approved browser access, service-token + HMAC ingest, snapshot, WebSocket, and logs;
6. run the disposable draft proof;
7. add D1 only when the catalog import slice is ready and independently tested.

Rollback uses Cloudflare Worker version rollback to the last verified release and stops the local ingestor. Revoke/rotate the Access service token and HMAC key if compromise is suspected. Schema migrations are additive and forward-compatible; never drop/rename columns or change the DO class binding in the staging proof. Code rollback must be tested against the latest schema before deployment. Catalog snapshots are immutable, so rollback repins a prior version only before a draft starts; an active draft never silently changes snapshots.

## Acceptance tests

The staging architecture is accepted only when all of these pass with retained, sanitized evidence:

### Correctness

- A full disposable draft replay yields every pick exactly once, in the correct overall order, with exact team rosters and no unavailable player recommended.
- Replaying every event produces `accepted=0`, the expected `deduped` count, no revision change, and no extra WebSocket update.
- A conflicting duplicate changes no state and returns `409`.
- Disconnecting after an acknowledged pick and resuming from the prior cursor loses no pick and creates no duplicate.
- The same fixture produces identical recommendations under the same pinned catalog and engine versions.
- Manual fallback is fully audited and reconciles safely when the ESPN event later arrives.

### Latency and resilience

- Worker ingest-to-commit-and-recommendation p95 is below 1 second during the disposable proof.
- At least 95% of picks visible in ESPN appear in the dashboard within 5 seconds; report polling delay separately from Cloudflare processing delay.
- A WebSocket disconnect/reconnect restores the exact current revision without user refresh.
- DO reactivation reconstructs exact state from SQLite.
- A simulated Cloudflare/ingestor interruption replays queued events idempotently and reaches the exact oracle state.

### Security and privacy

- Anonymous HTTP and WebSocket requests to the staging hostname are denied by Access.
- The intended interactive identity succeeds; an unapproved identity fails.
- A valid Access service token without valid HMAC fails; valid HMAC without Access fails.
- Old timestamps, reused nonces, altered bodies/paths, malformed signatures, oversized bodies, and unknown schema versions fail without state mutation.
- The default `workers.dev` route and any alternate route cannot bypass Access.
- Automated secret scanning and manual fixture/log review find no ESPN cookies, Access credentials, HMAC keys/signatures, OAuth data, raw authenticated responses, or private league data beyond the explicitly approved sanitized identifiers.
- Production leagues remain read-only and are never used for mutation testing.

### Operations and UX

- Health accurately reports live, stale, gap, conflict, manual, and disconnected states.
- Structured logs correlate an ingest request through the DO commit without sensitive payloads.
- Desktop and phone renders show recommendations, board, roster needs, and stale/error states without clipping or unusable density.
- A deployment rollback restores the prior verified version while preserving readable draft state.
- The helper continues ingesting and serving independently of any chat or operator-console session.

## Implementation sequence

1. Lock event/envelope/snapshot schemas and a sanitized replay oracle.
2. Implement Worker validation/HMAC and `DraftSession` SQLite/RPC behavior locally.
3. Add snapshot API and hibernating WebSocket resync.
4. Add the static dashboard and polling fallback.
5. Pass local unit/integration/replay/failure tests.
6. Privately deploy Worker + assets + DO behind Access and run security smoke tests.
7. Execute the controlled disposable live proof and measure end-to-end latency/reconnect behavior.
8. Implement versioned D1 catalog import, pin/copy the chosen snapshot into the DO, and rerun deterministic replay.
9. Run rendered desktop/mobile acceptance and rollback drill.

## Current Cloudflare references

- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Durable Object rules and best practices](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Durable Object RPC invocation](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/)
- [Durable Object WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Workers static asset binding](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Cloudflare Access self-hosted applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/)
- [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
