export function alertTone(event) {
  if (event?.type === 'violation_end') return 'recovery';
  const severity = String(event?.severity || '').toLowerCase();
  if (severity === 'caution' || severity === 'advisory' || severity === 'info') return 'caution';
  return 'violation';
}

export const APPROACH_REASON_LABELS = Object.freeze({
  high_sink_rate: 'High sink rate', steep_path_rate: 'Steep path rate', shallow_path_rate: 'Shallow path rate',
  climbing_on_approach: 'Climbing on approach', glideslope_deviation: 'Glideslope deviation',
  airspeed_deviation: 'Airspeed changed from gate', excessive_bank: 'Excessive bank',
  pitch_deviation: 'Pitch deviation', localizer_deviation: 'Localizer deviation',
});

const finite = value => typeof value === 'number' && Number.isFinite(value);

export function approachEpisodeDetails(event) {
  const ctx = event?.context;
  if (ctx?.assessment_version !== 4) return null;
  const rows = [];
  const add = (key, label, value) => rows.push({ key, label, value, valueClass: 'text-gray-300 font-mono' });
  const heightUnit = ctx.altitude_source === 'radio' ? 'ft radio height' : 'ft AAL';
  const reasons = (ctx.reasons || []).map(reason => APPROACH_REASON_LABELS[reason] || reason).join(', ');
  if (reasons) add('reasons', 'Conditions', reasons);
  if (finite(ctx.start_height_ft) && finite(ctx.end_height_ft)) {
    add('height', 'Height', `${Math.round(ctx.start_height_ft)} → ${Math.round(ctx.end_height_ft)} ${heightUnit}`);
  }
  if (finite(ctx.threshold_exceedance_duration_ms)) add('exceedance', 'Time outside alert limits', `${(ctx.threshold_exceedance_duration_ms / 1000).toFixed(1)}s`);
  if (finite(ctx.duration_ms)) add('duration', 'Episode including recovery', `${(ctx.duration_ms / 1000).toFixed(1)}s`);
  if (event.ruleId === 'approach_vertical_profile' && finite(ctx.peak_sink_rate_fpm)) {
    add('peak', 'Peak descent rate', `${Math.round(ctx.peak_sink_rate_fpm)} fpm`);
  } else if (finite(ctx.peak_value)) {
    const unit = event.ruleId === 'approach_airspeed' ? 'kt' : event.ruleId === 'approach_localizer' ? 'dots' : '°';
    add('peak', 'Largest deviation reading', `${Number(ctx.peak_value.toFixed(1))} ${unit}`);
  }
  if (finite(ctx.peak_glideslope_dots)) add('glideslope', 'Peak glideslope deviation', `${ctx.peak_glideslope_dots.toFixed(1)} dots`);
  if (event.ruleId === 'approach_airspeed' && finite(ctx.target_value)) add('reference', 'Recorded gate IAS', `${ctx.target_value.toFixed(1)} kt`);
  add('ending', 'Episode ended', ctx.end_reason === 'recovered' ? 'Recovered inside the clear band'
    : ctx.end_reason === 'data_gap' ? 'Telemetry gap; recovery unknown' : ctx.end_reason === 'paused' ? 'Simulator paused' : 'Assessment window ended');
  return rows;
}
