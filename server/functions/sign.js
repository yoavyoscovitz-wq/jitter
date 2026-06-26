/**
 * Cloudflare Pages Function: /sign
 * - Handles CORS preflight (OPTIONS)
 * - Accepts POST JSON: { documentId: string, entropyData: string }
 * - entropyData MUST be a 64-character SHA-256 hex digest (lowercase/uppercase hex OK).
 *   It is NOT a JSON blob; legacy JSON entropy payloads are rejected.
 * - Returns JSON: { signature: string }
 *
 * Expected environment:
 * - JITTER_HMAC_SECRET: a sufficiently long secret (bytes / string)
 */

const CORS_HEADERS = {
  // Extension requests come from chrome-extension://<id> origins.
  // We do not use credentials, so wildcard is acceptable.
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
  if (typeof documentId !== "string" || !documentId.trim()) {
    return json({ error: "Missing documentId" }, 400);
  }
  if (typeof entropyData !== "string" || !/^[a-fA-F0-9]{64}$/.test(entropyData)) {
    return json({ error: "entropyData must be a 64-character hex SHA-256 digest" }, 400);
  }

  // Keep the signing input stable. Client sends a fixed-length digest bound to documentId.
  // We bind the doc id to prevent cross-document signature replay.
  const signingInput = `${documentId}|${entropyData}`;

  try {
    const signature = await hmacSha256Hex(env?.JITTER_HMAC_SECRET, signingInput);
    return json({ signature });
  } catch (err) {
    return withCors(
      new Response(
        JSON.stringify({ error: err?.message ? String(err.message) : "Signing failed" }),
        { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } }
      )
    );
  }
}

// Helpful method error for any non-POST/OPTIONS request.
export async function onRequest(context) {
  return json({ error: "Method Not Allowed" }, 405, { Allow: "POST, OPTIONS" });
}
