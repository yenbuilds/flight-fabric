import { onBeforeUnmount, onMounted } from 'vue';

export function useDocumentEvent(type, handler, options) {
  onMounted(() => {
    if (typeof document === 'undefined') return;
    document.addEventListener(type, handler, options);
  });

  onBeforeUnmount(() => {
    if (typeof document === 'undefined') return;
    document.removeEventListener(type, handler, options);
  });
}
