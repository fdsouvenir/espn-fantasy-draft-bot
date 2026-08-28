import {
  type CompanionDraft,
  type CompanionDraftIdentity,
  CompanionRegistry,
} from "./companion-registry";
import type { DraftInitV1 } from "./contracts";
import { DraftSession } from "./draft-session";
import { MAX_INIT_BYTES, readBoundedBody, sha256Hex, verifyHmac } from "./security";
import { validateIngest, validateInit, validateResearchPublication } from "./validation";

export { CompanionRegistry, DraftSession };

type Route = {
  draftKey: string;
  action: "snapshot" | "health" | "ws" | "ingest" | "companion-ingest" | "initialize" | "research";
};
type CompanionAdminRoute = { deviceId: string; action: "revoke" | "enable" };

const MAX_REGISTRATION_BYTES = 4 * 1024;
const MAX_SELECTION_BYTES = 1024;
const MAX_RESEARCH_BYTES = 5 * 1024 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self' wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function parseRoute(pathname: string): Route | null {
  const match = /^\/api\/v1\/drafts\/([^/]+)\/(snapshot|health|ws|ingest|companion-ingest|initialize|research)$/.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  return { draftKey: decodeURIComponent(match[1]), action: match[2] as Route["action"] };
}

function parseCompanionAdminRoute(pathname: string): CompanionAdminRoute | null {
  const match = /^\/api\/v1\/companion\/devices\/([^/]+)\/(revoke|enable)$/.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  return { deviceId: decodeURIComponent(match[1]), action: match[2] as CompanionAdminRoute["action"] };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...SECURITY_HEADERS,
    },
  });
}

function errorCode(error: unknown): { status: number; code: string } {
  const message = error instanceof Error ? error.message : "internal_error";
  if (
    message === "pick_conflict" ||
    message === "event_id_conflict" ||
    message === "draft_identity_conflict" ||
    message === "draft_init_conflict" ||
    message === "research_publication_conflict"
  ) {
    return { status: 409, code: message };
  }
  if (message === "nonce_replay") return { status: 409, code: message };
  if (message === "draft_uninitialized") return { status: 409, code: message };
  if (message === "body_too_large") return { status: 413, code: message };
  if (message === "invalid_bearer_token") return { status: 401, code: message };
  if (message === "device_forbidden" || message === "invalid_origin" || message === "device_revoked") return { status: 403, code: message };
  if (message === "device_not_found" || message === "draft_not_found") return { status: 404, code: message };
  if (message === "device_token_conflict") return { status: 409, code: message };
  if (message === "registration_rate_limited") return { status: 429, code: message };
  if (message.startsWith("invalid_") || message.startsWith("unsupported_") || message === "events_not_strictly_ordered") {
    return { status: 400, code: message };
  }
  return { status: 500, code: "internal_error" };
}

function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== new URL(request.url).origin) throw new Error("invalid_origin");
}

function bearerToken(request: Request): string {
  const match = /^Bearer ([A-Za-z0-9._~-]{32,256})$/.exec(request.headers.get("Authorization") ?? "");
  if (!match?.[1]) throw new Error("invalid_bearer_token");
  return match[1];
}

function validateDeviceId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("invalid_device_id");
  }
  return value.toLowerCase();
}

function validateRegistration(value: unknown): { name: string; version: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_registration");
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const version = typeof record.version === "string" ? record.version.trim() : "";
  if (
    name.length < 1 ||
    name.length > 80 ||
    Array.from(name).some((character) => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127)
  ) {
    throw new Error("invalid_device_name");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/.test(version)) throw new Error("invalid_device_version");
  return { name, version };
}

function validateDraftSelection(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_draft_selection");
  const draftKey = (value as Record<string, unknown>).draftKey;
  if (typeof draftKey !== "string" || draftKey.length < 1 || draftKey.length > 240) {
    throw new Error("invalid_draft_key");
  }
  return draftKey;
}

function validateDraftRooms(value: unknown): CompanionDraftIdentity[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_draft_rooms");
  const rooms = (value as Record<string, unknown>).rooms;
  if (!Array.isArray(rooms) || rooms.length < 1 || rooms.length > 8) throw new Error("invalid_draft_rooms");
  return rooms.map((room) => {
    if (!room || typeof room !== "object" || Array.isArray(room)) throw new Error("invalid_draft_room");
    const record = room as Record<string, unknown>;
    const leagueId = typeof record.leagueId === "string" ? record.leagueId : "";
    const season = record.season;
    if (!/^\d{1,12}$/.test(leagueId)) throw new Error("invalid_draft_room");
    if (season !== null && (!Number.isInteger(season) || Number(season) < 2000 || Number(season) > 2200)) {
      throw new Error("invalid_draft_room");
    }
    return { leagueId, season: season === null ? null : Number(season) };
  });
}

function companionDraftFromKey(
  draftKey: string,
  initializedAt: string,
  displayName?: string,
): CompanionDraft | null {
  const match = /^(?:local|staging):espn:ffl:(\d{4}):(\d{1,12}):(\d{1,15})$/.exec(draftKey);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    draftKey,
    displayName: displayName ?? `ESPN league ${match[2]}`,
    season: Number(match[1]),
    leagueId: match[2],
    draftEpoch: Number(match[3]),
    initializedAt,
  };
}

function companionDraft(config: DraftInitV1, initializedAt: string): CompanionDraft | null {
  return companionDraftFromKey(config.draftKey, initializedAt, config.displayName);
}

async function verifyCompanionSignature(request: Request, token: string, bytes: Uint8Array): Promise<string> {
  const timestamp = request.headers.get("X-Draft-Timestamp") ?? "";
  const nonce = request.headers.get("X-Draft-Nonce") ?? "";
  const signature = request.headers.get("X-Draft-Signature") ?? "";
  if (
    !/^\d{10}$/.test(timestamp) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)
  ) {
    throw new Error("invalid_signature_headers");
  }
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 60) throw new Error("invalid_signature_time");
  if (!await verifyHmac(token, timestamp, nonce, request.method, new URL(request.url).pathname, bytes, signature)) {
    throw new Error("invalid_signature");
  }
  return nonce;
}

async function verifySignedRequest(request: Request, env: Env, bytes: Uint8Array): Promise<string> {
  const timestamp = request.headers.get("X-Draft-Timestamp") ?? "";
  const nonce = request.headers.get("X-Draft-Nonce") ?? "";
  const signature = request.headers.get("X-Draft-Signature") ?? "";
  if (
    !/^\d{10}$/.test(timestamp) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)
  ) {
    throw new Error("invalid_signature_headers");
  }
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 60) throw new Error("invalid_signature_time");
  const previous = (env as Env & { INGEST_HMAC_PREVIOUS?: string }).INGEST_HMAC_PREVIOUS;
  const validCurrent = await verifyHmac(
    env.INGEST_HMAC_CURRENT,
    timestamp,
    nonce,
    request.method,
    new URL(request.url).pathname,
    bytes,
    signature,
  );
  const validPrevious = !validCurrent && previous
    ? await verifyHmac(previous, timestamp, nonce, request.method, new URL(request.url).pathname, bytes, signature)
    : false;
  if (!validCurrent && !validPrevious) {
    throw new Error("invalid_signature");
  }
  return nonce;
}

async function verifyResearchSignature(request: Request, env: Env, bytes: Uint8Array): Promise<string> {
  const timestamp = request.headers.get("X-Draft-Timestamp") ?? "";
  const nonce = request.headers.get("X-Draft-Nonce") ?? "";
  const signature = request.headers.get("X-Draft-Signature") ?? "";
  if (
    !/^\d{10}$/.test(timestamp) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(nonce)
  ) {
    throw new Error("invalid_signature_headers");
  }
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 60) {
    throw new Error("invalid_signature_time");
  }
  const previous = (env as Env & { RESEARCH_HMAC_PREVIOUS?: string }).RESEARCH_HMAC_PREVIOUS;
  const validCurrent = await verifyHmac(
    env.RESEARCH_HMAC_CURRENT,
    timestamp,
    nonce,
    request.method,
    new URL(request.url).pathname,
    bytes,
    signature,
  );
  const validPrevious = !validCurrent && previous
    ? await verifyHmac(
        previous,
        timestamp,
        nonce,
        request.method,
        new URL(request.url).pathname,
        bytes,
        signature,
      )
    : false;
  if (!validCurrent && !validPrevious) throw new Error("invalid_signature");
  return nonce;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const started = Date.now();
    const url = new URL(request.url);
    let routeLabel = "asset";
    try {
      if (url.pathname === "/healthz") {
        routeLabel = "healthz";
        return json({ ok: true, environment: env.ENVIRONMENT, build: env.BUILD_VERSION });
      }
      const registry = env.COMPANION_REGISTRY.getByName("primary");
      if (url.pathname === "/api/v1/companion/register" && request.method === "POST") {
        if (url.searchParams.get("resource") === "draft") {
          routeLabel = "companion.register.draft";
          requireSameOrigin(request);
          if (!request.headers.get("content-type")?.startsWith("application/json")) {
            throw new Error("invalid_content_type");
          }
          const bytes = await readBoundedBody(request, MAX_SELECTION_BYTES);
          const draftKey = validateDraftSelection(JSON.parse(new TextDecoder().decode(bytes)));
          const bootstrap = await env.DRAFT_SESSION.getByName(draftKey).getCompanionConfig();
          if (bootstrap.draftKey !== draftKey) throw new Error("draft_identity_conflict");
          const draft = companionDraftFromKey(draftKey, new Date().toISOString());
          if (!draft) throw new Error("invalid_draft_key");
          return json({ draft: await registry.registerDraft(draft), bootstrap }, 201);
        }
        routeLabel = "companion.register";
        if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("invalid_content_type");
        const token = bearerToken(request);
        const deviceId = validateDeviceId(request.headers.get("X-Draftside-Device") ?? "");
        const bytes = await readBoundedBody(request, MAX_REGISTRATION_BYTES);
        const registration = validateRegistration(JSON.parse(new TextDecoder().decode(bytes)));
        const registrationResult = await registry.registerDevice(
          deviceId,
          await sha256Hex(new TextEncoder().encode(token)),
          registration.name,
          registration.version,
          new Date().toISOString(),
        );
        if (!registrationResult.ok) throw new Error(registrationResult.error);
        return json({ device: registrationResult.device }, 201);
      }
      if (url.pathname === "/api/v1/companion/resolve" && request.method === "POST") {
        routeLabel = "companion.resolve";
        if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("invalid_content_type");
        const token = bearerToken(request);
        const deviceId = validateDeviceId(request.headers.get("X-Draftside-Device") ?? "");
        const bytes = await readBoundedBody(request, MAX_SELECTION_BYTES);
        const rooms = validateDraftRooms(JSON.parse(new TextDecoder().decode(bytes)));
        if (!await registry.authorizeDevice(
          deviceId,
          await sha256Hex(new TextEncoder().encode(token)),
          new Date().toISOString(),
        )) {
          throw new Error("device_forbidden");
        }
        return json({ drafts: await registry.resolveDrafts(rooms) });
      }
      if (url.pathname === "/api/v1/companion/select" && request.method === "POST") {
        routeLabel = "companion.select";
        if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("invalid_content_type");
        const token = bearerToken(request);
        const deviceId = validateDeviceId(request.headers.get("X-Draftside-Device") ?? "");
        const bytes = await readBoundedBody(request, MAX_SELECTION_BYTES);
        const draftKey = validateDraftSelection(JSON.parse(new TextDecoder().decode(bytes)));
        const tokenSha256 = await sha256Hex(new TextEncoder().encode(token));
        const selection = await registry.selectDraft(
          deviceId,
          tokenSha256,
          draftKey,
          new Date().toISOString(),
        );
        if (selection !== "selected") throw new Error(selection);
        const bootstrap = await env.DRAFT_SESSION.getByName(draftKey).getCompanionConfig();
        const draft = (await registry.listDrafts()).find((candidate) => candidate.draftKey === draftKey);
        if (!draft) throw new Error("device_forbidden");
        return json({ draft, bootstrap });
      }
      if (url.pathname === "/api/v1/companion/devices" && request.method === "GET") {
        routeLabel = "companion.devices.list";
        return json({ devices: await registry.listDevices() });
      }
      const adminRoute = parseCompanionAdminRoute(url.pathname);
      if (adminRoute && request.method === "POST") {
        routeLabel = `companion.devices.${adminRoute.action}`;
        requireSameOrigin(request);
        const deviceId = validateDeviceId(adminRoute.deviceId);
        const now = new Date().toISOString();
        const device = adminRoute.action === "revoke"
          ? await registry.revokeDevice(deviceId, now)
          : await registry.enableDevice(deviceId);
        if (!device) throw new Error("device_not_found");
        return json({ device });
      }
      const route = parseRoute(url.pathname);
      if (route) {
        routeLabel = `draft.${route.action}`;
        const stub = env.DRAFT_SESSION.getByName(route.draftKey);
        if (route.action === "snapshot" && request.method === "GET") return json(await stub.getSnapshot());
        if (route.action === "health" && request.method === "GET") return json(await stub.getHealth());
        if (route.action === "research" && request.method === "GET") {
          return json(await stub.getResearchPublication());
        }
        if (route.action === "ws" && request.method === "GET" && request.headers.get("Upgrade") === "websocket") {
          return stub.fetch(request);
        }
        if (route.action === "initialize" && request.method === "POST") {
          if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("invalid_content_type");
          const bytes = await readBoundedBody(request, MAX_INIT_BYTES);
          const nonce = await verifySignedRequest(request, env, bytes);
          const body = validateInit(JSON.parse(new TextDecoder().decode(bytes)));
          if (body.draftKey !== route.draftKey) throw new Error("draft_identity_conflict");
          const initializedAt = new Date().toISOString();
          const result = await stub.initializeDraft(body, nonce, initializedAt);
          const draft = companionDraft(body, initializedAt);
          if (draft) await registry.registerDraft(draft);
          return json(result, 201);
        }
        if (route.action === "ingest" && request.method === "POST") {
          if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("invalid_content_type");
          const bytes = await readBoundedBody(request);
          const nonce = await verifySignedRequest(request, env, bytes);
          const body = validateIngest(JSON.parse(new TextDecoder().decode(bytes)));
          if (body.draftKey !== route.draftKey || body.events.some((event) => event.source !== "espn")) {
            throw new Error("draft_identity_conflict");
          }
          return json(await stub.ingestBatch(body, nonce, new Date().toISOString()));
        }
        if (route.action === "research" && request.method === "POST") {
          if (!request.headers.get("content-type")?.startsWith("application/json")) {
            throw new Error("invalid_content_type");
          }
          const bytes = await readBoundedBody(request, MAX_RESEARCH_BYTES);
          const nonce = await verifyResearchSignature(request, env, bytes);
          const body = validateResearchPublication(JSON.parse(new TextDecoder().decode(bytes)));
          if (body.draftKey !== route.draftKey) throw new Error("draft_identity_conflict");
          return json(await stub.publishResearch(body, nonce, new Date().toISOString()), 201);
        }
        if (route.action === "companion-ingest" && request.method === "POST") {
          if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("invalid_content_type");
          const token = bearerToken(request);
          const deviceId = validateDeviceId(request.headers.get("X-Draftside-Device") ?? "");
          const tokenSha256 = await sha256Hex(new TextEncoder().encode(token));
          if (!await registry.authorizeDeviceForDraft(
            deviceId,
            tokenSha256,
            route.draftKey,
            new Date().toISOString(),
          )) {
            throw new Error("device_forbidden");
          }
          const bytes = await readBoundedBody(request);
          const nonce = await verifyCompanionSignature(request, token, bytes);
          const body = validateIngest(JSON.parse(new TextDecoder().decode(bytes)));
          if (body.draftKey !== route.draftKey || body.events.some((event) => event.source !== "espn")) {
            throw new Error("draft_identity_conflict");
          }
          return json(await stub.ingestBatch(body, nonce, new Date().toISOString()));
        }
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });
      }
      if (url.pathname.startsWith("/api/")) {
        routeLabel = "api.not_found";
        return json({ error: "not_found", requestId }, 404);
      }
      const asset = await env.ASSETS.fetch(request);
      const headers = new Headers(asset.headers);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
      if (headers.get("content-type")?.startsWith("text/html")) headers.set("Cache-Control", "no-store");
      return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
    } catch (error) {
      const mapped = errorCode(error);
      console.error(JSON.stringify({ event: "request_failed", requestId, route: routeLabel, code: mapped.code }));
      return json({ error: mapped.code, requestId }, mapped.status);
    } finally {
      console.log(JSON.stringify({
        event: "request_complete",
        requestId,
        method: request.method,
        route: routeLabel,
        durationMs: Date.now() - started,
      }));
    }
  },
} satisfies ExportedHandler<Env>;
