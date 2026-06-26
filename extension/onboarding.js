(function () {
  const TOTAL = 5;
  let index = 0;

  const carousel = document.querySelector(".carousel");
  const slides = document.querySelectorAll(".slide");
  const dots = document.querySelectorAll(".carousel-dot");
  const btnBack = document.getElementById("carousel-back");
  const btnNext = document.getElementById("carousel-next");
  const btnLaunch = document.getElementById("carousel-launch");
  const setupNotice = document.getElementById("setup-notice");
  const helpLink = document.getElementById("onboard-help-link");
  const setupGuideLink = document.getElementById("setup-guide-link");

  if (!carousel || slides.length !== TOTAL || !btnBack || !btnNext || !btnLaunch) return;

  function wireHelpLinks() {
    [helpLink, setupGuideLink].forEach(function (link) {
      if (!link) return;
      link.addEventListener("click", function (e) {
        e.preventDefault();
        if (typeof jitterOpenHelpCenter === "function") {
          jitterOpenHelpCenter("getting-started");
        } else if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
          chrome.tabs.create({ url: chrome.runtime.getURL("help.html#getting-started") });
        }
      });
    });
  }

  function updatePlaceholderNotice() {
    if (!setupNotice) return;
    var show =
      typeof JITTER_CONFIG !== "undefined" &&
      typeof jitterHasPlaceholderConfig === "function" &&
      jitterHasPlaceholderConfig(JITTER_CONFIG);
    setupNotice.classList.toggle("hidden", !show);
  }

  function updateUI() {
    slides.forEach(function (slide, i) {
      var active = i === index;
      slide.classList.toggle("is-active", active);
      slide.setAttribute("aria-hidden", active ? "false" : "true");
    });

    dots.forEach(function (dot, i) {
      var active = i === index;
      dot.classList.toggle("is-active", active);
      dot.setAttribute("aria-selected", active ? "true" : "false");
    });

    var atStart = index === 0;
    var atEnd = index === TOTAL - 1;

    btnBack.classList.toggle("is-concealed", atStart);
    btnBack.disabled = atStart;
    btnBack.setAttribute("aria-hidden", atStart ? "true" : "false");
    btnBack.tabIndex = atStart ? -1 : 0;

    btnNext.hidden = atEnd;
    btnNext.setAttribute("aria-hidden", atEnd ? "true" : "false");

    btnLaunch.hidden = !atEnd;
    btnLaunch.setAttribute("aria-hidden", atEnd ? "false" : "true");

    if (atEnd) {
      updatePlaceholderNotice();
    }
  }

  btnBack.addEventListener("click", function () {
    index = Math.max(0, index - 1);
    updateUI();
  });

  btnNext.addEventListener("click", function () {
    index = Math.min(TOTAL - 1, index + 1);
    updateUI();
  });

  dots.forEach(function (dot) {
    dot.addEventListener("click", function () {
      var to = parseInt(dot.getAttribute("data-slide-to"), 10);
      if (!isNaN(to) && to >= 0 && to < TOTAL) {
        index = to;
        updateUI();
      }
    });
  });

  btnLaunch.addEventListener("click", function () {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ onboarding_complete: true }, function () {
        if (chrome.runtime && chrome.runtime.lastError) {
          /* still close; storage may fail in odd contexts */
        }
        window.close();
      });
    } else {
      window.close();
    }
  });

  carousel.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      index = Math.min(TOTAL - 1, index + 1);
      updateUI();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      index = Math.max(0, index - 1);
      updateUI();
    }
  });

  wireHelpLinks();
  updateUI();
})();
