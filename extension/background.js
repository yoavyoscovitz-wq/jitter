// JITTER background service worker (Manifest V3)
// Seeds the installation encryption key on first install.
// HMAC signing is handled by the remote signing service; no secret key is
// stored locally.

const STORAGE_KEY_INSTALL = "jitterInstallKey";
const LEN = 32;

function randomBase64(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.action !== "OPEN_REPORT_PAGE") return;
  const docId = message.docId;
  if (typeof docId !== "string" || !docId.length) {
    sendResponse({ ok: false, error: "missing_doc_id" });
    return;
  }
  const url =
    chrome.runtime.getURL("report.html") + "?doc=" + encodeURIComponent(docId);
  chrome.tabs.create({ url }, () => {
    if (chrome.runtime.lastError) {
      sendResponse({ ok: false, error: String(chrome.runtime.lastError.message || "") });
      return;
    }
    sendResponse({ ok: true });
  });
  return true;
});

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.get([STORAGE_KEY_INSTALL], (result) => {
    const updates = {};
    if (!result || !result[STORAGE_KEY_INSTALL]) {
      updates[STORAGE_KEY_INSTALL] = randomBase64(LEN);
    }
    if (Object.keys(updates).length) {
      chrome.storage.local.set(updates, () => {});
    }
  });
  // Open onboarding on first install (not on update).
  if (details && details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
});
