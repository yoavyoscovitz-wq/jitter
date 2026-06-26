(function () {
  var content = window.JITTER_HELP_CONTENT;
  var mainEl = document.getElementById("help-main");
  var footerEl = document.getElementById("help-footer");
  var navBtns = document.querySelectorAll(".help-nav-btn");

  if (!content || !mainEl) return;

  function resolveHref(href) {
    if (!href) return "#";
    if (href.indexOf("http") === 0) return href;
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
      return chrome.runtime.getURL(href);
    }
    return href;
  }

  function renderSections() {
    var html = "";

    content.sections.forEach(function (section) {
      html += '<section class="help-panel" id="' + section.id + '" data-panel="' + section.id + '">';
      if (section.intro) {
        html += '<p class="help-panel-intro">' + section.intro + "</p>";
      }
      if (section.callout) {
        html +=
          '<div class="help-callout help-callout--' +
          (section.callout.type || "info") +
          '">' +
          section.callout.text +
          "</div>";
      }
      if (section.steps && section.steps.length) {
        html += '<ol class="help-steps">';
        section.steps.forEach(function (step, i) {
          html +=
            '<li class="help-step">' +
            '<span class="help-step-num" aria-hidden="true">' +
            (i + 1) +
            "</span>" +
            '<div class="help-step-body">' +
            '<h2 class="help-step-title">' +
            step.title +
            "</h2>" +
            '<p class="help-step-text">' +
            step.body +
            "</p>" +
            "</div></li>";
        });
        html += "</ol>";
      }
      html += "</section>";
    });

    html += '<section class="help-panel" id="faq" data-panel="faq">';
    html += '<p class="help-panel-intro">Common questions about privacy, setup, and daily use.</p>';
    html += '<div class="help-faq">';
    content.faq.forEach(function (item, i) {
      html +=
        '<div class="help-faq-item" id="faq-' +
        i +
        '">' +
        '<button type="button" class="help-faq-q" aria-expanded="false" aria-controls="faq-a-' +
        i +
        '">' +
        item.q +
        "</button>" +
        '<p class="help-faq-a" id="faq-a-' +
        i +
        '" hidden>' +
        item.a +
        "</p></div>";
    });
    html += "</div></section>";

    mainEl.innerHTML = html;
  }

  function renderFooter() {
    if (!footerEl || !content.footerLinks) return;
    footerEl.innerHTML = content.footerLinks
      .map(function (link) {
        var href = resolveHref(link.href);
        var attrs = link.external ? ' target="_blank" rel="noopener noreferrer"' : "";
        return '<a href="' + href + '"' + attrs + ">" + link.label + "</a>";
      })
      .join("");
  }

  function showSection(sectionId) {
    var panels = mainEl.querySelectorAll(".help-panel");
    panels.forEach(function (panel) {
      var active = panel.getAttribute("data-panel") === sectionId;
      panel.classList.toggle("is-active", active);
      panel.setAttribute("aria-hidden", active ? "false" : "true");
    });

    navBtns.forEach(function (btn) {
      var active = btn.getAttribute("data-section") === sectionId;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });

    if (history.replaceState) {
      history.replaceState(null, "", "#" + sectionId);
    } else {
      location.hash = sectionId;
    }

    mainEl.focus();
  }

  function bindFaq() {
    mainEl.querySelectorAll(".help-faq-q").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var item = btn.closest(".help-faq-item");
        var answer = item && item.querySelector(".help-faq-a");
        if (!item || !answer) return;
        var open = item.classList.toggle("is-open");
        btn.setAttribute("aria-expanded", open ? "true" : "false");
        answer.hidden = !open;
      });
    });
  }

  function initFromHash() {
    var hash = (location.hash || "").replace(/^#/, "");
    var valid = ["getting-started", "how-to-use", "faq"];
    var section = valid.indexOf(hash) >= 0 ? hash : "getting-started";
    showSection(section);
  }

  renderSections();
  renderFooter();
  bindFaq();

  navBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      showSection(btn.getAttribute("data-section"));
    });
  });

  window.addEventListener("hashchange", initFromHash);
  initFromHash();
})();
