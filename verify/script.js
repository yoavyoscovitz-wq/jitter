/**
 * JITTER Verification Engine — script.js
 * ─────────────────────────────────────────────────────────────────
 * Orchestrates three-phase document verification:
 *   1. Local PDF parsing via pdf-lib (zero-knowledge, no upload)
 *   2. JITTER v3.2+ metadata: one JSON object in Keywords (or JITTER_CUSTOM_KEYS)
 *      { documentId, entropyData, signature } where entropyData is a 64-char SHA-256 hex digest
 *   3. Vault API handshake → { verified: true|false }
 *
 * All file content stays in the browser. Only the extracted metadata
 * fields are transmitted to the verification endpoint. Registry attestation
 * (Worker GET /verify/:id) exposes score, wordCount, and textHash (SHA-256
 * hex). Content integrity compares registry textHash to PDF-embedded textHash
 * (not PDF body text; certificate PDFs are image-based).
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   §1  CONSTANTS
═══════════════════════════════════════════════════════════════ */

// Replace these with your deployed backend URLs (see .env.example at repository root).
const VAULT_API = 'YOUR_VAULT_API_BASE_URL/verify';
const VAULT_TIMEOUT_MS = 14000;
const ATTESTATION_API_BASE = 'YOUR_REGISTRY_SAVE_URL'.replace('/save', '/verify/');
const ATTESTATION_TIMEOUT_MS = 8000;

const VERIFY_CONFIG_PLACEHOLDER_MESSAGE =
  'Backend URLs are not configured yet. Edit the constants at the top of script.js with your deployed vault and registry endpoints.';

function verifyHasPlaceholderConfig() {
  return [VAULT_API, ATTESTATION_API_BASE].some(
    (v) => typeof v === 'string' && v.includes('YOUR_')
  );
}

function showVerifyConfigBanner() {
  const root = $('verify-config-banner-root');
  if (!root || root.querySelector('.jitter-config-banner')) return;
  const banner = document.createElement('div');
  banner.className = 'jitter-config-banner';
  banner.setAttribute('role', 'status');
  banner.textContent = VERIFY_CONFIG_PLACEHOLDER_MESSAGE;
  root.appendChild(banner);
}

function showAttestationRouteNotice(message) {
  const el = $('attestationRouteNotice');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
}

function hideAttestationRouteNotice() {
  const el = $('attestationRouteNotice');
  if (!el) return;
  el.textContent = '';
  el.classList.add('hidden');
}

/** Field names the JITTER Chrome extension may use for custom PDF props. */
const JITTER_CUSTOM_KEYS = [
  'JitterData', 'jitterData', 'JITTER_DATA',
  'JitterMeta', 'jitterMeta', 'JITTER_META',
  'JitterPayload', 'jitterPayload',
  'JitterSignature', 'jitterSignature',
  'jitter', 'JITTER',
];

/** entropyData / registry textHash must be exactly 64 hexadecimal characters (SHA-256 digest). */
const ENTROPY_DIGEST_HEX_RE = /^[a-fA-F0-9]{64}$/;

/** Shown when extracted PDF text hash does not match the institutional registry. */
const CONTENT_HASH_MISMATCH_MSG =
  'Content integrity check failed: The document content does not match the registered version.';

/* ═══════════════════════════════════════════════════════════════
   §2  DOM REFERENCES
═══════════════════════════════════════════════════════════════ */

const $ = id => document.getElementById(id);

const DOM = {
  card:         $('portalCard'),
  dropZone:     $('dropZone'),
  dropInner:    $('dropZoneInner'),
  fileInput:    $('fileInput'),

  states: {
    idle:    $('stateIdle'),
    audit:   $('stateAuditing'),
    success: $('stateSuccess'),
    failure: $('stateFailure'),
    breach:  $('stateBreach'),
  },

  cert: {
    timestamp: $('certTimestamp'),
    docId:     $('certDocId'),
    humanityScore: $('certHumanityScore'),
    fileSize:  $('certFileSize'),
    hash:      $('certHash'),
  },

  failMessage:  $('failMessage'),
  breachDetail: $('breachDetail'),

  attestation: {
    card:        $('attestationCard'),
    score:       $('attestationScore'),
    scoreLabel:  $('attestationScoreLabel'),
    wordCount:   $('attestationWordCount'),
    fingerprint: $('attestationFingerprint'),
    copyBtn:     $('attestationCopyHash'),
  },
};

let attestationCopyHandlerWired = false;

/* ═══════════════════════════════════════════════════════════════
   §3  STATE MANAGER
═══════════════════════════════════════════════════════════════ */

let currentState    = 'idle';
let lastReceiptData = null;

/**
 * Transitions the portal to a named state.
 * Hides every state panel, applies card modifier classes,
 * and reveals only the target panel.
 */
function showState(name) {
  Object.values(DOM.states).forEach(el => el?.classList.add('hidden'));
  DOM.card.classList.remove(
    'state-success', 'state-failure', 'state-breach', 'drag-active'
  );
  currentState = name;

  DOM.states[name]?.classList.remove('hidden');

  if (name === 'success') DOM.card.classList.add('state-success');
  if (name === 'failure') DOM.card.classList.add('state-failure');
  if (name === 'breach')  DOM.card.classList.add('state-breach');
}

function resetPortal() {
  DOM.fileInput.value = '';
  DOM.dropInner.classList.remove('audit-active');
  resetAuditSteps();
  lastReceiptData = null;
  showState('idle');
}

/* ═══════════════════════════════════════════════════════════════
   §3A  ROUTE-LEVEL ATTESTATION CARD
═══════════════════════════════════════════════════════════════ */

/**
 * Resolves document id from SEAL / portal URL: query (?id= / ?docId= / ?documentId=)
 * or path (.../verify/:id or trailing path segment). Returns null if none.
 */
function getDocIdFromURL() {
  const params = new URLSearchParams(window.location.search);
  for (const key of ['id', 'docId', 'documentId']) {
    const raw = params.get(key);
    if (raw == null) continue;
    const v = decodeURIComponent(raw).trim();
    if (v) return v;
  }

  const pathParts = window.location.pathname.split('/').filter(Boolean);
  if (!pathParts.length) return null;

  const verifyIdx = pathParts.findIndex(p => p.toLowerCase() === 'verify');
  if (verifyIdx >= 0 && pathParts[verifyIdx + 1]) {
    const v = decodeURIComponent(pathParts[verifyIdx + 1]).trim();
    if (v) return v;
  }

  const last = decodeURIComponent(pathParts[pathParts.length - 1]).trim();
  if (!last || /^index\.html$/i.test(last) || last.toLowerCase() === 'verify') {
    return null;
  }
  return last;
}

function hideAttestationCard() {
  DOM.attestation.card?.classList.remove('is-human', 'is-mixed', 'is-ai');
  DOM.attestation.card?.classList.add('hidden');
  if (DOM.attestation.fingerprint) {
    DOM.attestation.fingerprint.textContent = '\u2014';
    DOM.attestation.fingerprint.removeAttribute('title');
    delete DOM.attestation.fingerprint.dataset.fullHash;
  }
  if (DOM.attestation.copyBtn) {
    DOM.attestation.copyBtn.hidden = true;
  }
}

function wireAttestationCopyButtonOnce() {
  if (attestationCopyHandlerWired || !DOM.attestation.copyBtn) return;
  attestationCopyHandlerWired = true;
  DOM.attestation.copyBtn.addEventListener('click', async () => {
    const full = DOM.attestation.fingerprint?.dataset.fullHash;
    if (!full) return;
    try {
      await navigator.clipboard.writeText(full);
      const prev = DOM.attestation.copyBtn.textContent;
      DOM.attestation.copyBtn.textContent = 'Copied';
      setTimeout(() => {
        DOM.attestation.copyBtn.textContent = prev;
      }, 1600);
    } catch (_) {
      /* clipboard denied */
    }
  });
}

function showAttestationCard(data) {
  if (!DOM.attestation.card) return;
  wireAttestationCopyButtonOnce();

  const score = data?.score ?? data?.Score;
  const wordCount = data?.wordCount ?? data?.word_count;
  const textHash =
    data?.textHash ??
    data?.text_hash ??
    (typeof data?.hash === 'string' ? data.hash : null);

  const scoreValue = parseAttestationScore(score);
  const scoreTier = getAttestationScoreTier(scoreValue);

  DOM.attestation.card.classList.remove('is-human', 'is-mixed', 'is-ai');
  DOM.attestation.card.classList.add(scoreTier?.cssClass ?? 'is-mixed');
  if (DOM.attestation.score) {
    DOM.attestation.score.textContent = formatAttestationScore(scoreValue);
  }
  if (DOM.attestation.scoreLabel) {
    DOM.attestation.scoreLabel.textContent = scoreTier?.label ?? 'Unknown';
  }
  if (DOM.attestation.wordCount) {
    DOM.attestation.wordCount.textContent = formatAttestationWordCount(wordCount);
  }

  const fp = normalizeRegistryTextHash(
    typeof textHash === 'string' ? textHash : textHash != null ? String(textHash) : ''
  );
  if (DOM.attestation.fingerprint) {
    if (fp) {
      DOM.attestation.fingerprint.textContent = `${fp.slice(0, 12)}...`;
      DOM.attestation.fingerprint.title = fp;
      DOM.attestation.fingerprint.dataset.fullHash = fp;
    } else {
      DOM.attestation.fingerprint.textContent = 'No content fingerprint in registry.';
      DOM.attestation.fingerprint.removeAttribute('title');
      delete DOM.attestation.fingerprint.dataset.fullHash;
    }
  }
  if (DOM.attestation.copyBtn) {
    DOM.attestation.copyBtn.hidden = !fp;
  }

  DOM.attestation.card.classList.remove('hidden');
}

function parseAttestationScore(score) {
  if (typeof score === 'number' && Number.isFinite(score)) {
    return score > 0 && score <= 1 ? score * 100 : score;
  }
  const parsed = Number.parseFloat(String(score ?? '').replace('%', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function formatAttestationScore(scoreValue) {
  if (typeof scoreValue !== 'number' || !Number.isFinite(scoreValue)) return 'N/A';
  const pct = Math.max(0, Math.min(100, Math.round(scoreValue)));
  return `${pct}%`;
}

function getAttestationScoreTier(scoreValue) {
  if (typeof scoreValue !== 'number' || !Number.isFinite(scoreValue)) {
    return {
      cssClass: 'is-mixed',
      label: 'Unknown',
    };
  }

  if (scoreValue >= 90) {
    return {
      cssClass: 'is-human',
      label: 'Human Original',
    };
  }

  if (scoreValue >= 60) {
    return {
      cssClass: 'is-human',
      label: 'Human-Led',
    };
  }

  if (scoreValue >= 20) {
    return {
      cssClass: 'is-mixed',
      label: 'AI-Driven',
    };
  }

  return {
    cssClass: 'is-ai',
    label: 'AI Generated',
  };
}

function formatAttestationWordCount(wordCount) {
  const count = Number.parseInt(wordCount, 10);
  if (Number.isFinite(count)) return count.toLocaleString();
  return 'N/A';
}

/** @returns {string|null} lowercase 64-char hex or null */
function normalizeRegistryTextHash(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim().toLowerCase();
  return ENTROPY_DIGEST_HEX_RE.test(t) ? t : null;
}

async function fetchAttestationData(docId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTESTATION_TIMEOUT_MS);
  try {
    const endpoint = `${ATTESTATION_API_BASE}${encodeURIComponent(docId)}`;
    const response = await fetch(endpoint, {
      method: 'GET',
      mode: 'cors',
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.found === false) return null;

    const score = data.score ?? data.Score;
    const wordCount = data.wordCount ?? data.word_count;
    const textHashRaw =
      data.textHash ?? data.text_hash ?? data.hash ?? data.contentHash ?? data.content_hash;
    const textHash =
      typeof textHashRaw === 'string'
        ? normalizeRegistryTextHash(textHashRaw)
        : textHashRaw != null
          ? normalizeRegistryTextHash(String(textHashRaw))
          : null;

    return { ...data, score, wordCount, textHash: textHash ?? null };
  } catch (err) {
    clearTimeout(timer);
    console.error('[JITTER] fetchAttestationData:', err);
    return null;
  }
}

async function initAttestationFromRoute() {
  hideAttestationCard();
  hideAttestationRouteNotice();
  const docId = getDocIdFromURL();
  if (!docId) return;

  showState('audit');
  resetAuditSteps();

  try {
    const data = await fetchAttestationData(docId);
    showState('idle');
    if (data) {
      showAttestationCard(data);
    } else {
      showAttestationRouteNotice(
        'Registry record not found or server unreachable. You can still verify a signed PDF by uploading it below.'
      );
    }
  } catch (error) {
    console.error('Attestation Route Error:', error);
    showState('idle');
    showAttestationRouteNotice(
      'Could not load registry attestation for this document. You can still verify a signed PDF by uploading it below.'
    );
  }
}

/* ─── Specific failure helpers ─── */

function showFailure(message) {
  DOM.dropInner.classList.remove('audit-active');
  if (DOM.failMessage) DOM.failMessage.textContent = message;
  showState('failure');
}

function showBreach(detail) {
  DOM.dropInner.classList.remove('audit-active');
  if (DOM.breachDetail) DOM.breachDetail.textContent = detail;
  showState('breach');
}

/* ═══════════════════════════════════════════════════════════════
   §4  DRAG & DROP + FILE INPUT
═══════════════════════════════════════════════════════════════ */

let dragCounter = 0;

document.addEventListener('dragenter', e => {
  e.preventDefault();
  if (currentState !== 'idle') return;
  if (++dragCounter === 1) DOM.card.classList.add('drag-active');
});

document.addEventListener('dragleave', () => {
  if (currentState !== 'idle') return;
  if (--dragCounter <= 0) {
    dragCounter = 0;
    DOM.card.classList.remove('drag-active');
  }
});

document.addEventListener('dragover', e => e.preventDefault());

document.addEventListener('drop', e => {
  e.preventDefault();
  dragCounter = 0;
  DOM.card.classList.remove('drag-active');
  if (currentState !== 'idle') return;
  const file = e.dataTransfer?.files?.[0];
  if (file) processFile(file);
});

DOM.dropZone?.addEventListener('click', () => {
  if (currentState !== 'idle') return;
  DOM.fileInput.click();
});

DOM.fileInput.addEventListener('change', e => {
  const file = e.target.files?.[0];
  if (file) processFile(file);
});

/* ═══════════════════════════════════════════════════════════════
   §5  BUTTON HANDLERS
═══════════════════════════════════════════════════════════════ */

$('btnReset')?.addEventListener('click', resetPortal);
$('btnResetFail')?.addEventListener('click', resetPortal);
$('btnResetBreach')?.addEventListener('click', resetPortal);

$('btnDownload')?.addEventListener('click', () => {
  if (lastReceiptData) downloadReceipt(lastReceiptData);
});

/* ═══════════════════════════════════════════════════════════════
   §6  MAIN VERIFICATION PIPELINE
═══════════════════════════════════════════════════════════════ */


/**
 * Reads PDF /Subject compact JSON for humanity score + tier (JITTER signed PDFs).
 */
async function extractSubjectMeta(buffer) {
  try {
    if (typeof PDFLib === 'undefined') return { sFinal: null, tier: null };
    const pdfDoc = await PDFLib.PDFDocument.load(buffer, { updateMetadata: false });
    const sub = pdfDoc.getSubject?.();
    const raw = Array.isArray(sub) ? sub[0] : sub;
    if (!raw || typeof raw !== 'string') return { sFinal: null, tier: null };
    const o = JSON.parse(raw.trim());
    const sRaw = o.sFinal != null ? o.sFinal : o.S_final;
    const sFinal = typeof sRaw === 'number' ? sRaw : Number.parseFloat(String(sRaw));
    const tier = typeof o.tier === 'string' ? o.tier : null;
    return {
      sFinal: Number.isFinite(sFinal) ? sFinal : null,
      tier,
    };
  } catch (_) {
    return { sFinal: null, tier: null };
  }
}
async function processFile(file) {
  /* ── Gate: file must be a PDF ── */
  if (!isPDFFile(file)) {
    showFailure('INVALID FORMAT: This file is not a PDF document.');
    return;
  }

  DOM.dropInner.classList.add('audit-active');
  showState('audit');
  resetAuditSteps();

  try {
    /* ── Phase 1: Read & validate PDF structure ── */
    const buffer = await readAsArrayBuffer(file);

    if (!hasPDFMagicBytes(buffer)) {
      await delay(600);
      showFailure('INVALID FORMAT: File header does not match a valid PDF structure.');
      return;
    }

    /* ── Phase 2: Extract JITTER metadata via pdf-lib ── */
    await completeStep('step1', 650); // step 1 = "Validating HMAC-SHA256 signature"

    let jitterMeta = null;

    try {
      jitterMeta = await extractJitterMetadata(buffer);
    } catch (_) {
      jitterMeta = extractMetaBinaryFallback(buffer);
    }

    if (!jitterMeta) {
      await completeStep('step2', 380);
      await delay(250);
      showFailure(
        'INVALID FORMAT: No valid JITTER verification metadata found. ' +
        'Expected Keywords JSON with documentId, a 64-character SHA-256 hex entropy digest, and signature.'
      );
      return;
    }

    const { documentId, entropyData, signature, embeddedTextHash } = jitterMeta;
    const subjectMeta = await extractSubjectMeta(buffer);
    await completeStep('step2', 550); // step 2 = "Verifying document integrity chain"

    /* ── Phase 3: Compute SHA-256 for the audit receipt ── */
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashHex    = hexFromBuffer(hashBuffer);

    /* ── Phase 4: Vault API handshake ── */
    let vaultResult;
    try {
      vaultResult = await callVaultAPI(documentId, entropyData, signature);
    } catch (netErr) {
      console.error('[JITTER] Vault handshake failed:', netErr.message);
      if (netErr.vaultClientError) {
        showFailure(
          'VERIFICATION REQUEST ERROR: ' +
            (netErr.message ||
              'The server could not process the metadata in this PDF. Check that the file is a complete JITTER export.')
        );
      } else {
        showFailure(
          'VAULT CONNECTION ERROR: Unable to reach the JITTER verification server. ' +
            'Please check your connection and try again.'
        );
      }
      return;
    }

    await completeStep('step3', 480); // step 3 = "Cross-referencing institutional registry"
    await delay(380);

    /* ── Phase 5: Content integrity — KV textHash vs PDF embedded textHash (no PDF body extract) ── */
    if (vaultResult.verified === true) {
      const reg = await fetchAttestationData(documentId);
      const kvHash = reg?.textHash ? normalizeRegistryTextHash(reg.textHash) : null;
      const embedded = embeddedTextHash || null;

      if (kvHash && embedded) {
        if (kvHash !== embedded) {
          showBreach(CONTENT_HASH_MISMATCH_MSG);
          return;
        }
      } else if (embedded && !kvHash) {
        showFailure(
          'REGISTRY ATTESTATION ERROR: This PDF embeds a content fingerprint, but no matching ' +
            'registry record was found. Try again in a moment, or re-save from the source document.'
        );
        return;
      }

      const rounded =
        subjectMeta.sFinal != null
          ? Math.round(Math.max(0, Math.min(100, subjectMeta.sFinal)))
          : null;
      const tierLabel =
        subjectMeta.tier ||
        (rounded != null ? getAttestationScoreTier(rounded).label : null);

      const certData = {
        timestamp: formatDate(new Date()),
        docId: documentId,
        humanityScore: rounded,
        humanityTier: tierLabel,
        fileSize: formatFileSize(file.size),
        hash: hashHex,
        filename: file.name,
      };

      populateCertificate(certData);
      showState('success');

    } else {
      showBreach(
        vaultResult.reason ||
        'Integrity check failed. Document has been altered or signature is forged.'
      );
    }

  } catch (err) {
    console.error('[JITTER] Unexpected pipeline error:', err);
    showFailure('SYSTEM ERROR: An unexpected error occurred during verification. Please try again.');
  }
}

/* ═══════════════════════════════════════════════════════════════
   §7  PDF-LIB METADATA EXTRACTOR
═══════════════════════════════════════════════════════════════ */

/**
 * Loads the PDF and reads verify metadata from Keywords, then JITTER_CUSTOM_KEYS.
 * entropyData must be exactly 64 hex characters (SHA-256 digest).
 * Optional textHash (64 hex) may appear in the same JSON for content-fingerprint checks.
 *
 * @returns {{ documentId: string, entropyData: string, signature: string, embeddedTextHash?: string }|null}
 */
async function extractJitterMetadata(buffer) {
  if (typeof PDFLib === 'undefined') {
    throw new Error('pdf-lib not loaded');
  }

  const pdfDoc = await PDFLib.PDFDocument.load(buffer, { updateMetadata: false });

  try {
    const keywords = pdfDoc.getKeywords?.();
    const kw0 = Array.isArray(keywords) ? keywords[0] : keywords;
    if (kw0 && typeof kw0 === 'string') {
      const result = parseVerifyMetadataJson(kw0);
      if (result) return result;
    }
  } catch (_) {}

  try {
    const infoDict = pdfDoc.getInfoDict?.();
    if (infoDict) {
      for (const keyName of JITTER_CUSTOM_KEYS) {
        try {
          const entry = infoDict.get(PDFLib.PDFName.of(keyName));
          if (entry) {
            const str = pdfEntryToString(entry);
            if (str) {
              const result = parseVerifyMetadataJson(str);
              if (result) return result;
            }
          }
        } catch (_) {}
      }
    }
  } catch (_) {}

  return null;
}

/** Safely convert a pdf-lib PDFObject to a plain string. */
function pdfEntryToString(entry) {
  try {
    if (typeof entry.decodeText === 'function') return entry.decodeText() || null;
    if (typeof entry.asString   === 'function') return entry.asString()   || null;
    if (typeof entry.value      !== 'undefined') return String(entry.value) || null;
    const s = String(entry);
    return s.startsWith('[object') ? null : s;
  } catch (_) { return null; }
}

/* ═══════════════════════════════════════════════════════════════
   §8  VERIFY METADATA PARSER (strict v3.2+)
═══════════════════════════════════════════════════════════════ */

/**
 * Parses a single JSON object: { documentId, entropyData, signature }.
 * All three values must be strings; entropyData must match ENTROPY_DIGEST_HEX_RE.
 * Optional textHash (64 hex) is returned as embeddedTextHash when present (registry content fingerprint).
 * Returns null if JSON is invalid or the schema does not match (no coercion).
 */
function parseVerifyMetadataJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  let obj;
  try {
    obj = JSON.parse(s);
  } catch (_) {
    return null;
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const { documentId, entropyData, signature, textHash } = obj;
  if (typeof documentId !== 'string' || typeof entropyData !== 'string' || typeof signature !== 'string') {
    return null;
  }

  const did = documentId.trim();
  const ent = entropyData.trim();
  const sig = signature.trim();
  if (!did || !sig || !ENTROPY_DIGEST_HEX_RE.test(ent)) return null;

  const out = { documentId: did, entropyData: ent, signature: sig };
  const regHash = normalizeRegistryTextHash(typeof textHash === 'string' ? textHash : '');
  if (regHash) out.embeddedTextHash = regHash;
  return out;
}

/* ═══════════════════════════════════════════════════════════════
   §9  BINARY FALLBACK EXTRACTOR
   Scans raw PDF bytes for JITTER data without pdf-lib.
   Used when the CDN script fails to load or throws.
═══════════════════════════════════════════════════════════════ */

function extractMetaBinaryFallback(buffer) {
  try {
    const text = new TextDecoder('latin1').decode(new Uint8Array(buffer));

    const keys = ['Keywords', ...JITTER_CUSTOM_KEYS];
    for (const key of keys) {
      const val = scanBinaryField(text, key);
      if (val) {
        const meta = parseVerifyMetadataJson(val);
        if (meta) return meta;
      }
    }
    return null;
  } catch (_) { return null; }
}

function scanBinaryField(text, key) {
  const reP = new RegExp('/' + key + '\\s*\\(([^)]{1,800})\\)');
  const mP  = text.match(reP);
  if (mP) return cleanBinaryString(mP[1]);

  const reH = new RegExp('/' + key + '\\s*<([0-9A-Fa-f]{2,1600})>');
  const mH  = text.match(reH);
  if (mH) {
    try {
      const h = mH[1];
      let s   = '';
      if (/^[Ff][Ee][Ff][Ff]/.test(h)) {
        for (let i = 4; i < h.length; i += 4)
          s += String.fromCodePoint(parseInt(h.substr(i, 4), 16));
      } else {
        for (let i = 0; i < h.length; i += 2)
          s += String.fromCharCode(parseInt(h.substr(i, 2), 16));
      }
      return cleanBinaryString(s);
    } catch (_) {}
  }
  return null;
}

function cleanBinaryString(s) {
  return s
    .replace(/\\n|\\r|\\t/g, ' ')
    .replace(/\\\\/g, '\\')
    .replace(/[^\x20-\x7E\u00C0-\u024F]/g, '')
    .trim() || null;
}

/* ═══════════════════════════════════════════════════════════════
   §10  VAULT API HANDSHAKE
═══════════════════════════════════════════════════════════════ */

/**
 * POST extracted JITTER fields to the verification endpoint.
 * Enforces a hard timeout via AbortController.
 * Returns parsed JSON on 200.
 * Throws Error with .vaultClientError === true for 4xx (bad request / client payload).
 * Throws Error without that flag for network, timeout, or 5xx.
 */
async function callVaultAPI(documentId, entropyData, signature) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VAULT_TIMEOUT_MS);

  try {
    const response = await fetch(VAULT_API, {
      method:  'POST',
      mode:    'cors',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ documentId, entropyData, signature }),
      signal:  controller.signal,
    });

    clearTimeout(timer);

    const bodyText = await response.text().catch(() => '');
    let bodyJson = null;
    try {
      bodyJson = bodyText ? JSON.parse(bodyText) : null;
    } catch (_) {
      /* keep bodyText for messages */
    }

    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        const msg =
          (bodyJson && typeof bodyJson.error === 'string' && bodyJson.error.trim()) ||
          `The verification service rejected this request (HTTP ${response.status}).`;
        const err = new Error(msg);
        err.vaultClientError = true;
        err.httpStatus = response.status;
        throw err;
      }
      throw new Error(`Server returned HTTP ${response.status}. ${bodyText}`.trim());
    }

    return bodyJson && typeof bodyJson === 'object' ? bodyJson : {};

  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`Vault request timed out after ${VAULT_TIMEOUT_MS / 1000}s.`);
    }
    throw err;
  }
}

/* ═══════════════════════════════════════════════════════════════
   §11  CERTIFICATE POPULATION
═══════════════════════════════════════════════════════════════ */

function populateCertificate(data) {
  DOM.cert.timestamp.textContent = data.timestamp;
  DOM.cert.docId.textContent = data.docId;
  if (DOM.cert.humanityScore) {
    const scorePart =
      data.humanityScore != null ? `${data.humanityScore} / 100` : '\u2014';
    const tierPart = data.humanityTier ? ` (${data.humanityTier})` : '';
    DOM.cert.humanityScore.textContent = scorePart + tierPart;
  }
  DOM.cert.fileSize.textContent = data.fileSize;
  DOM.cert.hash.textContent = data.hash;
  lastReceiptData = data;
}

/* ═══════════════════════════════════════════════════════════════
   §12  AUDIT STEP ANIMATIONS
═══════════════════════════════════════════════════════════════ */

async function completeStep(id, waitMs) {
  await delay(waitMs);
  const el = $(id);
  if (!el) return;
  el.querySelector('.step-idle')?.classList.add('hidden');
  el.querySelector('.step-done')?.classList.remove('hidden');
  el.classList.add('done');
}

function resetAuditSteps() {
  ['step1', 'step2', 'step3'].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.classList.remove('done');
    el.querySelector('.step-idle')?.classList.remove('hidden');
    el.querySelector('.step-done')?.classList.add('hidden');
  });
}

/* ═══════════════════════════════════════════════════════════════
   §13  DOWNLOAD AUDIT RECEIPT
═══════════════════════════════════════════════════════════════ */

function downloadReceipt(d) {
  const HR  = '─'.repeat(54);
  const lines = [
    '╔════════════════════════════════════════════════════════╗',
    '║          JITTER — CRYPTOGRAPHIC AUDIT RECEIPT          ║',
    '║               TRUST INFRASTRUCTURE v1.0.0              ║',
    '╚════════════════════════════════════════════════════════╝',
    '',
    `  GOOGLE_DOC_ID :  ${d.docId}`,
    `  TIMESTAMP    :  ${d.timestamp}`,
    `  HUMANITY_SCORE :  ${d.humanityScore != null ? d.humanityScore + " / 100" : "\u2014"}`,
    `  FILE_SIZE    :  ${d.fileSize}`,
    `  SOURCE_FILE  :  ${d.filename}`,
    '',
    HR,
    '  DOCUMENT_HASH (SHA-256):',
    `  ${d.hash}`,
    HR,
    '',
    '  AUDIT PROTOCOL : HMAC-SHA256 / AES-256',
    '  COMPLIANCE     : NIST SP 800-175B',
    '  ENVIRONMENT    : PDF parsed locally; verification metadata sent to vault API',
    '  VAULT ENDPOINT : ' + VAULT_API,
    '',
    '  This receipt was generated by JITTER Trust Infrastructure.',
    '  © 2026 JITTER. All rights reserved.',
  ];

  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: `JITTER-Audit-${d.docId}.txt`,
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ═══════════════════════════════════════════════════════════════
   §14  UTILITY FUNCTIONS
═══════════════════════════════════════════════════════════════ */

function isPDFFile(file) {
  return (
    file.name.toLowerCase().endsWith('.pdf') ||
    file.type === 'application/pdf'
  );
}

function hasPDFMagicBytes(buffer) {
  const b = new Uint8Array(buffer, 0, 5);
  // %PDF- (0x25 0x50 0x44 0x46 0x2D)
  return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
}

function readAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader    = new FileReader();
    reader.onload   = e => resolve(e.target.result);
    reader.onerror  = () => reject(new Error('FileReader: could not read file'));
    reader.readAsArrayBuffer(file);
  });
}

function hexFromBuffer(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function formatDate(d) {
  const mo = ['Jan','Feb','Mar','Apr','May','Jun',
               'Jul','Aug','Sep','Oct','Nov','Dec'];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${mo[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm} UTC`;
}

function formatFileSize(bytes) {
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ═══════════════════════════════════════════════════════════════
   §15  STARTUP (after all state + handlers exist — avoids TDZ on currentState)
═══════════════════════════════════════════════════════════════ */

function runPortalStartup() {
  if (verifyHasPlaceholderConfig()) {
    showVerifyConfigBanner();
  }
  initAttestationFromRoute();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', runPortalStartup);
} else {
  runPortalStartup();
}
