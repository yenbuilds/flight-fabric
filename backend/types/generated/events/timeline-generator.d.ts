/**
 * Timeline Generator - Reconstruct timelines from CSV flight logs
 *
 * ── ARCHITECTURE: THREE DETECTION PATTERNS ──────────────────────────────────
 *
 * 1. VIOLATION LOOP (streaming, per-row)
 *    Runs inside the main CSV row-iteration loop. Each row is examined in
 *    chronological order and checkViolationCondition() emits start/end event
 *    pairs whenever a metric crosses a threshold. Works on per-row data only;
 *    it has no knowledge of what comes later in the file (runway identity,
 *    whether a touchdown follows, etc.).
 *    Examples: high_sink_rate, GLIDESLOPE, LOCALIZER, BANK_ANGLE, below_glidepath
 *
 * 2. TOUCHDOWN EVENT BUILDER (single-point, triggered on WOW transition)
 *    Fires once per landing when the on_ground flag transitions from false→true
 *    at a reasonable IAS/VS. At this point the CSV row is the touchdown sample,
 *    the approach buffer (approachSamples) holds all pre-touchdown telemetry,
 *    and findRunwayByPosition() has resolved the runway. This is the ONLY place
 *    where runway geometry (threshold lat/lon, heading) is available during
 *    parsing, which is why any check that needs geometric runway context must
 *    live here rather than in the Violation Loop.
 *    Examples: landing grade, touchdown-zone scoring, lateral offset, short landing.
 *
 * 3. RETROACTIVE SCAN (post-hoc, at touchdown, over the approach buffer)
 *    After the landing event is assembled, the complete approachSamples buffer
 *    is scanned backwards or forwards to find conditions that could not be
 *    detected streaming because they require runway context. Results are emitted
 *    as violation_start events with a timestampMs pointing back to the moment
 *    the condition occurred in the approach, not to the touchdown moment.
 *    Examples: dangerously_low_approach (RA < threshold while still pre-threshold).
 *
 * ── STABILITY SCORER (retrospective, at touchdown) ──────────────────────────
 *    SimpleStabilityScorer accumulates approach samples (fed in the same loop
 *    that fills approachSamples) and computes a breakdown score at touchdown via
 *    getScore(). This is intentionally not just a fallback for missing LANDING
 *    rows: the legacy per-tick stability scorer was removed, and the live
 *    current-approach score is now written into the LANDING CSV row when the
 *    in-memory scorer is available. CSV replay still recomputes a fallback for
 *    older recordings and incomplete logs. If a LANDING row contains
 *    ultimate_stability_* fields, the merge path below prefers those persisted
 *    values.
 *
 *    Future simplification: once LANDING rows reliably persist the complete
 *    ultimate_stability_* payload and tests prove parity with CSV replay, this
 *    replay scorer can be demoted to a compatibility fallback or removed.
 *
 *    Stability is separate from the Violation Loop — violations are timeline
 *    events; the stability breakdown is a numeric summary on the landing card.
 *
 * ── DATA FLOWS ───────────────────────────────────────────────────────────────
 *    CSV row → Violation Loop → violation_start/end events on generatedTimeline
 *    CSV row → approachSamples buffer → Touchdown Event Builder → landing event
 *                                     → Retroactive Scan → violation_start events
 *                                     → SimpleStabilityScorer → breakdown on landing
 *
 * ── ON-DEMAND RECONSTRUCTION ─────────────────────────────────────────────────
 *    Timelines are reconstructed on-demand from CSV flight logs rather than being
 *    saved during flight. This ensures timelines are always available even if
 *    flights don't end cleanly (sim crash, user quits, backend killed). Since the
 *    CSV is append-only and survives crashes, we can always reconstruct from it.
 */
export {};
