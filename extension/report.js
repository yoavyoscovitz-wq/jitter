// JITTER Official Audit Report — populates the forensic report from extension storage.
// Requires crypto_layer.js for AES-GCM decryption of stored payloads. HMAC verification
// is performed by the verification portal (JITTER_CONFIG.PORTAL_VERIFY_BASE), not re-derived inside this page.
// Data is loaded for the document ID in the URL (?doc=DOC_ID) or jitterLastDocId.
// JITTER_CONFIG is defined in config.js (loaded before this script in report.html).

const PORTAL_VERIFY_HOST = JITTER_CONFIG.PORTAL_VERIFY_BASE.replace(/^https:\/\//, "");

const MIN_KEYSTROKES = 100;

const REPORT_ERROR_DEFAULT =
  "A minimum of 100 keystrokes must be recorded in a Google Doc with JITTER active before a forensic certificate can be issued.";
const REPORT_ERROR_NO_STORAGE =
  "Browser storage is unavailable. Reload the extension and try again.";
const REPORT_ERROR_NO_DOC =
  "No Google Doc session was found. Open a Google Doc with JITTER active, then reopen this certificate.";
const REPORT_ERROR_STORAGE_READ =
  "Could not read session data from local storage. Try closing and reopening the certificate.";
const REPORT_ERROR_RENDER =
  "The certificate could not be rendered from your session data. Try refreshing the page.";

function getStorageKey(docId, name) {
  return docId + "_" + name;
}

/** Resolve which document's data to load: URL param ?doc= or jitterLastDocId. */
function getReportDocId(cb) {
  const params = new URLSearchParams(typeof location !== "undefined" && location.search || "");
  const fromUrl = params.get("doc");
  if (fromUrl) {
    cb(fromUrl);
    return;
  }
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(["jitterLastDocId"], (r) => {
      cb(r.jitterLastDocId || null);
    });
  } else {
    cb(null);
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function safeNumber(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function mapTier(score) {
  const s = clamp(Math.round(safeNumber(score)), 0, 100);
  if (s >= 90) return { label: "Human Original",  classMod: "verdict-seal--human-original", bad: false, color: "#D4AF37" };
  if (s >= 60) return { label: "Human-Led",      classMod: "verdict-seal--human-led",      bad: false, color: "#D4AF37" };
  if (s >= 20) return { label: "AI-Driven",      classMod: "verdict-seal--ai-driven",      bad: true,  color: "#7f1d1d" };
  return            { label: "AI Generated",     classMod: "verdict-seal--ai-generated",   bad: true,  color: "#7f1d1d" };
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(value);
}

function hashFromTimestamp(ts) {
  const raw = String(ts) + ":" + String((ts * 2654435761) >>> 0);
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h  = Math.imul(h, 0x01000193);
  }
  const hex = (h >>> 0).toString(16).padStart(8, "0");
  return "JTR-" + hex + "-" + (typeof ts === "number" ? ts : Date.now()).toString(16).slice(-8);
}

// ─── Minimal QR code (SVG) for verify URL ─────────────────────────────────────
// Encodes a string as QR Version 5 (37×37), byte mode, EC-M. Outputs SVG.

function qrToSvg(text) {
  const str = String(text || "").slice(0, 75);
  const len = str.length;
  const dataBytes = [];
  dataBytes.push(0x40, len);
  for (let i = 0; i < len; i++) dataBytes.push(str.charCodeAt(i) & 0xff);
  dataBytes.push(0);
  while (dataBytes.length < 86) dataBytes.push((dataBytes.length % 2) ? 0x11 : 0xEC);

  const GF_EXP = [];
  const GF_LOG = [];
  let v = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = v;
    GF_LOG[v] = i;
    v = (v << 1) ^ (v >= 128 ? 0x11D : 0);
  }
  GF_EXP[255] = 1;
  GF_LOG[0] = 255;

  function mul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255];
  }

  function buildGenerator(ecLen) {
    const g = [1];
    for (let i = 0; i < ecLen; i++) {
      g.push(0);
      for (let j = g.length - 1; j >= 1; j--) g[j] = g[j - 1] ^ mul(g[j], GF_EXP[i]);
      g[0] = mul(g[0], GF_EXP[i]);
    }
    return g;
  }

  function rsEncode(data, ecLen) {
    const gen = buildGenerator(ecLen);
    const poly = data.slice();
    for (let i = 0; i < ecLen; i++) poly.push(0);
    for (let i = 0; i < data.length; i++) {
      const k = poly[i];
      if (k !== 0) for (let j = 0; j < gen.length; j++) poly[i + j] ^= mul(gen[j], k);
    }
    return poly.slice(data.length);
  }

  const b1 = dataBytes.slice(0, 43);
  const b2 = dataBytes.slice(43, 86);
  const ec1 = rsEncode(b1, 24);
  const ec2 = rsEncode(b2, 24);
  const codewords = [];
  for (let i = 0; i < 43; i++) { codewords.push(b1[i], b2[i]); }
  for (let i = 0; i < 24; i++) { codewords.push(ec1[i], ec2[i]); }
  let bits = "";
  for (let i = 0; i < codewords.length; i++) {
    for (let b = 7; b >= 0; b--) bits += (codewords[i] >> b) & 1;
  }
  bits += "0000";
  while (bits.length % 8) bits += "0";

  const N = 37;
  const mat = Array(N).fill(0).map(() => Array(N).fill(-1));
  const set = (r, c, v) => { if (r >= 0 && r < N && c >= 0 && c < N && mat[r][c] === -1) mat[r][c] = v; };
  const finder = [[1,1,1,1,1,1,1],[1,0,0,0,0,0,1],[1,0,1,1,1,0,1],[1,0,1,1,1,0,1],[1,0,1,1,1,0,1],[1,0,0,0,0,0,1],[1,1,1,1,1,1,1]];
  for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) {
    set(i, j, finder[i][j]);
    set(i, N - 7 + j, finder[i][j]);
    set(N - 7 + i, j, finder[i][j]);
  }
  for (let i = 8; i <= 28; i++) { set(6, i, i % 2); set(i, 6, i % 2); }
  for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++)
    set(30 + di, 30 + dj, (Math.max(Math.abs(di), Math.abs(dj)) === 2 || (di === 0 && dj === 0)) ? 1 : 0);
  set(29, 8, 1);
  let idx = 0;
  for (let col = N - 1; col >= 0; col -= 2) {
    if (col === 6) continue;
    const upward = (N - 1 - col) % 4 < 2;
    for (let r = upward ? N - 1 : 0; upward ? r >= 0 : r < N; r += upward ? -1 : 1) {
      for (let c = col; c >= col - 1 && c >= 0; c--) {
        if (c === 6) continue;
        if (mat[r][c] === -1 && idx < bits.length) { mat[r][c] = parseInt(bits[idx], 10); idx++; }
      }
    }
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (mat[i][j] === -1) mat[i][j] = 0;
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + N + ' ' + N + '" width="64" height="64">';
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    if (mat[i][j] === 1) svg += '<rect x="' + j + '" y="' + i + '" width="1" height="1" fill="#000"/>';
  }
  svg += "</svg>";
  return svg;
}

function setQrSvgInContainer(container, verifyUrl) {
  if (!container) return;
  container.replaceChildren();
  if (!verifyUrl) return;
  const svgStr = qrToSvg(verifyUrl);
  const parsed = new DOMParser().parseFromString(svgStr, "image/svg+xml");
  const root = parsed && parsed.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg") return;
  container.appendChild(document.importNode(root, true));
}

// ─── Humanity Scale (linear bar) ───────────────────────────────────────────────

function drawHumanityBar(score, color) {
  const fill = document.getElementById("humanity-bar-fill");
  if (!fill) return;
  const pct = clamp(safeNumber(score), 0, 100);
  fill.setAttribute("width", String(pct));
  fill.setAttribute("fill", color || "#1a1a1a");
}

// ─── Signal Wave (real sparkline from jitterLog) ──────────────────────────────

/**
 * Plot actual flight times from jitterLog as a normalized sparkline.
 * Short flights (fast typing) appear HIGH on the chart → pulse-like look.
 * Falls back to a synthetic CV-parameterised wave when data is too sparse.
 */
function drawSignalWave(flightTimes, cvFlight) {
  const path = document.getElementById("signal-path");
  if (!path) return;

  const W = 600;
  const H = 100;

  const valid = Array.isArray(flightTimes)
    ? flightTimes.filter(f => typeof f === "number" && f > 0 && f <= 3000)
    : [];

  if (valid.length < 8) {
    drawSyntheticWave(path, safeNumber(cvFlight), W, H);
    return;
  }

  // Use the most recent 200 samples so the chart reflects recent rhythm.
  const samples = valid.length > 200 ? valid.slice(-200) : valid.slice();

  // Rolling average (±3 neighbours) — smooths noise while preserving character.
  const halfW = 3;
  const smoothed = samples.map((_, i) => {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - halfW); j <= Math.min(samples.length - 1, i + halfW); j++) {
      sum += samples[j]; cnt++;
    }
    return sum / cnt;
  });

  // Percentile-based bounds (p5–p95) to suppress outlier distortion.
  const sorted = [...smoothed].sort((a, b) => a - b);
  const lo = sorted[Math.max(0, Math.floor(sorted.length * 0.05))];
  const hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const range = Math.max(1, hi - lo);

  // Map to SVG coords.
  // norm=0 (fast flight) → top of chart (low y)  — looks like a peak.
  // norm=1 (slow flight) → bottom of chart (high y) — looks like a valley.
  const marginY = 10;
  const plotH   = H - 2 * marginY;
  const n = smoothed.length;

  let d = "";
  for (let i = 0; i < n; i++) {
    const norm = clamp((smoothed[i] - lo) / range, 0, 1);
    const x    = ((i / Math.max(1, n - 1)) * W).toFixed(1);
    const y    = (marginY + norm * plotH).toFixed(1);
    d += (i === 0 ? "M" : "L") + x + "," + y + " ";
  }

  path.setAttribute("d", d.trim());
  path.setAttribute("stroke-width", "0.3");
  path.setAttribute("stroke", "#1A1A1A");
}

/**
 * Fallback: parametric sine-harmonic wave, shaped by CV (used when data < 8 pts).
 */
function drawSyntheticWave(path, cvFlight, W, H) {
  const mid     = H / 2;
  const samples = 48;
  const cv      = safeNumber(cvFlight);
  const organic = cv >= 0.25;
  const ampBase = organic ? 22 : cv < 0.12 ? 4 : 9;

  const pts = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const y = mid
      + Math.sin(t * Math.PI * 7) * ampBase
      + (organic ? Math.sin(t * Math.PI * 15 + 0.8) * (ampBase * 0.4) : 0)
      + (organic ? Math.cos(t * Math.PI * 4.2 + 1.2) * (ampBase * 0.25) : 0);
    pts.push([t * W, y]);
  }

  let d = "";
  pts.forEach((p, idx) => {
    d += (idx === 0 ? "M" : "L") + p[0].toFixed(2) + "," + p[1].toFixed(2) + " ";
  });
  path.setAttribute("d", d.trim());
  path.setAttribute("stroke-width", "0.3");
  path.setAttribute("stroke", "#1A1A1A");
}

// ─── Composition Map ──────────────────────────────────────────────────────────

function nearestPasteRedBucket(alpha, severe) {
  let bestK = 0;
  let bestD = Infinity;
  for (let k = 0; k <= 9; k++) {
    const level = severe
      ? 0.25 + (1 - k / 9) * 0.4
      : 0.12 + (1 - k / 9) * 0.25;
    const d = Math.abs(alpha - level);
    if (d < bestD) {
      bestD = d;
      bestK = k;
    }
  }
  return bestK;
}

function drawCompositionMap(pasteRatio) {
  const grid = document.getElementById("composition-grid");
  if (!grid) return;
  grid.replaceChildren();

  const ratio       = clamp(safeNumber(pasteRatio), 0, 1);
  const total       = 20;
  const compromised = Math.round(total * ratio);
  const severe      = ratio > 0.5;

  for (let i = 0; i < total; i++) {
    const cell = document.createElement("div");
    const fromRight = total - 1 - i;

    if (fromRight < compromised) {
      const t = compromised <= 1 ? 1 : fromRight / Math.max(1, compromised - 1);
      const alpha = severe
        ? (0.25 + (1 - t) * 0.4)
        : (0.12 + (1 - t) * 0.25);
      const k = nearestPasteRedBucket(alpha, severe);
      cell.className = "comp-cell comp-cell--r-" + (severe ? "s" : "m") + k;
    } else {
      cell.className = "comp-cell comp-cell--clean";
    }

    grid.appendChild(cell);
  }
}

// Base64 payload is written into #proof-signature (pre.proof-payload) in populateReport.

// ─── Main populate ────────────────────────────────────────────────────────────

async function populateReport(score, log) {
  const details        = score.details || {};
  const totalKeystrokes = safeNumber(details.totalKeystrokes);
  const sFinal         = clamp(safeNumber(score.S_final), 0, 100);
  const tier           = mapTier(sFinal);
  const vBio           = safeNumber(score.V_bio);
  const pDecay         = safeNumber(score.P_decay);
  const now            = Date.now();

  // ── Meta ─────────────────────────────────────────────────────────────
  const documentId = score.documentId || hashFromTimestamp(now);
  setText("cert-serial", documentId);
  const dateStr = new Date(now).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const timeStr = new Date(now).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  setText(
    "meta-data-strip",
    "Protocol v1.0.0 | " +
      Math.round(sFinal) +
      "% | " +
      dateStr +
      " " +
      timeStr
  );

  // ── Header Line 2: dynamic category only (Line 1 "SYSTEM ATTESTATION" is static HTML)
  setText("hero-tier", tier.label);
  const statusCard = document.getElementById("status-card");
  if (statusCard) {
    statusCard.classList.remove("status-card--pass", "status-card--fail",
      "verdict-seal--human-original", "verdict-seal--human-led",
      "verdict-seal--ai-driven", "verdict-seal--ai-generated");
    statusCard.classList.add(tier.classMod || "");
  }
  // Apply colour class; clear any inline color override
  const heroTierEl = document.getElementById("hero-tier");
  if (heroTierEl) heroTierEl.removeAttribute("style");

  drawHumanityBar(sFinal, tier.color);

  // ── Sparkline (real flight-time data from jitterLog) ──────────────────
  const flightTimes = Array.isArray(log)
    ? log.map(item => item && item.f).filter(f => typeof f === "number" && f > 0 && f <= 3000)
    : [];

  drawSignalWave(flightTimes, details.cvFlight);

  const captionEl = document.getElementById("signal-caption");
  if (captionEl) {
    captionEl.textContent = flightTimes.length >= 8
      ? "Inter-key intervals · " + flightTimes.length + " samples · normalized"
      : "Parametric estimate · insufficient sample depth";
  }

  // ── Composition map ───────────────────────────────────────────────────
  const pasteRatio = details.pasteRatio !== undefined
    ? safeNumber(details.pasteRatio)
    : (safeNumber(details.estimatedDocumentLength) > 0)
      ? safeNumber(details.pastedChars || details.totalPastedChars) /
        Math.max(1, safeNumber(details.estimatedDocumentLength))
      : 0;

  drawCompositionMap(pasteRatio);

  // ── Raw analytics ─────────────────────────────────────────────────────
  const deleted = safeNumber(details.deletedChars);
  const typed      = safeNumber(details.typedChars);
  const pasted     = safeNumber(details.totalPastedChars || details.pastedChars);
  const docLen     = safeNumber(details.estimatedDocumentLength);
  const meanFlight = safeNumber(details.meanFlight);
  const meanDwell  = safeNumber(details.meanDwell);

  setText("raw-keystrokes",   Math.round(totalKeystrokes).toLocaleString());
  setText("raw-typed-deleted", Math.round(typed) + " / " + Math.round(deleted));
  setText("raw-pasted",        Math.round(pasted).toLocaleString());
  setText("raw-doclen",        "~" + Math.round(docLen).toLocaleString() + " chars");
  setText("raw-mean-flight",   Math.round(meanFlight) + " ms");
  setText("raw-mean-dwell",    Math.round(meanDwell)  + " ms");

  // ── Cryptographic proof: signed result + timestamp → Base64 ───────────
  const signedResult = {
    documentId,
    S_final: sFinal,
    totalKeystrokes,
    signature: score.signature || "",
    timestamp: now,
    protocol: "v3.2.0",
  };
  const base64Payload = btoa(unescape(encodeURIComponent(JSON.stringify(signedResult))));
  const proofSigEl = document.getElementById("proof-signature");
  if (proofSigEl) proofSigEl.textContent = base64Payload || "—";

  const stamp = document.getElementById("proof-stamp");
  if (stamp) {
    stamp.classList.toggle("stamp--bad", tier.bad);
    const statusEl = document.getElementById("proof-stamp-status");
    if (statusEl) statusEl.textContent = tier.bad ? "FLAGGED" : "VERIFIED";
    stamp.setAttribute("aria-label", tier.bad ? "JITTER FLAGGED" : "JITTER VERIFIED");
  }

  // ── HMAC-SHA256: display full hash (session signature) ───────────────────
  const hmacSignature = score.signature || "";
  setText("proof-fingerprint", hmacSignature || "(verification unavailable)");

  // ── QR code: same verify portal URL as Image Seal (Google Doc id path) ───
  const idTrim = documentId != null ? String(documentId).trim() : "";
  const verifyUrl =
    idTrim && window.JitterSealClipboard && typeof JitterSealClipboard.verifyHref === "function"
      ? JitterSealClipboard.verifyHref(documentId)
      : idTrim
        ? JITTER_CONFIG.PORTAL_VERIFY_BASE + "/" + idTrim.replace(/^\/+/, "")
        : "";
  const qrLink = document.getElementById("proof-qr-link");
  const qrImage = document.getElementById("proof-qr-image");
  if (qrLink) qrLink.href = verifyUrl;
  setQrSvgInContainer(qrImage, verifyUrl);

  const verifyPortalHostEl = document.getElementById("verify-portal-host");
  if (verifyPortalHostEl) verifyPortalHostEl.textContent = PORTAL_VERIFY_HOST;

  const verifyGuideEl = document.getElementById("proof-verify-guide");
  if (verifyGuideEl) {
    verifyGuideEl.textContent = verifyUrl
      ? "Scan to open the verification portal or visit " + verifyUrl
      : "Open " + PORTAL_VERIFY_HOST + " with your document ID to see registry attestation.";
  }

  // ── PDF metadata embedding (hidden DOM element read by downloadSignedPdf) ─
  const pdfMeta = document.getElementById("jitter-pdf-meta");
  if (pdfMeta) {
    pdfMeta.setAttribute("data-jitter-document-id", documentId);
    pdfMeta.setAttribute("data-jitter-s-final", String(sFinal));
    pdfMeta.setAttribute("data-jitter-signature", score.signature || "");
    pdfMeta.setAttribute("data-jitter-timestamp", String(now));
    pdfMeta.setAttribute("data-jitter-tier", tier.label);
    pdfMeta.setAttribute("data-jitter-protocol", "v3.2.0");
    // entropyData = 64-char SHA-256 hex of canonical score.details — must match content.js /sign body.
    let entropyHex = "";
    if (window.JitterCrypto && typeof JitterCrypto.entropyDigestFromDetails === "function") {
      try {
        entropyHex = await JitterCrypto.entropyDigestFromDetails(details);
      } catch (_) {}
    }
    pdfMeta.setAttribute("data-jitter-entropy", entropyHex);
    // Content fingerprint (same as KV /save + /sign textHash) when persisted on score.
    const thRaw = score.textHash != null ? String(score.textHash).trim() : "";
    if (/^[a-fA-F0-9]{64}$/.test(thRaw)) {
      pdfMeta.setAttribute("data-jitter-text-hash", thRaw.toLowerCase());
    } else {
      pdfMeta.removeAttribute("data-jitter-text-hash");
    }
  }
}

// ─── Show / hide helpers ──────────────────────────────────────────────────────

function hideLoading() {
  const loading = document.getElementById("report-loading");
  if (loading) loading.classList.add("hidden");
}

function setSidebarActive(active) {
  const sidebar = document.getElementById("integrity-seal-hub");
  if (!sidebar) return;
  sidebar.classList.toggle("actions-sidebar--inactive", !active);
  const printBtn = document.getElementById("btn-print");
  const copyBtn = document.getElementById("btn-copy-digital-seal");
  if (printBtn) printBtn.disabled = !active;
  if (copyBtn) copyBtn.disabled = !active;
}

function hideSigningNotice() {
  const notice = document.getElementById("report-signing-notice");
  if (notice) {
    notice.textContent = "";
    notice.classList.add("hidden");
  }
}

function showSigningNotice(message) {
  const notice = document.getElementById("report-signing-notice");
  if (!notice) return;
  notice.textContent = message;
  notice.classList.remove("hidden");
}

function showError(message) {
  hideLoading();
  hideSigningNotice();
  const content = document.getElementById("report-content");
  const err = document.getElementById("report-error");
  const msgEl = document.getElementById("report-error-message");
  if (content) content.classList.add("hidden");
  if (err) err.classList.remove("hidden");
  if (msgEl) msgEl.textContent = message || REPORT_ERROR_DEFAULT;
  setSidebarActive(false);
}

function showContent() {
  hideLoading();
  hideSigningNotice();
  const err = document.getElementById("report-error");
  const content = document.getElementById("report-content");
  const breach = document.getElementById("report-breach");
  if (err) err.classList.add("hidden");
  if (breach) breach.classList.add("hidden");
  if (content) content.classList.remove("hidden");
  setSidebarActive(true);
}

function showBreach() {
  hideLoading();
  hideSigningNotice();
  const content = document.getElementById("report-content");
  const err = document.getElementById("report-error");
  const breach = document.getElementById("report-breach");
  if (content) content.classList.add("hidden");
  if (err) err.classList.add("hidden");
  if (breach) breach.classList.remove("hidden");
  setSidebarActive(false);
}

// ─── Digitally signed PDF (metadata injection + download) ────────────────────
// Generates a PDF from the report DOM, injects the JITTER cryptographic
// signature into multiple PDF Info Dictionary fields (Protocol v3.2.0 layout),
// then triggers a direct file download.
//
// IMPORTANT: The signed PDF must be delivered as a direct download, NOT through
// the browser's print-to-PDF dialog. When a user saves a PDF via the browser
// print dialog, Chrome creates a brand-new PDF that strips all custom metadata
// fields (Keywords, Subject, Author, etc.), making portal verification fail.

async function downloadSignedPdf() {
  const reportWrap = document.querySelector(".report-wrap");
  const pdfMeta = document.getElementById("jitter-pdf-meta");
  if (!reportWrap || !pdfMeta) {
    window.print();
    return;
  }

  const docId = pdfMeta.getAttribute("data-jitter-document-id") || "";
  let signature = pdfMeta.getAttribute("data-jitter-signature") || "";

  const printBtn = document.getElementById("btn-print");
    if (printBtn) {
      printBtn.disabled = true;
    printBtn.textContent = "GENERATING FORENSIC PDF…";
    }

  try {
    // If the stored score was saved while the signing endpoint was unreachable
    // (e.g. missing host permissions), recover by re-signing from the embedded
    // SHA-256 digest (data-jitter-entropy) sent as entropyData to /sign; textHash when present.
    if (!signature && docId) {
      const entropyData = pdfMeta.getAttribute("data-jitter-entropy") || "";
      if (entropyData) {
        try {
          signature = await (async () => {
            const candidateUrls = [JITTER_CONFIG.VAULT_API_BASE + "/sign"];

            let lastErr = null;
            for (const url of candidateUrls) {
              try {
                const th = pdfMeta.getAttribute("data-jitter-text-hash") || "";
                const signBody = { documentId: docId, entropyData };
                if (/^[a-fA-F0-9]{64}$/.test(th)) {
                  signBody.textHash = th.toLowerCase();
                }
                const res = await fetch(url, {
                  method: "POST",
                  mode: "cors",
                  credentials: "omit",
                  cache: "no-store",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(signBody),
                });

                if (!res.ok) {
                  let detail = "";
                  try {
                    const j = await res.json();
                    detail = j && (j.error || j.message)
                      ? " (" + String(j.error || j.message) + ")"
                      : "";
                  } catch (_) {}
                  lastErr = new Error("Signing server returned " + res.status + detail);
                  continue;
                }

                const payload = await res.json();
                const sig =
                  payload && typeof payload.signature === "string"
                    ? payload.signature
                    : payload && payload.data && typeof payload.data.signature === "string"
                      ? payload.data.signature
                      : "";
                if (sig) return sig;

                lastErr = new Error("Signing server returned empty signature");
              } catch (e) {
                lastErr = e instanceof Error ? e : new Error(String(e));
              }
            }

            throw lastErr || new Error("Signing server unreachable");
          })();

          if (signature) {
            pdfMeta.setAttribute("data-jitter-signature", signature);
          }
        } catch (recoverErr) {
          const msg =
            recoverErr && recoverErr.message
              ? String(recoverErr.message)
              : "Signing server unreachable.";
          showSigningNotice(
            "Could not reach the signing service or it rejected the request. " +
              "Signed PDF download requires a valid signature.\n\n" +
              msg
          );
          return;
        }
      }
    }

    if (!signature || !docId) {
      showSigningNotice(
        "Integrity Server Error: Security signature could not be verified. " +
          "If you were offline when saving, reconnect and open the certificate again, or use Print to PDF (metadata may be limited)."
      );
      return;
    }

    if (typeof html2canvas === "undefined" || typeof jspdf === "undefined" || typeof PDFLib === "undefined") {
      window.print();
      return;
    }

    const canvas = await html2canvas(reportWrap, {
      scale: 2,
      useCORS: true,
      logging: false,
      backgroundColor: "#f8f5f2",
    });

    const imgW = 210;
    const imgH = 297;
    const pdf = new jspdf.jsPDF({ orientation: "p", unit: "mm", format: "a4" });
    pdf.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, imgW, imgH);

    const rawPdfBytes = pdf.output("arraybuffer");
    const pdfDoc = await PDFLib.PDFDocument.load(rawPdfBytes);

    // ── Protocol v3.2.0 metadata layout ────────────────────────────────────
    // The verification portal scans the PDF Info Dictionary using two strategies:
    //   Strategy A – JSON.parse on Subject or Keywords → extract {documentId, signature, ...}
    //   Strategy B – raw byte-scan for JITTER marker strings
    //
    // To satisfy both strategies we populate every standard field:
    //   Creator / Producer   → JITTER identity markers (Strategy B)
    //   Subject              → compact JSON payload without large arrays (Strategy A primary)
    //   Author               → "X-Jitter-Signature: <sig>" pattern (Strategy B)
    //   Keywords             → full JSON payload including entropyData (Strategy A HMAC path)

    const entropyData = pdfMeta.getAttribute("data-jitter-entropy") || "";
    const textHashMeta = pdfMeta.getAttribute("data-jitter-text-hash") || "";
    const textHashNorm =
      /^[a-fA-F0-9]{64}$/.test(textHashMeta) ? textHashMeta.toLowerCase() : "";
    const sFinalVal   = pdfMeta.getAttribute("data-jitter-s-final") || "";
    const tierVal     = pdfMeta.getAttribute("data-jitter-tier") || "";
    const tsVal       = pdfMeta.getAttribute("data-jitter-timestamp") || "";

    // Compact payload — no large biometric arrays, safe for all PDF parsers.
    const compactPayload = JSON.stringify({
      jitter: true,
      protocol: "v3.2.0",
      documentId: docId,
      signature,
      sFinal: sFinalVal ? parseFloat(sFinalVal) : undefined,
      tier: tierVal || undefined,
      timestamp: tsVal ? parseInt(tsVal, 10) : undefined,
    });

    // Full payload — entropyData is SHA-256 hex of canonical details; portal/server must match /sign HMAC input.
    const fullPayloadObj = {
      jitter: true,
      protocol: "v3.2.0",
      documentId: docId,
      entropyData,
      signature,
    };
    if (textHashNorm) fullPayloadObj.textHash = textHashNorm;
    const fullPayload = JSON.stringify(fullPayloadObj);

    pdfDoc.setCreator("JITTER");
    pdfDoc.setProducer("JITTER Protocol v3.2.0");
    pdfDoc.setTitle("JITTER Forensic Integrity Certificate");
    // Subject: compact JSON — Strategy A primary parse target.
    pdfDoc.setSubject(compactPayload);
    // Author: legacy marker format must match verify-portal regex exactly:
    //   /X-Jitter-Signature:(\S+)/ and /X-Jitter-DocID:(\S+)/
    pdfDoc.setAuthor("JITTER | X-Jitter-Signature:" + signature + " | X-Jitter-DocID:" + docId);
    // Keywords: full JSON with entropyData (64-char hex digest) — Strategy A HMAC re-verification path.
    pdfDoc.setKeywords([fullPayload]);

    // Also write under a portal-known custom key, in case a PDF reader mangles Keywords.
    // (verify-portal scans JitterPayload/JitterMeta/JitterData/etc + any unknown info-dict keys)
    try {
      const infoDict = pdfDoc.getInfoDict?.();
      if (infoDict && PDFLib?.PDFName && PDFLib?.PDFHexString) {
        infoDict.set(PDFLib.PDFName.of("JitterPayload"), PDFLib.PDFHexString.fromText(fullPayload));
        infoDict.set(PDFLib.PDFName.of("JitterSignature"), PDFLib.PDFHexString.fromText(signature));
        infoDict.set(PDFLib.PDFName.of("JitterDocumentId"), PDFLib.PDFHexString.fromText(docId));
      }
    } catch (_) {}

    // Save without object streams for maximal parser compatibility across pdf-lib versions.
    const modifiedPdfBytes = await pdfDoc.save({ useObjectStreams: false });
    const blob = new Blob([modifiedPdfBytes], { type: "application/pdf" });
    const blobUrl = URL.createObjectURL(blob);
    const fileName =
      "JITTER-Report-" + (docId.replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 32)) + ".pdf";

    // Always deliver via direct download — this is the ONLY way to guarantee the
    // PDF Info Dictionary metadata survives intact. Never use iframe + window.print()
    // as the primary path: the browser print-to-PDF dialog creates a new stripped PDF.
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Revoke after a generous delay so the download can fully transfer.
    setTimeout(() => {
      try { URL.revokeObjectURL(blobUrl); } catch (_) {}
    }, 60_000);

  } catch (err) {
    window.print();
  } finally {
    if (printBtn) {
      printBtn.disabled = false;
      printBtn.textContent = "DOWNLOAD FORENSIC REPORT PDF";
    }
  }
}

function getReportVerifyDocId() {
  var hub = document.getElementById("integrity-seal-hub");
  if (hub && hub.hasAttribute("data-verify-doc-id")) {
    return hub.getAttribute("data-verify-doc-id") || "";
  }
  var meta = document.getElementById("jitter-pdf-meta");
  return (meta && meta.getAttribute("data-jitter-document-id")) || "";
}

function updateReportSealHub(googleDocId) {
  var hub = document.getElementById("integrity-seal-hub");
  var id = googleDocId != null ? String(googleDocId).trim() : "";
  if (hub) {
    hub.setAttribute("data-verify-doc-id", id);
  }
  var el = document.getElementById("seal-hub-doc-id");
  if (el) el.textContent = id || "—";
}

// ─── Digital Integrity Seal clipboard (MV3-friendly rich HTML copy) ─────────

function sanitizeVerifyDocId(docId) {
  return String(docId || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\s+/g, "");
}

function buildDigitalIntegritySealElement(docId) {
  var id = sanitizeVerifyDocId(docId);
  var verifyHref = JITTER_CONFIG.PORTAL_VERIFY_BASE + "/" + id;
  var a = document.createElement("a");
  a.setAttribute("data-jitter-seal", "1");
  a.setAttribute("href", verifyHref);
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

async function copyTextHtmlToClipboard(plainText, sealDocId) {
  var sealEl = buildDigitalIntegritySealElement(sealDocId);
  var html = sealEl.outerHTML;
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.write === "function" &&
      typeof ClipboardItem !== "undefined"
    ) {
      var item = new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plainText || ""], { type: "text/plain" }),
      });
      await navigator.clipboard.write([item]);
      return;
    }
  } catch (_) {
    // fall through to execCommand fallback
  }

  if (typeof document === "undefined" || !document.body || typeof document.execCommand !== "function") {
    throw new Error("Clipboard API not available");
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
    if (!ok) throw new Error("Copy failed");
  } finally {
    try {
      if (div.parentNode) div.parentNode.removeChild(div);
    } catch (_) {}
  }
}
// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function init() {
  if (
    typeof JITTER_CONFIG !== "undefined" &&
    typeof jitterHasPlaceholderConfig === "function" &&
    jitterHasPlaceholderConfig(JITTER_CONFIG)
  ) {
    jitterShowConfigBanner("report-config-banner-root", undefined, { showHelpLink: true });
  }

  setSidebarActive(false);

  const railEl = document.getElementById("report-security-rail-text");
  if (railEl && !railEl.textContent.trim()) {
    const part =
      "JITTER BIOMETRIC AUTHENTICITY STANDARD \u2022 OPEN PROTOCOL \u2022 ";
    railEl.textContent = new Array(56).join(part);
  }

  const printBtn = document.getElementById("btn-print");
  if (printBtn) printBtn.addEventListener("click", () => downloadSignedPdf());

  const copySealBtn = document.getElementById("btn-copy-digital-seal");
  const copyConfirmEl = document.getElementById("seal-copy-confirm");
  if (copySealBtn) {
    copySealBtn.addEventListener("click", async () => {
      var docId = getReportVerifyDocId();
      var safeId = sanitizeVerifyDocId(docId || "");
      var plain = JITTER_CONFIG.PORTAL_VERIFY_BASE + "/" + safeId;
      copySealBtn.disabled = true;

      try {
        await copyTextHtmlToClipboard(plain, safeId);
        if (copyConfirmEl) {
          copyConfirmEl.textContent = "Copied! ✓";
          copyConfirmEl.classList.remove("actions-sidebar__copy-confirm--error");
          copyConfirmEl.classList.add("actions-sidebar__copy-confirm--show");
          setTimeout(() => {
            copyConfirmEl.classList.remove("actions-sidebar__copy-confirm--show");
          }, 650);
        }
      } catch (_) {
        if (copyConfirmEl) {
          copyConfirmEl.textContent = "Copy failed";
          copyConfirmEl.classList.add("actions-sidebar__copy-confirm--error");
          copyConfirmEl.classList.add("actions-sidebar__copy-confirm--show");
          setTimeout(() => {
            copyConfirmEl.classList.remove("actions-sidebar__copy-confirm--show");
          }, 1100);
        }
      } finally {
        copySealBtn.disabled = false;
      }
    });
  }

  const annexToggle = document.getElementById("annex-toggle");
  const annexBody = document.getElementById("annex-body");
  if (annexToggle && annexBody) {
    annexToggle.addEventListener("click", () => {
      const open = annexBody.classList.toggle("open");
      annexToggle.setAttribute("aria-expanded", String(open));
    });
  }

  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
    updateReportSealHub("");
    showError(REPORT_ERROR_NO_STORAGE);
    return;
  }

  getReportDocId((docId) => {
    updateReportSealHub(docId || "");

    if (!docId) {
      showError(REPORT_ERROR_NO_DOC);
      return;
    }

    const keyLog = getStorageKey(docId, "jitterLog");
    const keyScore = getStorageKey(docId, "jitterScore");

    chrome.storage.local.get([keyLog, keyScore], async (result) => {
      if (chrome.runtime.lastError) {
        updateReportSealHub("");
        showError(REPORT_ERROR_STORAGE_READ);
        return;
      }

      let log = result[keyLog];
      let score = result[keyScore] || null;
      let storageBreach = false;

      if (window.JitterCrypto) {
        try {
          const rawScore = result[keyScore];
          if (rawScore && JitterCrypto.isEncrypted(rawScore)) {
            const decScore = await JitterCrypto.decryptJitterData(rawScore);
            if (decScore == null) {
              storageBreach = true;
            } else {
              score = decScore;
            }
          }

          const rawLog = result[keyLog];
          if (rawLog && JitterCrypto.isEncrypted(rawLog)) {
            const decLog = await JitterCrypto.decryptJitterData(rawLog);
            if (decLog == null) {
              storageBreach = true;
              log = [];
            } else {
              log = Array.isArray(decLog) ? decLog : [];
            }
          } else if (rawLog && !JitterCrypto.isEncrypted(rawLog)) {
            log = rawLog;
          }
        } catch (e) {
          storageBreach = true;
          log = [];
          score = null;
        }
      }

      if (storageBreach) {
        showBreach();
        return;
      }

      if (!Array.isArray(log)) log = [];

      const totalKeystrokes = score && score.details
        ? safeNumber(score.details.totalKeystrokes)
        : log.length;

      if (!score || totalKeystrokes < MIN_KEYSTROKES) {
        showError(REPORT_ERROR_DEFAULT);
        return;
      }

      showContent();
      try {
        await populateReport(score, log);
      } catch (_) {
        showError(REPORT_ERROR_RENDER);
      }
    });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
