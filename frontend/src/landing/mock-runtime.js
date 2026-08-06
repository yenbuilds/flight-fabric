// ES module — strict mode is implicit in modules.

/**
 * Mock landing runtime
 * Injects realistic mock landing + stability data into the frontend
 * so the approach-profile diagram, stability breakdown and landing card
 * can be previewed without running a simulator.
 *
 * Wires optional demo controls when a test or local harness provides them,
 * keeping the scenario injector module-local instead of exposing another global.
 *
 * Scenarios: 'good', 'butter', 'hard', 'unstable'
 */

// ── helpers ──────────────────────────────────────────────────────────────
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function jitter(base, range) { return base + (Math.random() - 0.5) * range; }

// ── approach profile builder ─────────────────────────────────────────────
/**
 * Build a synthetic approach profile array.
 *
 * Altitude is simply linearly interpolated from startAltFt → 0 with minor
 * jitter and an optional sink-burst segment for bad-approach scenarios.
 * The last ~8 % of samples form a gentle flare (rate tapers to zero).
 *
 * @param {object} p
 * @param {number} p.startAltFt   – RA at first sample (top of profile)
 * @param {number} p.points       – total sample count
 * @param {number} p.avgVsFpm     – average descent rate (negative, for V/S annotation only)
 * @param {number} p.iasKts       – approach IAS
 * @param {number} p.gsKts        – ground speed
 * @param {number} p.sinkBurstIdx – index range [start,end] of a high-sink-rate segment (or null)
 * @param {number} p.sinkBurstFpm – V/S during burst
 * @param {number} [p.jitterFt=2] – altitude jitter amplitude (ft)
 */
function buildProfile(p) {
  const pts = [];
  const n = p.points;
  const altJitter = p.jitterFt != null ? p.jitterFt : 2;

  // Flare: last 8 % — altitude taper slows to zero
  const flareStart = Math.floor(n * 0.92);

  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);                            // 0 → 1

    // ── Altitude: straight-line from startAlt → 0, with gentle flare ──
    let targetAlt;
    if (i <= flareStart) {
      // Linear descent
      const flareAlt = p.startAltFt * (1 - flareStart / (n - 1));
      targetAlt = lerp(p.startAltFt, flareAlt, i / flareStart);
    } else {
      // Flare: remaining altitude tapers to 0
      const flareAlt = p.startAltFt * (1 - flareStart / (n - 1));
      const flareFrac = (i - flareStart) / (n - 1 - flareStart); // 0 → 1
      // Cosine taper: starts at descent rate, ends at zero rate
      targetAlt = flareAlt * (1 - flareFrac) * (1 - 0.5 * flareFrac);
    }

    // Apply sink burst (pushes altitude below the ideal line)
    let burstOffset = 0;
    if (p.sinkBurstIdx && i >= p.sinkBurstIdx[0] && i <= p.sinkBurstIdx[1]) {
      const burstT = (i - p.sinkBurstIdx[0]) / (p.sinkBurstIdx[1] - p.sinkBurstIdx[0]);
      burstOffset = Math.sin(burstT * Math.PI) * Math.abs(p.sinkBurstFpm) * 0.04;
    }

    const alt = Math.max(0, targetAlt - burstOffset + jitter(0, altJitter));

    // ── V/S: back-derive from altitude delta ──
    const prevAlt = pts.length > 0 ? pts[pts.length - 1].raFt : p.startAltFt;
    const vs = (alt - prevAlt) * 60;

    const pitch = jitter(lerp(-1, 3, t), 0.3);

    pts.push({
      raFt:    Math.round(alt * 10) / 10,
      vsFpm:   Math.round(vs),
      iasKts:  Math.round(jitter(p.iasKts - t * 8, 2)),
      gsKts:   Math.round(jitter(p.gsKts  - t * 6, 2)),
      pitchDeg: Math.round(pitch * 10) / 10,
      bankDeg:  Math.round(jitter(0, 2) * 10) / 10,
    });
  }

  // Guarantee last point is exactly on the runway
  pts[pts.length - 1].raFt = 0;
  return pts;
}

// ── scenario definitions ─────────────────────────────────────────────────
const SCENARIOS = {
  good: {
    label: 'Good ILS',
    profile: {
      startAltFt: 1100, points: 80, avgVsFpm: -720,
      iasKts: 142, gsKts: 152, sinkBurstIdx: null, sinkBurstFpm: 0,
    },
    landing: {
      vs: -180, grade: 'GOOD', color: '#4ade80',
      gforce: 1.25, icao: 'EGLL', runway: '27L',
      pitchDeg: 3.2, bankDeg: -1.1, centerlineDev: 1.2,
      crosswind: 8, windSpeed: 14, iasKts: 138, gsKts: 148,
      approachType: 'ILS', final: true,
      runwayExcursion: false, shortLanding: false,
      touchdownDistance: {
        distanceFt: 850, grade: 'Outstanding', score: 100, tdzAchieved: true,
        shortLanding: false, runway: 'EGLL/27L',
        lateralOffsetFt: 12, lateralOffsetSide: 'L', lateralOffsetGrade: 'Good',
        lateralOffsetScore: 88, lateralOffsetSuspect: false, runwayWidthFt: 150,
        bounceGrade: 'Clean', bounceCount: 0, bounceDistanceFt: null, bounceScore: 100,
      },
      ultimateStability: { score: 87, gateStable: true },
    },
    stability: {
      score: 87, samples: 246,
      breakdown: {
        speed_ok: 92, speed_trend_ok: 88,
        vs_ok: 85, glidepath_ok: 80,
        config_ok: 100, flaps_ok: 100, gear_ok: 100, spoilers_ok: 95,
        thrust_ok: 78, thrust_not_idle_ok: 100, thrust_stable_ok: 78,
        pitch_ok: 90, bank_ok: 95,
      },
      breakdownDetails: {
        gateStable: true, gateFailures: [],
      },
    },
  },

  butter: {
    label: 'Butter Landing',
    profile: {
      startAltFt: 1050, points: 90, avgVsFpm: -650,
      iasKts: 140, gsKts: 148, sinkBurstIdx: null, sinkBurstFpm: 0,
    },
    landing: {
      vs: -68, grade: 'PERFECT', color: '#4ade80',
      gforce: 1.05, icao: 'KJFK', runway: '31L',
      pitchDeg: 4.1, bankDeg: 0.3, centerlineDev: 0.4,
      crosswind: 3, windSpeed: 8, iasKts: 136, gsKts: 144,
      approachType: 'ILS CAT III', final: true,
      runwayExcursion: false, shortLanding: false,
      touchdownDistance: {
        distanceFt: 980, grade: 'Outstanding', score: 100, tdzAchieved: true,
        shortLanding: false, runway: 'KJFK/31L',
        lateralOffsetFt: 4, lateralOffsetSide: 'R', lateralOffsetGrade: 'Perfect',
        lateralOffsetScore: 98, lateralOffsetSuspect: false, runwayWidthFt: 150,
        bounceGrade: 'Clean', bounceCount: 0, bounceDistanceFt: null, bounceScore: 100,
      },
      ultimateStability: { score: 96, gateStable: true },
    },
    stability: {
      score: 96, samples: 310,
      breakdown: {
        speed_ok: 98, speed_trend_ok: 95,
        vs_ok: 96, glidepath_ok: 92,
        config_ok: 100, flaps_ok: 100, gear_ok: 100, spoilers_ok: 100,
        thrust_ok: 90, thrust_not_idle_ok: 100, thrust_stable_ok: 90,
        pitch_ok: 95, bank_ok: 98,
      },
      breakdownDetails: {
        gateStable: true, gateFailures: [],
      },
    },
  },

  hard: {
    label: 'Hard Landing',
    profile: {
      startAltFt: 1200, points: 70, avgVsFpm: -850,
      iasKts: 148, gsKts: 158, sinkBurstIdx: [45, 55], sinkBurstFpm: -1350,
    },
    landing: {
      vs: -520, grade: 'HARD', color: '#ef4444',
      gforce: 2.1, icao: 'KLAX', runway: '25L',
      pitchDeg: 1.1, bankDeg: -4.2, centerlineDev: 6.8,
      crosswind: 18, windSpeed: 24, iasKts: 152, gsKts: 162,
      approachType: 'VISUAL', final: true,
      runwayExcursion: false, shortLanding: false,
      touchdownDistance: {
        distanceFt: 2100, grade: 'Good', score: 90, tdzAchieved: false,
        shortLanding: false, runway: 'KLAX/25L',
        lateralOffsetFt: 38, lateralOffsetSide: 'R', lateralOffsetGrade: 'Marginal',
        lateralOffsetScore: 62, lateralOffsetSuspect: false, runwayWidthFt: 150,
        bounceGrade: 'Single Bounce', bounceCount: 1, bounceDistanceFt: 280, bounceScore: 72,
      },
      ultimateStability: { score: 58, gateStable: false },
    },
    stability: {
      score: 58, samples: 188,
      breakdown: {
        speed_ok: 65, speed_trend_ok: 50,
        vs_ok: 40, glidepath_ok: 55,
        config_ok: 100, flaps_ok: 100, gear_ok: 100, spoilers_ok: 70,
        thrust_ok: 45, thrust_not_idle_ok: 100, thrust_stable_ok: 45,
        pitch_ok: 60, bank_ok: 50,
      },
      breakdownDetails: {
        gateStable: false,
        gateFailures: ['vs_ok', 'speed_ok', 'bank_ok', 'thrust_stable_ok'],
      },
    },
  },

  unstable: {
    label: 'Unstable Approach',
    profile: {
      startAltFt: 1250, points: 85, avgVsFpm: -920,
      iasKts: 155, gsKts: 168, sinkBurstIdx: [30, 50], sinkBurstFpm: -1500,
    },
    landing: {
      vs: -380, grade: 'FIRM', color: '#fbbf24',
      gforce: 1.65, icao: 'EDDM', runway: '08R',
      pitchDeg: 1.8, bankDeg: 3.5, centerlineDev: 4.1,
      crosswind: 12, windSpeed: 20, iasKts: 148, gsKts: 160,
      approachType: 'VISUAL', final: true,
      runwayExcursion: false, shortLanding: false,
      touchdownDistance: {
        distanceFt: 1850, grade: 'Good', score: 90, tdzAchieved: false,
        shortLanding: false, runway: 'EDDM/08R',
        lateralOffsetFt: 22, lateralOffsetSide: 'L', lateralOffsetGrade: 'Marginal',
        lateralOffsetScore: 68, lateralOffsetSuspect: false, runwayWidthFt: 150,
        bounceGrade: 'Multiple Bounces', bounceCount: 2, bounceDistanceFt: 460, bounceScore: 55,
      },
      ultimateStability: { score: 42, gateStable: false },
    },
    stability: {
      score: 42, samples: 220,
      breakdown: {
        speed_ok: 45, speed_trend_ok: 35,
        vs_ok: 30, glidepath_ok: 25,
        config_ok: 80, flaps_ok: 80, gear_ok: 100, spoilers_ok: 60,
        thrust_ok: 30, thrust_not_idle_ok: 100, thrust_stable_ok: 30,
        pitch_ok: 50, bank_ok: 40,
      },
      breakdownDetails: {
        gateStable: false,
        gateFailures: ['vs_ok', 'glidepath_ok', 'speed_ok', 'speed_trend_ok', 'thrust_stable_ok', 'bank_ok'],
      },
    },
  },
};

// ── inject ───────────────────────────────────────────────────────────────
/**
 * Inject a mock landing scenario into the live frontend.
 * @param {'good'|'butter'|'hard'|'unstable'} [scenario='good']
 */
function createScenarioInjector({
  getHandleMessage = () => null,
  windowRef = window,
} = {}) {
  const schedule = typeof windowRef?.setTimeout === 'function'
    ? windowRef.setTimeout.bind(windowRef)
    : setTimeout;

  return function inject(scenario) {
    const s = SCENARIOS[scenario] || SCENARIOS.good;
    const handleMessage = typeof getHandleMessage === 'function'
      ? getHandleMessage()
      : null;
    if (typeof handleMessage !== 'function') {
      console.error('[MockLanding] shared message handler is not available');
      return;
    }

    const profile = buildProfile(s.profile);

    // 1) Send ultimateStabilityScore (includes approach profile + breakdown)
    handleMessage({
      type: 'ultimateStabilityScore',
      score: s.stability.score,
      breakdown: s.stability.breakdown,
      breakdownDetails: s.stability.breakdownDetails,
      samples: s.stability.samples,
      approachProfile: profile,
    });

    // 2) Send landing message (short delay so stability renders first)
    schedule(() => {
      handleMessage(Object.assign({ type: 'landing' }, s.landing));
    }, 80);

    console.log(`[MockLanding] Injected "${s.label}" scenario`);
  };
}

// ── button wiring ────────────────────────────────────────────────────────
// ── button wiring (DOM is ready — module is deferred) ——————————————
export function initMockLandingRuntime({
  getHandleMessage = () => null,
  documentRef = document,
  windowRef = window,
} = {}) {
  const inject = createScenarioInjector({ getHandleMessage, windowRef });
  const bar = documentRef.getElementById('demo-landing-bar');
  const cleanupFns = [];

  if (typeof windowRef.electronAPI !== 'undefined') {
    if (bar) {
      bar.classList.add('hidden');
      cleanupFns.push(() => bar.classList.remove('hidden'));
    }
  } else {
    const btn = documentRef.getElementById('demo-landing-btn');
    const select = documentRef.getElementById('demo-landing-select');
    if (btn) {
      const handleDemoLandingClick = () => {
        const scenario = select ? select.value : 'good';
        inject(scenario);
      };
      btn.addEventListener('click', handleDemoLandingClick);
      cleanupFns.push(() => btn.removeEventListener('click', handleDemoLandingClick));
    }
  }

  function cleanup() {
    while (cleanupFns.length > 0) {
      cleanupFns.pop()?.();
    }
  }

  return { inject, cleanup };
}

