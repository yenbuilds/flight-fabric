export function mcpDraftKey(config, fallbackId = '') {
  const fieldId = typeof config?.fieldId === 'string' && config.fieldId
    ? config.fieldId
    : (typeof config?.id === 'string' && config.id ? config.id : fallbackId);
  const controlId = typeof config?.commandId === 'string'
    ? config.commandId
    : (typeof config?.actionId === 'string' ? config.actionId : '');
  return `${fieldId}:${controlId}`;
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
  requestCommand,
}) {
  if (disabled) return false;
  const next = parseMcpDraftNumber(rawValue, config);
  if (next === null) return false;
  if (typeof config?.commandId === 'string' && typeof requestCommand === 'function') {
    return requestCommand(config.commandId, groupId, { value: next });
  }
  if (typeof requestAction !== 'function') return false;
  return requestAction(config.actionId, groupId, next);
}

function formatMcpNumericDraft(rawValue) {
  const current = Number(rawValue);
  if (!Number.isFinite(current)) return '';
  return Number.isInteger(current) ? String(current) : String(Number(current.toFixed(2)));
}

export function reconcileMcpNumericDraftState(state = {}, snapshot = {}, previous = []) {
  const {
    rawValue,
    unavailable = false,
    profileKey,
    sourceStatus,
    pending = false,
  } = snapshot;
  const next = {
    draft: typeof state.draft === 'string' ? state.draft : '',
    dirty: state.dirty === true,
    error: typeof state.error === 'string' ? state.error : '',
  };
  const contextChanged = previous[2] !== undefined
    && (previous[2] !== profileKey || previous[3] !== sourceStatus);

  if (contextChanged || sourceStatus !== 'connected' || unavailable) {
    next.dirty = false;
    next.error = '';
  }
  if (unavailable || sourceStatus !== 'connected') {
    next.draft = '';
    return next;
  }
  if (!contextChanged && previous[4] !== undefined && pending) return next;
  if (!next.dirty) next.draft = formatMcpNumericDraft(rawValue);
  return next;
}
