<script setup>
import { useBodyStyle } from '../composables/useBodyStyle.js';
import { useSettingsUiStore } from '../stores/settings-ui.js';
import { useStatusStore } from '../stores/status.js';

const status = useStatusStore();
const settingsUi = useSettingsUiStore();
const bannerInnerClass = 'max-w-7xl mx-auto px-4 py-2 flex items-center justify-between gap-3';
const bannerMessageWrapClass = 'min-w-0 flex items-center gap-2';
const bannerActionWrapClass = 'shrink-0 flex items-center gap-2';
const dismissButtonClass = 'hover:text-white p-1';
const closeIconClass = 'w-4 h-4';
const restartButtonClass = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-amber-100/60 bg-amber-700/25 text-xs font-semibold text-white hover:bg-amber-700/40 transition-colors disabled:opacity-60 disabled:cursor-not-allowed';

function confirmRestartRequiredAction() {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  return window.confirm('Restart Flight Fabric now to apply the pending changes?');
}

async function requestRestartFromBanner() {
  if (settingsUi.restartActionDisabled || !confirmRestartRequiredAction()) return false;
  return settingsUi.requestRestart();
}

useBodyStyle(
  () => status.systemBannerOffsetPx,
  'paddingTop',
  (offsetPx) => offsetPx || '',
  '',
);
</script>

<template>
  <div
    id="system-banner-stack"
    class="fixed top-0 left-0 right-0 z-[101]"
    :class="{ hidden: !status.systemBannerOffsetVisible }"
  >
    <div
      id="disk-warning-banner"
      class="bg-red-600/95 backdrop-blur-sm border-b border-red-400/30"
      :class="{ hidden: !status.diskWarningVisible }"
    >
      <div :class="bannerInnerClass">
        <div :class="bannerMessageWrapClass">
          <svg class="w-4 h-4 text-red-200" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span id="disk-warning-message" class="text-sm text-white">
            {{ status.diskWarningMessage }}
          </span>
        </div>
        <button id="disk-warning-dismiss" type="button" :class="[dismissButtonClass, 'text-red-200']" aria-label="Dismiss disk warning" @click="status.dismissDiskWarning()">
          <svg :class="closeIconClass" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>

    <div
      id="restart-required-banner"
      class="bg-amber-500/95 backdrop-blur-sm border-b border-amber-300/40"
      :class="{ hidden: !status.restartRequiredBannerVisible }"
    >
      <div :class="bannerInnerClass">
        <div :class="bannerMessageWrapClass">
          <svg class="w-4 h-4 text-amber-100" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M4.93 19h14.14c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.198 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span id="restart-required-message" class="text-sm text-white">
            {{ status.restartRequiredMessage }}
          </span>
        </div>
        <div :class="bannerActionWrapClass">
          <button
            id="restart-required-restart-btn"
            type="button"
            :class="restartButtonClass"
            :disabled="settingsUi.restartActionDisabled"
            :title="settingsUi.restartActionTitle"
            aria-label="Restart app to apply changes"
            @click="requestRestartFromBanner()"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h5M20 20v-5h-5M5.64 18.36A9 9 0 0018.36 5.64M18.36 5.64A9 9 0 005.64 18.36" />
            </svg>
            {{ settingsUi.restartActionLabel }}
          </button>
          <button id="restart-required-dismiss" type="button" :class="[dismissButtonClass, 'text-amber-100']" aria-label="Dismiss restart required banner" @click="status.dismissRestartRequiredBanner()">
            <svg :class="closeIconClass" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <div
      id="update-banner"
      class="backdrop-blur-sm border-b"
      :class="[status.updateBannerToneClass, { hidden: !status.updateBannerVisible }]"
    >
      <div :class="bannerInnerClass">
        <div :class="bannerMessageWrapClass">
          <svg id="update-icon" class="w-4 h-4" :class="status.updateIconToneClass" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span class="text-sm text-white">
            Update available: <span id="update-version" class="font-semibold">{{ status.updateVersionLabel }}</span>
            <span id="update-message" class="ml-2" :class="[status.updateMessageToneClass, { hidden: !status.updateMessageVisible }]">{{ status.updateMessageLabel }}</span>
          </span>
        </div>
        <div class="flex items-center gap-3">
          <a
            v-if="status.updateDownloadUrl"
            id="update-download-link"
            :href="status.updateDownloadUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="text-sm font-medium text-white hover:text-blue-100 underline underline-offset-2"
          >
            Download
          </a>
          <button id="update-dismiss" type="button" :class="[dismissButtonClass, 'text-blue-200']" aria-label="Dismiss update banner" @click="status.dismissUpdateBanner()">
            <svg :class="closeIconClass" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
