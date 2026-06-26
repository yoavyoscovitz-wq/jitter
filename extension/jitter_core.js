// JITTER Core Biometric Engine
// -----------------------------------------------
// Wrapped in an IIFE to limit global scope exposure; only JitterEngine is exported.
(function () {
  "use strict";

// This module is responsible for turning raw timing and editing
// statistics into a high-confidence "Humanity Score" in the range [0, 100].
//
// The engine is intentionally deterministic and side-effect free so that:
// - It can be reused in different environments (content script, backend).
// - It can be unit-tested with synthetic datasets.
//
// INPUT (per evaluation):
//   {
//     flightTimes: number[]            // Raw key flight times (ms) between keyups.
//     dwellTimes: number[]             // Raw key dwell times (ms) on each key.
//     cppPauses: number[]              // Flight times immediately following punctuation (ms).
//     baselineFlights: number[]        // Non-punctuation flight times (ms).
//     erlSamples: number[]             // Error Recovery Latencies (ms) after Backspace.
//     cognitivePauseCount: number      // Count of detected cognitive punctuation pauses.
//     totalKeystrokes: number          // Total number of keydown events observed.
//     backspaceCount: number           // Count of Backspace/Delete keystrokes.
//     typedChars: number               // Count of "normal" characters typed.
//     deletedChars: number             // Approximate number of characters deleted.
//     pastedChars: number              // Billable paste chars (content script filters seal / image-only /
//                                       URL-only / micro-pastes before incrementing).
//     totalPastedChars: number         // Historical total of billable pasted characters (same filter).
//     pasteDebt: number                // Outstanding unpaid *billable* pasted characters.
//     estimatedDocumentLength?: number // Optional explicit estimate of document length.
//   }
//
// OUTPUT:
//   {
//     V_bio: number,     // Biometric Authenticity vector [0, 100]
//     V_effort: number,  // Effort Density vector [0, 100]
//     P_decay: number,   // Paste decay multiplier [0.0, 1.0]
//     S_final: number,   // Final Humanity Score [0, 100]
//     details: { ... }   // Detailed intermediate metrics for debugging / telemetry
//   }

class JitterEngine {
  /**
   * @param {Object} [config] Optional engine configuration.
   *        This allows tuning without modifying the core algorithm.
   */
  constructor(config) {
    this.config = Object.assign(
      {
        // Expected human coefficient of variation band for flight times.
        cvHumanMin: 0.3,
        cvHumanMax: 1.5,
        // "Ideal" CV center and tolerance for scoring.
        cvCenter: 0.9,
        cvWidth: 0.6,

        // Expected human coefficient of variation band for dwell times.
        dwellCvHumanMin: 0.1,
        dwellCvHumanMax: 0.4,
        dwellCvCenter: 0.25,
        dwellCvWidth: 0.2,

        // Error rate (backspace / keystroke) behaviour.
        // We only penalize extreme *low* error rates; high rates are tolerated
        // up to fairly large values because heavy editors delete a lot.
        erMin: 0.01, // 1%

        // Weighting of V_bio sub-components (CV + ER + cognitive vectors).
        // [Logic] Do not change without recalibrating thresholds.
        vBioCvWeight: 0.25,
        vBioDwellCvWeight: 0.15,
        vBioErWeight: 0.1,
        vBioCppWeight: 0.2,
        vBioBurstWeight: 0.15,
        vBioErlWeight: 0.1,
        vBioAutocorrWeight: 0.05,

        // Final blend between vectors before paste penalty.
        finalBioWeight: 0.6,
        finalEffortWeight: 0.4,

        // Paste debt / decay configuration.
        debtSoftThreshold: 0.05, // UDR <= 5% => effectively no penalty.
        debtHardThreshold: 0.4, // Above this unpaid debt ratio, penalties are severe.
        pasteMinMultiplier: 0.1, // Lowest allowed multiplier on S_final.
        pasteSigmoidAlpha: 6.0, // Steepness of the sigmoid around the midpoint.
        // Document only: must match content.js PASTE_MICRO_THRESHOLD (paste classification is upstream).
        pasteMicroForgivenessThreshold: 15,
        // Reserved if raw vs billable paste split is added later; billable URL pastes are 0 upstream.
        urlPasteBillableFraction: 0,
      },
      config || {}
    );
  }

  /**
   * Public entry point: compute a full scoring result from raw metrics.
   */
  compute(input) {
    const normalized = this._normalizeInput(input);

    const bioMetrics = this._computeBioMetrics(normalized);
    const vBioRaw = this._scoreVbio(bioMetrics);
    const vBio = this._clamp(vBioRaw, 0, 100);

    const vEffortRaw = this._scoreVeffort(normalized);
    const vEffort = this._clamp(vEffortRaw, 0, 100);

    const pasteRatio = this._computePasteRatio(normalized);
    const pDecayRaw = this._computePasteDecay(normalized, vBio);
    const pDecay = this._clamp(pDecayRaw, 0, 1);

    const rawScore =
      this.config.finalBioWeight * vBio +
      this.config.finalEffortWeight * vEffort;

    // Apply paste decay as a multiplicative factor, then clamp to [0, 100].
    const sFinal = this._clamp(rawScore * pDecay, 0, 100);

    const confidence = this._computeConfidence(normalized);
    const confidenceLabel = this._confidenceToLabel(confidence);

    return {
      V_bio: vBio,
      V_effort: vEffort,
      P_decay: pDecay,
      S_final: sFinal,
      details: Object.assign({}, normalized, bioMetrics, {
        pasteRatio,
        rawScoreBeforeDecay: rawScore,
        confidence,
        confidenceLabel,
      }),
    };
  }

  /**
   * Statistical confidence in [0, 1] from volume (log curve on keystrokes)
   * and richness (presence of cppPauses and valid dwellTimes).
   * Deterministic and side-effect free.
   */
  _computeConfidence(norm) {
    const k = Math.max(0, this._safeNumber(norm.totalKeystrokes));
    // Aggressive early-volume curve for MVP responsiveness:
    // start scaling at ~10 keys and saturate by ~300.
    const logStart = Math.log(1 + 10);
    const logTarget = Math.log(1 + 300);
    const volumeRaw =
      (Math.log(1 + k) - logStart) / Math.max(1e-6, logTarget - logStart);
    const volumeComponent = this._clamp(volumeRaw, 0, 1);

    const hasCpp = Array.isArray(norm.cppPauses) && norm.cppPauses.length >= 3;
    const hasDwell =
      Array.isArray(norm.dwellTimes) && norm.dwellTimes.length >= 10;
    // Hebrew typing often lacks standard punctuation intervals; don't get stuck
    // calibrating when we have *either* CPP or dwell richness.
    const richness = hasCpp || hasDwell ? 1.0 : 0.7;

    const confidence = this._clamp(volumeComponent * richness, 0, 1);
    return confidence;
  }

  /**
   * Map confidence float to exact tier string for UI.
   */
  _confidenceToLabel(confidence) {
    const c = this._safeNumber(confidence);
    // CRITICAL: exact tier thresholds shared by HUD + Popup.
    if (c < 0.15) return "CALIBRATING";
    if (c < 0.4) return "LOW";
    if (c < 0.7) return "MODERATE";
    return "HIGH";
  }

  // ---------------------------------------------------------------------------
  // Normalization helpers
  // ---------------------------------------------------------------------------

  _safeNumber(value) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || Number.isNaN(n)) return 0;
    return n;
  }

  _clamp(value, min, max) {
    const v = this._safeNumber(value);
    if (v < min) return min;
    if (v > max) return max;
    return v;
  }

  _normalizeInput(input) {
    const rawFlights = Array.isArray(input && input.flightTimes)
      ? input.flightTimes.map((v) => this._safeNumber(v))
      : [];
    const rawDwells = Array.isArray(input && input.dwellTimes)
      ? input.dwellTimes.map((v) => this._safeNumber(v))
      : [];
    const afterPause = Array.isArray(input && input.flightAfterPause)
      ? input.flightAfterPause
      : [];

    // Outlier rejection: ignore > 3000ms and flights immediately after tab-switch/inactivity.
    const flightTimes = [];
    const dwellTimes = [];
    const n = rawFlights.length;
    for (let i = 0; i < n; i++) {
      const f = rawFlights[i];
      if (f <= 0 || f > 3000) continue;
      if (afterPause[i]) continue;
      flightTimes.push(f);
      const d = i < rawDwells.length ? rawDwells[i] : 0;
      if (d > 0 && d <= 3000) dwellTimes.push(d);
    }

    const cppPauses = Array.isArray(input && input.cppPauses)
      ? input.cppPauses
          .map((v) => this._safeNumber(v))
          .filter((v) => v > 0 && v <= 3000)
      : [];

    const baselineFlights = Array.isArray(input && input.baselineFlights)
      ? input.baselineFlights
          .map((v) => this._safeNumber(v))
          .filter((v) => v > 0 && v <= 3000)
      : [];

    const erlSamples = Array.isArray(input && input.erlSamples)
      ? input.erlSamples
          .map((v) => this._safeNumber(v))
          .filter((v) => v > 0 && v <= 3000)
      : [];

    const cognitivePauseCount = Math.max(
      0,
      this._safeNumber(input && input.cognitivePauseCount)
    );

    const totalKeystrokes = Math.max(
      0,
      this._safeNumber(input && input.totalKeystrokes)
    );
    const backspaceCount = Math.max(
      0,
      this._safeNumber(input && input.backspaceCount)
    );
    const typedChars = Math.max(
      0,
      this._safeNumber(input && input.typedChars)
    );
    const deletedChars = Math.max(
      0,
      this._safeNumber(input && input.deletedChars)
    );
    // pastedChars / totalPastedChars / pasteDebt are pre-filtered in the content script
    // (seal, image-only, URL-only, micro-paste); do not re-apply clipboard logic here.
    const pastedChars = Math.max(
      0,
      this._safeNumber(input && input.pastedChars)
    );
    const totalPastedChars = Math.max(
      0,
      this._safeNumber(input && input.totalPastedChars)
    );
    const pasteDebt = Math.max(
      0,
      this._safeNumber(input && input.pasteDebt)
    );

    const explicitDocLen = this._safeNumber(
      input && input.estimatedDocumentLength
    );

    // If not provided, estimate document length as current visible content:
    //   approxDocLen = typedChars + pastedChars - deletedChars
    // and ensure it never goes below 1 to avoid division by zero.
    const estimatedDocumentLength =
      explicitDocLen > 0
        ? explicitDocLen
        : Math.max(1, typedChars + pastedChars - deletedChars);

    return {
      flightTimes,
      totalKeystrokes,
      backspaceCount,
      typedChars,
      deletedChars,
      pastedChars,
      totalPastedChars,
      pasteDebt,
      estimatedDocumentLength,
      cppPauses,
      baselineFlights,
      erlSamples,
      dwellTimes,
      cognitivePauseCount,
    };
  }

  // ---------------------------------------------------------------------------
  // Biometric Authenticity Vector (V_bio)
  // ---------------------------------------------------------------------------

  /**
   * Compute μ (mean), σ (standard deviation), CV (σ / μ), and lag-1
   * autocorrelation for a series of positive timing values.
   *
   * Autocorrelation here measures how strongly each sample is related
   * to its immediate predecessor. Human typing tends to have "momentum":
   * short flights follow short flights and long follow long, which yields
   * a positive lag-1 autocorrelation. A naive Math.random() bot has
   * autocorrelation near zero.
   */
  _computeTimingStats(series) {
    if (!series.length) {
      return {
        mean: 0,
        sd: 0,
        cv: 0,
        acfLag1: 0,
      };
    }

    const n = series.length;
    let sum = 0;
    let sumSq = 0;

    for (let i = 0; i < n; i++) {
      const v = this._safeNumber(series[i]);
      sum += v;
      sumSq += v * v;
    }

    const mean = sum / Math.max(1, n);
    // Population variance: E[X^2] − (E[X])^2
    const variance = n > 1 ? sumSq / n - mean * mean : 0;
    const sd = variance > 0 ? Math.sqrt(variance) : 0;

    const safeMean = Math.max(1e-6, mean);
    const cv = Number.isFinite(sd) ? sd / safeMean : 0;

    // Lag-1 autocorrelation R = Cov(X_t, X_{t-1}) / Var(X)
    let acfLag1 = 0;
    if (n > 1 && variance > 0) {
      let covSum = 0;
      for (let t = 1; t < n; t++) {
        const x = this._safeNumber(series[t]) - mean;
        const prev = this._safeNumber(series[t - 1]) - mean;
        covSum += x * prev;
      }
      const cov = covSum / Math.max(1, n - 1);
      const safeVariance = Math.max(1e-6, variance);
      acfLag1 = cov / safeVariance;
      if (!Number.isFinite(acfLag1)) acfLag1 = 0;
    }

    return {
      mean,
      sd,
      cv,
      acfLag1,
    };
  }

  /**
   * Compute core biometric metrics used for V_bio.
   */
  _computeBioMetrics(norm) {
    // Flight-time statistics capture the rhythm between key releases and
    // include lag-1 autocorrelation to detect random vs. momentum-driven flows.
    const flightStats = this._computeTimingStats(norm.flightTimes);

    // Dwell-time statistics capture how long keys are held down. Bots tend to
    // have nearly fixed dwell durations (very low CV), whereas human dwell CV
    // is modest but non-zero.
    const dwellStats = this._computeTimingStats(norm.dwellTimes || []);

    // Error Rate (ER) = backspaces / total_keystrokes.
    const er =
      norm.totalKeystrokes > 0
        ? norm.backspaceCount / Math.max(1, norm.totalKeystrokes)
        : 0;

    const cppMetrics = this._computeCppMetrics(
      norm.cppPauses,
      norm.baselineFlights
    );
    const burstMetrics = this._computeBurstinessMetrics(norm.flightTimes);
    const erlMetrics = this._computeErlMetrics(
      norm.erlSamples,
      flightStats.mean
    );

    return Object.assign(
      {},
      {
        meanFlight: flightStats.mean,
        sdFlight: flightStats.sd,
        cvFlight: flightStats.cv,
        acfLag1Flight: flightStats.acfLag1,
        meanDwell: dwellStats.mean,
        sdDwell: dwellStats.sd,
        cvDwell: dwellStats.cv,
      },
      {
        errorRate: er,
      },
      cppMetrics,
      burstMetrics,
      erlMetrics
    );
  }

  /**
   * Score the Biometric Authenticity Vector (V_bio) in [0, 100].
   *
   * We blend:
   *   - CV behavior: Humans typically have 0.3 ≤ CV ≤ 1.5 with a "healthy" center.
   *   - Error rate: Humans make some errors; zero errors over long text is suspicious.
   *   - CPP (Cognitive Punctuation Pauses): humans slow down after punctuation.
   *   - Burstiness: humans show alternating fast and slow phases.
   *   - ERL (Error Recovery Latency): humans hesitate briefly after correcting.
   */
  _scoreVbio(bioMetrics) {
    const { cvFlight, cvDwell, errorRate, acfLag1Flight } = bioMetrics;

    // 1) Score based on coefficient of variation (CV) of flight times.
    const cvScore = this._scoreCv(cvFlight);
    const dwellCvScore = this._scoreDwellCv(cvDwell);

    // 2) Score based on error rate (backspaces / keystrokes).
    const erScore = this._scoreErrorRate(errorRate);

    // 3) Score cognitive vectors.
    const cppScore = this._scoreCpp(bioMetrics);
    const burstScore = this._scoreBurstiness(bioMetrics);
    const erlScore = this._scoreErl(bioMetrics);
    const autocorrScore = this._scoreAutocorr(acfLag1Flight);

    // 4) Blend using configured weights, and scale to [0, 100].
    const blended =
      this.config.vBioCvWeight * cvScore +
      this.config.vBioDwellCvWeight * dwellCvScore +
      this.config.vBioErWeight * erScore +
      this.config.vBioCppWeight * cppScore +
      this.config.vBioBurstWeight * burstScore +
      this.config.vBioErlWeight * erlScore +
      this.config.vBioAutocorrWeight * autocorrScore;

    return this._clamp(blended * 100, 0, 100);
  }

  // ---------------------------------------------------------------------------
  // Cognitive Punctuation Pause (CPP) metrics
  // ---------------------------------------------------------------------------

  _computeCppMetrics(cppPauses, baselineFlights) {
    if (!Array.isArray(cppPauses) || cppPauses.length === 0) {
      return {
        cppMean: 0,
        cppMeanBaseline: 0,
        cppCount: 0,
      };
    }

    const mean = (arr) => {
      if (!arr.length) return 0;
      let s = 0;
      for (let i = 0; i < arr.length; i++) s += arr[i];
      return s / Math.max(1, arr.length);
    };

    const cppMean = mean(cppPauses);
    const baselineMean = mean(baselineFlights || []);

    return {
      cppMean,
      cppMeanBaseline: baselineMean,
      cppCount: cppPauses.length,
    };
  }

  _scoreCpp(bioMetrics) {
    const { cppMean, cppMeanBaseline, cppCount } = bioMetrics;

    // With very few punctuation pauses, treat as neutral.
    if (!cppCount || cppCount < 3) return 0.6;

    const meanCpp = this._safeNumber(cppMean);
    const meanBase = this._safeNumber(cppMeanBaseline);

    if (meanCpp <= 0) return 0.2;

    // Ideal CPP window: 400–1200 ms.
    let windowScore;
    if (meanCpp < 400) {
      // Too fast, suspicious.
      windowScore = 0.1;
    } else if (meanCpp > 1600) {
      // Very long pauses may reflect distraction more than cognition.
      windowScore = 0.4;
    } else if (meanCpp <= 1200) {
      // 400–1200ms: ramp up from 0.6 to 1.0.
      const t = (meanCpp - 400) / (1200 - 400);
      windowScore = 0.6 + t * 0.4;
    } else {
      // 1200–1600ms: gentle decline from 1.0 to 0.6.
      const t = (1600 - meanCpp) / (1600 - 1200);
      windowScore = 0.6 + Math.max(0, t) * 0.4;
    }

    // Relative slowdown: we expect punctuation pauses to be meaningfully
    // slower than baseline flight times.
    const meanBaseSafe = Math.max(1e-6, meanBase);
    if (meanBase > 0) {
      const ratio = meanCpp / meanBaseSafe; // >1 when punctuation is slower.
      if (ratio < 1.1) {
        // Almost indistinguishable from baseline: strongly suspicious.
        windowScore *= 0.3;
      } else if (ratio < 1.5) {
        // Slightly slower: modest penalty.
        windowScore *= 0.7;
      } else if (ratio > 3.0) {
        // Extremely slower than baseline: may be distraction; dampen slightly.
        windowScore *= 0.8;
      }
    }

    return this._clamp(windowScore, 0, 1);
  }

  // ---------------------------------------------------------------------------
  // Burstiness metrics
  // ---------------------------------------------------------------------------

  _computeBurstinessMetrics(flightTimes) {
    if (!Array.isArray(flightTimes) || flightTimes.length === 0) {
      return {
        burstFastFraction: 0,
        burstSlowFraction: 0,
        burstTransitionsPerKeystroke: 0,
      };
    }

    const n = flightTimes.length;
    let fastCount = 0; // < 100 ms
    let slowCount = 0; // > 400 ms
    let transitions = 0;

    const classify = (v) => {
      if (v < 100) return "fast";
      if (v > 400) return "slow";
      return "medium";
    };

    let prevClass = classify(flightTimes[0]);

    for (let i = 0; i < n; i++) {
      const v = flightTimes[i];
      const c = classify(v);
      if (c === "fast") fastCount += 1;
      if (c === "slow") slowCount += 1;

      if (i > 0 && c !== prevClass && c !== "medium" && prevClass !== "medium") {
        // Count direct fast<->slow alternations as "burst transitions".
        transitions += 1;
      }

      if (c !== "medium") prevClass = c;
    }

    const safeN = Math.max(1, n);
    return {
      burstFastFraction: fastCount / safeN,
      burstSlowFraction: slowCount / safeN,
      burstTransitionsPerKeystroke: transitions / safeN,
    };
  }

  _scoreBurstiness(bioMetrics) {
    const {
      burstFastFraction,
      burstSlowFraction,
      burstTransitionsPerKeystroke,
    } = bioMetrics;

    // Require at least some representation of both regimes.
    if (burstFastFraction < 0.05 || burstSlowFraction < 0.05) {
      return 0.3;
    }

    // We want a moderate amount of fast/slow alternation, not constant switching.
    // Heuristic: ideal transitions around 0.05–0.2 per keystroke.
    const t = this._safeNumber(burstTransitionsPerKeystroke);
    if (t <= 0) return 0.2;

    if (t < 0.05) {
      // Too few transitions: flow is too uniform.
      return 0.5;
    }

    if (t <= 0.2) {
      // 0.05–0.2: ramp from 0.6 to 1.0.
      const x = (t - 0.05) / (0.2 - 0.05);
      return 0.6 + x * 0.4;
    }

    if (t > 0.5) {
      // Very high: chaotic, suspicious.
      return 0.3;
    }

    // 0.2–0.5: gently fall from 1.0 to 0.6.
    const x = (0.5 - t) / (0.5 - 0.2);
    return 0.6 + Math.max(0, x) * 0.4;
  }

  // ---------------------------------------------------------------------------
  // Error Recovery Latency (ERL) metrics
  // ---------------------------------------------------------------------------

  _computeErlMetrics(erlSamples, baselineMeanFlight) {
    if (!Array.isArray(erlSamples) || erlSamples.length === 0) {
      return {
        erlMean: 0,
        erlCount: 0,
        erlBaselineMean: baselineMeanFlight || 0,
      };
    }

    let sum = 0;
    for (let i = 0; i < erlSamples.length; i++) sum += erlSamples[i];

    const erlN = Math.max(1, erlSamples.length);
    return {
      erlMean: sum / erlN,
      erlCount: erlSamples.length,
      erlBaselineMean: baselineMeanFlight || 0,
    };
  }

  _scoreErl(bioMetrics) {
    const { erlMean, erlCount, erlBaselineMean } = bioMetrics;

    if (!erlCount) return 0.5;

    const meanErl = this._safeNumber(erlMean);
    const base = this._safeNumber(erlBaselineMean);

    if (meanErl <= 0 || base <= 0) return 0.5;

    const baseSafe = Math.max(1e-6, base);
    const ratio = meanErl / baseSafe;

    // We expect ERL to be somewhat larger than typical flight times.
    if (ratio < 1.0) {
      // Recoveries faster than baseline are suspicious (bot-like immediate corrections).
      return 0.2;
    }

    if (ratio <= 2.0) {
      // 1.0–2.0: ramp from 0.6 to 1.0.
      const t = (ratio - 1.0) / (2.0 - 1.0);
      return 0.6 + t * 0.4;
    }

    if (ratio > 4.0) {
      // Extremely slow recoveries suggest distraction rather than cognition.
      return 0.4;
    }

    // 2.0–4.0: gently fall from 1.0 to 0.6.
    const t = (4.0 - ratio) / (4.0 - 2.0);
    return 0.6 + Math.max(0, t) * 0.4;
  }

  /**
   * Map CV to a normalized score in [0, 1].
   * - CV near 0 (robotic) -> 0.
   * - CV within [cvHumanMin, cvHumanMax] -> high.
   * - Very high CV -> penalized again (unstable / highly synthetic).
   * [Internal] Autocorrelation branch uses different band; see _scoreAutocorr.
   */
  _scoreCv(cv) {
    const v = this._safeNumber(cv);
    if (v <= 0) return 0;

    const { cvHumanMin, cvHumanMax, cvCenter, cvWidth } = this.config;
    const cvWidthSafe = Math.max(1e-6, cvWidth);

    // Triangular "peak" around cvCenter with base width 2 * cvWidth.
    const distance = Math.abs(v - cvCenter);
    let peakComponent = 1 - distance / cvWidthSafe; // Linear falloff.
    if (peakComponent < 0) peakComponent = 0;

    // Ensure that values inside the expected human band are not overly penalized.
    if (v >= cvHumanMin && v <= cvHumanMax) {
      // Within "human band": floor the score to at least 0.6.
      peakComponent = Math.max(peakComponent, 0.6);
    }

    // Very extreme CV values outside [0.1, 3.0] are suspicious; down-weight.
    if (v < 0.1 || v > 3.0) {
      peakComponent *= 0.5;
    }

    return this._clamp(peakComponent, 0, 1);
  }

  /**
   * Map error rate (ER) into [0, 1].
   *
   * Design principle:
   * - Humans, especially heavy editors, often have high error rates; we
   *   therefore avoid punishing *high* ER up to fairly large values.
   * - The only truly suspicious regime is an error rate that is effectively
   *   zero across many keystrokes, which suggests synthetic text.
   */
  _scoreErrorRate(er) {
    const v = Math.max(0, this._safeNumber(er));
    const erMin = Math.max(1e-6, this.config.erMin);

    if (v === 0) {
      // Zero errors at any realistic scale is suspicious: strongly synthetic.
      return 0.1;
    }

    // For non-zero ER, we very gently increase from neutral as ER moves away
    // from zero, but we do *not* penalize large values.
    if (v < erMin) {
      const t = v / erMin; // 0 -> erMin => 0 -> 1
      return 0.4 + t * (1.0 - 0.4);
    }

    // For ER >= erMin, we treat it as fully acceptable.
    return 1.0;
  }

  /**
   * Dwell-time CV scoring: bots tend to have near-constant dwell durations
   * (CV ~ 0), whereas human dwell CV is modest but non-zero.
   */
  _scoreDwellCv(cv) {
    const v = this._safeNumber(cv);
    if (v <= 0) return 0.2;

    const { dwellCvHumanMin, dwellCvHumanMax, dwellCvCenter, dwellCvWidth } =
      this.config;
    const dwellCvWidthSafe = Math.max(1e-6, dwellCvWidth);

    const distance = Math.abs(v - dwellCvCenter);
    let score = 1 - distance / dwellCvWidthSafe; // linear peak
    if (score < 0) score = 0;

    if (v >= dwellCvHumanMin && v <= dwellCvHumanMax) {
      score = Math.max(score, 0.7);
    }

    if (v < 0.02 || v > 0.8) {
      // Extremely rigid or wildly noisy dwell CV is suspicious.
      score *= 0.4;
    }

    return this._clamp(score, 0, 1);
  }

  /**
   * Autocorrelation scoring: lag-1 autocorrelation close to zero indicates
   * independent, random timings (typical of naive bots). Humans usually show
   * positive autocorrelation because their motor system has inertia.
   */
  _scoreAutocorr(acfLag1) {
    const r = this._safeNumber(acfLag1);

    // Slight negative or zero autocorrelation: heavily penalize.
    if (r <= 0) return 0.1;

    // 0–0.3: still fairly low momentum; ramp up from 0.3 to 0.7.
    if (r < 0.3) {
      const t = r / 0.3;
      return 0.3 + t * (0.7 - 0.3);
    }

    // 0.3–0.8: strong positive autocorrelation, typical of humans.
    if (r <= 0.8) {
      const t = (r - 0.3) / (0.8 - 0.3);
      return 0.7 + t * (1.0 - 0.7);
    }

    // >0.8: cap at full score; extremely high autocorrelation is rare but fine.
    return 1.0;
  }

  // ---------------------------------------------------------------------------
  // Effort Density Vector (V_effort)
  // ---------------------------------------------------------------------------

  /**
   * V_effort = min(1.0, (typed_chars + deleted_chars * 1.5) / estimated_document_length) * 100
   *
   * This rewards:
   * - Longer drafting sessions.
   * - Heavy editing and backspacing.
   */
  _scoreVeffort(norm) {
    const typed = norm.typedChars;
    const deleted = norm.deletedChars;
    const docLen = Math.max(1, norm.estimatedDocumentLength || 1);
    // Cap effective deleted so backspace-spam cannot inflate effort beyond document volume.
    const pasted = Math.max(0, norm.pastedChars ?? 0);
    const effectiveDeleted = Math.min(deleted, typed + pasted);

    const effortNumerator = typed + effectiveDeleted * 1.5;
    const rawEffortRatio = effortNumerator / docLen;

    // Cap at 1.0 so extremely long sessions don't exceed 100.
    const bounded = Math.min(1.0, Math.max(0, rawEffortRatio));
    return this._clamp(bounded * 100, 0, 100);
  }

  // ---------------------------------------------------------------------------
  // Paste Decay Penalty (P_decay)
  // ---------------------------------------------------------------------------

  _computePasteRatio(norm) {
    const docLen = Math.max(1, norm.estimatedDocumentLength || 1);
    const total = norm.totalPastedChars || norm.pastedChars || 0;
    const ratio = total / docLen;
    return this._clamp(ratio, 0, 1);
  }

  /**
   * Paste penalty based on "Cognitive Paste Debt":
   *
   *   pasteDebt    = outstanding number of pasted characters that have not yet
   *                  been "paid off" via genuine editing.
   *   UDR          = pasteDebt / estimatedDocumentLength
   *   EffectiveUDR = UDR * (1 + (100 - V_bio) / 100)
   *
   * Interpretation:
   *   - When V_bio is high (genuinely human typing), the multiplier term is
   *     close to 1, so editing actually pays down the debt.
   *   - When V_bio is low (keyboard mashing or synthetic patterns), the
   *     multiplier inflates the effective debt back up, so "fake" editing does
   *     not neutralize the paste penalty.
   *
   * We then feed EffectiveUDR through a sigmoid so that:
   *   - EffectiveUDR <= debtSoftThreshold (~5%) => P_decay ≈ 1.0
   *   - EffectiveUDR >= debtHardThreshold (~40%) => P_decay approaches
   *     pasteMinMultiplier (e.g. 0.1).
   */
  _computePasteDecay(norm, vBio) {
    const docLen = Math.max(1, norm.estimatedDocumentLength || 1);
    const debt = Math.max(0, this._safeNumber(norm.pasteDebt));
    const baseUdr = debt / docLen;

    const vBioSafe = this._clamp(vBio, 0, 100);
    // When V_bio is 100 => factor = 1.0; when 0 => factor = 2.0.
    const mashFactor = 1 + (100 - vBioSafe) / 100;

    let effectiveUdr = baseUdr * mashFactor;
    effectiveUdr = this._clamp(effectiveUdr, 0, 1);

    const {
      debtSoftThreshold,
      debtHardThreshold,
      pasteMinMultiplier,
      pasteSigmoidAlpha,
    } = this.config;

    // Small quotes / minor debt incur no penalty.
    if (effectiveUdr <= debtSoftThreshold) {
      return 1.0;
    }

    // Normalize effectiveUdr into [0, 1] between soft and hard thresholds.
    const denom = Math.max(1e-6, debtHardThreshold - debtSoftThreshold);
    const tRaw = (effectiveUdr - debtSoftThreshold) / denom;
    const t = this._clamp(tRaw, 0, 1);

    // Sigmoid centered at 0.5: s(t) in (0,1), steepness controlled by alpha.
    const s = 1 / (1 + Math.exp(-pasteSigmoidAlpha * (t - 0.5)));

    // Map sigmoid output to [pasteMinMultiplier, 1.0].
    const minM = this._clamp(pasteMinMultiplier, 0, 1);
    const mult = 1 - s * (1 - minM);

    return this._clamp(mult, minM, 1);
  }
}

// Expose only the engine to global scope for content scripts.
window.JitterEngine = JitterEngine;

})();

