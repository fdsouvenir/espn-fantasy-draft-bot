import { DurableObject } from "cloudflare:workers";

export type CompanionDevice = {
  deviceId: string;
  name: string;
  version: string;
  registeredAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
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
}
