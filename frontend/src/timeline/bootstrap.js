// ES module - strict mode is implicit in modules.
import { buildTimelineEventRows } from './events.js';
import { MARKER_LABELS, TYPE_LABELS } from './constants.js';
import { buildTimelineEventDetailState } from './detail-state.js';
import {
  buildTimelineAltitudeProfileModel,
  updateTimelineAltitudeProfileCursor,
} from './altitude-profile.js';
import {
  eventPassesMapFilter as mapEventPassesFilter,
  getEventPosition as getMapEventPosition,
  getTimelineEventMarkerVisual as getMapEventMarkerVisual,
} from './map.js';
import {
  createTimelineMapController,
} from './map-controller.js';
import {
  getEventAttitudeDeg,
  normalizeTimelineTrackPoints,
} from './track-points.js';
import { createPFD } from './pfd.js';
import {
  createScrubber,
  formatTimeOffset as formatTimelineOffset,
} from './scrubber.js';
import { buildTimelineSummaryState, compactTimelineEvents, formatDuration, normalizeTimelineForUI } from './model.js';
import { attachTimelinePfdOverlayFitter } from './pfd-overlay.js';
import { createTimelinePageController } from './page-controller.js';
import { createTimelineProfileController } from './profile.js';
import { createTimelineRuntime } from './runtime.js';
import { approachProfileApi } from '../landing/approach-profile-global.js';

function defaultCoordValidator(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  return !(Math.abs(lat) <= 1e-6 && Math.abs(lon) <= 1e-6);
}

export function isTimelineMapElementVisible({
  tabsStore = null,
  timelineStore = null,
  mapEl = null,
} = {}) {
  if (!mapEl) return false;

  const tabVisible = !tabsStore || tabsStore.activeTabId === 'timeline';
  const modalVisible = timelineStore?.timelineMobileViewerOpen === true;
  if (!tabVisible && !modalVisible) return false;

  if (mapEl.offsetParent != null) return true;

  const width = Number(mapEl.clientWidth);
  const height = Number(mapEl.clientHeight);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

export function initTimelinePage({
  timelineStore = null,
  tabsStore = null,
  statusStore = null,
  getAuthorizationScope = null,
  getElementById = (id) => document.getElementById(id),
  isValidCoord = null,
  windowRef = window,
  documentRef = document,
  allowOnlineMapTiles = () => true,
  approachProfileApiRef = approachProfileApi,
  subscribeLandingReceivedSignal = null,
  subscribeWsMessageSignal = null,
} = {}) {
  if (!timelineStore) {
    throw new Error('Timeline store is required before timeline bootstrap');
  }
  const resolvedIsValidCoord = typeof isValidCoord === 'function' ? isValidCoord : defaultCoordValidator;

  const scrubberEl = getElementById('timeline-time-scrubber');
  const pfdHdgTape = getElementById('pfd-hdg-tape');
  const pfdSpdTape = getElementById('pfd-spd-tape');
  const pfdAltTape = getElementById('pfd-alt-tape');
  const pfdPitchMarks = getElementById('pfd-adi-pitchmarks');
  const profileCanvas = getElementById('pfd-profile-canvas');
  const mapEl = getElementById('timeline-map');

  const timelinePfd = createPFD({
    documentRef,
    timelineStore,
    pfdHdgTape,
    pfdSpdTape,
    pfdAltTape,
    pfdPitchMarks,
  });

  let timelineScrubberPoints = [];
  let timelineScrubberStartMs = null;
  let timelineScrubberEndMs = null;
  let timelineAltitudeProfileModel = null;
  let timelinePage = null;
  let timelineRuntime = null;

// Map marker filters
// Default: only violations on the map. Other categories are noisy and can
// be re-enabled per user via checkboxes above the map.
function isTimelineTabVisible() {
  return isTimelineMapElementVisible({ tabsStore, timelineStore, mapEl });
}

function eventPassesMapFilter(event) {
  return mapEventPassesFilter(event, timelineStore.mapFilters || {});
}

function getTimelineEventMarkerVisual(event) {
  return getMapEventMarkerVisual(event);
}

function createTimelineEventIcon(event) {
  return createTimelineBadgeIcon(getTimelineEventMarkerVisual(event));
}

function createTimelineBadgeIcon(visual) {
  const sizePx = visual.size;
  const iconSize = visual.shape === 'pill' ? Math.max(26, sizePx * 2.8) : Math.max(20, sizePx + 11);
  const borderRadius = visual.shape === 'pill' ? '999px' : (visual.shape === 'diamond' ? '3px' : '999px');
  const extraTransform = visual.shape === 'diamond' ? 'transform:rotate(45deg);' : '';
  const glyphTransform = visual.shape === 'diamond' ? 'transform:rotate(-45deg);' : '';
  const style = [
    `width:${iconSize}px`,
    `height:${visual.shape === 'pill' ? Math.max(18, sizePx + 8) : iconSize}px`,
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'font-family:ui-monospace, SFMono-Regular, Menlo, monospace',
    'letter-spacing:0.02em',
    `font-size:${sizePx}px`,
    `color:${visual.fg}`,
    `background:${visual.bg}`,
    `border:1.5px solid ${visual.border}`,
    `border-radius:${borderRadius}`,
    'box-shadow:0 0 10px rgba(2, 6, 23, 0.85)',
    'line-height:1',
    'font-weight:700',
    'user-select:none',
    extraTransform,
  ].join(';');

  return windowRef.L.divIcon({
    className: 'timeline-event-marker-icon',
    html: `<div style="${style}"><span style="${glyphTransform}">${visual.glyph}</span></div>`,
    iconSize: [iconSize, iconSize],
    iconAnchor: [Math.round(iconSize / 2), Math.round(iconSize / 2)],
  });
}

function jumpToTimelineEvent(event, originalIndex, options = {}) {
  const shouldPanMap = options.shouldPanMap !== false;
  if (!event) return;

  const timestampMs = Number(event?.timestampMs);
  let scrubbed = false;
  if (Number.isFinite(timestampMs) && Number.isFinite(timelineScrubberStartMs)) {
    const offsetMs = Math.max(0, timestampMs - timelineScrubberStartMs);
    scrubbed = !!scrubToOffset(offsetMs, shouldPanMap);
  }

  if (!scrubbed) {
    timelineMapController.focusEvent(event);
  }

  if (timelinePage && Number.isFinite(originalIndex)) {
    timelinePage.selectTimelineRowByOriginalIndex(originalIndex, { focusMap: false });
  }
}

function getEventPosition(event) {
  return getMapEventPosition(event, resolvedIsValidCoord);
}

  const timelineProfile = createTimelineProfileController({
    profileCanvas,
    windowRef,
  });

  function publishAltitudeProfile(offsetMs = 0) {
    timelineStore.setAltitudeProfileState(updateTimelineAltitudeProfileCursor(timelineAltitudeProfileModel, offsetMs));
  }

  function updateProfileCursor(offsetMs) {
    timelineProfile.updateCursorByOffset(offsetMs, timelineScrubberStartMs, timelineScrubberEndMs);
    publishAltitudeProfile(offsetMs);
  }

  function updateOrientationWidget(headingDeg = null, pitchDeg = null, rollDeg = null, iasKts = null, altFt = null) {
    timelinePfd.update({ headingDeg, pitchDeg, rollDeg, iasKts, altFt });
  }

  const timelineMapController = createTimelineMapController({
    mapEl,
    timelineStore,
    windowRef,
    consoleRef: console,
    isTimelineTabVisible,
    isValidCoord: resolvedIsValidCoord,
    eventPassesMapFilter,
    getEventPosition,
    getEventAttitude: getEventAttitudeDeg,
    createTimelineEventIcon,
    jumpToTimelineEvent,
    updateOrientationWidget,
    syncScrubberToTimestamp,
    updateProfileCursor,
    getTimelineScrubberStartMs: () => timelineScrubberStartMs,
    typeLabels: TYPE_LABELS,
    allowOnlineTiles: allowOnlineMapTiles,
  });

  const timelineScrubber = createScrubber({
    scrubberEl,
    timelineStore,
    windowRef,
    onScrub: (point, offsetMs, shouldPanMap) => {
      updateProfileCursor(offsetMs);
      timelineMapController.setCursorPosition(point, {
        headingDeg: point.hdgTrueDeg,
        pitchDeg: point.pitchDeg,
        rollDeg: point.rollDeg,
        iasKts: point.iasKts,
        altFt: point.altFt,
      }, shouldPanMap);
    },
  });

function getTimelineScrubberPoints(timeline, trackPoints = null) {
  const normalizedTrackPoints = Array.isArray(trackPoints)
    ? trackPoints
    : normalizeTimelineTrackPoints(timeline, {
      isValidCoord: resolvedIsValidCoord,
      getEventPosition,
      getEventAttitude: getEventAttitudeDeg,
    });
  const points = normalizedTrackPoints
    .filter((point) => Number.isFinite(point.timestampMs))
    .slice()
    .sort((a, b) => a.timestampMs - b.timestampMs);

  if (points.length <= 1) {
    const eventPoints = (Array.isArray(timeline?.events) ? timeline.events : [])
      .map((event) => {
        const pos = getEventPosition(event);
        const timestampMs = Number(event?.timestampMs);
        if (!pos || !Number.isFinite(timestampMs)) return null;
        const { headingDeg, pitchDeg, rollDeg } = getEventAttitudeDeg(event);
        const eventIas = Number(event?.ias_kts);
        const eventAlt = Number(event?.alt_msl_ft ?? event?.alt_ft);
        return {
          lat: pos.lat,
          lon: pos.lon,
          timestampMs,
          hdgTrueDeg: Number.isFinite(headingDeg) ? headingDeg : null,
          pitchDeg: Number.isFinite(pitchDeg) ? pitchDeg : null,
          rollDeg: Number.isFinite(rollDeg) ? rollDeg : null,
          iasKts: Number.isFinite(eventIas) ? eventIas : null,
          altFt: Number.isFinite(eventAlt) ? eventAlt : null,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.timestampMs - b.timestampMs);
    return eventPoints;
  }

  return points;
}

  function syncScrubberToTimestamp(timestampMs) {
    timelineScrubber.syncToTimestamp(timestampMs);
  }

  function scrubToOffset(offsetMs, shouldPanMap = true) {
    return timelineScrubber.scrubToOffset(offsetMs, shouldPanMap);
  }

  function setupTimelineScrubber(timeline, trackPoints = null) {
    timelineScrubberPoints = getTimelineScrubberPoints(timeline, trackPoints);

    if (!timelineScrubber.setPoints(timelineScrubberPoints)) {
      timelineScrubberStartMs = null;
      timelineScrubberEndMs = null;
      timelineAltitudeProfileModel = null;
      timelineStore.resetAltitudeProfileState();
      return;
    }

    timelineScrubberStartMs = timelineScrubber.getStartMs();
    timelineScrubberEndMs = timelineScrubber.getEndMs();
    timelineProfile.setPoints(timelineScrubberPoints);
    timelineAltitudeProfileModel = buildTimelineAltitudeProfileModel(timelineScrubberPoints, {
      startMs: timelineScrubberStartMs,
      endMs: timelineScrubberEndMs,
    });
    publishAltitudeProfile(0);
    scrubToOffset(0, false);
  }

  function resetScrubberUi() {
    timelineScrubberPoints = [];
    timelineScrubberStartMs = null;
    timelineScrubberEndMs = null;
    timelineAltitudeProfileModel = null;
    timelineScrubber.setPoints([]);
    timelineProfile.setPoints([]);
    timelineStore.resetAltitudeProfileState();
  }

  timelinePage = createTimelinePageController({
    timelineStore,
    timelineMapController,
    normalizeTimelineForUI,
    compactTimelineEvents,
    buildTimelineSummaryState,
    buildTimelineEventDetailState,
    buildTimelineEventRows,
    documentRef,
    typeLabels: TYPE_LABELS,
    markerLabels: MARKER_LABELS,
    formatTimeOffset: formatTimelineOffset,
    getEventPosition,
    setupTimelineScrubber,
    scrubToOffset,
    getTimelineScrubberPointsLength: () => timelineScrubberPoints.length,
    resetScrubberUi,
    buildDurationText: (timeline) => timeline?.durationFormatted || formatDuration(timeline?.durationMs || 0),
    getApproachProfileApi: () => approachProfileApiRef,
  });

  timelineRuntime = createTimelineRuntime({
    windowRef,
    subscribeLandingReceivedSignal,
    subscribeWsMessageSignal,
    tabsStore,
    statusStore,
    getAuthorizationScope,
    timelineStore,
    timelinePage,
    timelineMapController,
    getCurrentTimeline: () => timelinePage.getCurrentTimeline(),
  });

  const pfdOverlay = documentRef.getElementById('timeline-pfd-overlay');
  const pfdOverlayFitter = attachTimelinePfdOverlayFitter({
    pfdOverlay,
    timelineStore,
    windowRef,
  });

  timelineRuntime.init();
  timelinePage.showEmpty();
  return function cleanupTimelinePage() {
    timelineRuntime?.cleanup?.();
    pfdOverlayFitter?.destroy?.();
    timelinePage?.cleanup?.();
    timelineScrubber?.cleanup?.();
    timelineMapController?.destroy?.();
    timelinePfd?.destroy?.();
    resetScrubberUi();
    timelineStore.clearInspector?.();
    timelineStore.clearSummary?.();
    timelineStore.clearDetail?.();
  };
}




