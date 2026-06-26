/**
 * Single source of truth for Help Center copy (Getting Started, How to Use, FAQ).
 */
(function () {
  var JITTER_HELP_CONTENT = {
    sections: [
      {
        id: "getting-started",
        title: "Getting Started",
        intro:
          "Follow these steps after cloning JITTER from GitHub. There is no API key in the extension — only backend URLs and a server-side HMAC secret.",
        callout: {
          type: "info",
          text: "There is no API key in the extension. You deploy your own backend, set JITTER_HMAC_SECRET on the server, and paste your deployed URLs into config.js.",
        },
        steps: [
          {
            title: "Prerequisites",
            body: "Install Google Chrome, Node.js 18+, and the Wrangler CLI: npm install -g wrangler",
          },
          {
            title: "Generate your server secret",
            body: 'Run: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" — save the output as JITTER_HMAC_SECRET. This stays on your server only; never put it in the extension.',
          },
          {
            title: "Deploy the HMAC vault",
            body: "Deploy server/functions/sign.js and server/functions/verify.js as Cloudflare Pages Functions. Set the JITTER_HMAC_SECRET secret on that project. The base URL becomes VAULT_API_BASE in extension/config.js and YOUR_API_DOMAIN in extension/manifest.json.",
          },
          {
            title: "Deploy the registry worker",
            body: "In server/jitter-db-api/: run npm install, create a KV namespace (wrangler kv namespace create JITTER_ATTESTATIONS), add the id to wrangler.toml, then wrangler deploy. Use the worker URL + /save as REGISTRY_SAVE_URL in config.js and YOUR_REGISTRY_DOMAIN in manifest.json.",
          },
          {
            title: "Host the verify portal",
            body: "Host the static verify/ folder (Cloudflare Pages, Netlify, or GitHub Pages). Edit verify/script.js — set VAULT_API and ATTESTATION_API_BASE to your deployed endpoints. Set PORTAL_VERIFY_BASE in extension/config.js to your portal origin.",
          },
          {
            title: "Configure the extension",
            body: "Edit extension/config.js — replace all six YOUR_* placeholders: VAULT_API_BASE, REGISTRY_SAVE_URL, PORTAL_VERIFY_BASE, SEAL_IMAGE_URL, SEAL_VERIFY_HOST, SEAL_IMG_MARKER. Edit extension/manifest.json — replace YOUR_API_DOMAIN, YOUR_REGISTRY_DOMAIN, and YOUR_SEAL_IMAGE_DOMAIN to match your deployed hosts.",
          },
          {
            title: "Load the extension in Chrome",
            body: "Open chrome://extensions, enable Developer mode, click Load unpacked, and select the extension/ folder from your clone.",
          },
          {
            title: "Validate your vault",
            body: "From the repo root, set JITTER_HMAC_SECRET and VAULT_BASE (your vault origin), then run: node e2e-vault-verify.mjs — exit code 0 means signing works.",
          },
          {
            title: "First use",
            body: "Open a Google Doc and type naturally. After roughly 100 keystrokes, the Dragon Guardian HUD appears with your Humanity tier. Click the JITTER icon in the toolbar to open the popup.",
          },
        ],
      },
      {
        id: "how-to-use",
        title: "How to Use",
        intro: "Daily workflow once your backend is configured.",
        steps: [
          {
            title: "Write in Google Docs",
            body: "JITTER runs silently while you type. Keystroke timing stays on your device. The Dragon Guardian HUD shows your tier (Human Original, Human-Led, and so on) after calibration.",
          },
          {
            title: "Open the popup",
            body: "Click the JITTER extension icon to see your current Humanity tier, session duration, and keystroke count.",
          },
          {
            title: "Open Certificate",
            body: "From the popup, click Open Certificate to view a forensic report you can export as PDF. It includes a QR code linking to your verify portal.",
          },
          {
            title: "Copy Seal",
            body: "Click Copy Seal to copy rich HTML for pasting into Google Docs or email. The seal embeds a verification link recipients can check.",
          },
          {
            title: "Awaken Dragon",
            body: "If you dismissed the in-doc HUD, use Awaken Dragon in the popup to bring it back on the current document.",
          },
          {
            title: "Verify for others",
            body: "Share your PDF certificate or pasted seal. Anyone can verify authenticity at your hosted verify portal by uploading the PDF or pasting the seal HTML.",
          },
        ],
      },
    ],
    faq: [
      {
        q: "Do you read my document text?",
        a: "No. JITTER analyzes keystroke timing locally on your device. Only a privacy-preserving hash of writing metadata is sent to your signing server — never raw document text. See docs/PRIVACY.md in the repository for the full disclosure.",
      },
      {
        q: "What permissions does JITTER need and why?",
        a: "Storage (save session data locally), tabs (open report and help pages), and host access to Google Docs (keystroke sensor), your vault API, registry worker, and seal image host (signing and clipboard features).",
      },
      {
        q: "Why is signing or registry failing?",
        a: "Most often extension/config.js or manifest.json still contains YOUR_* placeholders, or your backend is not deployed. Open the Setup Guide and complete all deployment steps, then reload the extension.",
      },
      {
        q: "Can I use JITTER without deploying a backend?",
        a: "Local Humanity scoring and the Dragon HUD work without a backend. Cryptographic certificates, registry attestation, and clipboard seals require your deployed vault and registry.",
      },
      {
        q: "What sites are supported?",
        a: "Google Docs is the primary supported platform. The content script is wired for docs.google.com.",
      },
      {
        q: "How long until the HUD appears?",
        a: "After roughly 100 keystrokes in a Google Doc, once calibration has enough signal. Keep typing naturally — no special test required.",
      },
      {
        q: "What do the tier names mean?",
        a: "Human Original (90–100): high-confidence organic typing. Human-Led (60–89): primarily human with some assistance signals. AI-Driven (20–59): significant AI indicators. AI Generated (0–19): minimal biometric signal.",
      },
      {
        q: "How do I reopen this guide?",
        a: "Click the ? button in the extension popup anytime, or open Help from the welcome tour. You can also replay the welcome carousel from the link at the bottom of this page.",
      },
      {
        q: "Is my data encrypted locally?",
        a: "Yes. Session data is encrypted with AES-256-GCM in chrome.storage.local before persistence.",
      },
      {
        q: "Who can verify my certificate?",
        a: "Anyone with your PDF certificate, pasted seal, or verification link can independently verify the HMAC signature through your hosted verify portal.",
      },
    ],
    footerLinks: [
      { label: "Replay welcome tour", href: "onboarding.html" },
      { label: "Privacy (docs/PRIVACY.md)", href: "https://github.com/yoavyoscovitz-wq/jitter/blob/main/docs/PRIVACY.md", external: true },
      { label: "API contracts (docs/CONTRACTS.md)", href: "https://github.com/yoavyoscovitz-wq/jitter/blob/main/docs/CONTRACTS.md", external: true },
    ],
  };

  window.JITTER_HELP_CONTENT = JITTER_HELP_CONTENT;
})();
