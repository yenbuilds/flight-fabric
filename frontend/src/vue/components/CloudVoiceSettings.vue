<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useVoiceControlStore } from '../stores/voice-control.js';
import { useTabsStore } from '../stores/tabs.js';

const props = defineProps({ disabled: Boolean });
const voice = useVoiceControlStore();
const tabs = useTabsStore();
const draft = ref('');
const busy = ref(false);
const message = ref('');
const locked = computed(() => props.disabled || busy.value);
const provider = computed(() => voice.runtime.cloud.selectionValid && voice.runtime.cloud.providers.find(item => item.id === voice.runtime.cloud.providerId));
const providerLabel = computed(() => voice.runtime.cloud.providerLabel);
watch(() => [voice.runtime.cloud.providerId, voice.runtime.cloud.modelId], () => { draft.value = ''; });
watch(() => tabs.activeTabId, () => { draft.value = ''; });
onBeforeUnmount(() => { draft.value = ''; });

async function update(method, ...args) {
  if (locked.value) return false;
  busy.value = true;
  message.value = '';
  try {
    const saved = await voice[method](...args);
    message.value = saved ? 'Voice settings saved.' : 'Could not save voice settings. Check the key format and storage availability.';
    return saved;
  } catch {
    message.value = 'Could not save voice settings. Please try again.';
    return false;
  } finally { busy.value = false; }
}
async function saveKey() {
  const key = draft.value.trim();
  draft.value = '';
  await update('saveCloudKey', voice.runtime.cloud.providerId, key);
}
async function changeMode(event) {
  await update('setMode', event.currentTarget.value);
  event.target.value = voice.runtime.mode;
}
async function changeProvider(event) {
  draft.value = '';
  await update('setCloudProvider', { providerId: event.currentTarget.value });
  event.target.value = voice.runtime.cloud.selectionValid ? voice.runtime.cloud.providerId : '';
}
async function changeModel(event) {
  draft.value = '';
  await update('setCloudProvider', { providerId: voice.runtime.cloud.providerId, modelId: event.currentTarget.value });
  event.target.value = voice.runtime.cloud.modelId;
}
</script>

<template>
  <section v-if="voice.runtime.cloud.enabled" class="my-4 space-y-3 border-b border-border pb-4" aria-labelledby="voice-mode-title" data-cloud-voice-settings>
    <label id="voice-mode-title" for="voice-mode" class="block text-sm font-medium text-fg">Recognition mode</label>
    <select id="voice-mode" class="min-h-10 w-full rounded-lg border border-border bg-panel-subtle px-3 text-sm text-fg disabled:opacity-50"
      :value="voice.runtime.mode" :disabled="locked" @change="changeMode">
      <option value="offline">Offline — on this PC</option>
      <option value="cloud">Cloud — preview</option>
    </select>
    <p class="text-xs text-muted-fg">Offline uses the built-in speech model on this PC. Cloud accepts natural phrasing and requires internet access and your own provider API key.</p>
    <template v-if="voice.runtime.mode === 'cloud'">
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="min-w-0">
          <label for="voice-cloud-provider" class="mb-1 block text-xs font-medium text-fg">Provider</label>
          <select id="voice-cloud-provider" class="min-h-10 w-full rounded-lg border border-border bg-panel-subtle px-3 text-sm text-fg disabled:opacity-50"
            :value="voice.runtime.cloud.selectionValid ? voice.runtime.cloud.providerId : ''" :disabled="locked" @change="changeProvider">
            <option v-if="!voice.runtime.cloud.selectionValid" value="" disabled>Choose a provider</option>
            <option v-for="item in voice.runtime.cloud.providers" :key="item.id" :value="item.id">{{ item.label }}{{ item.keyConfigured ? ' · key saved' : '' }}</option>
          </select>
        </div>
        <div class="min-w-0">
          <label for="voice-cloud-model" class="mb-1 block text-xs font-medium text-fg">Model</label>
          <select id="voice-cloud-model" class="min-h-10 w-full rounded-lg border border-border bg-panel-subtle px-3 text-sm text-fg disabled:opacity-50"
            :value="voice.runtime.cloud.modelId" :disabled="locked || !provider || provider.models.length < 2" @change="changeModel">
            <option v-for="model in provider?.models || []" :key="model.id" :value="model.id">{{ model.label }}</option>
          </select>
        </div>
      </div>
      <template v-if="voice.runtime.cloud.selectionValid">
      <p class="text-xs text-muted-fg">Each completed recording and the aircraft’s supported controls are sent to {{ providerLabel }}. API usage may incur charges on your provider account. Switching providers keeps their saved keys separate.</p>
      <p class="text-xs text-muted-fg">Preview: one command at a time for gear, flaps, selected heading, altitude, speed and supported lights, plus aircraft and flight plan questions. Available actions and values depend on the aircraft. Speech accuracy and latency still need live testing.</p>
      <form class="space-y-2" @submit.prevent="saveKey">
        <label for="voice-cloud-key" class="block text-xs font-medium text-fg">{{ providerLabel }} API key</label>
        <input id="voice-cloud-key" v-model="draft" type="password" autocomplete="off" spellcheck="false" maxlength="512"
          class="min-h-10 w-full rounded-lg border border-border bg-panel-subtle px-3 text-sm text-fg disabled:opacity-50"
          :disabled="locked || !voice.runtime.cloud.storageAvailable" placeholder="Paste your API key" aria-describedby="voice-cloud-key-status">
        <div class="flex flex-wrap gap-2">
          <button type="submit" class="ff-button-secondary text-xs disabled:opacity-50" :disabled="locked || !draft.trim() || !voice.runtime.cloud.storageAvailable">{{ voice.runtime.cloud.keyConfigured ? 'Replace key' : 'Save key' }}</button>
          <button v-if="voice.runtime.cloud.keyConfigured" type="button" class="ff-button-secondary text-xs disabled:opacity-50" :disabled="locked" @click="update('removeCloudKey', voice.runtime.cloud.providerId)">Remove key</button>
        </div>
      </form>
      <p id="voice-cloud-key-status" class="text-xs text-muted-fg">{{ !voice.runtime.cloud.storageAvailable ? 'Protected storage is unavailable on this PC. Cloud voice cannot save a key.' : voice.runtime.cloud.keyConfigured ? `${providerLabel} key saved in protected storage on this PC.` : `No key saved for ${providerLabel}. You can add one later.` }}</p>
      </template>
      <p v-else class="text-xs text-muted-fg" role="status">The saved provider or model is no longer supported. Choose a provider to continue.</p>
    </template>
    <p v-if="message" class="text-xs text-muted-fg" role="status">{{ message }}</p>
  </section>
</template>
