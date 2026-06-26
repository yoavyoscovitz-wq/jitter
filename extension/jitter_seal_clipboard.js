/**
 * JITTER Digital Seal — clipboard via DOM selection + execCommand('copy').
 * Rich HTML (external img URL) so Google Docs accepts the pasted seal.
 * Requires config.js loaded first (JITTER_CONFIG).
 */
(function (global) {
  "use strict";

  function verifyHref(docId) {
    var id = docId != null ? String(docId).trim() : "";
    if (!id) return JITTER_CONFIG.PORTAL_VERIFY_BASE + "/";
    return JITTER_CONFIG.PORTAL_VERIFY_BASE + "/" + id.replace(/^\/+/, "");
  }

  function buildSealElement(docId) {
    var href = verifyHref(docId);
    var a = document.createElement("a");
    a.setAttribute("data-jitter-seal", "1");
    a.setAttribute("href", href);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
    a.setAttribute(
      "style",
      "text-decoration:none; background-color:transparent; display:inline-block; line-height:0;"
    );
    a.appendChild(document.createTextNode("\u200B"));
    var img = document.createElement("img");
    img.setAttribute("src", JITTER_CONFIG.SEAL_IMAGE_URL);
    img.setAttribute("alt", "JITTER CERTIFIED");
    img.setAttribute("width", "110");
    img.setAttribute(
      "style",
      "border:none; display:inline-block; background-color:transparent; vertical-align:middle;"
    );
    a.appendChild(img);
    a.appendChild(document.createTextNode("\u200B"));
    return a;
  }

  function copySeal(docId) {
    return new Promise(async function (resolve, reject) {
      if (typeof document === "undefined" || !document.body) {
        reject(new Error("No document context for copy"));
        return;
      }

      var sealEl = buildSealElement(docId);
      var html = sealEl.outerHTML;

      try {
        if (
          typeof navigator !== "undefined" &&
          navigator.clipboard &&
          typeof navigator.clipboard.write === "function" &&
          typeof ClipboardItem !== "undefined"
        ) {
          var plain = verifyHref(docId);
          var item = new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([plain], { type: "text/plain" }),
          });
          await navigator.clipboard.write([item]);
          resolve();
          return;
        }
      } catch (_) {
        // Ignore and fall back to execCommand.
      }

      if (typeof document.execCommand !== "function") {
        reject(new Error("execCommand not available"));
        return;
      }

      var div = document.createElement("div");
      div.setAttribute(
        "style",
        "position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;"
      );
      div.appendChild(sealEl.cloneNode(true));
      document.body.appendChild(div);

      try {
        var selection = window.getSelection();
        var range = document.createRange();
        range.selectNodeContents(div);
        selection.removeAllRanges();
        selection.addRange(range);

        var ok = document.execCommand("copy");

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
        } catch (_) {}
        reject(err);
      }
    });
  }

  global.JitterSealClipboard = {
    copySeal: copySeal,
    verifyHref: verifyHref,
    SEAL_IMAGE_URL: JITTER_CONFIG.SEAL_IMAGE_URL,
  };
})(typeof window !== "undefined" ? window : self);