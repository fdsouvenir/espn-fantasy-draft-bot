import { DurableObject } from "cloudflare:workers";
import type {
  CatalogPlayerV1,
  DraftHealth,
  DraftInitV1,
  DraftNeedsV1,
  DraftPickEventV1,
  DraftSnapshot,
  IngestAck,
  IngestBatchV1,
  ResearchPublicationAckV1,
  ResearchPublicationV1,
  ResearchSnapshotV1,
} from "./contracts";
import { rankAvailable } from "./ranking";
import { auditResearchPublication, researchInventoryBucket } from "./research";

type MetaRow = {
  draft_key: string;
  revision: number;
  status: DraftHealth["status"];
  last_ingest_at: string | null;
  total_pick_slots: number;
  source_cursor_last_overall_pick: number;
  init_fingerprint: string;
  pinned_catalog_version: string | null;
  conflict_count: number;
};

type PickRow = {
  event_id: string;
  overall_pick: number;
  round_number: number;
  round_pick: number;
  team_id: string;
  player_id: string;
  source: "espn" | "manual";
  provider_observed_at: string | null;
  ingestor_observed_at: string;
};

type CatalogRow = { ranking_payload_json: string };
type ContextRow = { init_context_json: string };
type ResearchMetaRow = {
  publication_id: string;
  research_revision: number;
  fingerprint: string;
  publication_json: string;
  warnings_json: string;
};
type ResearchProfileRow = { player_id: string; profile_json: string };

type PersistedDraftContext = Pick<
  DraftInitV1,
  "expectedTeams" | "expectedRounds" | "managedTeamId" | "draftSlotTeamIds" | "rosterTargets"
>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const INGESTOR_STALE_AFTER_SECONDS = 45;
export const INGESTOR_DEAD_AFTER_SECONDS = 120;

export class DraftSession extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS draft_meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          draft_key TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pre_draft',
          last_ingest_at TEXT,
          total_pick_slots INTEGER NOT NULL,
          source_cursor_last_overall_pick INTEGER NOT NULL DEFAULT 0,
          pinned_catalog_version TEXT,
          init_fingerprint TEXT NOT NULL,
          conflict_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS picks (
          event_id TEXT PRIMARY KEY,
          overall_pick INTEGER NOT NULL UNIQUE,
          round_number INTEGER NOT NULL,
          round_pick INTEGER NOT NULL,
          team_id TEXT NOT NULL,
          player_id TEXT NOT NULL,
          source TEXT NOT NULL,
          provider_observed_at TEXT,
          ingestor_observed_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS seen_nonces (
          nonce TEXT PRIMARY KEY,
          seen_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS catalog_players (
          player_id TEXT PRIMARY KEY,
          ranking_payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS draft_context (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          init_context_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS research_publication (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          publication_id TEXT NOT NULL,
          research_revision INTEGER NOT NULL,
          fingerprint TEXT NOT NULL,
          publication_json TEXT NOT NULL,
          warnings_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS research_profiles (
          player_id TEXT PRIMARY KEY,
          profile_json TEXT NOT NULL
        );
      `);
    });
  }

  async initializeDraft(
    config: DraftInitV1,
    nonce?: string,
    receivedAt = new Date().toISOString(),
  ): Promise<{ created: boolean; revision: number }> {
    const fingerprint = await this.initFingerprint(config);
    const existing = this.meta();
    if (existing) {
      if (existing.draft_key !== config.draftKey) throw new Error("draft_identity_conflict");
      if (existing.init_fingerprint !== fingerprint) throw new Error("draft_init_conflict");
      if (nonce) {
        this.ctx.storage.transactionSync(() => {
          this.claimNonce(nonce, receivedAt);
          this.pruneNonces(receivedAt);
        });
      }
      return { created: false, revision: existing.revision };
    }
    const persistedContext: PersistedDraftContext = {
      expectedTeams: config.expectedTeams,
      expectedRounds: config.expectedRounds,
      managedTeamId: config.managedTeamId,
      draftSlotTeamIds: config.draftSlotTeamIds,
      rosterTargets: config.rosterTargets,
    };
    this.ctx.storage.transactionSync(() => {
      if (nonce) this.claimNonce(nonce, receivedAt);
      this.ctx.storage.sql.exec(
        `INSERT INTO draft_meta
         (singleton, draft_key, revision, status, total_pick_slots, pinned_catalog_version, init_fingerprint)
         VALUES (1, ?, 0, 'pre_draft', ?, ?, ?)`,
        config.draftKey,
        config.totalPickSlots,
        config.pinnedCatalogVersion,
        fingerprint,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO draft_context (singleton, init_context_json) VALUES (1, ?)",
        JSON.stringify(persistedContext),
      );
      for (const player of config.catalog) {
        this.ctx.storage.sql.exec(
          "INSERT INTO catalog_players (player_id, ranking_payload_json) VALUES (?, ?)",
          player.playerId,
          JSON.stringify(player),
        );
      }
      this.pruneNonces(receivedAt);
    });
    return { created: true, revision: 0 };
  }

  async ingestBatch(envelope: IngestBatchV1, nonce: string, receivedAt: string): Promise<IngestAck> {
    const meta = this.meta();
    if (!meta) throw new Error("draft_uninitialized");
    if (meta.draft_key !== envelope.draftKey) throw new Error("draft_identity_conflict");
    const context = this.context();
    if (!context) throw new Error("draft_context_missing");
    this.validateEnvelopeAgainstDraft(envelope, meta, context);

    let deduped = 0;
    const fresh: DraftPickEventV1[] = [];
    for (const event of envelope.events) {
      const eventIdMatch = this.ctx.storage.sql
        .exec<PickRow>("SELECT * FROM picks WHERE event_id = ?", event.eventId)
        .toArray()[0];
      const overallMatch = this.ctx.storage.sql
        .exec<PickRow>("SELECT * FROM picks WHERE overall_pick = ?", event.overallPick)
        .toArray()[0];
      if (eventIdMatch && eventIdMatch.overall_pick !== event.overallPick) {
        this.recordConflict();
        throw new Error("event_id_conflict");
      }
      const existing = overallMatch ?? eventIdMatch;
      if (!existing) {
        fresh.push(event);
        continue;
      }
      if (this.pickEquals(existing, event)) {
        deduped += 1;
        continue;
      }
      this.recordConflict();
      throw new Error("pick_conflict");
    }

    const nextStatus: DraftHealth["status"] = envelope.draftState.drafted
      ? "complete"
      : envelope.draftState.inProgress
        ? "live"
        : "pre_draft";
    const phaseChanged = meta.status !== nextStatus;

    this.ctx.storage.transactionSync(() => {
      this.claimNonce(nonce, receivedAt);
      for (const event of fresh) {
        this.ctx.storage.sql.exec(
          `INSERT INTO picks
           (event_id, overall_pick, round_number, round_pick, team_id, player_id, source,
            provider_observed_at, ingestor_observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          event.eventId,
          event.overallPick,
          event.round,
          event.roundPick,
          event.teamId,
          event.playerId,
          event.source,
          event.providerObservedAt,
          event.ingestorObservedAt,
        );
      }
      const changed = fresh.length > 0 || phaseChanged;
      this.ctx.storage.sql.exec(
        `UPDATE draft_meta
         SET revision = revision + ?, status = ?, last_ingest_at = ?,
             source_cursor_last_overall_pick = MAX(source_cursor_last_overall_pick, ?)
         WHERE singleton = 1`,
        changed ? 1 : 0,
        nextStatus,
        receivedAt,
        envelope.cursor.lastOverallPick,
      );
      this.pruneNonces(receivedAt);
    });
    const changed = fresh.length > 0 || phaseChanged;

    const ack = this.ack(fresh.length, deduped);
    if (changed) this.broadcast(ack);
    return ack;
  }

  async publishResearch(
    publication: ResearchPublicationV1,
    nonce: string,
    receivedAt: string,
  ): Promise<ResearchPublicationAckV1> {
    const meta = this.meta();
    if (!meta) throw new Error("draft_uninitialized");
    if (publication.draftKey !== meta.draft_key) throw new Error("draft_identity_conflict");
    const warnings = auditResearchPublication(publication, this.catalog());
    const fingerprint = await this.researchFingerprint(publication);
    const existing = this.researchMeta();
    if (existing?.publication_id === publication.publicationId) {
      if (existing.fingerprint !== fingerprint) throw new Error("research_publication_conflict");
      this.ctx.storage.transactionSync(() => {
        this.claimNonce(nonce, receivedAt);
        this.pruneNonces(receivedAt);
      });
      return this.researchAck(existing, false);
    }
    const researchRevision = (existing?.research_revision ?? 0) + 1;
    this.ctx.storage.transactionSync(() => {
      this.claimNonce(nonce, receivedAt);
      this.ctx.storage.sql.exec("DELETE FROM research_profiles");
      for (const entry of publication.profiles) {
        this.ctx.storage.sql.exec(
          "INSERT INTO research_profiles (player_id, profile_json) VALUES (?, ?)",
          entry.playerKey.slice("espn:".length),
          JSON.stringify(entry.profile),
        );
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO research_publication
         (singleton, publication_id, research_revision, fingerprint, publication_json, warnings_json)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           publication_id = excluded.publication_id,
           research_revision = excluded.research_revision,
           fingerprint = excluded.fingerprint,
           publication_json = excluded.publication_json,
           warnings_json = excluded.warnings_json`,
        publication.publicationId,
        researchRevision,
        fingerprint,
        JSON.stringify(publication),
        JSON.stringify(warnings),
      );
      this.ctx.storage.sql.exec("UPDATE draft_meta SET revision = revision + 1 WHERE singleton = 1");
      this.pruneNonces(receivedAt);
    });
    const stored = this.researchMeta();
    if (!stored) throw new Error("research_publication_missing");
    const ack = this.researchAck(stored, true);
    this.broadcastResearch(ack);
    return ack;
  }

  getResearchPublication(): ResearchPublicationV1 | null {
    return this.researchPublication();
  }

  async getSnapshot(): Promise<DraftSnapshot> {
    const meta = this.meta();
    if (!meta) return this.uninitializedSnapshot();
    const picks = this.pickRows();
    const rosters: Record<string, DraftPickEventV1[]> = {};
    for (const pick of picks) {
      const roster = rosters[pick.teamId] ?? [];
      roster.push(pick);
      rosters[pick.teamId] = roster;
    }
    const publishedProfiles = new Map(
      this.ctx.storage.sql
        .exec<ResearchProfileRow>("SELECT player_id, profile_json FROM research_profiles")
        .toArray()
        .map((row) => [
          row.player_id,
          JSON.parse(row.profile_json) as NonNullable<CatalogPlayerV1["researchProfile"]>,
        ]),
    );
    const hasPublishedResearch = this.researchMeta() !== null;
    const catalog = this.catalog().map((player) => {
      const profile = publishedProfiles.get(player.playerId) ??
        (hasPublishedResearch ? undefined : player.researchProfile);
      if (!profile) {
        const { researchProfile: _profile, researchInventoryBucket: _bucket, ...withoutResearch } = player;
        return withoutResearch;
      }
      return {
        ...player,
        researchProfile: profile,
        researchInventoryBucket: researchInventoryBucket(player.position, profile.researchedRole) ?? undefined,
      };
    });
    const context = this.context();
    if (!context) throw new Error("draft_context_missing");
    const catalogById = new Map(catalog.map((player) => [player.playerId, player]));
    const managedRoster = picks
      .filter((pick) => pick.teamId === context.managedTeamId)
      .flatMap((pick) => {
        const player = catalogById.get(pick.playerId);
        return player ? [{ ...player, overallPick: pick.overallPick }] : [];
      });
    const needs = this.needs(context, managedRoster);
    const draft = this.draftClock(meta, context, picks);
    const health = this.health(meta, picks);
    const available = rankAvailable(catalog, picks, {
      currentPick: draft.current,
      nextTeamPick: draft.nextTeamPick,
      baseDeficits: needs.baseDeficits,
      flexOpen: needs.flexOpen,
      draftSlotTeamIds: context.draftSlotTeamIds,
      managedTeamId: context.managedTeamId,
      rosterTargets: context.rosterTargets,
    });
    return {
      schemaVersion: 1,
      draftKey: meta.draft_key,
      revision: meta.revision,
      status: meta.status,
      picks,
      rosters,
      managedRoster,
      needs,
      draft,
      available,
      recommendations: health.hasGap || health.conflictCount > 0 || health.stale
        ? []
        : available.slice(0, 3),
      research: this.researchSnapshot(),
      health,
      pinnedCatalogVersion: meta.pinned_catalog_version,
      serverTime: new Date().toISOString(),
    };
  }

  async getHealth(): Promise<DraftHealth> {
    const meta = this.meta();
    return meta ? this.health(meta, this.pickRows()) : this.uninitializedSnapshot().health;
  }

  getCompanionConfig(): {
    draftKey: string;
    expectedTeams: number;
    totalPickSlots: number;
    draftSlotTeamIds: string[];
    draftUrl: string;
  } {
    const meta = this.meta();
    const context = this.context();
    if (!meta || !context) throw new Error("draft_uninitialized");
    return {
      draftKey: meta.draft_key,
      expectedTeams: context.expectedTeams,
      totalPickSlots: meta.total_pick_slots,
      draftSlotTeamIds: context.draftSlotTeamIds,
      draftUrl: "https://fantasy.espn.com/football/draft",
    };
  }

  override async fetch(_request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const meta = this.meta();
    server.send(JSON.stringify({ type: "snapshot_required", revision: meta?.revision ?? 0 }));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string" && message === "ping") socket.send("pong");
  }

  private meta(): MetaRow | null {
    return this.ctx.storage.sql.exec<MetaRow>("SELECT * FROM draft_meta WHERE singleton = 1").toArray()[0] ?? null;
  }

  private catalog(): CatalogPlayerV1[] {
    return this.ctx.storage.sql
      .exec<CatalogRow>("SELECT ranking_payload_json FROM catalog_players")
      .toArray()
      .map((row) => JSON.parse(row.ranking_payload_json) as CatalogPlayerV1);
  }

  private researchMeta(): ResearchMetaRow | null {
    return this.ctx.storage.sql
      .exec<ResearchMetaRow>("SELECT * FROM research_publication WHERE singleton = 1")
      .toArray()[0] ?? null;
  }

  private researchSnapshot(): ResearchSnapshotV1 | null {
    const row = this.researchMeta();
    if (!row) return null;
    const publication = JSON.parse(row.publication_json) as ResearchPublicationV1;
    return {
      publicationId: publication.publicationId,
      researchRevision: row.research_revision,
      roleVocabularyVersion: publication.roleVocabularyVersion,
      rubricVersion: publication.rubricVersion,
      publishedAt: publication.publishedAt,
      publishedBy: publication.publishedBy,
      profileCount: publication.profiles.length,
      warnings: JSON.parse(row.warnings_json) as ResearchSnapshotV1["warnings"],
    };
  }

  private researchPublication(): ResearchPublicationV1 | null {
    const row = this.researchMeta();
    return row ? JSON.parse(row.publication_json) as ResearchPublicationV1 : null;
  }

  private pickRows(): DraftPickEventV1[] {
    return this.ctx.storage.sql
      .exec<PickRow>("SELECT * FROM picks ORDER BY overall_pick")
      .toArray()
      .map((row) => ({
        schemaVersion: 1,
        eventId: row.event_id,
        overallPick: row.overall_pick,
        round: row.round_number,
        roundPick: row.round_pick,
        teamId: row.team_id,
        playerId: row.player_id,
        source: row.source,
        providerObservedAt: row.provider_observed_at,
        ingestorObservedAt: row.ingestor_observed_at,
      }));
  }

  private context(): PersistedDraftContext | null {
    const row = this.ctx.storage.sql
      .exec<ContextRow>("SELECT init_context_json FROM draft_context WHERE singleton = 1")
      .toArray()[0];
    return row ? (JSON.parse(row.init_context_json) as PersistedDraftContext) : null;
  }

  private needs(
    context: PersistedDraftContext,
    managedRoster: DraftSnapshot["managedRoster"],
  ): DraftNeedsV1 {
    const positions = ["QB", "RB", "WR", "TE"] as const;
    const filled = { QB: 0, RB: 0, WR: 0, TE: 0 };
    for (const player of managedRoster) {
      if (positions.includes(player.position as (typeof positions)[number])) {
        filled[player.position as (typeof positions)[number]] += 1;
      }
    }
    const baseDeficits = {
      QB: Math.max(0, context.rosterTargets.QB - filled.QB),
      RB: Math.max(0, context.rosterTargets.RB - filled.RB),
      WR: Math.max(0, context.rosterTargets.WR - filled.WR),
      TE: Math.max(0, context.rosterTargets.TE - filled.TE),
    };
    const flexEligibleAfterBase = (["RB", "WR", "TE"] as const).reduce(
      (total, position) => total + Math.max(0, filled[position] - context.rosterTargets[position]),
      0,
    );
    const flexOpen = Math.max(0, context.rosterTargets.FLEX - flexEligibleAfterBase);
    return {
      targets: context.rosterTargets,
      filled,
      baseDeficits,
      flexEligibleAfterBase,
      flexOpen,
      flexMet: flexOpen === 0,
    };
  }

  private draftClock(
    meta: MetaRow,
    context: PersistedDraftContext,
    picks: DraftPickEventV1[],
  ): DraftSnapshot["draft"] {
    const lastStoredPick = picks.at(-1)?.overallPick ?? 0;
    const lastObservedPick = Math.max(lastStoredPick, meta.source_cursor_last_overall_pick);
    const current = lastObservedPick < meta.total_pick_slots ? lastObservedPick + 1 : null;
    if (current === null) {
      return { current: null, round: null, roundPick: null, nextTeamPick: null, picksAway: null };
    }
    const nextOffset = context.draftSlotTeamIds.slice(current - 1).indexOf(context.managedTeamId);
    const nextTeamPick = nextOffset === -1 ? null : current + nextOffset;
    return {
      current,
      round: Math.floor((current - 1) / context.expectedTeams) + 1,
      roundPick: ((current - 1) % context.expectedTeams) + 1,
      nextTeamPick,
      picksAway: nextTeamPick === null ? null : nextTeamPick - current,
    };
  }

  private health(meta: MetaRow, picks: DraftPickEventV1[]): DraftHealth {
    const selected = new Set(picks.map((pick) => pick.overallPick));
    const lastStoredPick = picks.at(-1)?.overallPick ?? 0;
    const lastOverallPick = Math.max(lastStoredPick, meta.source_cursor_last_overall_pick);
    const missingOverallPicks = Array.from({ length: lastOverallPick }, (_, index) => index + 1).filter(
      (pick) => !selected.has(pick),
    );
    const elapsedSeconds = meta.last_ingest_at
      ? Math.max(0, (Date.now() - Date.parse(meta.last_ingest_at)) / 1000)
      : null;
    const ingestorStatus: DraftHealth["ingestorStatus"] = meta.status === "complete"
      ? "healthy"
      : meta.last_ingest_at === null
        ? "never_seen"
        : elapsedSeconds! >= INGESTOR_DEAD_AFTER_SECONDS
          ? "dead"
          : elapsedSeconds! >= INGESTOR_STALE_AFTER_SECONDS
            ? "stale"
            : "healthy";
    return {
      revision: meta.revision,
      status: meta.status,
      lastIngestAt: meta.last_ingest_at,
      lastOverallPick,
      sourceCursorLastOverallPick: meta.source_cursor_last_overall_pick,
      totalPickSlots: meta.total_pick_slots,
      missingOverallPicks,
      hasGap: missingOverallPicks.length > 0,
      conflictCount: meta.conflict_count,
      connectionCount: this.ctx.getWebSockets().length,
      ingestorStatus,
      stale: ingestorStatus === "stale" || ingestorStatus === "dead",
      staleAfterSeconds: INGESTOR_STALE_AFTER_SECONDS,
      deadAfterSeconds: INGESTOR_DEAD_AFTER_SECONDS,
    };
  }

  private ack(accepted: number, deduped: number): IngestAck {
    const meta = this.meta();
    if (!meta) throw new Error("draft_uninitialized");
    const health = this.health(meta, this.pickRows());
    return {
      revision: meta.revision,
      accepted,
      deduped,
      lastOverallPick: health.lastOverallPick,
      missingOverallPicks: health.missingOverallPicks,
      serverTime: new Date().toISOString(),
    };
  }

  private broadcast(ack: IngestAck): void {
    const message = JSON.stringify({
      type: "draft.updated",
      revision: ack.revision,
      lastOverallPick: ack.lastOverallPick,
      changed: ["picks", "availability", "recommendations"],
      serverTime: ack.serverTime,
    });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        socket.close(1011, "send_failed");
      }
    }
  }

  private researchAck(row: ResearchMetaRow, changed: boolean): ResearchPublicationAckV1 {
    const snapshot = this.researchSnapshot();
    if (!snapshot) throw new Error("research_publication_missing");
    return {
      publicationId: row.publication_id,
      researchRevision: row.research_revision,
      changed,
      profileCount: snapshot.profileCount,
      warnings: snapshot.warnings,
      serverTime: new Date().toISOString(),
    };
  }

  private broadcastResearch(ack: ResearchPublicationAckV1): void {
    const message = JSON.stringify({
      type: "research.updated",
      revision: this.meta()?.revision ?? 0,
      researchRevision: ack.researchRevision,
      changed: ["research", "availability"],
      serverTime: ack.serverTime,
    });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        socket.close(1011, "send_failed");
      }
    }
  }

  private uninitializedSnapshot(): DraftSnapshot {
    return {
      schemaVersion: 1,
      draftKey: "uninitialized",
      revision: 0,
      status: "uninitialized",
      picks: [],
      rosters: {},
      managedRoster: [],
      needs: {
        targets: { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0 },
        filled: { QB: 0, RB: 0, WR: 0, TE: 0 },
        baseDeficits: { QB: 0, RB: 0, WR: 0, TE: 0 },
        flexEligibleAfterBase: 0,
        flexOpen: 0,
        flexMet: true,
      },
      draft: { current: null, round: null, roundPick: null, nextTeamPick: null, picksAway: null },
      available: [],
      recommendations: [],
      research: null,
      health: {
        revision: 0,
        status: "uninitialized",
        lastIngestAt: null,
        lastOverallPick: 0,
        sourceCursorLastOverallPick: 0,
        totalPickSlots: 0,
        missingOverallPicks: [],
        hasGap: false,
        conflictCount: 0,
        connectionCount: this.ctx.getWebSockets().length,
        ingestorStatus: "never_seen",
        stale: false,
        staleAfterSeconds: INGESTOR_STALE_AFTER_SECONDS,
        deadAfterSeconds: INGESTOR_DEAD_AFTER_SECONDS,
      },
      pinnedCatalogVersion: null,
      serverTime: new Date().toISOString(),
    };
  }

  private async initFingerprint(config: DraftInitV1): Promise<string> {
    const canonical = JSON.stringify({
      draftKey: config.draftKey,
      expectedTeams: config.expectedTeams,
      expectedRounds: config.expectedRounds,
      totalPickSlots: config.totalPickSlots,
      managedTeamId: config.managedTeamId,
      draftSlotTeamIds: config.draftSlotTeamIds,
      rosterTargets: config.rosterTargets,
      pinnedCatalogVersion: config.pinnedCatalogVersion,
      catalog: [...config.catalog].sort((left, right) => left.playerId.localeCompare(right.playerId)),
    });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private async researchFingerprint(publication: ResearchPublicationV1): Promise<string> {
    const canonical = canonicalJson({
      ...publication,
      teamSnapshots: [...publication.teamSnapshots].sort((left, right) => left.nflTeam.localeCompare(right.nflTeam)),
      profiles: [...publication.profiles].sort((left, right) => left.playerKey.localeCompare(right.playerKey)),
    });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  private claimNonce(nonce: string, receivedAt: string): void {
    try {
      this.ctx.storage.sql.exec(
        "INSERT INTO seen_nonces (nonce, seen_at) VALUES (?, ?)",
        nonce,
        receivedAt,
      );
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: seen_nonces\.nonce/i.test(error.message)) {
        throw new Error("nonce_replay");
      }
      throw error;
    }
  }

  private pruneNonces(receivedAt: string): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM seen_nonces WHERE seen_at < ?",
      new Date(Date.parse(receivedAt) - 86_400_000).toISOString(),
    );
  }

  private recordConflict(): void {
    this.ctx.storage.sql.exec(
      "UPDATE draft_meta SET conflict_count = conflict_count + 1 WHERE singleton = 1",
    );
  }

  private pickEquals(row: PickRow, event: DraftPickEventV1): boolean {
    // Observation timestamps describe when each poll saw the pick, so they may
    // legitimately change during gap or reset replay. The first observation is
    // retained in storage; only the provider pick identity participates here.
    return row.event_id === event.eventId &&
      row.overall_pick === event.overallPick &&
      row.round_number === event.round &&
      row.round_pick === event.roundPick &&
      row.team_id === event.teamId &&
      row.player_id === event.playerId &&
      row.source === event.source;
  }

  private validateEnvelopeAgainstDraft(
    envelope: IngestBatchV1,
    meta: MetaRow,
    context: PersistedDraftContext,
  ): void {
    if (envelope.draftState.totalPickSlots !== meta.total_pick_slots) throw new Error("invalid_total_picks");
    if (envelope.cursor.lastOverallPick > meta.total_pick_slots) throw new Error("invalid_cursor");
    const catalogPlayerIds = new Set(
      this.ctx.storage.sql.exec<{ player_id: string }>("SELECT player_id FROM catalog_players")
        .toArray()
        .map((row) => row.player_id),
    );
    const batchPlayerPicks = new Map<string, number>();
    for (const event of envelope.events) {
      if (event.overallPick > envelope.cursor.lastOverallPick) throw new Error("invalid_cursor");
      const expectedRound = Math.floor((event.overallPick - 1) / context.expectedTeams) + 1;
      const expectedRoundPick = ((event.overallPick - 1) % context.expectedTeams) + 1;
      if (event.overallPick > meta.total_pick_slots || expectedRound > context.expectedRounds) {
        throw new Error("invalid_overall_pick");
      }
      if (event.round !== expectedRound || event.roundPick !== expectedRoundPick) {
        throw new Error("invalid_pick_coordinates");
      }
      if (event.teamId !== context.draftSlotTeamIds[event.overallPick - 1]) {
        throw new Error("invalid_pick_team");
      }
      if (!catalogPlayerIds.has(event.playerId)) throw new Error("invalid_player_id");
      const priorBatchPick = batchPlayerPicks.get(event.playerId);
      if (priorBatchPick !== undefined && priorBatchPick !== event.overallPick) {
        throw new Error("invalid_duplicate_player");
      }
      batchPlayerPicks.set(event.playerId, event.overallPick);
      const priorStoredPick = this.ctx.storage.sql
        .exec<{ overall_pick: number }>(
          "SELECT overall_pick FROM picks WHERE player_id = ? LIMIT 1",
          event.playerId,
        )
        .toArray()[0];
      if (priorStoredPick && priorStoredPick.overall_pick !== event.overallPick) {
        throw new Error("invalid_duplicate_player");
      }
    }
  }
}
