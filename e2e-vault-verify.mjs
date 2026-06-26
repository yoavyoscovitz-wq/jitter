#!/usr/bin/env node
/**
 * JITTER Vault E2E contract test (Node 18+).
 * Mirrors extension crypto_layer canonical digest + server/ /sign and /verify endpoints.
 *
 * Usage:
 *   JITTER_HMAC_SECRET="your-server-secret" node e2e-vault-verify.mjs
 *   VAULT_BASE=https://your-api-domain.com node e2e-vault-verify.mjs
 *
 * Exits 0 on success, 1 on failure.
 */

import crypto from "node:crypto";

const VAULT_BASE = (process.env.VAULT_BASE || "https://your-api-domain.com").replace(/\/$/, "");
const SECRET = process.env.JITTER_HMAC_SECRET || "";

function canonicalStringifyForDigest(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    return JSON.stringify({});
  }
  const sorted = Object.keys(obj)
    .sort()
    .reduce((acc, k) => {
      acc[k] = obj[k];
      return acc;
    }, {});
  return JSON.stringify(sorted);
}

function entropyDigestFromDetails(details) {
  const s = canonicalStringifyForDigest(details);
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function hmacSha256Hex(secret, message) {
  return crypto.createHmac("sha256", String(secret)).update(message, "utf8").digest("hex");
}

function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERT FAIL:", msg);
    process.exit(1);
  }
}

async function main() {
  if (!SECRET || SECRET.length < 16) {
    console.error(
      "Set JITTER_HMAC_SECRET (min 16 chars) to match the server JITTER_HMAC_SECRET."
    );
    process.exit(1);
  }

  const documentId = "e2e-mock-doc-" + crypto.randomBytes(4).toString("hex");
  const mockDetails = {
    totalKeystrokes: 120,
    typedChars: 100,
    backspaceCount: 5,
    confidence: 0.5,
    confidenceLabel: "MODERATE",
  };
  const entropyData = entropyDigestFromDetails(mockDetails);
  assert(/^[a-f0-9]{64}$/.test(entropyData), "entropyData must be 64 hex chars");

  const signingInput = `${documentId}|${entropyData}`;
  const expectedLocal = hmacSha256Hex(SECRET, signingInput);

  const signUrl = `${VAULT_BASE}/sign`;
  const verifyUrl = `${VAULT_BASE}/verify`;

  let signRes;
  try {
    signRes = await fetch(signUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId, entropyData }),
    });
  } catch (e) {
    console.error("POST /sign network error:", e.message);
    process.exit(1);
  }

  const signText = await signRes.text();
  let signJson = null;
  try {
    signJson = signText ? JSON.parse(signText) : null;
  } catch {
    /* ignore */
  }

  assert(signRes.ok, `/sign HTTP ${signRes.status}: ${signText.slice(0, 500)}`);
  assert(signJson && typeof signJson.signature === "string" && signJson.signature.trim(), "missing signature");
  assert(
    signJson.signature.toLowerCase() === expectedLocal.toLowerCase(),
    "server signature must match local HMAC"
  );

  let verRes;
  try {
    verRes = await fetch(verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId,
        entropyData,
        signature: signJson.signature,
      }),
    });
  } catch (e) {
    console.error("POST /verify network error:", e.message);
    process.exit(1);
  }

  const verText = await verRes.text();
  let verJson = null;
  try {
    verJson = verText ? JSON.parse(verText) : null;
  } catch {
    /* ignore */
  }

  assert(verRes.ok, `/verify (good sig) HTTP ${verRes.status}: ${verText.slice(0, 500)}`);
  assert(verJson && verJson.verified === true, "expected { verified: true }");

  const badSig =
    signJson.signature.slice(0, -1) +
    (signJson.signature.slice(-1) === "0" ? "1" : "0");

  let verBad;
  try {
    verBad = await fetch(verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId,
        entropyData,
        signature: badSig,
      }),
    });
  } catch (e) {
    console.error("POST /verify (bad sig) network error:", e.message);
    process.exit(1);
  }

  const badText = await verBad.text();
  let badJson = null;
  try {
    badJson = badText ? JSON.parse(badText) : null;
  } catch {
    /* ignore */
  }

  assert(verBad.ok, `/verify (bad sig) HTTP ${verBad.status}: ${badText.slice(0, 500)}`);
  assert(badJson && badJson.verified === false, "expected { verified: false }");
  assert(typeof badJson.reason === "string" && badJson.reason.length > 0, "expected reason string");

  const badEntropy = "gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg"; // 64 chars, not hex
  let ver400;
  try {
    ver400 = await fetch(verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        documentId,
        entropyData: badEntropy,
        signature: signJson.signature,
      }),
    });
  } catch (e) {
    console.error("POST /verify (bad entropy) network error:", e.message);
    process.exit(1);
  }

  assert(ver400.status === 400, `expected HTTP 400 for invalid entropyData, got ${ver400.status}`);
  const err400 = await ver400.json().catch(() => ({}));
  assert(err400.error, "expected { error } on 400");

  console.log("OK: /sign + /verify contract matches portal expectations (verified, reason, 400 error body).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
