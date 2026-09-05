<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useAircraftControlsStore } from '../stores/aircraft-controls.js';
import { parseNavRadioFrequency } from '../../aircraft/nav-radio.js';

const controls = useAircraftControlsStore();
const receivers = [{ id: 'nav1', label: 'NAV 1' }, { id: 'nav2', label: 'NAV 2' }];
const drafts = ref({});
const sending = ref({});
const now = ref(Date.now());
let timer;
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 250); });
onUnmounted(() => clearInterval(timer));
const context = computed(() => [controls.aircraftCommandCatalogue.profileKey, controls.aircraftCommandCatalogue.profileRevision].join(':'));
const hasCommands = computed(() => receivers.some(({ id }) => controls.isAircraftCommandSupported(`radios.${id}.setStandby`)));
const fresh = computed(() => controls.navRadiosReceivedAt != null
  && now.value - controls.navRadiosReceivedAt <= 2000);
const visible = computed(() => fresh.value ? receivers.filter(({ id }) => controls.navRadios[id].installed === true) : []);
const unknown = computed(() => fresh.value ? receivers.filter(({ id }) => controls.navRadios[id].installed == null) : receivers);
watch(context, () => { drafts.value = {}; sending.value = {}; });
watch(fresh, (value) => { if (!value) drafts.value = {}; });
watch(() => controls.availability.enabled, () => { drafts.value = {}; });
watch(() => controls.navRadios, (radios) => {
  for (const { id } of receivers) {
    if (radios[id].installed !== true || (radios[id].standbyMhz != null
      && radios[id].standbyMhz === parseNavRadioFrequency(drafts.value[id]))) delete drafts.value[id];
  }
});

const format = (value) => typeof value === 'number' ? value.toFixed(2) : '—';
const draft = (id) => drafts.value[id] ?? (controls.navRadios[id].standbyMhz == null ? '' : format(controls.navRadios[id].standbyMhz));
const invalid = (id) => draft(id).trim() !== '' && parseNavRadioFrequency(draft(id)) == null;
const edited = (id) => Object.hasOwn(drafts.value, id)
  && parseNavRadioFrequency(drafts.value[id]) !== controls.navRadios[id].standbyMhz;
function cancelEdit(id) { delete drafts.value[id]; }
function selectFrequency(event) {
  const input = event.target;
  nextTick(() => { if (document.activeElement === input) input.select(); });
}
const busy = (id) => sending.value[id] === true || ['setStandby', 'swap'].some((operation) => (
  controls.isCommandPending(`aircraft-command:radios.${id}.${operation}`)
));
function disabled(id, operation) {
  const radio = controls.navRadios[id];
  return !fresh.value || radio.installed !== true || radio.standbyMhz == null
    || controls.availability.enabled !== true || busy(id)
    || !controls.isAircraftCommandSupported(`radios.${id}.${operation}`)
    || (operation === 'swap' ? radio.activeMhz == null || edited(id)
      : parseNavRadioFrequency(draft(id)) == null || parseNavRadioFrequency(draft(id)) === radio.standbyMhz);
}
async function send(id, operation) {
  if (disabled(id, operation)) return;
  const commandId = `radios.${id}.${operation}`;
  sending.value[id] = true;
  const submittedContext = context.value;
  try {
    const accepted = await controls.requestControlCommand({
      type: 'canonical', commandId,
      input: operation === 'setStandby' ? { value: parseNavRadioFrequency(draft(id)) } : {},
    });
    if (accepted && operation === 'swap' && submittedContext === context.value) delete drafts.value[id];
  } finally {
    if (submittedContext === context.value) sending.value[id] = false;
  }
}
</script>

<template>
  <section v-if="hasCommands" class="nav-radios" aria-labelledby="generic-nav-radios-title" data-generic-nav-radios>
    <header class="nav-radios__header">
      <h2 id="generic-nav-radios-title">Navigation radios</h2>
      <p>Set a standby frequency, then swap when you’re ready to use it.</p>
    </header>
    <div v-if="visible.length" class="nav-radios__grid">
      <form v-for="receiver in visible" :key="`${context}:${receiver.id}`" class="nav-radio"
        :data-nav-radio="receiver.id" :data-aircraft-control-group="`generic-${receiver.id}`"
        :data-aircraft-search-label="`${receiver.label} navigation radio frequency standby swap`"
        :aria-busy="busy(receiver.id)" @submit.prevent="send(receiver.id, 'setStandby')">
        <div class="nav-radio__heading">
          <h3>{{ receiver.label }}</h3><span>MHz</span>
        </div>
        <div class="nav-radio__readbacks">
          <div><span>Active</span><output :aria-label="`${receiver.label} active frequency`">{{ format(controls.navRadios[receiver.id].activeMhz) }}</output></div>
          <div><span>Standby</span><output :aria-label="`${receiver.label} standby frequency`">{{ format(controls.navRadios[receiver.id].standbyMhz) }}</output></div>
        </div>
        <label :for="`${receiver.id}-standby-input`">New standby frequency</label>
        <input :id="`${receiver.id}-standby-input`" type="text" inputmode="decimal" enterkeyhint="done"
          autocomplete="off" spellcheck="false" maxlength="6" placeholder="110.30"
          :value="draft(receiver.id)" :aria-invalid="invalid(receiver.id)"
          :aria-describedby="`${receiver.id}-frequency-help`"
          :disabled="busy(receiver.id) || controls.availability.enabled !== true || controls.navRadios[receiver.id].standbyMhz == null"
          @focus="selectFrequency"
          @keydown.esc.prevent="cancelEdit(receiver.id)"
          @input="drafts[receiver.id] = $event.target.value">
        <p :id="`${receiver.id}-frequency-help`" class="nav-radio__help" :class="{ 'nav-radio__help--error': invalid(receiver.id) }">
          {{ invalid(receiver.id) ? 'Enter 108.00–117.95 in 0.05 MHz steps.' : '108.00–117.95 · 0.05 MHz steps' }}
        </p>
        <div class="nav-radio__actions">
          <button type="submit" :disabled="disabled(receiver.id, 'setStandby')" :aria-label="`Set ${receiver.label} standby frequency`">Set standby</button>
          <button type="button" :disabled="disabled(receiver.id, 'swap')" :aria-label="`Swap ${receiver.label} active and standby frequencies`"
            :aria-describedby="`${receiver.id}-radio-status`"
            @click="send(receiver.id, 'swap')"><span aria-hidden="true">⇄</span> Swap</button>
        </div>
        <button v-if="edited(receiver.id)" type="button" class="nav-radio__cancel" :disabled="busy(receiver.id)"
          :aria-label="`Cancel ${receiver.label} frequency edit`" @click="cancelEdit(receiver.id)">Cancel edit</button>
        <p :id="`${receiver.id}-radio-status`" class="nav-radio__status" role="status">
          {{ busy(receiver.id) ? 'Sending…' : controls.navRadios[receiver.id].standbyMhz == null || controls.navRadios[receiver.id].activeMhz == null
            ? 'Waiting for frequency readback.' : controls.availability.enabled !== true ? controls.availability.reason
              : edited(receiver.id) ? 'Set standby or cancel your edit before swapping.' : 'Swap exchanges active and standby.' }}
        </p>
      </form>
    </div>
    <p v-if="unknown.length" class="nav-radios__empty" role="status">
      {{ !fresh || unknown.length === 2 ? 'Waiting for NAV radio data.' : `Waiting for ${unknown.map((receiver) => receiver.label).join(' and ')} availability.` }}
    </p>
    <p v-else-if="visible.length === 0" class="nav-radios__empty">No NAV radios reported for this aircraft.</p>
  </section>
</template>

<style scoped>
.nav-radios { min-width: 0; overflow: hidden; border: 1px solid rgb(var(--border)); border-radius: 0.875rem; background: rgb(var(--card)); }
.nav-radios__header { padding: 1rem; border-bottom: 1px solid rgb(var(--border)); }
.nav-radios__header h2 { margin: 0; font-size: 1rem; font-weight: 650; }
.nav-radios__header p, .nav-radios__empty { color: rgb(var(--muted-foreground)); font-size: 0.8125rem; line-height: 1.5; }
.nav-radios__header p { margin: 0.3rem 0 0; }
.nav-radios__empty { margin: 0; padding: 1rem; }
.nav-radios__grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; padding: 1rem; }
.nav-radio { min-width: 0; padding: 1rem; border: 1px solid rgb(var(--border)); border-radius: 0.75rem; background: rgb(var(--background)); }
.nav-radio__heading { display: flex; justify-content: space-between; align-items: baseline; }
.nav-radio__heading h3 { margin: 0; font-size: 1rem; font-weight: 700; }
.nav-radio__heading > span, .nav-radio__readbacks span { color: rgb(var(--muted-foreground)); font-size: 0.75rem; }
.nav-radio__readbacks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.5rem; margin: 0.75rem 0 1rem; }
.nav-radio__readbacks output { display: block; font-family: ui-monospace, monospace; font-size: clamp(1.4rem, 6vw, 2rem); font-variant-numeric: tabular-nums; line-height: 1.3; }
.nav-radio__readbacks > div:first-child output { color: rgb(var(--color-accent, 0 212 255)); }
.nav-radio label { display: block; margin-bottom: 0.4rem; font-size: 0.8125rem; }
.nav-radio input { display: block; width: 100%; min-width: 0; min-height: 3rem; box-sizing: border-box; padding: 0.6rem 0.75rem; border: 1px solid rgb(var(--border)); border-radius: 0.5rem; background: rgb(var(--panel)); color: inherit; font-family: ui-monospace, monospace; font-size: 1.125rem; }
.nav-radio__help, .nav-radio__status { min-height: 1.25rem; margin: 0.45rem 0 0; color: rgb(var(--muted-foreground)); font-size: 0.75rem; line-height: 1.5; }
.nav-radio__help--error { color: rgb(var(--danger)); }
.nav-radio__actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.625rem; margin-top: 0.75rem; }
.nav-radio button { min-width: 0; min-height: 3rem; padding: 0.65rem 0.5rem; border: 1px solid rgb(var(--color-accent, 0 212 255) / 0.4); border-radius: 0.5rem; background: rgb(var(--color-accent, 0 212 255) / 0.08); color: inherit; font-size: 0.875rem; font-weight: 600; touch-action: manipulation; }
.nav-radio button:not(:disabled):hover { background: rgb(var(--color-accent, 0 212 255) / 0.16); }
.nav-radio button.nav-radio__cancel { margin-top: 0.5rem; width: 100%; border-color: rgb(var(--border)); background: transparent; color: rgb(var(--muted-foreground)); }
.nav-radio :disabled { opacity: 0.45; cursor: not-allowed; }
.nav-radio :is(input, button):focus-visible { outline: 2px solid rgb(var(--color-accent, 0 212 255)); outline-offset: 3px; }
@media (min-width: 700px) { .nav-radios__grid { grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); } }
</style>
