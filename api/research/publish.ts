import { buildResearchPublication, ResearchSheetImportError } from "../../src/research-sheet-import.js";
import { bytesToHex, canonicalHmacInput } from "../../src/security.js";

declare const process: { env: Record<string, string | undefined> };

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const encoder = new TextEncoder();

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function requiredEnvironment(name: string, minimumLength = 1): string {
  const value = process.env[name]?.trim() ?? "";
  if (value.length < minimumLength) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

function authorized(request: Request, expected: string): boolean {
  const match = /^Bearer ([A-Za-z0-9._~-]{32,256})$/.exec(request.headers.get("Authorization") ?? "");
  if (!match?.[1]) return false;
  const supplied = encoder.encode(match[1]);
  const configured = encoder.encode(expected);
  const length = Math.max(supplied.length, configured.length);
  let difference = supplied.length ^ configured.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (supplied[index] ?? 0) ^ (configured[index] ?? 0);
  }
  return difference === 0;
}

async function signedHeaders(secret: string, pathname: string, body: Uint8Array): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    Uint8Array.from(await canonicalHmacInput(timestamp, nonce, "POST", pathname, body)).buffer,
  );
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "draftside-sheet-publisher/1",
    "X-Draft-Timestamp": timestamp,
    "X-Draft-Nonce": nonce,
    "X-Draft-Signature": `v1=${bytesToHex(new Uint8Array(signature))}`,
  };
  const clientId = process.env.CF_ACCESS_CLIENT_ID?.trim();
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET?.trim();
  if (clientId && clientSecret) {
    headers["CF-Access-Client-Id"] = clientId;
    headers["CF-Access-Client-Secret"] = clientSecret;
  }
  return headers;
}

async function publishToWorker(publication: unknown, workerBase: string, secret: string): Promise<unknown> {
  const record = publication as { draftKey: string };
  const base = new URL(workerBase);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname))) {
    throw new Error("invalid_worker_base");
  }
  const pathname = `/api/v1/drafts/${encodeURIComponent(record.draftKey)}/research`;
  const url = new URL(pathname, base);
  const body = encoder.encode(JSON.stringify(publication));
  const response = await fetch(url, {
    method: "POST",
    headers: await signedHeaders(secret, pathname, body),
    body,
    redirect: "error",
  });
  const result = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const code = typeof result?.error === "string" ? result.error : "worker_publication_failed";
    throw new Error(`${code}:${response.status}`);
  }
  return result;
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    try {
      const triggerToken = requiredEnvironment("DRAFTSIDE_PUBLISH_TRIGGER_TOKEN", 32);
      if (!authorized(request, triggerToken)) return json({ error: "unauthorized" }, 401);
      const declaredLength = Number(request.headers.get("content-length") ?? "0");
      if (declaredLength > MAX_IMPORT_BYTES) return json({ error: "body_too_large" }, 413);
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > MAX_IMPORT_BYTES) return json({ error: "body_too_large" }, 413);
      const payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      const expectedSheetId = requiredEnvironment("DRAFTSIDE_RESEARCH_SPREADSHEET_ID");
      if (
        !payload || typeof payload !== "object" || Array.isArray(payload) ||
        (payload as { spreadsheetId?: unknown }).spreadsheetId !== expectedSheetId
      ) {
        return json({ error: "spreadsheet_not_allowed" }, 403);
      }
      const draftKey = requiredEnvironment("DRAFTSIDE_DRAFT_KEY");
      const publication = buildResearchPublication(payload, draftKey);
      if (process.env.DRAFTSIDE_PUBLISH_VALIDATE_ONLY === "1") {
        return json({
          publicationId: publication.publicationId,
          draftKey: publication.draftKey,
          profileCount: publication.profiles.length,
          teamCount: publication.teamSnapshots.length,
          validated: true,
          published: false,
        });
      }
      const workerBase = requiredEnvironment("DRAFTSIDE_WORKER_BASE");
      const researchSecret = requiredEnvironment("RESEARCH_HMAC_CURRENT", 32);
      const acknowledgement = await publishToWorker(publication, workerBase, researchSecret) as Record<string, unknown>;
      return json({
        publicationId: publication.publicationId,
        draftKey: publication.draftKey,
        profileCount: publication.profiles.length,
        teamCount: publication.teamSnapshots.length,
        validated: true,
        published: true,
        researchRevision: acknowledgement.researchRevision,
        changed: acknowledgement.changed,
        warningCount: Array.isArray(acknowledgement.warnings) ? acknowledgement.warnings.length : 0,
      });
    } catch (error) {
      if (error instanceof ResearchSheetImportError) {
        return json({ error: error.message, problems: error.problems.slice(0, 100) }, 400);
      }
      if (error instanceof SyntaxError) return json({ error: "invalid_json" }, 400);
      const message = error instanceof Error ? (error.message.split(":", 1)[0] ?? "internal_error") : "internal_error";
      const status = message.startsWith("missing_") ? 503 : message === "invalid_worker_base" ? 500 : 502;
      return json({ error: message }, status);
    }
  },
};
