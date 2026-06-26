/**
 * JITTER integration URLs — single source of truth for extension scripts.
 * Loaded as a classic script before content.js (manifest) and before report.js (report.html).
 *
 * SETUP: Replace every placeholder below with your own deployed backend URLs.
 * See .env.example at the repository root for a description of each variable.
 */

const JITTER_CONFIG = {
  /** Base URL of your HMAC signing + verify API (no trailing slash). */
  VAULT_API_BASE: "YOUR_VAULT_API_BASE_URL",
  /** Full URL for POST registry write (Worker endpoint). */
  REGISTRY_SAVE_URL: "YOUR_REGISTRY_SAVE_URL",
  /** Verification portal origin used in seal links (no trailing slash). */
  PORTAL_VERIFY_BASE: "YOUR_VERIFY_PORTAL_URL",
  /** Publicly accessible URL of the seal image embedded in clipboard HTML. */
  SEAL_IMAGE_URL: "YOUR_SEAL_IMAGE_URL",
  /** Hostname only — used for paste/seal heuristics in the content script. */
  SEAL_VERIFY_HOST: "YOUR_VERIFY_HOST",
  /** Substring match in HTML clipboard payloads (image URL path). */
  SEAL_IMG_MARKER: "YOUR_SEAL_IMG_MARKER",
};
