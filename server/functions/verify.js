/**
 * Cloudflare Pages Function: /verify
 * - Handles CORS preflight (OPTIONS)
 * - Accepts POST JSON: { documentId: string, entropyData: string, signature: string }
 * - entropyData MUST be a 64-character SHA-256 hex digest (lowercase/uppercase hex OK).
 *   It is NOT a JSON blob; legacy JSON entropy payloads are rejected.
 * - Returns JSON: { verified: true|false, reason?: string }
 *
 * Expected environment:
 * - JITTER_HMAC_SECRET: same secret used by /sign
 */

const CORS_HEADERS = {
  // Portal runs on a different origin; we do not use credentials.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const keyBytes = enc.encode(String(secret ?? ""));
  if (keyBytes.length < 16) {
    throw new Error("Server misconfigured: JITTER_HMAC_SECRET is missing/too short");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aa = a.trim().toLowerCase();
  const bb = b.trim().toLowerCase();
  if (aa.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < aa.length; i++) out |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  return out === 0;
}

export async function onRequestOptions() {
  // CORS preflight
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const documentId = body?.documentId;
  const entropyData = body?.entropyData;
  const signature = body?.signature;

  if (typeof documentId !== "string" || !documentId.trim()) {
    return json({ error: "Missing documentId" }, 400);
  }
  if (typeof entropyData !== "string" || !/^[a-fA-F0-9]{64}$/.test(entropyData)) {
    return json({ error: "entropyData must be a 64-character hex SHA-256 digest" }, 400);
  }
  if (typeof signature !== "string" || !signature.trim()) {
    return json({ error: "Missing signature" }, 400);
  }

  // Match the exact signing input used by /sign.
  const signingInput = `${documentId}|${entropyData}`;

  try {
    const expected = await hmacSha256Hex(env?.JITTER_HMAC_SECRET, signingInput);
    const verified = timingSafeEqualHex(signature, expected);
    return verified
      ? json({ verified: true })
      : json({ verified: false, reason: "Signature mismatch" }, 200);
  } catch (err) {
    return withCors(
      new Response(
        JSON.stringify({ error: err?.message ? String(err.message) : "Verification failed" }),
        { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } }
      )
    );
  }
}

// Helpful method error for any non-POST/OPTIONS request.
export async function onRequest(context) {
  return json({ error: "Method Not Allowed" }, 405, { Allow: "POST, OPTIONS" });
}
