<script setup>
import AppTooltip from './AppTooltip.vue';
import { useSettingsUiStore } from '../stores/settings-ui.js';

const settingsUi = useSettingsUiStore();

async function openLegal(filename) {
  await settingsUi.requestOpenLegalFile(filename);
}

async function revealLegalFolder() {
  await settingsUi.requestRevealLegalFolder();
}

async function openStorageLocation(location) {
  await settingsUi.requestOpenStorageLocation(location);
}

async function copyStorageLocationPath(location) {
  await settingsUi.requestCopyStorageLocationPath(location);
}
</script>

<template>
  <div class="settings-about-card bg-surface-100 border border-surface-200 overflow-hidden">
    <div class="px-4 py-3 border-b border-surface-200">
      <div class="text-xs font-semibold uppercase tracking-widest text-cyan-400" style="font-family: 'B612 Mono', monospace;">About Flight Fabric</div>
      <div class="text-xs text-amber-300 mt-1">Alpha build. Experimental release. Use with care.</div>
    </div>

    <div class="divide-y divide-surface-200">
      <div class="px-4 py-3 flex items-center justify-between gap-4">
        <div>
          <div class="text-[10px] uppercase tracking-widest text-gray-400 mb-1" style="font-family: 'B612 Mono', monospace;">Version</div>
          <div id="about-version" class="text-sm text-gray-200" style="font-family: 'B612 Mono', monospace;">{{ settingsUi.aboutVersion }}</div>
        </div>
        <div class="text-xs text-gray-500 shrink-0">AGPL-3.0-only</div>
      </div>

      <div class="px-4 py-4 space-y-2">
        <div class="text-[10px] uppercase tracking-widest text-cyan-400" style="font-family: 'B612 Mono', monospace;">Simulator Support</div>
        <p id="about-simulator-support-note" class="text-xs leading-relaxed text-gray-400">
          Flight Fabric is designed and tested with Microsoft Flight Simulator
          2024. Microsoft Flight Simulator 2020 is not a tested or supported
          target; some features may work through SimConnect, but compatibility is
          not guaranteed. The experimental X-Plane Web API path has not been
          tested and is not a supported target.
        </p>
      </div>

      <div class="px-4 py-4 space-y-2">
        <div class="text-[10px] uppercase tracking-widest text-amber-300" style="font-family: 'B612 Mono', monospace;">Safety Notice</div>
        <p id="about-safety-notice" class="text-xs leading-relaxed text-gray-400">
          Flight Fabric is experimental alpha software designed for use with consumer
          flight simulators. Distributed Windows builds are unsigned. It is not certified,
          approved, or intended for real-world aviation or any other safety-critical use.
          Do not rely on Flight Fabric or any data, analysis, score, alert, recommendation,
          or other output it produces for real-world flight operations, navigation,
          dispatch, pilot training, certification, or decisions affecting the safety of
          any person or property. See the bundled Safety Notice for the complete warranty,
          liability, non-excludable-rights, and GNU AGPL qualifiers.
        </p>
      </div>

      <div id="about-source-offer" class="px-4 py-4 space-y-2">
        <div class="text-[10px] uppercase tracking-widest text-cyan-400" style="font-family: 'B612 Mono', monospace;">Source Code</div>
        <p class="text-xs leading-relaxed text-gray-400">
          Flight Fabric is free software licensed under the GNU Affero General
          Public License version 3. The complete corresponding source code for
          this version is available at no charge from the Flight Fabric source
          repository.
        </p>
        <a
          id="about-source-link"
          class="inline-flex px-3 py-1.5 bg-cyan-500/10 border border-cyan-500/40 text-cyan-300 text-xs font-medium hover:bg-cyan-500/20 transition-colors"
          href="https://github.com/yenbuilds/flight-fabric/releases"
          target="_blank"
          rel="noopener noreferrer"
        >View Corresponding Source</a>
      </div>

      <div class="px-4 py-4 space-y-3">
        <div class="text-[10px] uppercase tracking-widest text-gray-400" style="font-family: 'B612 Mono', monospace;">Storage Locations</div>
        <p id="about-storage-note" class="text-xs leading-relaxed text-gray-500">
          Flight Fabric stores app settings and runtime state under AppData, and saves
          user-visible flight logs under Documents. It does not create or modify files
          outside its own app folders unless you explicitly choose an export location.
        </p>

        <div class="space-y-2">
          <div
            v-for="location in settingsUi.storageLocationRows"
            :key="location.id"
            class="rounded-xl border border-surface-300 bg-surface-200/40 px-3 py-2"
          >
            <div class="flex flex-wrap items-start justify-between gap-2">
              <div class="min-w-0">
                <div class="text-xs font-semibold text-gray-200">{{ location.label }}</div>
                <div class="mt-1 break-all font-mono text-[11px] text-gray-400">{{ location.path }}</div>
                <div v-if="location.description" class="mt-1 text-[11px] leading-relaxed text-gray-500">{{ location.description }}</div>
              </div>
              <div class="flex shrink-0 gap-2">
                <AppTooltip :content="settingsUi.openStorageLocationActionBound ? '' : 'Only available in the packaged Electron app.'" :disabled="settingsUi.openStorageLocationActionBound">
                  <button
                    type="button"
                    class="px-2 py-1 bg-surface-100 border border-surface-300 text-gray-300 text-[11px] font-medium hover:bg-surface-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    :disabled="!settingsUi.openStorageLocationActionBound"
                    @click="openStorageLocation(location)"
                  >
                    Open
                  </button>
                </AppTooltip>
                <AppTooltip :content="settingsUi.copyStorageLocationActionBound ? '' : 'Clipboard access is not available here.'" :disabled="settingsUi.copyStorageLocationActionBound">
                  <button
                    type="button"
                    class="px-2 py-1 bg-surface-100 border border-surface-300 text-gray-300 text-[11px] font-medium hover:bg-surface-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    :disabled="!settingsUi.copyStorageLocationActionBound"
                    @click="copyStorageLocationPath(location)"
                  >
                    {{ location.copyLabel }}
                  </button>
                </AppTooltip>
              </div>
            </div>
          </div>
        </div>

        <p
          id="about-storage-browser-notice"
          class="text-xs text-gray-600 mt-2"
          :class="{ hidden: settingsUi.storageLocationRows.length > 0 || settingsUi.storageError }"
        >
          Storage paths are shown in the packaged Electron app.
        </p>
        <p id="about-storage-error" class="text-xs text-red-400 mt-1" :class="{ hidden: !settingsUi.storageError }">{{ settingsUi.storageError }}</p>
      </div>

      <div class="px-4 py-4 space-y-3">
        <div class="text-[10px] uppercase tracking-widest text-gray-400 mb-2" style="font-family: 'B612 Mono', monospace;">Legal Documents</div>

        <div class="flex flex-wrap gap-2">
          <AppTooltip :content="settingsUi.isElectron ? '' : 'Only available in the packaged Electron app.'" :disabled="settingsUi.isElectron"><button id="about-open-safety-btn" type="button" class="px-3 py-1.5 bg-surface-200 border border-surface-300 text-gray-300 text-xs font-medium hover:bg-surface-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" :disabled="!settingsUi.isElectron" @click="openLegal('SAFETY-NOTICE.md')">Safety Notice</button></AppTooltip>
          <AppTooltip :content="settingsUi.isElectron ? '' : 'Only available in the packaged Electron app.'" :disabled="settingsUi.isElectron"><button id="about-open-license-btn" type="button" class="px-3 py-1.5 bg-surface-200 border border-surface-300 text-gray-300 text-xs font-medium hover:bg-surface-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" :disabled="!settingsUi.isElectron" @click="openLegal('LICENSE.md')">License (AGPLv3)</button></AppTooltip>
          <AppTooltip :content="settingsUi.isElectron ? '' : 'Only available in the packaged Electron app.'" :disabled="settingsUi.isElectron"><button id="about-open-notices-btn" type="button" class="px-3 py-1.5 bg-surface-200 border border-surface-300 text-gray-300 text-xs font-medium hover:bg-surface-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" :disabled="!settingsUi.isElectron" @click="openLegal('THIRD_PARTY_NOTICES.md')">Third-Party Notices</button></AppTooltip>
          <AppTooltip :content="settingsUi.isElectron ? '' : 'Only available in the packaged Electron app.'" :disabled="settingsUi.isElectron"><button id="about-open-ourairports-btn" type="button" class="px-3 py-1.5 bg-surface-200 border border-surface-300 text-gray-300 text-xs font-medium hover:bg-surface-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" :disabled="!settingsUi.isElectron" @click="openLegal('OURAIRPORTS-DATA-LICENSE.txt')">OurAirports Data License</button></AppTooltip>
          <AppTooltip :content="settingsUi.isElectron ? 'Open the folder containing all legal documents' : 'Only available in the packaged Electron app.'"><button id="about-open-legal-folder-btn" type="button" class="px-3 py-1.5 bg-surface-200 border border-surface-300 text-gray-500 text-xs font-medium hover:bg-surface-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed" :disabled="!settingsUi.isElectron" @click="revealLegalFolder">Open Legal Folder</button></AppTooltip>
        </div>

        <p id="about-browser-notice" class="text-xs text-gray-600 mt-2" :class="{ hidden: settingsUi.isElectron }">
          Legal documents are bundled with the Electron app. In browser mode, see
          <span class="font-mono text-gray-400">SAFETY-NOTICE.md</span>,
          <span class="font-mono text-gray-400">LICENSE.md</span> and
          <span class="font-mono text-gray-400">THIRD_PARTY_NOTICES.md</span> in the project root,
          or use the corresponding-source link above.
        </p>

        <p id="about-legal-error" class="text-xs text-red-400 mt-1" :class="{ hidden: !settingsUi.legalError }">{{ settingsUi.legalError }}</p>
      </div>
    </div>
  </div>
</template>
