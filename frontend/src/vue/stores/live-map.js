import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

function sanitizeIcao(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

const DEFAULT_MAP_EMPTY_MESSAGE = 'No live GPS position yet';

export const useLiveMapStore = defineStore('liveMap', () => {
  const followStatusKind = ref('following');
  const metaText = ref('Waiting for position data...');
  const mapEmptyVisible = ref(true);
  const mapEmptyMessage = ref(DEFAULT_MAP_EMPTY_MESSAGE);
  const targetInput = ref('');
  const originInput = ref('');
  const targetStatusMessage = ref('No target airport set');
  const targetStatusTone = ref('neutral');
  const originStatusMessage = ref('No origin airport set');
  const originStatusTone = ref('neutral');
  const overlayVisible = ref(false);
  const overlayRotationDeg = ref(0);
  const overlayPrimary = ref('--');
  const overlaySecondary = ref('--');
  const destinationProgressVisible = ref(false);
  const destinationProgressLabel = ref('Destination');
  const destinationProgressText = ref('--');
  const destinationProgressPercent = ref(0);
  let onCenterRequest = null;
  let onSetTargetRequest = null;
  let onClearTargetRequest = null;
  let onSetOriginRequest = null;
  let onClearOriginRequest = null;

  const followStatusLabel = computed(() => {
    if (followStatusKind.value === 'paused') return 'Paused';
    if (followStatusKind.value === 'no-data') return 'No Data';
    return 'Following';
  });

  const followStatusClass = computed(() => {
    if (followStatusKind.value === 'paused') {
      return 'px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-amber-500/20 text-amber-300 border border-amber-500/40';
    }
    if (followStatusKind.value === 'no-data') {
      return 'px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-red-500/15 text-red-300 border border-red-500/35';
    }
    return 'px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-emerald-500/15 text-emerald-300 border border-emerald-500/35';
  });

  const centerButtonLabel = computed(() => (
    followStatusKind.value === 'paused' ? 'Resume Follow' : 'Center'
  ));

  const centerButtonClass = computed(() => (
    followStatusKind.value === 'paused'
      ? 'px-2.5 py-1 rounded-lg border border-accent bg-surface-200 text-xs text-accent hover:text-white hover:bg-surface-300 transition-colors'
      : 'px-2.5 py-1 rounded-lg border border-surface-300 bg-surface-200 text-xs text-gray-300 hover:text-white hover:bg-surface-300 transition-colors'
  ));

  const targetStatusClass = computed(() => (
    targetStatusTone.value === 'error' ? 'text-xs text-red-400' : 'text-xs text-gray-500'
  ));
  const originStatusClass = computed(() => (
    originStatusTone.value === 'error' ? 'text-xs text-red-400' : 'text-xs text-gray-500'
  ));
  const overlayArrowStyle = computed(() => ({
    transform: `rotate(${overlayRotationDeg.value}deg)`,
  }));
  const destinationProgressWidthStyle = computed(() => ({
    width: `${destinationProgressPercent.value.toFixed(1)}%`,
  }));

  function setFollowStatus(kind) {
    followStatusKind.value = kind === 'paused' || kind === 'no-data' ? kind : 'following';
  }

  function setMeta(text) {
    metaText.value = text || 'Waiting for position data...';
  }

  function setMapEmptyState(nextState = {}) {
    if (Object.prototype.hasOwnProperty.call(nextState, 'visible')) {
      mapEmptyVisible.value = nextState.visible === true;
    }
    if (Object.prototype.hasOwnProperty.call(nextState, 'message')) {
      mapEmptyMessage.value = nextState.message || DEFAULT_MAP_EMPTY_MESSAGE;
    }
  }

  function hideMapEmptyState() {
    setMapEmptyState({ visible: false });
  }

  function resetMapEmptyState() {
    mapEmptyVisible.value = true;
    mapEmptyMessage.value = DEFAULT_MAP_EMPTY_MESSAGE;
  }

  function setTargetInput(value) {
    targetInput.value = sanitizeIcao(value);
  }

  function setOriginInput(value) {
    originInput.value = sanitizeIcao(value);
  }

  function setTargetStatus(text, tone = 'neutral') {
    targetStatusMessage.value = text || 'No target airport set';
    targetStatusTone.value = tone === 'error' ? 'error' : 'neutral';
  }

  function setOriginStatus(text, tone = 'neutral') {
    originStatusMessage.value = text || 'No origin airport set';
    originStatusTone.value = tone === 'error' ? 'error' : 'neutral';
  }

  function setOverlay(nextState = {}) {
    overlayVisible.value = nextState.visible === true;
    overlayRotationDeg.value = Number.isFinite(nextState.rotationDeg) ? Number(nextState.rotationDeg) : 0;
    overlayPrimary.value = nextState.primary || '--';
    overlaySecondary.value = nextState.secondary || '--';
  }

  function hideOverlay() {
    setOverlay({ visible: false, rotationDeg: 0, primary: '--', secondary: '--' });
  }

  function setDestinationProgress(nextState = {}) {
    destinationProgressVisible.value = nextState.visible === true;
    destinationProgressLabel.value = nextState.label || 'Destination';
    destinationProgressText.value = nextState.text || '--';
    destinationProgressPercent.value = Number.isFinite(nextState.percent)
      ? Math.max(0, Math.min(100, Number(nextState.percent)))
      : 0;
  }

  function hideDestinationProgress() {
    setDestinationProgress({ visible: false, label: 'Destination', text: '--', percent: 0 });
  }

  function bindRuntimeActions({
    onCenter = null,
    onSetTarget = null,
    onClearTarget = null,
    onSetOrigin = null,
    onClearOrigin = null,
  } = {}) {
    onCenterRequest = typeof onCenter === 'function' ? onCenter : null;
    onSetTargetRequest = typeof onSetTarget === 'function' ? onSetTarget : null;
    onClearTargetRequest = typeof onClearTarget === 'function' ? onClearTarget : null;
    onSetOriginRequest = typeof onSetOrigin === 'function' ? onSetOrigin : null;
    onClearOriginRequest = typeof onClearOrigin === 'function' ? onClearOrigin : null;
  }

  function requestCenter() {
    if (typeof onCenterRequest !== 'function') return false;
    onCenterRequest();
    return true;
  }

  function requestSetTarget() {
    if (typeof onSetTargetRequest !== 'function') return false;
    onSetTargetRequest();
    return true;
  }

  function requestClearTarget() {
    if (typeof onClearTargetRequest !== 'function') return false;
    onClearTargetRequest();
    return true;
  }

  function requestSetOrigin() {
    if (typeof onSetOriginRequest !== 'function') return false;
    onSetOriginRequest();
    return true;
  }

  function requestClearOrigin() {
    if (typeof onClearOriginRequest !== 'function') return false;
    onClearOriginRequest();
    return true;
  }

  return {
    bindRuntimeActions,
    centerButtonClass,
    centerButtonLabel,
    destinationProgressLabel,
    destinationProgressPercent,
    destinationProgressText,
    destinationProgressVisible,
    destinationProgressWidthStyle,
    followStatusClass,
    followStatusKind,
    followStatusLabel,
    hideMapEmptyState,
    hideDestinationProgress,
    hideOverlay,
    mapEmptyMessage,
    mapEmptyVisible,
    metaText,
    originInput,
    originStatusClass,
    originStatusMessage,
    originStatusTone,
    overlayArrowStyle,
    overlayPrimary,
    overlayRotationDeg,
    overlaySecondary,
    overlayVisible,
    requestCenter,
    requestClearOrigin,
    requestClearTarget,
    requestSetOrigin,
    requestSetTarget,
    resetMapEmptyState,
    setDestinationProgress,
    setFollowStatus,
    setMapEmptyState,
    setMeta,
    setOriginInput,
    setOriginStatus,
    setOverlay,
    setTargetInput,
    setTargetStatus,
    targetInput,
    targetStatusClass,
    targetStatusMessage,
    targetStatusTone,
  };
});
