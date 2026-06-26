# JITTER — Privacy Disclosure

This document describes what data JITTER collects, how it is processed, and what is transmitted to external servers.

---

## What JITTER Collects Locally

JITTER records the following data while you type in Google Docs. All processing happens on your device before any data leaves the browser:

| Data Point | Description |
|------------|-------------|
| Keystroke dwell times | Duration each key is held down (milliseconds) |
| Keystroke flight times | Time between consecutive key events (milliseconds) |
| Punctuation pause patterns | Flight times immediately following punctuation characters |
| Error Recovery Latencies | Timing after Backspace/Delete keystrokes |
| Backspace and delete counts | Number of correction keystrokes |
| Paste events | Count and approximate character size of clipboard pastes (filtered: URL-only, image-only, and micro-pastes are excluded) |
| Estimated document length | Approximated from typed + deleted + pasted characters |

**Raw keystroke content (what you typed) is never recorded.** Only timing metadata is captured.

---

## What is Transmitted to Servers

When a certificate is requested, the following fields are sent to the remote signing API (`VAULT_API_BASE/sign`):

| Field | Value | Sensitivity |
|-------|-------|-------------|
| `documentId` | Pseudonymous identifier derived from the Google Doc URL path and a timestamp | No PII |
| `entropyData` | SHA-256 hex digest of a canonical JSON object of biometric score details | No PII |
| `textHash` | SHA-256 hex digest of a normalized sample of observed typing-derived words (optional; not full document text) | Low |

The following fields are sent to the registry worker (`REGISTRY_SAVE_URL`):

| Field | Value | Sensitivity |
|-------|-------|-------------|
| `documentId` | Same pseudonymous identifier | No PII |
| `score` | Rounded integer Humanity Score (0–100) | No PII |
| `wordCount` | Approximate word count of the observed session | No PII |
| `textHash` | Same SHA-256 digest as above | Low |

---

## What is NOT Transmitted

- Raw document text
- The actual words you typed
- Keystroke timing arrays (they stay encrypted in `chrome.storage.local`)
- Your name, email, or any account identifiers
- Cookies or browser fingerprints

---

## Local Storage

Session data (score, timing log, document metadata) is encrypted with AES-256-GCM using a per-install key generated at extension install time. The key is stored in `chrome.storage.local` and never leaves the device. All session records can be cleared by uninstalling the extension or clearing extension storage.

---

## Third-Party Services

Depending on your deployment, the signing server may run on Cloudflare Workers. Cloudflare's own privacy policy applies to infrastructure-level data (IP address, request metadata). JITTER itself transmits only the fields listed above and does not set cookies or use analytics.

---

## Data Retention

The registry worker stores session metadata (`documentId`, `score`, `wordCount`, `textHash`) in Cloudflare KV. This data is pseudonymous and has no expiry by default. Operators deploying their own server should configure a KV TTL appropriate for their use case.

---

## Contact

This is an open-source project. To report a privacy concern, open an issue on the GitHub repository.
