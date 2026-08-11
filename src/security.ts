const encoder = new TextEncoder();

export const MAX_INGEST_BYTES = 256 * 1024;
export const MAX_INIT_BYTES = 2 * 1024 * 1024;

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[a-f0-9]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)));
}

export async function canonicalHmacInput(
  timestamp: string,
  nonce: string,
  method: string,
  pathname: string,
  body: Uint8Array,
): Promise<Uint8Array> {
  const bodyHash = await sha256Hex(body);
  return encoder.encode(`${timestamp}\n${nonce}\n${method.toUpperCase()}\n${pathname}\n${bodyHash}`);
}

export async function verifyHmac(
  secret: string,
  timestamp: string,
  nonce: string,
  method: string,
  pathname: string,
  body: Uint8Array,
  signatureHeader: string,
): Promise<boolean> {
  const match = /^v1=([a-f0-9]{64})$/.exec(signatureHeader);
  if (!match?.[1] || secret.length < 32) return false;
  const signature = hexToBytes(match[1]);
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(encoder.encode(secret)).buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(signature).buffer,
    Uint8Array.from(await canonicalHmacInput(timestamp, nonce, method, pathname, body)).buffer,
  );
}

export async function readBoundedBody(request: Request, maxBytes = MAX_INGEST_BYTES): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) throw new Error("body_too_large");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error("body_too_large");
  return bytes;
}
