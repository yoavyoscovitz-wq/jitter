// JITTER Security & Integrity Layer — Encryption at Rest
// Uses Web Crypto API: AES-256-GCM for local storage encryption.
// HMAC-SHA256 signing is performed exclusively by the remote signing service.
// All operations are async to avoid blocking the UI.

(function () {
  "use strict";

  const STORAGE_KEY_INSTALL = "jitterInstallKey";
  const ENC_VERSION = 1;
  const IV_LEN = 12;
  const TAG_LEN = 16;
  const KEY_LEN = 32;

  function base64ToBytes(base64) {
    const bin = atob(base64.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function bytesToBase64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function ensureInstallKey() {
    return new Promise((resolve, reject) => {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
        reject(new Error("JITTER: chrome.storage not available"));
        return;
      }
      chrome.storage.local.get([STORAGE_KEY_INSTALL], (result) => {
        let raw = result && result[STORAGE_KEY_INSTALL];
        if (raw && typeof raw === "string") {
          try {
            const keyBytes = base64ToBytes(raw);
            if (keyBytes.length === KEY_LEN) {
              resolve(keyBytes);
              return;
            }
          } catch (_) {}
        }
        const keyBytes = new Uint8Array(KEY_LEN);
        if (typeof crypto !== "undefined" && crypto.getRandomValues) {
          crypto.getRandomValues(keyBytes);
        } else {
          reject(new Error("JITTER: crypto.getRandomValues not available"));
          return;
        }
        const b64 = bytesToBase64(keyBytes);
        chrome.storage.local.set({ [STORAGE_KEY_INSTALL]: b64 }, () => {
          resolve(keyBytes);
        });
      });
    });
  }

  async function getJitterInstallKey() {
    const keyBytes = await ensureInstallKey();
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
    return key;
  }

  async function encryptJitterData(plainObject) {
    const key = await getJitterInstallKey();
    const json = JSON.stringify(plainObject);
    const enc = new TextEncoder();
    const plain = enc.encode(json);
    const iv = new Uint8Array(IV_LEN);
    crypto.getRandomValues(iv);
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        tagLength: TAG_LEN * 8,
      },
      key,
      plain
    );
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return { v: ENC_VERSION, payload: bytesToBase64(combined) };
  }

  async function decryptJitterData(stored) {
    if (!stored || typeof stored !== "object" || stored.v !== ENC_VERSION || typeof stored.payload !== "string") {
      return null;
    }
    try {
      const key = await getJitterInstallKey();
      const combined = base64ToBytes(stored.payload);
      if (combined.length < IV_LEN + TAG_LEN) return null;
      const iv = combined.slice(0, IV_LEN);
      const ct = combined.slice(IV_LEN);
      const dec = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv,
          tagLength: TAG_LEN * 8,
        },
        key,
        ct
      );
      const json = new TextDecoder().decode(dec);
      return JSON.parse(json);
    } catch (_) {
      return null;
    }
  }

  async function sha256Hex(inputString) {
    const enc = new TextEncoder();
    const data = enc.encode(inputString);
    const hash = await crypto.subtle.digest("SHA-256", data);
    const hex = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return hex;
  }

  /**
   * Deterministic JSON string for signing: sorted keys, stable shape.
   * Must match across content.js, report.js, and the signing server (hash input).
   */
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

  /** SHA-256 hex (64 chars) of canonicalStringifyForDigest(details). */
  async function entropyDigestFromDetails(details) {
    return sha256Hex(canonicalStringifyForDigest(details));
  }

  function documentIdFromTimestamp(ts) {
    const t = typeof ts === "number" ? ts : Date.now();
    const raw = String(t) + ":" + String((t * 2654435761) >>> 0);
    let h = 0x811c9dc5;
    for (let i = 0; i < raw.length; i++) {
      h ^= raw.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    const hex = (h >>> 0).toString(16).padStart(8, "0");
    return "JTR-" + hex + "-" + (t >>> 0).toString(16).slice(-8);
  }

  window.JitterCrypto = {
    getJitterInstallKey,
    encryptJitterData,
    decryptJitterData,
    sha256Hex,
    canonicalStringifyForDigest,
    entropyDigestFromDetails,
    documentIdFromTimestamp,
    isEncrypted(stored) {
      return stored && typeof stored === "object" && stored.v === ENC_VERSION && typeof stored.payload === "string";
    },
  };
})();
