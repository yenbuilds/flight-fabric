import { onBeforeUnmount, onMounted, watch } from 'vue';

function setBodyClass(className, enabled) {
  if (typeof document === 'undefined' || !document.body) return;
  document.body.classList.toggle(className, enabled === true);
}

export function useBodyClass(source, className) {
  let stopSync = () => {};

  onMounted(() => {
    stopSync = watch(
      source,
      (enabled) => setBodyClass(className, enabled),
      { immediate: true },
    );
  });

  onBeforeUnmount(() => {
    stopSync();
    setBodyClass(className, false);
  });
}
