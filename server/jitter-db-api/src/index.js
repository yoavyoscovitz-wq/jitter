/**
 * JITTER DB API Worker
 * - POST /save — registry write (extension): document id, score, wordCount, textHash (64-char SHA-256 hex)
 * - GET /verify/:documentId — public read for verification portal
 *
 * Stored value (JSON): { documentId, score, wordCount, textHash }
 * Never persist or log raw text / textSnippet — only the hash.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
};

/** SHA-256 hex digest from client (64 chars). */
const TEXT_HASH_HEX_RE = /^[a-fA-F0-9]{64}$/;

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      ...extra,
    },
  });
}

function kvKey(documentId) {
  return `attest:${documentId}`;
}

function normalizeDocumentId(raw) {
  if (typeof raw !== "string") return "";
  const t = raw.trim();
  return t.length > 0 ? t : "";
}

/**
 * @param {unknown} value
 * @returns {string | null} lowercase 64-char hex or null
 */
function normalizeTextHash(value) {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!TEXT_HASH_HEX_RE.test(t)) return null;
  return t.toLowerCase();
}

function parseScore(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

function parseWordCount(value) {
  const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (path === "/save" && request.method === "POST") {
      return handleSave(request, env);
    }

    if (path.startsWith("/verify/") && request.method === "GET") {
      const documentId = decodeURIComponent(path.slice("/verify/".length).trim());
      return handleVerifyGet(env, documentId);
    }

    return json({ error: "Not Found" }, 404);
  },
};

async function handleSave(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const documentId = normalizeDocumentId(body?.documentId ?? body?.id);
  const textHash = normalizeTextHash(body?.textHash);

  if (!documentId) {
    return json({ error: "Missing documentId (or id)" }, 400);
  }
  if (!textHash) {
    return json(
      { error: "textHash is required and must be a 64-character hexadecimal string (SHA-256)" },
      400
    );
  }

  const score = parseScore(body?.score);
  const wordCount = parseWordCount(body?.wordCount);
  if (score === null) {
    return json({ error: "score must be a finite number" }, 400);
  }
  if (wordCount === null) {
    return json({ error: "wordCount must be a non-negative integer" }, 400);
  }

  // Do not accept or persist legacy raw snippet; ignore if present (no logging).
  const record = {
    documentId,
    score,
    wordCount,
    textHash,
  };

  const kv = env?.ATTESTATIONS;
  if (!kv || typeof kv.put !== "function") {
    console.error("[save] misconfigured: ATTESTATIONS KV binding missing");
    return json({ error: "Server misconfigured" }, 500);
  }

  try {
    await kv.put(kvKey(documentId), JSON.stringify(record));

    const roundTrip = await kv.get(kvKey(documentId), { type: "text" });
    let verified = false;
    if (roundTrip) {
      try {
        const parsed = JSON.parse(roundTrip);
        verified =
          typeof parsed?.textHash === "string" &&
          parsed.textHash.toLowerCase() === textHash;
      } catch {
        verified = false;
      }
    }

    console.log("[save] stored", JSON.stringify({ documentId, textHash }));

    return json({
      ok: true,
      documentId,
      textHash,
      stored: true,
      verified,
    });
  } catch (err) {
    console.error("[save] kv error", JSON.stringify({ documentId, textHash }));
    return json({ error: "Storage failed" }, 500);
  }
}

async function handleVerifyGet(env, documentIdRaw) {
  const documentId = normalizeDocumentId(documentIdRaw);
  if (!documentId) {
    return json({ found: false }, 404);
  }

  const kv = env?.ATTESTATIONS;
  if (!kv || typeof kv.get !== "function") {
    console.error("[verify] misconfigured: ATTESTATIONS KV binding missing");
    return json({ error: "Server misconfigured" }, 500);
  }

  try {
    const raw = await kv.get(kvKey(documentId), { type: "text" });
    if (!raw) {
      console.log("[verify] miss", JSON.stringify({ documentId }));
      return json({ found: false, documentId });
    }

    const data = JSON.parse(raw);
    const textHash =
      typeof data?.textHash === "string" && TEXT_HASH_HEX_RE.test(data.textHash)
        ? data.textHash.toLowerCase()
        : null;

    if (!textHash) {
      console.log("[verify] invalid record", JSON.stringify({ documentId }));
      return json({ found: false, documentId });
    }

    console.log("[verify] hit", JSON.stringify({ documentId, textHash }));

    return json({
      found: true,
      documentId: data.documentId ?? documentId,
      score: data.score,
      wordCount: data.wordCount,
      textHash,
    });
  } catch (err) {
    console.error("[verify] error", JSON.stringify({ documentId }));
    return json({ found: false, documentId }, 500);
  }
}
