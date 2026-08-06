'use strict';

type CabinAnnouncementsConfig = {
  enabled?: boolean;
  style?: string;
  startupGraceMs?: number;
  envOverrides?: {
    enabled?: boolean;
    style?: boolean;
    startupGraceMs?: boolean;
  };
};

type CabinAnnouncementsSettings = {
  cabinAnnouncements?: CabinAnnouncementsConfig | null;
};

type CabinAnnouncementsHandle = {
  reconfigure?: (_config: CabinAnnouncementsSettings) => unknown;
  stop: () => void;
};

type EventBusLike = {
  on: (_eventName: string, _listener: (_payload?: unknown) => void) => (() => void) | void;
};

type AnnouncementMessage = {
  type: string;
  phase: string;
  style: string;
};

type StartCabinAnnouncementsOptions = {
  eventBus: EventBusLike;
  broadcast: (_message: AnnouncementMessage) => void;
  config: CabinAnnouncementsSettings;
  initialPhase?: unknown;
  initialTelemetryFrame?: unknown;
  timeNow?: () => number;
  setTimer?: (_listener: () => void, _delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (_timer: ReturnType<typeof setTimeout>) => void;
};

type StartCabinAnnouncements = (
  _options: StartCabinAnnouncementsOptions,
) => CabinAnnouncementsHandle | void;

type CabinAnnouncementsControllerOptions = Omit<StartCabinAnnouncementsOptions, 'config'> & {
  getCurrentPhase?: () => unknown;
  getLatestTelemetryFrame?: () => unknown;
  startAnnouncements?: StartCabinAnnouncements;
};

type ReconfigureResult = {
  changed: boolean;
  enabled: boolean;
};

type CabinAnnouncementsController = CabinAnnouncementsHandle & {
  getConfig: () => NormalizedCabinAnnouncementsConfig | null;
  reconfigure: (_config: CabinAnnouncementsSettings) => ReconfigureResult;
};

const { startCabinAnnouncements } = require('./cabin-announcements') as {
  startCabinAnnouncements: StartCabinAnnouncements;
};

const DEFAULT_STYLE = 'standard';
const DEFAULT_STARTUP_GRACE_MS = 5_000;

type NormalizedCabinAnnouncementsConfig = {
  enabled: boolean;
  style: string;
  startupGraceMs: number;
};

function normalizeConfig(config: CabinAnnouncementsSettings): NormalizedCabinAnnouncementsConfig {
  const cabinConfig = config?.cabinAnnouncements;
  return {
    enabled: cabinConfig?.enabled === true,
    style: typeof cabinConfig?.style === 'string' && cabinConfig.style
      ? cabinConfig.style
      : DEFAULT_STYLE,
    startupGraceMs: Math.max(
      0,
      typeof cabinConfig?.startupGraceMs === 'number' && Number.isFinite(cabinConfig.startupGraceMs)
        ? cabinConfig.startupGraceMs
        : DEFAULT_STARTUP_GRACE_MS,
    ),
  };
}

function configKey(config: NormalizedCabinAnnouncementsConfig): string {
  if (!config.enabled) return 'disabled';
  return JSON.stringify(config);
}

function resolveCabinAnnouncementsReconfigureSettings(
  settings: CabinAnnouncementsSettings,
  effectiveConfig: CabinAnnouncementsConfig,
): CabinAnnouncementsSettings {
  const saved = normalizeConfig(settings);
  const effective = normalizeConfig({ cabinAnnouncements: effectiveConfig });
  const envOverrides = effectiveConfig?.envOverrides;
  return {
    cabinAnnouncements: {
      enabled: envOverrides?.enabled === true ? effective.enabled : saved.enabled,
      style: envOverrides?.style === true ? effective.style : saved.style,
      startupGraceMs: envOverrides?.startupGraceMs === true
        ? effective.startupGraceMs
        : saved.startupGraceMs,
    },
  };
}

function createCabinAnnouncementsController(
  options: CabinAnnouncementsControllerOptions,
): CabinAnnouncementsController {
  const {
    eventBus,
    broadcast,
    timeNow,
    setTimer,
    clearTimer,
    getCurrentPhase,
    getLatestTelemetryFrame,
    startAnnouncements = startCabinAnnouncements,
  } = options;
  let activeHandle: CabinAnnouncementsHandle | null = null;
  let activeConfigKey: string | null = null;
  let activeConfig: NormalizedCabinAnnouncementsConfig | null = null;

  function stopActiveHandle(): void {
    const handle = activeHandle;
    activeHandle = null;
    if (handle) {
      handle.stop();
    }
  }

  return {
    getConfig(): NormalizedCabinAnnouncementsConfig | null {
      return activeConfig ? { ...activeConfig } : null;
    },

    reconfigure(config: CabinAnnouncementsSettings): ReconfigureResult {
      const normalized = normalizeConfig(config);
      const nextConfigKey = configKey(normalized);
      if (nextConfigKey === activeConfigKey) {
        activeConfig = normalized;
        return { changed: false, enabled: normalized.enabled };
      }

      if (normalized.enabled) {
        if (activeHandle && typeof activeHandle.reconfigure === 'function') {
          activeHandle.reconfigure({ cabinAnnouncements: normalized });
          activeConfigKey = nextConfigKey;
          activeConfig = normalized;
          return { changed: true, enabled: true };
        }

        // Starting is synchronous and does not emit events. Bring up the
        // replacement before stopping the current handle so a startup failure
        // leaves the working listeners intact.
        const nextHandle = startAnnouncements({
          eventBus,
          broadcast,
          config: { cabinAnnouncements: normalized },
          initialPhase: getCurrentPhase?.(),
          initialTelemetryFrame: getLatestTelemetryFrame?.(),
          timeNow,
          setTimer,
          clearTimer,
        });
        if (!nextHandle) {
          throw new Error('Cabin announcement runtime did not return a handle');
        }

        const previousHandle = activeHandle;
        activeHandle = nextHandle;
        activeConfigKey = nextConfigKey;
        activeConfig = normalized;
        previousHandle?.stop();
        return { changed: true, enabled: true };
      }

      stopActiveHandle();
      activeConfigKey = nextConfigKey;
      activeConfig = normalized;
      return { changed: true, enabled: false };
    },

    stop(): void {
      stopActiveHandle();
      activeConfigKey = null;
      activeConfig = null;
    },
  };
}

module.exports = {
  createCabinAnnouncementsController,
  resolveCabinAnnouncementsReconfigureSettings,
};

export {};
