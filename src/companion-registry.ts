import { DurableObject } from "cloudflare:workers";

export type CompanionDevice = {
  deviceId: string;
  name: string;
  version: string;
  registeredAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
};

export type CompanionDraft = {
  draftKey: string;
  displayName: string;
  season: number;
  leagueId: string;
  draftEpoch: number;
  initializedAt: string;
};

export type CompanionDraftIdentity = {
  season: number | null;
  leagueId: string;
};

export type RegistrationResult =
  | { ok: true; device: CompanionDevice }
  | { ok: false; error: "device_token_conflict" | "device_revoked" | "registration_rate_limited" };

type DeviceRow = {
  device_id: string;
  token_sha256: string;
  name: string;
  version: string;
  registered_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
};

type DraftRow = {
  draft_key: string;
  display_name: string;
  season: number;
  league_id: string;
  draft_epoch: number;
  initialized_at: string;
};

const MAX_REGISTRATIONS_PER_MINUTE = 20;

export class CompanionRegistry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS companion_devices (
          device_id TEXT PRIMARY KEY,
          token_sha256 TEXT NOT NULL,
          name TEXT NOT NULL,
          version TEXT NOT NULL,
          registered_at TEXT NOT NULL,
          last_seen_at TEXT,
          revoked_at TEXT
        );
        CREATE TABLE IF NOT EXISTS registration_windows (
          window_start INTEGER PRIMARY KEY,
          attempts INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS initialized_drafts (
          draft_key TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          season INTEGER NOT NULL,
          league_id TEXT NOT NULL,
          draft_epoch INTEGER NOT NULL,
          initialized_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS companion_device_selections (
          device_id TEXT PRIMARY KEY,
          draft_key TEXT NOT NULL,
          selected_at TEXT NOT NULL
        );
      `);
    });
  }

  registerDevice(deviceId: string, tokenSha256: string, name: string, version: string, now: string): RegistrationResult {
    const existing = this.find(deviceId);
    if (existing) {
      if (!this.findWithToken(deviceId, tokenSha256)) return { ok: false, error: "device_token_conflict" };
      if (existing.revoked_at) return { ok: false, error: "device_revoked" };
      this.ctx.storage.sql.exec(
        "UPDATE companion_devices SET name = ?, version = ?, last_seen_at = ? WHERE device_id = ?",
        name,
        version,
        now,
        deviceId,
      );
      return { ok: true, device: this.toDevice(this.find(deviceId)!) };
    }

    if (!this.claimRegistrationWindow(now)) return { ok: false, error: "registration_rate_limited" };
    this.ctx.storage.sql.exec(
      `INSERT INTO companion_devices
       (device_id, token_sha256, name, version, registered_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      deviceId,
      tokenSha256,
      name,
      version,
      now,
      now,
    );
    return { ok: true, device: this.toDevice(this.find(deviceId)!) };
  }

  listDevices(): CompanionDevice[] {
    return this.ctx.storage.sql
      .exec<DeviceRow>("SELECT * FROM companion_devices ORDER BY registered_at, device_id")
      .toArray()
      .map((row) => this.toDevice(row));
  }

  revokeDevice(deviceId: string, now: string): CompanionDevice | null {
    const existing = this.find(deviceId);
    if (!existing) return null;
    if (!existing.revoked_at) {
      this.ctx.storage.sql.exec("UPDATE companion_devices SET revoked_at = ? WHERE device_id = ?", now, deviceId);
    }
    return this.toDevice(this.find(deviceId)!);
  }

  enableDevice(deviceId: string): CompanionDevice | null {
    const existing = this.find(deviceId);
    if (!existing) return null;
    if (existing.revoked_at) {
      this.ctx.storage.sql.exec("UPDATE companion_devices SET revoked_at = NULL WHERE device_id = ?", deviceId);
    }
    return this.toDevice(this.find(deviceId)!);
  }

  authorizeDevice(deviceId: string, tokenSha256: string, now: string): boolean {
    const existing = this.findWithToken(deviceId, tokenSha256);
    if (!existing || existing.revoked_at) return false;
    this.ctx.storage.sql.exec("UPDATE companion_devices SET last_seen_at = ? WHERE device_id = ?", now, deviceId);
    return true;
  }

  registerDraft(draft: CompanionDraft): CompanionDraft {
    this.ctx.storage.sql.exec(
      `INSERT INTO initialized_drafts
       (draft_key, display_name, season, league_id, draft_epoch, initialized_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(draft_key) DO UPDATE SET display_name = excluded.display_name`,
      draft.draftKey,
      draft.displayName,
      draft.season,
      draft.leagueId,
      draft.draftEpoch,
      draft.initializedAt,
    );
    return this.toDraft(this.findDraft(draft.draftKey)!);
  }

  listDrafts(): CompanionDraft[] {
    return this.ctx.storage.sql
      .exec<DraftRow>("SELECT * FROM initialized_drafts ORDER BY draft_epoch DESC, draft_key")
      .toArray()
      .map((row) => this.toDraft(row));
  }

  resolveDrafts(identities: CompanionDraftIdentity[]): CompanionDraft[] {
    const matches = new Map<string, CompanionDraft>();
    for (const draft of this.listDrafts()) {
      if (identities.some((identity) => (
        identity.leagueId === draft.leagueId
        && (identity.season === null || identity.season === draft.season)
      ))) {
        matches.set(draft.draftKey, draft);
      }
    }
    return [...matches.values()];
  }

  selectDraft(
    deviceId: string,
    tokenSha256: string,
    draftKey: string,
    now: string,
  ): "selected" | "device_forbidden" | "draft_not_found" {
    if (!this.authorizeDevice(deviceId, tokenSha256, now)) return "device_forbidden";
    if (!this.findDraft(draftKey)) return "draft_not_found";
    this.ctx.storage.sql.exec(
      `INSERT INTO companion_device_selections (device_id, draft_key, selected_at)
       VALUES (?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         draft_key = excluded.draft_key,
         selected_at = excluded.selected_at`,
      deviceId,
      draftKey,
      now,
    );
    return "selected";
  }

  authorizeDeviceForDraft(deviceId: string, tokenSha256: string, draftKey: string, now: string): boolean {
    const device = this.findWithToken(deviceId, tokenSha256);
    if (!device || device.revoked_at) return false;
    const selection = this.ctx.storage.sql
      .exec<{ draft_key: string }>(
        "SELECT draft_key FROM companion_device_selections WHERE device_id = ?",
        deviceId,
      )
      .toArray()[0];
    if (selection?.draft_key !== draftKey) return false;
    this.ctx.storage.sql.exec("UPDATE companion_devices SET last_seen_at = ? WHERE device_id = ?", now, deviceId);
    return true;
  }

  private claimRegistrationWindow(now: string): boolean {
    const windowStart = Math.floor(Date.parse(now) / 60_000) * 60_000;
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql
        .exec<{ attempts: number }>("SELECT attempts FROM registration_windows WHERE window_start = ?", windowStart)
        .toArray()[0];
      if ((row?.attempts ?? 0) >= MAX_REGISTRATIONS_PER_MINUTE) return false;
      this.ctx.storage.sql.exec(
        `INSERT INTO registration_windows (window_start, attempts) VALUES (?, 1)
         ON CONFLICT(window_start) DO UPDATE SET attempts = attempts + 1`,
        windowStart,
      );
      this.ctx.storage.sql.exec("DELETE FROM registration_windows WHERE window_start < ?", windowStart - 60_000);
      return true;
    });
  }

  private find(deviceId: string): DeviceRow | null {
    return this.ctx.storage.sql
      .exec<DeviceRow>("SELECT * FROM companion_devices WHERE device_id = ?", deviceId)
      .toArray()[0] ?? null;
  }

  private findWithToken(deviceId: string, tokenSha256: string): DeviceRow | null {
    return this.ctx.storage.sql
      .exec<DeviceRow>(
        "SELECT * FROM companion_devices WHERE device_id = ? AND token_sha256 = ?",
        deviceId,
        tokenSha256,
      )
      .toArray()[0] ?? null;
  }

  private findDraft(draftKey: string): DraftRow | null {
    return this.ctx.storage.sql
      .exec<DraftRow>("SELECT * FROM initialized_drafts WHERE draft_key = ?", draftKey)
      .toArray()[0] ?? null;
  }

  private toDevice(row: DeviceRow): CompanionDevice {
    return {
      deviceId: row.device_id,
      name: row.name,
      version: row.version,
      registeredAt: row.registered_at,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at,
    };
  }

  private toDraft(row: DraftRow): CompanionDraft {
    return {
      draftKey: row.draft_key,
      displayName: row.display_name,
      season: row.season,
      leagueId: row.league_id,
      draftEpoch: row.draft_epoch,
      initializedAt: row.initialized_at,
    };
  }
}
