<script setup>
import { computed, ref } from 'vue';
import { resolveAircraftSpecificTemplate } from '../../aircraft-specific/template-registry.js';
import { useAircraftControlsStore } from '../../stores/aircraft-controls.js';
import { useAircraftSpecificStore } from '../../stores/aircraft-specific.js';

const aircraftControls = useAircraftControlsStore();
const aircraftSpecific = useAircraftSpecificStore();
const templateComponent = computed(() => resolveAircraftSpecificTemplate(aircraftSpecific.templateId));
const hasPartialData = computed(() => (
  aircraftSpecific.available && aircraftSpecific.unavailable.length > 0
));
const badgeLabel = computed(() => {
  return aircraftSpecific.available ? 'Live' : aircraftSpecific.sourceStatus;
});
const mobiflightDependency = computed(() => {
  const dependency = aircraftSpecific.dependencies.mobiflightEventModule;
  return dependency?.required === true ? dependency : null;
});
const directLvarFallbackActive = computed(() => (
  aircraftSpecific.dependencies.mobiflightEventModule?.fallbackActive === true
));
const mobiflightNoticeElement = ref(null);
const controlDependencyProps = computed(() => (
  aircraftSpecific.controlsSetupRequired
    ? { controlSetupRequired: true }
    : {}
));

const MOBIFLIGHT_INSTALL_URL = 'https://docs.mobiflight.com/guides/wasm-module/wasm-reinstall/';
const MOBIFLIGHT_ENABLE_URL = 'https://docs.mobiflight.com/guides/wasm-module/enable-in-msfs2024/';

const mobiflightNotice = computed(() => {
  const dependency = mobiflightDependency.value;
  if (!dependency) return null;
  const affectsSomeControls = dependency.scope === 'some-controls';
  const controlScope = affectsSomeControls ? 'Some controls' : 'These aircraft controls';
  const notices = {
    connected: {
      label: 'Connected',
      detail: `${controlScope} use the separately installed MobiFlight Event Module. It is connected and ready.`,
    },
    connecting: {
      label: 'Checking',
      detail: `${controlScope} require the MobiFlight Event Module. Flight Fabric is checking the connection.`,
    },
    disabled: {
      label: 'Disabled',
      detail: 'The module is disabled. Enable EVENT MODULE in MSFS 2024 My Library, then restart the simulator.',
    },
    missing: {
      label: 'Not detected',
      detail: `${controlScope} require the separately installed MobiFlight Event Module. Aircraft data remains viewable, but write buttons stay disabled until it is detected.`,
    },
    error: {
      label: 'Connection error',
      detail: `${controlScope} require the MobiFlight Event Module, but its connection is not ready.`,
    },
    disconnected: {
      label: 'Simulator offline',
      detail: `${controlScope} require the MobiFlight Event Module. Detection will resume when the simulator reconnects.`,
    },
    unavailable: {
      label: 'Not ready',
      detail: `${controlScope} require the separately installed MobiFlight Event Module. Aircraft data remains viewable, but write buttons stay disabled until it is detected.`,
    },
  };
  const status = dependency.connected === true ? 'connected' : dependency.status;
  const notice = notices[status] || notices.unavailable;
  return {
    ...notice,
    connected: status === 'connected',
    guideLabel: status === 'disabled' ? 'Enable in MSFS 2024' : 'Installation guide',
    guideUrl: status === 'disabled' ? MOBIFLIGHT_ENABLE_URL : MOBIFLIGHT_INSTALL_URL,
  };
});

function focusMobiflightNotice() {
  const notice = mobiflightNoticeElement.value;
  if (!notice) return;
  notice.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  notice.focus?.({ preventScroll: true });
}

const AIRCRAFT_SPECIFIC_PENDING_PREFIX = 'aircraft-specific-group:';

function getPendingKey(groupId) {
  return `${AIRCRAFT_SPECIFIC_PENDING_PREFIX}${groupId}`;
}

function requestAction(actionId, groupId = actionId, value) {
  return aircraftSpecific.requestAction(actionId, {
    pendingKey: getPendingKey(groupId),
    ...(value === undefined ? {} : { value }),
  });
}

function isActionPending(groupId) {
  return aircraftControls.isCommandPending(getPendingKey(groupId));
}
</script>

<template>
  <section
    v-if="aircraftSpecific.hasTemplate && templateComponent"
    id="aircraft-specific-section"
    class="flight-section-block ff-panel bg-surface-100 border border-surface-200 overflow-hidden"
  >
    <div class="p-3 sm:p-4 border-b border-surface-200 flex flex-wrap items-center justify-between gap-3">
      <div>
        <div class="ff-kicker">Aircraft Specific</div>
        <div class="text-xs text-muted-fg mt-0.5">{{ aircraftSpecific.statusLabel }}</div>
      </div>
      <div class="flex flex-wrap items-center justify-end gap-2">
        <button
          v-if="aircraftSpecific.controlsSetupRequired"
          type="button"
          class="px-2.5 py-1 rounded-full border border-amber-500/40 bg-amber-500/10 text-[9px] font-semibold uppercase tracking-wider text-amber-200 transition-colors hover:border-amber-400/70 hover:bg-amber-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
          data-aircraft-setup-required
          title="Aircraft controls require additional setup."
          aria-controls="aircraft-mobiflight-notice"
          @click="focusMobiflightNotice"
        >
          Setup required
        </button>
        <div
          v-if="directLvarFallbackActive"
          class="px-2.5 py-1 rounded-full border border-cyan-500/35 bg-cyan-500/[0.08] text-[9px] font-semibold uppercase tracking-wider text-cyan-200"
          data-aircraft-control-mode="direct-lvar-fallback"
          title="MobiFlight is not connected. Guarded aircraft controls are using the native SimConnect direct LVAR route."
        >
          Direct LVAR fallback
        </div>
        <div
          v-if="!hasPartialData"
          class="px-2.5 py-1 rounded-full border text-[10px] font-semibold uppercase tracking-wider"
          :class="aircraftSpecific.available
            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
            : 'border-surface-200 bg-surface-50 text-gray-400'"
        >
          {{ badgeLabel }}
        </div>
      </div>
    </div>

    <div
      v-if="mobiflightNotice"
      id="aircraft-mobiflight-notice"
      ref="mobiflightNoticeElement"
      class="px-3 py-2.5 sm:px-4 border-b flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5"
      :class="mobiflightNotice.connected
        ? 'border-emerald-500/25 bg-emerald-500/[0.06]'
        : 'border-amber-500/30 bg-amber-500/[0.08]'"
      role="status"
      aria-live="polite"
      tabindex="-1"
      data-aircraft-dependency="mobiflight-event-module"
    >
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-xs font-semibold text-gray-100">MobiFlight Event Module</span>
          <span
            class="rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
            :class="mobiflightNotice.connected
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-300'"
          >
            {{ mobiflightNotice.label }}
          </span>
        </div>
        <p class="mt-1 text-[11px] leading-relaxed text-muted-fg">
          {{ mobiflightNotice.detail }}
        </p>
      </div>
      <a
        class="shrink-0 inline-flex items-center justify-center rounded-md border border-surface-300 bg-surface-100 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-200 transition-colors hover:border-cyan-500/50 hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
        :href="mobiflightNotice.guideUrl"
        target="_blank"
        rel="noopener noreferrer"
      >
        {{ mobiflightNotice.guideLabel }} <span aria-hidden="true">↗</span>
      </a>
    </div>

    <Suspense>
      <component
        :is="templateComponent"
        v-bind="controlDependencyProps"
        :values="aircraftSpecific.values"
        :unavailable="aircraftSpecific.unavailable"
        :source-status="aircraftSpecific.sourceStatus"
        :source-statuses="aircraftSpecific.sourceStatuses"
        :action-capabilities="aircraftSpecific.actionCapabilities"
        :request-action="requestAction"
        :is-action-pending="isActionPending"
        :profile-key="aircraftSpecific.activeProfileKey || ''"
      />
      <template #fallback>
        <div class="p-4 text-sm text-gray-500">Loading aircraft panel...</div>
      </template>
    </Suspense>
  </section>
</template>
