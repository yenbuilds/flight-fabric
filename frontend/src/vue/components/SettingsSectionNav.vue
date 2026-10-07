<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useTabsStore } from '../stores/tabs.js';
import { focusSettingsSection } from '../settings-section-navigation.js';

const props = defineProps({ sections: { type: Array, required: true } });
const tabs = useTabsStore();
const navigation = ref(null);
const activeId = ref('');
let cleanup = () => {};
let revision = 0;

async function navigate(id) {
  if (!props.sections.some(section => section.id === id)) return;
  await focusSettingsSection(id);
}

watch(() => [tabs.activeTabId, props.sections.map(section => section.id).join(',')], async () => {
  const current = ++revision;
  cleanup();
  await nextTick();
  if (current !== revision || tabs.activeTabId !== 'settings' || !navigation.value) return;
  const nav = navigation.value;
  const page = nav.closest('.settings-page');
  const scroller = nav.closest('.app-main');
  if (!page || !scroller) return;
  let frame = null;
  const update = () => {
    frame = null;
    const height = nav.getBoundingClientRect().height;
    page.style.setProperty('--settings-navigation-height', `${height}px`);
    const boundary = scroller.getBoundingClientRect().top + height + 20;
    const sections = props.sections.map(item => ({ ...item, element: document.getElementById(item.id) }))
      .filter(item => item.element?.getClientRects().length && !item.element.closest('[inert]'));
    let active = sections[0];
    for (const section of sections) {
      if (section.element.getBoundingClientRect().top <= boundary) active = section;
    }
    activeId.value = active?.id || '';
  };
  const schedule = () => { if (frame === null) frame = requestAnimationFrame(update); };
  const observer = new ResizeObserver(schedule);
  observer.observe(page);
  observer.observe(nav);
  scroller.addEventListener('scroll', schedule, { passive: true });
  cleanup = () => {
    observer.disconnect();
    scroller.removeEventListener('scroll', schedule);
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
  update();
}, { immediate: true, flush: 'post' });

onBeforeUnmount(() => { revision++; cleanup(); });
</script>

<template>
  <nav v-if="sections.length > 1" ref="navigation" class="settings-section-nav" aria-label="Settings sections">
    <div class="settings-section-links">
      <a v-for="section in sections" :key="section.id" :href="`#${section.id}`"
        :aria-current="activeId === section.id ? 'location' : undefined"
        @click.prevent="navigate(section.id)">{{ section.label }}</a>
    </div>
    <label class="settings-section-select">
      <span>Section</span>
      <select aria-label="Settings section" :value="activeId" @change="navigate($event.target.value)">
        <option v-for="section in sections" :key="section.id" :value="section.id">{{ section.label }}</option>
      </select>
    </label>
  </nav>
</template>
