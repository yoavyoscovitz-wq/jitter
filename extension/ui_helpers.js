/**

 * UI-only helpers for config readiness banners and help navigation (no backend logic).

 */

(function () {

  function jitterHasPlaceholderConfig(values) {

    if (!values || typeof values !== "object") return false;

    return Object.values(values).some(

      (v) => typeof v === "string" && v.includes("YOUR_")

    );

  }



  function jitterGetHelpUrl(hash) {

    var base = "help.html";

    if (hash) {

      base += "#" + String(hash).replace(/^#/, "");

    }

    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {

      return chrome.runtime.getURL(base);

    }

    return base;

  }



  function jitterOpenHelpCenter(hash) {

    var url = jitterGetHelpUrl(hash);

    if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.create) {

      chrome.tabs.create({ url: url });

      return;

    }

    window.open(url, "_blank", "noopener,noreferrer");

  }



  function jitterShowConfigBanner(containerId, message, options) {

    const root =

      typeof containerId === "string"

        ? document.getElementById(containerId)

        : containerId;

    if (!root) return;



    const opts = options && typeof options === "object" ? options : {};

    const showHelpLink = opts.showHelpLink !== false;



    const banner = document.createElement("div");

    banner.className = "jitter-config-banner";

    banner.setAttribute("role", "status");



    const text = document.createElement("span");

    text.textContent =

      message ||

      "Backend URLs are not configured yet. Edit extension/config.js and extension/manifest.json with your deployed endpoints before using signing or registry features.";

    banner.appendChild(text);



    if (showHelpLink) {

      const link = document.createElement("a");

      link.href = jitterGetHelpUrl("getting-started");

      link.className = "jitter-config-banner-link";

      link.textContent = "Open Setup Guide";

      link.addEventListener("click", function (e) {

        e.preventDefault();

        jitterOpenHelpCenter("getting-started");

      });

      banner.appendChild(document.createTextNode(" "));

      banner.appendChild(link);

    }



    root.appendChild(banner);

  }



  function jitterShowSetupTip(containerId) {

    const root =

      typeof containerId === "string"

        ? document.getElementById(containerId)

        : containerId;

    if (!root) return;



    const tip = document.createElement("div");

    tip.className = "jitter-setup-tip";

    tip.setAttribute("role", "note");



    const text = document.createElement("span");

    text.textContent = "Complete setup in the Help Guide";

    tip.appendChild(text);



    const link = document.createElement("a");

    link.href = jitterGetHelpUrl("getting-started");

    link.className = "jitter-setup-tip-link";

    link.textContent = "Open Setup Guide";

    link.addEventListener("click", function (e) {

      e.preventDefault();

      jitterOpenHelpCenter("getting-started");

    });

    tip.appendChild(document.createTextNode(" \u2192 "));

    tip.appendChild(link);



    const dismiss = document.createElement("button");

    dismiss.type = "button";

    dismiss.className = "jitter-setup-tip-dismiss";

    dismiss.setAttribute("aria-label", "Dismiss setup tip");

    dismiss.textContent = "\u00d7";

    dismiss.addEventListener("click", function () {

      tip.remove();

      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {

        chrome.storage.local.set({ help_tip_dismissed: true });

      }

    });

    tip.appendChild(dismiss);



    root.appendChild(tip);

  }



  window.jitterHasPlaceholderConfig = jitterHasPlaceholderConfig;

  window.jitterGetHelpUrl = jitterGetHelpUrl;

  window.jitterOpenHelpCenter = jitterOpenHelpCenter;

  window.jitterShowConfigBanner = jitterShowConfigBanner;

  window.jitterShowSetupTip = jitterShowSetupTip;

})();


