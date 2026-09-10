import { computed, inject, unref } from 'vue';

// Shell-owned cards precede the aircraft template in both DOM and navigation order.
export const AIRCRAFT_PAGE_SECTIONS = Symbol('aircraft-page-sections');

export function useAircraftPageSections(templateSections) {
  const pageSections = inject(AIRCRAFT_PAGE_SECTIONS, []);
  return computed(() => [
    ...unref(pageSections),
    ...(typeof templateSections === 'function' ? templateSections() : unref(templateSections)),
  ]);
}

export function aircraftSectionAnchorY(ribbon, scroller) {
  const rect = ribbon?.getBoundingClientRect?.();
  const viewportTop = scroller?.getBoundingClientRect?.().top || 0;
  // The ribbon sits below shell-owned cards until it becomes sticky. Its natural
  // position must not make every preceding card count as already scrolled past.
  return Math.min(rect?.bottom || 0, viewportTop + (rect?.height || 0) + 16) + 16;
}
