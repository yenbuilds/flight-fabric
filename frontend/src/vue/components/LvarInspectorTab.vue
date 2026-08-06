<script setup>
import { computed } from 'vue';
import { useLvarInspectorStore } from '../stores/lvar-inspector.js';

const lvarInspector = useLvarInspectorStore();

const watchPlaceholder = [
  'Examples:',
  'MY_CUSTOM_SWITCH',
  'L:MY_CUSTOM_HEADING',
  '(L:MY_CUSTOM_SPEED, number)',
].join('\n');

const watchInputModel = computed({
  get: () => lvarInspector.watchInputText,
  set: (value) => {
    lvarInspector.setWatchInputText(value);
  },
});
</script>

<template>
  <div class="bg-surface-100 border border-surface-200 overflow-hidden">
    <div class="p-4 border-b border-surface-200 flex items-center justify-between gap-3">
      <div>
        <div class="text-sm font-semibold">Custom Variables (LVARs)</div>
        <div id="lvars-status" class="text-xs text-gray-500">{{ lvarInspector.statusLabel }}</div>
      </div>
      <div id="lvars-count" class="text-xs text-gray-500">{{ lvarInspector.headerCountLabel }}</div>
    </div>

    <div class="p-4 border-b border-surface-200 space-y-3 bg-surface-50/50">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="text-xs font-semibold uppercase tracking-[0.18em] text-gray-400">Monitor</div>
          <div class="mt-1 text-xs text-gray-500">
            MSFS does not expose a global enumerate-all-LVAR API here. Enter documented variable names or expressions to monitor through the sidecar, one per line.
          </div>
        </div>
        <div id="lvars-debug-summary" class="text-xs text-gray-500 text-right">{{ lvarInspector.debugSummaryLabel }}</div>
      </div>

      <textarea
        id="lvars-debug-input"
        v-model="watchInputModel"
        rows="4"
        spellcheck="false"
        class="w-full bg-surface-200 border border-surface-300 px-3 py-2 text-xs text-gray-100 font-mono focus:outline-none focus:border-cyan-500"
        :placeholder="watchPlaceholder"
      ></textarea>

      <div class="flex flex-wrap items-center gap-2">
        <button
          id="lvars-debug-apply"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs font-semibold uppercase tracking-[0.12em] hover:bg-cyan-500/20 transition-colors"
          @click="lvarInspector.applyWatchInput()"
        >
          Watch
        </button>
        <button
          id="lvars-debug-clear"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 bg-surface-200 border border-surface-300 text-gray-300 text-xs font-semibold uppercase tracking-[0.12em] hover:bg-surface-300 transition-colors"
          @click="lvarInspector.clearWatchInput()"
        >
          Clear
        </button>
      </div>
    </div>

    <div class="px-4 py-3 border-b border-surface-200 flex items-center justify-between gap-3 text-xs uppercase tracking-[0.16em] text-gray-500">
      <span>Profile Preview</span>
      <span id="lvars-profile-count">{{ lvarInspector.profileCountLabel }}</span>
    </div>

    <div
      id="lvars-empty"
      class="p-6 text-center text-sm text-gray-500"
      :class="{ hidden: lvarInspector.previewRows.length > 0 }"
    >
      No profile-driven LVAR data available for this aircraft yet.
    </div>

    <div
      id="lvars-table-wrap"
      class="overflow-x-auto"
      :class="{ hidden: lvarInspector.previewRows.length === 0 }"
    >
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-surface-200 text-left text-xs uppercase tracking-wider text-gray-500">
            <th class="px-4 py-3 font-medium">Variable</th>
            <th class="px-4 py-3 font-medium">Value</th>
          </tr>
        </thead>
        <tbody id="lvars-table-body" class="divide-y divide-surface-200">
          <tr v-for="row in lvarInspector.previewRows" :key="row.key">
            <td class="px-4 py-3 text-gray-300 font-mono text-xs">{{ row.key }}</td>
            <td class="px-4 py-3 text-gray-100 tabular">{{ row.valueText }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="border-t border-surface-200">
      <div class="px-4 py-3 border-b border-surface-200 flex items-center justify-between gap-3 text-xs uppercase tracking-[0.16em] text-gray-500">
        <span>Debug Watch Results</span>
        <span id="lvars-debug-count">{{ lvarInspector.debugCountLabel }}</span>
      </div>

      <div
        id="lvars-debug-empty"
        class="p-6 text-center text-sm text-gray-500"
        :class="{ hidden: lvarInspector.debugRows.length > 0 }"
      >
        No debug watch LVARs configured.
      </div>

      <div
        id="lvars-debug-table-wrap"
        class="overflow-x-auto"
        :class="{ hidden: lvarInspector.debugRows.length === 0 }"
      >
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-surface-200 text-left text-xs uppercase tracking-wider text-gray-500">
              <th class="px-4 py-3 font-medium">Expression</th>
              <th class="px-4 py-3 font-medium">Value</th>
              <th class="px-4 py-3 font-medium">Live</th>
            </tr>
          </thead>
          <tbody id="lvars-debug-table-body" class="divide-y divide-surface-200">
            <tr v-for="row in lvarInspector.debugRows" :key="row.expression">
              <td class="px-4 py-3 text-gray-300 font-mono text-xs">{{ row.expression }}</td>
              <td class="px-4 py-3 text-gray-100 tabular">{{ row.valueText }}</td>
              <td class="px-4 py-3 text-xs font-semibold uppercase tracking-[0.14em]" :class="row.liveClass">{{ row.liveText }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
