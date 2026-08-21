(function startPmdg737PreviewToolbar() {
  'use strict';

  const API_ROOT = '/__pmdg-preview';
  let currentState = null;

  function element(tagName, options = {}) {
    const node = document.createElement(tagName);
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = options.text;
    if (options.type) node.type = options.type;
    if (options.title) node.title = options.title;
    return node;
  }

  async function requestState() {
    const response = await fetch(`${API_ROOT}/state`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Fixture state request failed (${response.status})`);
    return response.json();
  }

  async function requestScenario(scenario) {
    const response = await fetch(`${API_ROOT}/scenario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Scenario change failed (${response.status})`);
    return payload;
  }

  function mountToolbar(initialState) {
    if (document.querySelector('[data-pmdg-preview-toolbar]')) return;

    const toolbar = element('aside', { className: 'pmdg-preview-toolbar' });
    toolbar.dataset.pmdgPreviewToolbar = '';
    toolbar.setAttribute('aria-label', 'PMDG 737 fixture controls');

    const toggle = element('button', {
      className: 'pmdg-preview-toggle',
      text: 'FIXTURE DATA',
      type: 'button',
      title: 'Show or hide PMDG preview controls',
    });
    const toggleScenario = element('span', { className: 'pmdg-preview-toggle-scenario' });
    toggle.append(toggleScenario);

    const panel = element('div', { className: 'pmdg-preview-panel' });
    const heading = element('div', { className: 'pmdg-preview-heading' });
    const title = element('strong', { text: 'PMDG 737 preview' });
    const close = element('button', {
      className: 'pmdg-preview-close',
      text: 'Close',
      type: 'button',
      title: 'Collapse fixture controls',
    });
    heading.append(title, close);

    const safety = element('p', {
      className: 'pmdg-preview-safety',
      text: 'Local fixture only. No simulator or PMDG commands are sent.',
    });
    const label = element('label', {
      className: 'pmdg-preview-label',
      text: 'Aircraft state',
    });
    const select = element('select', { className: 'pmdg-preview-select' });
    select.dataset.pmdgPreviewScenario = '';
    select.setAttribute('aria-label', 'PMDG fixture scenario');
    label.append(select);
    const description = element('p', { className: 'pmdg-preview-description' });
    const status = element('p', { className: 'pmdg-preview-status' });
    status.setAttribute('role', 'status');
    const reset = element('button', {
      className: 'pmdg-preview-reset',
      text: 'Reset this scenario',
      type: 'button',
    });
    panel.append(heading, safety, label, description, status, reset);
    toolbar.append(toggle, panel);
    document.body.append(toolbar);

    const requestedOpen = new URLSearchParams(window.location.search).get('previewPanel') === 'open';
    let open = requestedOpen;

    function setOpen(nextOpen) {
      open = Boolean(nextOpen);
      toolbar.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      panel.hidden = !open;
    }

    function render(state) {
      currentState = state;
      const knownIds = new Set(Array.from(select.options).map((option) => option.value));
      for (const scenario of state.scenarios || []) {
        if (knownIds.has(scenario.id)) continue;
        const option = element('option', { text: scenario.label });
        option.value = scenario.id;
        select.append(option);
      }
      select.value = state.scenario;
      toggleScenario.textContent = ` / ${state.label}`;
      description.textContent = state.description;
      status.textContent = state.dirty
        ? 'Modified by page controls. Reset to restore the fixture.'
        : `Source: ${String(state.sourceStatus || 'unknown').toUpperCase()}`;
      status.classList.toggle('is-dirty', Boolean(state.dirty));
    }

    async function changeScenario(scenario) {
      select.disabled = true;
      reset.disabled = true;
      status.textContent = 'Applying fixture state...';
      try {
        render(await requestScenario(scenario));
      } catch (error) {
        status.textContent = error.message;
        status.classList.add('is-error');
        throw error;
      } finally {
        select.disabled = false;
        reset.disabled = false;
      }
      return currentState;
    }

    toggle.addEventListener('click', () => setOpen(!open));
    close.addEventListener('click', () => setOpen(false));
    select.addEventListener('change', () => {
      status.classList.remove('is-error');
      changeScenario(select.value).catch(() => {});
    });
    reset.addEventListener('click', () => {
      status.classList.remove('is-error');
      changeScenario(select.value).catch(() => {});
    });

    window.__PMDG_737_PREVIEW__ = Object.freeze({
      getState: requestState,
      setScenario: changeScenario,
    });
    render(initialState);
    setOpen(open);
  }

  function start() {
    requestState()
      .then(mountToolbar)
      .catch((error) => {
        console.error('[pmdg-737-preview] Could not mount fixture toolbar:', error);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}());
