import { onBeforeUnmount, onMounted, watch } from 'vue';

function setBodyStyle(propertyName, value) {
  if (typeof document === 'undefined' || !document.body) return;
  document.body.style[propertyName] = value;
}

export function useBodyStyle(source, propertyName, resolveValue, resetValue = '') {
  let stopSync = () => {};

  onMounted(() => {
    stopSync = watch(
      source,
      (value) => setBodyStyle(propertyName, resolveValue(value)),
      { immediate: true },
    );
  });

  onBeforeUnmount(() => {
    stopSync();
    setBodyStyle(propertyName, resetValue);
  });
}
