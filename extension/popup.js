// JITTER popup: reads encrypted session data from chrome.storage for the active Doc.
// Doc ID uses chrome.tabs.query on the active tab; tab.url is readable for URLs covered by
// host_permissions (https://docs.google.com/document/*) without the tabs or activeTab permission.
// Data handling: keystroke timing stays local (encrypted). For attestation, the content script may POST
// document id, rounded score, word count, and a SHA-256 hex hash of observed typing-derived material
// (never raw document text) to the configured registry endpoint; signing uses JITTER_CONFIG.VAULT_API_BASE.

function getStorageKey(docId, name) {
  return docId + "_" + name;
}

function hiddenHudKeyForDoc(docId) {
  return "jitter_hud_hidden_" + docId;
}

function updateAwakenDragonUI(docId, storage) {
  const row = document.getElementById("popup-awaken-row");
  const btn = document.getElementById("btn-awaken-dragon");
  if (!row || !btn) return;
  if (!docId) {
    row.classList.add("hidden");
    return;
  }
  const globalOff = !storage.jitterHudDisabledGlobal;
  const docOff = !storage[hiddenHudKeyForDoc(docId)];
  const needsAwaken = !globalOff || !docOff;
  if (needsAwaken) {
    row.classList.remove("hidden");
    btn.disabled = false;
  } else {
    row.classList.add("hidden");
    btn.disabled = true;
  }
}

function refreshAwakenDragonState() {
  getCurrentDocId((docId) => {
    if (!docId) {
      updateAwakenDragonUI(null, {});
      return;
    }
    const hk = hiddenHudKeyForDoc(docId);
    chrome.storage.local.get(["jitterHudDisabledGlobal", hk], (result) => {
      if (chrome.runtime.lastError) return;
      updateAwakenDragonUI(docId, result || {});
    });
  });
}

function extractDocIdFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const u = new URL(url);
    if (!/^https:\/\/docs\.google\.com\/document\/d\//.test(u.pathname)) return null;
    const m = u.pathname.match(/\/d\/([^/]+)(?:\/|$)/);
    return m && m[1] ? m[1] : null;
  } catch (_) {
    return null;
  }
}

function getCurrentDocId(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError) {
      cb(null);
      return;
    }
    const tab = tabs && tabs[0];
    const url = tab && tab.url ? tab.url : "";
    const fromTab = extractDocIdFromUrl(url);
    if (fromTab) {
      cb(fromTab);
      return;
    }
    if (/^https:\/\/docs\.google\.com\/document\//.test(url)) {
      chrome.storage.local.get(["jitterLastDocId"], (storage) => {
        if (chrome.runtime.lastError) {
          cb(null);
          return;
        }
        cb(storage.jitterLastDocId || null);
      });
      return;
    }
    // Not on a Google Doc (or tab URL unavailable): show empty state; do not guess another doc.
    cb(null);
  });
}

function safeNumber(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function confidenceToLabel(confidence) {
  const c = safeNumber(confidence);
  if (c < 0.15) return "CALIBRATING";
  if (c < 0.4) return "LOW";
  if (c < 0.7) return "MODERATE";
  return "HIGH";
}

function getTier({ sFinal, totalKeystrokes, confidenceLabel }) {
  const h    = Math.max(0, Math.min(100, safeNumber(sFinal)));
  const keys = Math.max(0, safeNumber(totalKeystrokes));
  const conf = confidenceLabel != null ? String(confidenceLabel) : "CALIBRATING";

  if (keys < 100 || conf === "CALIBRATING") {
    return { label: "Attesting\u2026", class: "tier--attesting" };
  }
  if (h >= 90) return { label: "Human Original", class: "tier--human-original" };
  if (h >= 60) return { label: "Human-Led",      class: "tier--human-led" };
  if (h >= 20) return { label: "AI-Driven",       class: "tier--ai-driven" };
  return       { label: "AI Generated",           class: "tier--ai-generated" };
}

function setSensorStatus(_hasData) {
  // Sensor status indicator reserved for future UI implementation.
}

/** Duration display: number emphasis + subdued unit (DOM, no innerHTML). */
function setSessionDurationContent(timeEl, ms) {
  if (!timeEl) return;
  timeEl.replaceChildren();
  const totalSec = Math.floor(ms / 1000);
  const appendPair = (numStr, unit) => {
    const n = document.createElement("span");
    n.className = "dur-num";
    n.textContent = numStr;
    const u = document.createElement("span");
    u.className = "dur-unit";
    u.textContent = unit;
    timeEl.append(n, u);
  };
  if (totalSec < 60) {
    appendPair(String(totalSec), "s");
    return;
  }
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (s === 0) {
    appendPair(String(m), "m");
    return;
  }
  appendPair(String(m), "m");
  timeEl.appendChild(document.createTextNode(" "));
  appendPair(String(s), "s");
}

let _ekgIdleTimer = null;
function setEkgBreathingIdle(isIdle) {
  const svg = document.querySelector(".popup-pulse-svg");
  if (!svg) return;
  if (isIdle) {
    clearTimeout(_ekgIdleTimer);
    _ekgIdleTimer = null;
    svg.classList.add("ekg-breathing");
  } else {
    svg.classList.remove("ekg-breathing");
    clearTimeout(_ekgIdleTimer);
    _ekgIdleTimer = setTimeout(function () {
      svg.classList.add("ekg-breathing");
      _ekgIdleTimer = null;
    }, 2800);
  }
}

function setEmptyState(show) {
  const emptyEl = document.getElementById("popup-empty");
  const cardEl = document.getElementById("popup-status-card");
  const sectionEl = document.getElementById("popup-session-section");
  if (emptyEl) emptyEl.classList.toggle("hidden", !show);
  if (cardEl) cardEl.classList.toggle("hidden", show);
  if (sectionEl) sectionEl.classList.toggle("hidden", show);
}

// Tracks whether the popup has performed its initial forensic reveal animation.
let _revealDone = false;

function renderPopup(score, log) {
  const tierEl = document.getElementById("tier-label");
  const confidenceEl = document.getElementById("confidence-label");
  const timeEl = document.getElementById("session-time");
  const keysEl = document.getElementById("session-keys");

  const details = score && score.details ? score.details : {};
  const sFinal = safeNumber(score && score.S_final);
  const typedChars = safeNumber(details.typedChars);
  const totalKeystrokes = safeNumber(details.totalKeystrokes);
  const confidenceLabel =
    details.confidenceLabel != null
      ? String(details.confidenceLabel)
      : details.confidence != null
        ? confidenceToLabel(details.confidence)
        : "—";

  if (totalKeystrokes === 0) {
    setEmptyState(true);
    setSensorStatus(false);
    setEkgBreathingIdle(true);
    return;
  }

  setEmptyState(false);
  setSensorStatus(true);

  // Session metrics update immediately (no delay).
  let timeSpentMs = 0;
  if (Array.isArray(log) && log.length > 0) {
    for (const item of log) {
      if (item && typeof item === "object") {
        timeSpentMs += safeNumber(item.d) + safeNumber(item.f);
      }
    }
  }
  if (timeEl) {
    if (log && log.length > 0) {
      setSessionDurationContent(timeEl, timeSpentMs);
    } else {
      timeEl.textContent = "—";
    }
  }
  if (keysEl) keysEl.textContent = String(typedChars > 0 ? typedChars : totalKeystrokes);

  const tier = getTier({ sFinal, totalKeystrokes, confidenceLabel });
  const confDisplay = (confidenceLabel === "—") ? "—" : confidenceLabel.toLowerCase();

  if (!_revealDone) {
    // First render: show "Attesting…" for 500 ms, then reveal the real result.
    _revealDone = true;
    if (tierEl) {
      tierEl.textContent = "Attesting\u2026";
      tierEl.className = "tier tier--attesting";
    }
    if (confidenceEl) confidenceEl.textContent = "Attestation quality: \u2026";

    setTimeout(() => {
      if (tierEl) {
        tierEl.textContent = tier.label;
        tierEl.className = "tier " + tier.class;
      }
      if (confidenceEl) confidenceEl.textContent = "Attestation quality: " + confDisplay;
    }, 500);
  } else {
    // Subsequent storage-change refreshes: instant update, no animation.
    if (tierEl) {
      tierEl.textContent = tier.label;
      tierEl.className = "tier " + tier.class;
    }
    if (confidenceEl) confidenceEl.textContent = "Attestation quality: " + confDisplay;
  }
}

function resetUI() {
  setEmptyState(true);
  const tierEl = document.getElementById("tier-label");
  const confidenceEl = document.getElementById("confidence-label");
  const timeEl = document.getElementById("session-time");
  const keysEl = document.getElementById("session-keys");
  if (tierEl) {
    tierEl.textContent = "Attesting\u2026";
    tierEl.className = "tier tier--attesting";
  }
  if (confidenceEl) confidenceEl.textContent = "Attestation quality: —";
  if (timeEl) timeEl.textContent = "—";
  if (keysEl) keysEl.textContent = "0";
  setSensorStatus(false);
  setEkgBreathingIdle(true);
}

function loadMetrics() {
  getCurrentDocId((docId) => {
    if (!docId) {
      resetUI();
      refreshAwakenDragonState();
      return;
    }

    const keyLog = getStorageKey(docId, "jitterLog");
    const keyScore = getStorageKey(docId, "jitterScore");

    chrome.storage.local.get([keyLog, keyScore], async (result) => {
      let log = result[keyLog];
      let score = result[keyScore] || null;

      if (window.JitterCrypto) {
        try {
          if (log && JitterCrypto.isEncrypted(log)) {
            const dec = await JitterCrypto.decryptJitterData(log);
            log = Array.isArray(dec) ? dec : [];
          }
          if (score && JitterCrypto.isEncrypted(score)) {
            score = await JitterCrypto.decryptJitterData(score);
          }
        } catch (_) {
          log = [];
          score = null;
        }
      }
      if (!Array.isArray(log)) log = [];

      if (!score) {
        resetUI();
        refreshAwakenDragonState();
        return;
      }

      renderPopup(score, log);
      refreshAwakenDragonState();
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const helpBtn = document.getElementById("btn-help");
  if (helpBtn && typeof jitterOpenHelpCenter === "function") {
    helpBtn.addEventListener("click", () => {
      jitterOpenHelpCenter();
    });
  }

  const hasPlaceholders =
    typeof JITTER_CONFIG !== "undefined" &&
    typeof jitterHasPlaceholderConfig === "function" &&
    jitterHasPlaceholderConfig(JITTER_CONFIG);

  if (hasPlaceholders) {
    jitterShowConfigBanner("popup-config-banner-root", undefined, { showHelpLink: true });
  }

  if (
    hasPlaceholders &&
    typeof chrome !== "undefined" &&
    chrome.storage &&
    chrome.storage.local &&
    typeof jitterShowSetupTip === "function"
  ) {
    chrome.storage.local.get(["onboarding_complete", "help_tip_dismissed"], (result) => {
      if (
        result &&
        result.onboarding_complete &&
        !result.help_tip_dismissed
      ) {
        jitterShowSetupTip("popup-setup-tip-root");
      }
    });
  }

  const auditButton = document.getElementById("btn-audit-report");
  if (auditButton && typeof chrome !== "undefined" && chrome.tabs) {
    auditButton.addEventListener("click", () => {
      getCurrentDocId((docId) => {
        const url =
          chrome.runtime.getURL("report.html") +
          (docId ? "?doc=" + encodeURIComponent(docId) : "");
        chrome.tabs.create({ url });
      });
    });
  }

  const copySealBtn = document.getElementById("btn-copy-seal");
  if (copySealBtn && window.JitterSealClipboard) {
    copySealBtn.addEventListener("click", () => {
      getCurrentDocId((docId) => {
        const label = copySealBtn.textContent;
        copySealBtn.disabled = true;
        JitterSealClipboard.copySeal(docId || "")
          .then(() => {
            copySealBtn.textContent = "COPIED";
            setTimeout(() => {
              copySealBtn.textContent = label;
              copySealBtn.disabled = false;
            }, 2000);
          })
          .catch(() => {
            copySealBtn.textContent = "FAILED";
            setTimeout(() => {
              copySealBtn.textContent = label;
              copySealBtn.disabled = false;
            }, 2000);
          });
      });
    });
  }

  const awakenBtn = document.getElementById("btn-awaken-dragon");
  if (awakenBtn && chrome.tabs && chrome.storage) {
    awakenBtn.addEventListener("click", () => {
      getCurrentDocId((docId) => {
        if (!docId) return;
        const hk = hiddenHudKeyForDoc(docId);
        chrome.storage.local.remove(["jitterHudDisabledGlobal", hk], () => {
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tab = tabs && tabs[0];
            if (!tab || tab.id == null) {
              refreshAwakenDragonState();
              return;
            }
            chrome.tabs.sendMessage(
              tab.id,
              { action: "JITTER_REVIVE_HUD", docId },
              () => {
                void chrome.runtime.lastError;
                refreshAwakenDragonState();
              }
            );
          });
        });
      });
    });
  }

  loadMetrics();
  refreshAwakenDragonState();

  // Real-time refresh while popup is open.
  if (chrome && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      const touched = Object.keys(changes || {});
      if (!touched.length) return;
      const logUpdated = touched.some(
        (k) => typeof k === "string" && k.endsWith("_jitterLog")
      );
      if (logUpdated) setEkgBreathingIdle(false);
      const shouldRefresh = touched.some(
        (k) =>
          typeof k === "string" &&
          (k.endsWith("_jitterLog") || k.endsWith("_jitterScore"))
      );
      if (shouldRefresh) loadMetrics();
      const awakenTouched = touched.some(
        (k) =>
          k === "jitterHudDisabledGlobal" ||
          (typeof k === "string" && k.indexOf("jitter_hud_hidden_") === 0)
      );
      if (awakenTouched) refreshAwakenDragonState();
    });
  }
});
