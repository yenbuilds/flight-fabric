'use strict';

function controllerDisplayName(value) {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim()).slice(0, 100).join('');
}

function normalizeControllerBinding(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
      || typeof value.devicePath !== 'string' || !value.devicePath || value.devicePath.length > 4096
      || /[\x00-\x1f\x7f]/.test(value.devicePath)
      || !Number.isInteger(value.reportId) || value.reportId < 0 || value.reportId > 255
      || !Number.isInteger(value.linkCollection) || value.linkCollection < 0 || value.linkCollection > 65535
      || !Number.isInteger(value.button) || value.button < 1 || value.button > 65535) {
    throw new TypeError('Controller button identity is invalid. Select the button again.');
  }
  const label = controllerDisplayName(value.label);
  return Object.freeze({ version: 1, devicePath: value.devicePath, reportId: value.reportId,
    linkCollection: value.linkCollection, button: value.button, label: label || 'Controller' });
}

function sameControllerButton(event, binding) {
  return Boolean(binding && typeof event?.path === 'string'
    && event.path.toLowerCase() === binding.devicePath.toLowerCase()
    && event.reportId === binding.reportId && event.linkCollection === binding.linkCollection
    && event.button === binding.button);
}

function controllerArguments(binding, accelerator = '') {
  const valid = normalizeControllerBinding(binding);
  return ['--controller-integration', '--shortcut', accelerator, '--device-path', valid.devicePath,
    '--report-id', String(valid.reportId), '--collection', String(valid.linkCollection), '--button', String(valid.button)];
}

// This summary is safe for the renderer. Device paths stay in the main process.
function controllerSummary(binding, state = 'unbound', error = '', label = binding?.label) {
  return { binding: binding ? { label, button: binding.button } : null, state, error };
}

module.exports = { normalizeControllerBinding, sameControllerButton, controllerArguments, controllerSummary, controllerDisplayName };
