import { DraftSession } from "./draft-session";
import { MAX_INIT_BYTES, readBoundedBody, verifyHmac } from "./security";
import { validateIngest, validateInit } from "./validation";

export { DraftSession };

type Route = { draftKey: string; action: "snapshot" | "health" | "ws" | "ingest" | "initialize" };

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self' wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function parseRoute(pathname: string): Route | null {
  const match = /^\/api\/v1\/drafts\/([^/]+)\/(snapshot|health|ws|ingest|initialize)$/.exec(pathname);
  if (!match?.[1] || !match[2]) return null;
  return { draftKey: decodeURIComponent(match[1]), action: match[2] as Route["action"] };
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
  if (message === "pick_conflict" || message === "event_id_conflict" || message === "draft_identity_conflict" || message === "draft_init_conflict") return { status: 409, code: message };
  if (message === "nonce_replay") return { status: 409, code: message };
  if (message === "draft_uninitialized") return { status: 409, code: message };
  if (message === "body_too_large") return { status: 413, code: message };
  if (message.startsWith("invalid_") || message.startsWith("unsupported_") || message === "events_not_strictly_ordered") {
    return { status: 400, code: message };
  }
  return { status: 500, code: "internal_error" };
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
      const route = parseRoute(url.pathname);
      if (route) {
        routeLabel = `draft.${route.action}`;
        const stub = env.DRAFT_SESSION.getByName(route.draftKey);
        if (route.action === "snapshot" && request.method === "GET") return json(await stub.getSnapshot());
        if (route.action === "health" && request.method === "GET") return json(await stub.getHealth());
        if (route.action === "ws" && request.method === "GET" && request.headers.get("Upgrade") === "websocket") {
          return stub.fetch(request);
        }
        if (route.action === "initialize" && request.method === "POST") {
          if (!request.headers.get("content-type")?.startsWith("application/json")) throw new Error("invalid_content_type");
          const bytes = await readBoundedBody(request, MAX_INIT_BYTES);
          const nonce = await verifySignedRequest(request, env, bytes);
          const body = validateInit(JSON.parse(new TextDecoder().decode(bytes)));
          if (body.draftKey !== route.draftKey) throw new Error("draft_identity_conflict");
          return json(await stub.initializeDraft(body, nonce, new Date().toISOString()), 201);
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
