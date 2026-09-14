import { computed, inject, unref } from 'vue';

// Shared cards join the template at their actual position in the page.
export const AIRCRAFT_PAGE_SECTIONS = Symbol('aircraft-page-sections');

export function useAircraftPageSections(templateSections) {
  const pageSections = inject(AIRCRAFT_PAGE_SECTIONS, []);
  return computed(() => {
    const shared = unref(pageSections);
    const native = typeof templateSections === 'function' ? templateSections() : unref(templateSections);
    return [
      ...shared.filter(section => !section.after),
      ...native.flatMap(section => [section, ...shared.filter(card => card.after === section.id)]),
      ...shared.filter(card => card.after && !native.some(section => section.id === card.after)),
    ];
  });
}

export function aircraftSectionAnchorY(ribbon, scroller) {
  const rect = ribbon?.getBoundingClientRect?.();
  const viewportTop = scroller?.getBoundingClientRect?.().top || 0;
  // The ribbon sits below shell-owned cards until it becomes sticky. Its natural
  // position must not make every preceding card count as already scrolled past.
  return Math.min(rect?.bottom || 0, viewportTop + (rect?.height || 0) + 16) + 16;
}
