# JITTER Cross-Project API Contracts

Authoritative description of HTTP surfaces used by the Chrome extension (`extension/`), the vault Pages Functions + registry Worker (`server/`), and the verification portal (`verify/`).

**Base URLs** are configured in `extension/config.js`. Replace all `YOUR_*` placeholders with your deployed backend URLs before loading the extension.

---

## 1. `POST /sign` (Vault API — `VAULT_API_BASE/sign`)

**Purpose:** Server-side HMAC-SHA256 over a stable string derived from the document id and entropy digest. Called by the extension only.

**Request**

- Method: `POST`
- Headers: `Content-Type: application/json`
- Body (JSON):
  - `documentId` (string, required): non-empty after trim.
  - `entropyData` (string, required): exactly **64** hexadecimal characters (SHA-256 digest of canonical score details).
  - `textHash` (string, optional): if present, must be 64 hex chars (content fingerprint). **Sent by the extension when available but ignored for HMAC generation** — the server does not read or validate this field; the signing input is only `documentId` and `entropyData` (i.e. `signingInput = \`${documentId}|${entropyData}\``).

**Success (200)**

- JSON: `{ "signature": "<hex string>" }`  
  (Clients may also accept a nested `{ "data": { "signature": "..." } }` shape for compatibility; the deployed server returns the flat form.)

**Errors**

- `400` — invalid JSON, missing `documentId`, or `entropyData` not matching the 64-hex digest rule.
- `500` — signing failure (e.g. misconfigured secret).

**CORS:** Preflight `OPTIONS` supported; headers are defined in the deployed function.

---

## 2. `POST /verify` (Vault API — `VAULT_API_BASE/verify`)

**Purpose:** Verify that `signature` is a valid HMAC for `documentId` + `entropyData` using the same secret as `/sign`. Used by the verification portal.

**Request**

- Method: `POST`
- Headers: `Content-Type: application/json`
- Body (JSON):
  - `documentId` (string, required)
  - `entropyData` (string, required): 64 hex characters (same rules as `/sign`)
  - `signature` (string, required): non-empty after trim

**Success (200)**

- `{ "verified": true }` when the signature matches.
- `{ "verified": false, "reason": "Signature mismatch" }` when it does not (still HTTP 200).

**Errors**

- `400` — invalid JSON or validation failure on required fields / digest format.
- `500` — verification error (e.g. misconfigured secret).

---

## 3. `POST /save` (Registry Worker — `REGISTRY_SAVE_URL`)

**Purpose:** Store attestation metadata for a Google Doc id (extension write path).

**Request**

- Method: `POST`
- Headers: `Content-Type: application/json`
- Body (JSON):
  - `documentId` or `id` (string, required): document identifier; at least one must be present and non-empty after normalization.
  - `score` (number, required): finite.
  - `wordCount` (number, required): non-negative integer.
  - `textHash` (string, required): 64 hexadecimal characters (SHA-256 of extension-shaped observed-word material).

**Success (200)**

- JSON includes at least: `ok`, `documentId`, `textHash`, `stored`, `verified` (round-trip check against KV). Exact shape is implementation-defined; the extension currently does not depend on the response body.

**Errors**

- `400` — validation failure.
- `500` — KV misconfiguration or storage failure.

---

## 4. `GET /verify/:documentId` (Registry Worker)

**Purpose:** Public read of stored attestation for portal "registry" / attestation UI.

**Request**

- Method: `GET`
- Path: `/verify/` + URL-encoded `documentId`.

**Responses**

- **Found:** `200` with JSON including `found: true`, `documentId`, `score`, `wordCount`, `textHash` (lowercase hex when normalized).
- **Not found:** `404` with `{ "found": false }` or `200` with `{ "found": false, "documentId": "..." }` depending on path (empty id vs miss); portal client tolerates both.
- **Invalid stored record:** `found: false` when stored data lacks a valid `textHash`.
- **500** — KV error or misconfiguration.

---

## HMAC Scope (vault vs registry)

- **Vault** (`/sign`, `/verify`): HMAC binds **`documentId` + `entropyData` only**. Optional `textHash` on `POST /sign` is **not** part of the HMAC message.
- **Registry** (`/save`, `GET /verify/...`): Persists **`textHash`** (and score metadata) separately for attestation comparison in the portal workflow.

---

## Related

- Executable vault round-trip test: [`e2e-vault-verify.mjs`](../e2e-vault-verify.mjs)
- Server implementations: [`server/functions/sign.js`](../server/functions/sign.js), [`server/functions/verify.js`](../server/functions/verify.js), [`server/jitter-db-api/src/index.js`](../server/jitter-db-api/src/index.js)
