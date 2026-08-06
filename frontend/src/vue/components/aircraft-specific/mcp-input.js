export function mcpDraftKey(config, fallbackId = '') {
  const fieldId = typeof config?.fieldId === 'string' && config.fieldId
    ? config.fieldId
    : (typeof config?.id === 'string' && config.id ? config.id : fallbackId);
  const actionId = typeof config?.actionId === 'string' ? config.actionId : '';
  return `${fieldId}:${actionId}`;
}

export function parseMcpDraftNumber(rawValue, config) {
  if (typeof rawValue === 'string' && rawValue.trim() === '') return null;

  const next = Number(rawValue);
  if (!Number.isFinite(next)) return null;
  if (Number.isFinite(config?.min) && next < config.min) return null;
  if (Number.isFinite(config?.max) && next > config.max) return null;

  if (Number.isFinite(config?.step) && config.step > 0 && Number.isFinite(config?.min)) {
    const stepOffset = (next - config.min) / config.step;
    if (Math.abs(stepOffset - Math.round(stepOffset)) > 1e-7) return null;
  }

  return next;
}

export function submitMcpDraft({
  config,
  disabled,
  groupId,
  rawValue,
  requestAction,
}) {
  if (disabled || typeof requestAction !== 'function') return false;
  const next = parseMcpDraftNumber(rawValue, config);
  if (next === null) return false;
  return requestAction(config.actionId, groupId, next);
}
