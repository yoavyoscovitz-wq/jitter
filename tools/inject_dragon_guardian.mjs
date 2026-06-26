/**
 * Encodes Assets/jitter_dragon_explaining.webp + Assets/NEW/*.webp and merges Dragon Guardian HUD into content.js.
 * Run from JITTER_MVP: node tools/inject_dragon_guardian.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const contentPath = path.join(root, "content.js");

const assetFiles = [
  ["attesting", path.join(root, "Assets", "jitter_dragon_explaining.webp"), "image/webp"],
  ["humanOriginal", path.join(root, "Assets", "NEW", "jitter_dragon_human.webp"), "image/webp"],
  ["humanLed", path.join(root, "Assets", "NEW", "jitter_dragon_assistant.webp"), "image/webp"],
  ["aiDriven", path.join(root, "Assets", "NEW", "jitter_dragon_cyborg.webp"), "image/webp"],
  ["aiGenerated", path.join(root, "Assets", "NEW", "jitter_dragon_synthetic.webp"), "image/webp"],
];
const assets = {};
for (const [key, filePath, mime] of assetFiles) {
  if (!fs.existsSync(filePath)) {
    throw new Error("Missing asset: " + filePath);
  }
  assets[key] = "data:" + mime + ";base64," + fs.readFileSync(filePath).toString("base64");
}
const assetsJs = "const DRAGON_ASSETS = " + JSON.stringify(assets) + ";\n\n";

const tail = `/** Same numeric rules as popup.js getTier (do not diverge). */
function dragonHudSafeNumber(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function dragonHudGetTier({ sFinal, totalKeystrokes, confidenceLabel }) {
  const h = Math.max(0, Math.min(100, dragonHudSafeNumber(sFinal)));
  const keys = Math.max(0, dragonHudSafeNumber(totalKeystrokes));
  const conf = confidenceLabel != null ? String(confidenceLabel) : "CALIBRATING";

  if (keys < 100 || conf === "CALIBRATING") {
    return { label: "Attesting\\u2026", class: "tier--attesting" };
  }
  if (h >= 90) return { label: "Human Original", class: "tier--human-original" };
  if (h >= 60) return { label: "Human-Led", class: "tier--human-led" };
  if (h >= 20) return { label: "AI-Driven", class: "tier--ai-driven" };
  return { label: "AI Generated", class: "tier--ai-generated" };
}

function dragonHudTierClassToAssetKey(className) {
  switch (className) {
    case "tier--human-original":
      return "humanOriginal";
    case "tier--human-led":
      return "humanLed";
    case "tier--ai-driven":
      return "aiDriven";
    case "tier--ai-generated":
      return "aiGenerated";
    case "tier--attesting":
    default:
      return "attesting";
  }
}

async function dragonHudDecryptScore(raw) {
  if (raw == null) return null;
  try {
    if (window.JitterCrypto && JitterCrypto.isEncrypted(raw)) {
      return await JitterCrypto.decryptJitterData(raw);
    }
    return raw;
  } catch (_) {
    return null;
  }
}

/** Inlined from jitter_seal_clipboard.js (uses JITTER_CONFIG from config.js). */
function dragonHudVerifyHref(docId) {
  const id = docId != null ? String(docId).trim() : "";
  if (!id) return JITTER_CONFIG.PORTAL_VERIFY_BASE + "/";
  return JITTER_CONFIG.PORTAL_VERIFY_BASE + "/" + id.replace(/^\\/+/, "");
}

function dragonHudBuildSealElement(docId) {
  const href = dragonHudVerifyHref(docId);
  const a = document.createElement("a");
  a.setAttribute("data-jitter-seal", "1");
  a.setAttribute("href", href);
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener noreferrer");
  a.setAttribute(
    "style",
    "text-decoration:none; background-color:transparent; display:inline-block; line-height:0;"
  );
  a.appendChild(document.createTextNode("\\u200B"));
  const img = document.createElement("img");
  img.setAttribute("src", JITTER_CONFIG.SEAL_IMAGE_URL);
  img.setAttribute("alt", "JITTER CERTIFIED");
  img.setAttribute("width", "110");
  img.setAttribute(
    "style",
    "border:none; display:inline-block; background-color:transparent; vertical-align:middle;"
  );
  a.appendChild(img);
  a.appendChild(document.createTextNode("\\u200B"));
  return a;
}

function dragonHudCopySeal(docId) {
  return new Promise(async function (resolve, reject) {
    if (typeof document === "undefined" || !document.body) {
      reject(new Error("No document context for copy"));
      return;
    }

    const sealEl = dragonHudBuildSealElement(docId);
    const html = sealEl.outerHTML;

    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard &&
        typeof navigator.clipboard.write === "function" &&
        typeof ClipboardItem !== "undefined"
      ) {
        const plain = dragonHudVerifyHref(docId);
        const item = new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        });
        await navigator.clipboard.write([item]);
        resolve();
        return;
      }
    } catch (_) {
      /* fall through */
    }

    if (typeof document.execCommand !== "function") {
      reject(new Error("execCommand not available"));
      return;
    }

    const div = document.createElement("div");
    div.setAttribute(
      "style",
      "position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;"
    );
    div.appendChild(sealEl.cloneNode(true));
    document.body.appendChild(div);

    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(div);
      selection.removeAllRanges();
      selection.addRange(range);

      const ok = document.execCommand("copy");

      selection.removeAllRanges();
      div.parentNode.removeChild(div);

      if (ok) {
        resolve();
      } else {
        reject(new Error("Copy failed"));
      }
    } catch (err) {
      try {
        if (div.parentNode) {
          div.parentNode.removeChild(div);
        }
      } catch (_) {
        /* ignore */
      }
      reject(err);
    }
  });
}

class DragonGuardian {
  static _instance = null;

  static ensureMounted() {
    const docId = getDocId();
    if (!docId || docId === "unknown") return;
    try {
      if (typeof sessionStorage !== "undefined" && sessionStorage.getItem("jitterDragonHudDismissed:" + docId)) {
        return;
      }
    } catch (_) {
      /* sessionStorage may be blocked */
    }

    if (DragonGuardian._instance && DragonGuardian._instance._docId !== docId) {
      DragonGuardian._instance.destroy();
      DragonGuardian._instance = null;
    }

    if (!DragonGuardian._instance) {
      DragonGuardian._instance = new DragonGuardian(docId);
      DragonGuardian._instance.mount();
    }
  }

  constructor(docId) {
    this._docId = docId;
    this._host = null;
    this._shadow = null;
    this._tierLabelEl = null;
    this._btnCopy = null;
    this._imgA = null;
    this._imgB = null;
    this._visibleIdx = 0;
    this._currentAssetUrl = "";
    this._storageListener = null;
    this._listenerBound = false;
  }

  destroy() {
    if (this._storageListener && chrome.storage && chrome.storage.onChanged) {
      try {
        chrome.storage.onChanged.removeListener(this._storageListener);
      } catch (_) {
        /* ignore */
      }
    }
    this._storageListener = null;
    this._listenerBound = false;
    if (this._host && this._host.parentNode) {
      this._host.parentNode.removeChild(this._host);
    }
    this._host = null;
    this._shadow = null;
    if (DragonGuardian._instance === this) {
      DragonGuardian._instance = null;
    }
  }

  _tierFromScore(score) {
    if (!score) {
      return dragonHudGetTier({
        sFinal: 0,
        totalKeystrokes: 0,
        confidenceLabel: "CALIBRATING",
      });
    }
    const details = score.details || {};
    const sFinal = dragonHudSafeNumber(score.S_final);
    const totalKeystrokes = dragonHudSafeNumber(details.totalKeystrokes);
    const confidenceLabel =
      details.confidenceLabel != null ? String(details.confidenceLabel) : "CALIBRATING";
    return dragonHudGetTier({ sFinal, totalKeystrokes, confidenceLabel });
  }

  _applyTier(tier) {
    const assetKey = dragonHudTierClassToAssetKey(tier.class);
    const url = DRAGON_ASSETS[assetKey] || DRAGON_ASSETS.attesting;
    if (this._tierLabelEl) {
      this._tierLabelEl.textContent = tier.label;
    }
    this._crossfadeTo(url);
  }

  applyScore(score) {
    const tier = this._tierFromScore(score);
    this._applyTier(tier);
  }

  _crossfadeTo(url) {
    if (!this._imgA || !this._imgB) return;
    if (url === this._currentAssetUrl) return;
    this._currentAssetUrl = url;

    const imgs = [this._imgA, this._imgB];
    const vis = this._visibleIdx;
    const hid = 1 - vis;
    const incoming = imgs[hid];
    const outgoing = imgs[vis];

    const finish = () => {
      requestAnimationFrame(() => {
        outgoing.classList.remove("visible");
        incoming.classList.add("visible");
        this._visibleIdx = hid;
      });
    };

    incoming.onload = () => finish();
    incoming.src = url;
    if (incoming.complete && incoming.naturalWidth > 0) {
      incoming.onload = null;
      finish();
    }
  }

  async _hydrateFromStorage() {
    const key = getStorageKey("jitterScore");
    return new Promise((resolve) => {
      chrome.storage.local.get([key], async (result) => {
        if (chrome.runtime.lastError) {
          this.applyScore(null);
          resolve();
          return;
        }
        const raw = result[key];
        const score = await dragonHudDecryptScore(raw);
        this.applyScore(score);
        resolve();
      });
    });
  }

  _bindStorageListener() {
    if (this._listenerBound || !chrome.storage || !chrome.storage.onChanged) return;
    this._storageListener = (changes, areaName) => {
      if (areaName !== "local") return;
      const key = getStorageKey("jitterScore");
      if (!changes || !Object.prototype.hasOwnProperty.call(changes, key)) return;
      const nv = changes[key].newValue;
      dragonHudDecryptScore(nv).then((score) => {
        this.applyScore(score);
      });
    };
    chrome.storage.onChanged.addListener(this._storageListener);
    this._listenerBound = true;
  }

  mount() {
    if (this._host) return;

    this._host = document.createElement("div");
    this._host.setAttribute("data-jitter-dragon-guardian", "1");
    this._shadow = this._host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent =
      ":host{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}" +
      ".pill{position:fixed;right:24px;bottom:80px;z-index:2147483646;outline:none;}" +
      ".glass{display:flex;flex-direction:row-reverse;align-items:center;justify-content:flex-end;" +
      "max-width:60px;min-height:60px;height:60px;overflow:hidden;box-sizing:border-box;" +
      "transition:max-width 0.35s ease,border-radius 0.35s ease,box-shadow 0.35s ease,height 0.35s ease;" +
      "border-radius:50%;" +
      "background:rgba(255,255,255,0.12);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);" +
      "border:1px solid rgba(255,255,255,0.22);box-shadow:0 2px 12px rgba(0,0,0,0.1);}" +
      ".pill:hover .glass,.pill:focus-within .glass{max-width:min(320px,calc(100vw - 48px));" +
      "height:auto;border-radius:22px;box-shadow:0 4px 18px rgba(0,0,0,0.12);}" +
      ".dragon-wrap{position:relative;width:54px;height:54px;flex:0 0 54px;margin:3px;box-sizing:border-box;}" +
      ".img-layer{position:absolute;inset:0;width:54px;height:54px;max-width:100%;max-height:100%;object-fit:contain;opacity:0;" +
      "transition:opacity 0.5s ease;pointer-events:none;user-select:none;-webkit-user-drag:none;}" +
      ".img-layer.visible{opacity:1;}" +
      ".side{flex:1 1 auto;display:flex;flex-direction:column;gap:6px;min-width:0;max-width:0;" +
      "opacity:0;padding:0;overflow:hidden;transition:max-width 0.35s ease,opacity 0.25s ease,padding 0.35s ease;}" +
      ".pill:hover .side,.pill:focus-within .side{max-width:240px;opacity:1;padding:8px 6px 8px 10px;}" +
      ".tier-label{font-size:13px;font-weight:600;color:#111827;white-space:nowrap;text-shadow:0 1px 0 rgba(255,255,255,0.5);}" +
      ".actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}" +
      ".btn{cursor:pointer;border:1px solid rgba(17,24,39,0.15);background:rgba(255,255,255,0.45);" +
      "color:#111827;border-radius:8px;padding:6px 10px;font-size:12px;font-weight:500;" +
      "transition:background 0.15s ease;}" +
      ".btn:hover{background:rgba(255,255,255,0.75);}" +
      ".btn.dismiss{padding:6px 12px;font-size:16px;line-height:1;}";

    const pill = document.createElement("div");
    pill.className = "pill";
    pill.setAttribute("tabindex", "0");
    pill.setAttribute("role", "region");
    pill.setAttribute("aria-label", "JITTER Dragon Guardian");

    const glass = document.createElement("div");
    glass.className = "glass";

    const dragonWrap = document.createElement("div");
    dragonWrap.className = "dragon-wrap";
    this._imgA = document.createElement("img");
    this._imgA.className = "img-layer visible";
    this._imgA.setAttribute("alt", "");
    this._imgB = document.createElement("img");
    this._imgB.className = "img-layer";
    this._imgB.setAttribute("alt", "");
    dragonWrap.appendChild(this._imgA);
    dragonWrap.appendChild(this._imgB);

    const side = document.createElement("div");
    side.className = "side";
    this._tierLabelEl = document.createElement("div");
    this._tierLabelEl.className = "tier-label";
    this._tierLabelEl.textContent = "Attesting\\u2026";

    const actions = document.createElement("div");
    actions.className = "actions";

    this._btnCopy = document.createElement("button");
    this._btnCopy.type = "button";
    this._btnCopy.className = "btn";
    this._btnCopy.textContent = "Copy Seal";

    const btnReport = document.createElement("button");
    btnReport.type = "button";
    btnReport.className = "btn";
    btnReport.textContent = "Open Report";

    const btnDismiss = document.createElement("button");
    btnDismiss.type = "button";
    btnDismiss.className = "btn dismiss";
    btnDismiss.setAttribute("aria-label", "Dismiss");
    btnDismiss.textContent = "\\u00d7";

    actions.appendChild(this._btnCopy);
    actions.appendChild(btnReport);
    actions.appendChild(btnDismiss);
    side.appendChild(this._tierLabelEl);
    side.appendChild(actions);

    glass.appendChild(dragonWrap);
    glass.appendChild(side);
    pill.appendChild(glass);

    this._shadow.appendChild(style);
    this._shadow.appendChild(pill);

    const startUrl = DRAGON_ASSETS.attesting;
    this._imgA.src = startUrl;
    this._imgB.src = startUrl;
    this._currentAssetUrl = startUrl;

    this._btnCopy.addEventListener("click", () => {
      const label = this._btnCopy.textContent;
      this._btnCopy.disabled = true;
      dragonHudCopySeal(this._docId || "")
        .then(() => {
          this._btnCopy.textContent = "Copied";
          setTimeout(() => {
            this._btnCopy.textContent = label;
            this._btnCopy.disabled = false;
          }, 2000);
        })
        .catch(() => {
          this._btnCopy.textContent = "Failed";
          setTimeout(() => {
            this._btnCopy.textContent = label;
            this._btnCopy.disabled = false;
          }, 2000);
        });
    });

    btnReport.addEventListener("click", () => {
      const url =
        chrome.runtime.getURL("report.html") +
        "?doc=" +
        encodeURIComponent(this._docId || "");
      window.open(url, "_blank", "noopener");
    });

    btnDismiss.addEventListener("click", () => {
      try {
        sessionStorage.setItem("jitterDragonHudDismissed:" + this._docId, "1");
      } catch (_) {
        /* ignore */
      }
      this.destroy();
    });

    document.body.appendChild(this._host);
    this._bindStorageListener();
    this._hydrateFromStorage();
  }
}

// Periodically attempt to attach to the Docs editing iframe as it appears.
setInterval(() => {
  attachJitterSensor();
  DragonGuardian.ensureMounted();
}, 1000);
`;

let c = fs.readFileSync(contentPath, "utf8");
const assetsNeedle = "const DRAGON_ASSETS = ";
const idx = c.indexOf(assetsNeedle);
if (idx === -1) {
  throw new Error("const DRAGON_ASSETS not found in content.js — aborting.");
}
c = c.slice(0, idx) + assetsJs + tail;
fs.writeFileSync(contentPath, c, "utf8");
console.log("Updated", contentPath, "size", c.length);
