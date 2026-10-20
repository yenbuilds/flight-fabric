import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, unref, watch } from 'vue';
import { useDocumentEvent } from '../../composables/useDocumentEvent.js';
import { useAircraftSectionMemory } from './aircraft-section-memory.js';

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

export function aircraftSectionAnchorY(ribbon, scroller, target) {
  const rect = ribbon?.getBoundingClientRect?.();
  const viewportTop = scroller?.getBoundingClientRect?.().top || 0;
  // The ribbon sits below shell-owned cards until it becomes sticky. Its natural
  // position must not make every preceding card count as already scrolled past.
  const ribbonAnchor = Math.min(rect?.bottom || 0, viewportTop + (rect?.height || 0) + 16) + 16;
  // scrollIntoView stops at the section's CSS margin. Count that destination
  // as reached, including fractional layout rounded to a whole-pixel scroll.
  const scrollMargin = target ? parseFloat(window.getComputedStyle(target).scrollMarginTop) || 0 : 0;
  return Math.max(ribbonAnchor, viewportTop + scrollMargin) + 1;
}

// One instance owns the scroll listeners, remembered destination, menu focus and
// gesture timers for a ribbon. Components retain their own markup and selectors.
export function useAircraftSectionNavigation({
  sections,
  sectionIdPrefix,
  memoryKey,
  choiceSelector = '[data-aircraft-section-choice]',
  neighborSelector = '.aircraft-section-ribbon__neighbor',
  expandAncestorDetails = true,
}) {
  const sectionRibbon = ref(null);
  const sectionMenu = ref(null);
  const sectionMenuButton = ref(null);
  const activeSectionIndex = ref(0);
  const sectionMenuOpen = ref(false);
  let sectionScrollTarget = null;
  let sectionSyncTimer = null;
  let ribbonSwipeStart = null;
  let suppressRibbonClick = false;
  let suppressRibbonClickTimer = null;

  const activeSection = computed(() => sections.value[activeSectionIndex.value] || sections.value[0]);
  const previousSection = computed(() => sections.value[activeSectionIndex.value - 1] || null);
  const nextSection = computed(() => sections.value[activeSectionIndex.value + 1] || null);

  function sectionElement(index) {
    const section = sections.value[index];
    return section ? document.getElementById(section.targetId || `${sectionIdPrefix()}${section.id}`) : null;
  }

  function closeSectionMenu({ restoreFocus = false } = {}) {
    sectionMenuOpen.value = false;
    if (restoreFocus) nextTick(() => sectionMenuButton.value?.focus?.({ preventScroll: true }));
  }

  function openSectionMenu() {
    if (suppressRibbonClick) {
      suppressRibbonClick = false;
      return;
    }
    sectionMenuOpen.value = true;
    nextTick(() => {
      sectionMenu.value?.querySelector?.(choiceSelector)?.focus?.({ preventScroll: true });
    });
  }

  function openAncestorDetails(target) {
    let details = target?.closest?.('details');
    while (details) {
      details.open = true;
      details = details.parentElement?.closest?.('details') || null;
    }
  }

  function goToSection(index, options = {}) {
    const numericIndex = Number(index);
    if (!Number.isFinite(numericIndex)) return false;
    const boundedIndex = Math.max(0, Math.min(sections.value.length - 1, Math.trunc(numericIndex)));
    const section = sections.value[boundedIndex];
    const target = sectionElement(boundedIndex);
    if (!section || !target) return false;

    activeSectionIndex.value = boundedIndex;
    if (options.remember !== false) rememberSection(section.id);
    closeSectionMenu();
    if (expandAncestorDetails) openAncestorDetails(target);
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    target.scrollIntoView?.({
      behavior: options.behavior || (reducedMotion ? 'auto' : 'smooth'),
      block: 'start',
    });
    if (options.focus !== false) target.focus?.({ preventScroll: true });
    return true;
  }

  const { aircraftTabIsActive, rememberSection } = useAircraftSectionMemory({
    memoryKey,
    sections,
    onRestore: (sectionId) => {
      const index = sections.value.findIndex((section) => section.id === sectionId);
      return index >= 0
        ? goToSection(index, { behavior: 'auto', focus: false, remember: false })
        : false;
    },
  });

  function handleSectionButtonClick(index) {
    if (suppressRibbonClick) {
      suppressRibbonClick = false;
      return;
    }
    goToSection(index);
  }

  function clearRibbonSwipe() {
    ribbonSwipeStart = null;
  }

  function handleRibbonPointerDown(event) {
    if (event?.button != null && event.button !== 0) return;
    if (event?.target?.closest?.(neighborSelector)) {
      clearRibbonSwipe();
      return;
    }
    const x = Number(event?.clientX);
    const y = Number(event?.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      clearRibbonSwipe();
      return;
    }
    ribbonSwipeStart = { pointerId: event.pointerId, x, y };
  }

  function handleRibbonPointerUp(event) {
    const start = ribbonSwipeStart;
    clearRibbonSwipe();
    if (!start || start.pointerId !== event.pointerId) return;

    const endX = Number(event?.clientX);
    const endY = Number(event?.clientY);
    if (!Number.isFinite(endX) || !Number.isFinite(endY)) return;
    const deltaX = endX - start.x;
    const deltaY = endY - start.y;
    const ribbonWidth = sectionRibbon.value?.getBoundingClientRect?.().width || 320;
    const threshold = Math.max(44, ribbonWidth * 0.16);
    if (Math.abs(deltaX) < threshold || Math.abs(deltaX) <= Math.abs(deltaY) * 1.2) return;

    const nextIndex = activeSectionIndex.value + (deltaX < 0 ? 1 : -1);
    if (nextIndex < 0 || nextIndex >= sections.value.length) return;

    event.preventDefault?.();
    suppressRibbonClick = true;
    if (suppressRibbonClickTimer != null) window.clearTimeout(suppressRibbonClickTimer);
    suppressRibbonClickTimer = window.setTimeout(() => {
      suppressRibbonClick = false;
      suppressRibbonClickTimer = null;
    }, 400);
    goToSection(nextIndex);
  }

  function syncActiveSection() {
    sectionSyncTimer = null;
    if (!aircraftTabIsActive()) return;
    let nextIndex = 0;

    for (let index = 0; index < sections.value.length; index += 1) {
      const target = sectionElement(index);
      const anchorY = aircraftSectionAnchorY(sectionRibbon.value, sectionScrollTarget, target);
      if (!target || target.getBoundingClientRect().top > anchorY) break;
      nextIndex = index;
    }

    const scroller = sectionScrollTarget;
    if (
      scroller
      && scroller !== window
      && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 24
    ) {
      nextIndex = sections.value.length - 1;
    }
    activeSectionIndex.value = nextIndex;
    rememberSection(sections.value[nextIndex]?.id);
  }

  function scheduleSectionSync() {
    if (sectionSyncTimer != null || !aircraftTabIsActive()) return;
    sectionSyncTimer = window.setTimeout(syncActiveSection, 32);
  }

  watch(sections, () => nextTick(scheduleSectionSync));

  function handleDocumentKeydown(event) {
    if (!sectionMenuOpen.value) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeSectionMenu({ restoreFocus: true });
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(sectionMenu.value?.querySelectorAll?.('button:not(:disabled)') || []);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  useDocumentEvent('keydown', handleDocumentKeydown);

  onMounted(() => {
    sectionScrollTarget = document.getElementById('vue-main-root') || window;
    sectionScrollTarget.addEventListener?.('scroll', scheduleSectionSync, { passive: true });
    window.addEventListener('resize', scheduleSectionSync, { passive: true });
    nextTick(scheduleSectionSync);
  });

  onBeforeUnmount(() => {
    sectionScrollTarget?.removeEventListener?.('scroll', scheduleSectionSync);
    window.removeEventListener('resize', scheduleSectionSync);
    if (sectionSyncTimer != null) window.clearTimeout(sectionSyncTimer);
    if (suppressRibbonClickTimer != null) window.clearTimeout(suppressRibbonClickTimer);
    sectionScrollTarget = null;
    sectionSyncTimer = null;
    suppressRibbonClickTimer = null;
  });

  return {
    sectionRibbon,
    sectionMenu,
    sectionMenuButton,
    activeSectionIndex,
    sectionMenuOpen,
    activeSection,
    previousSection,
    nextSection,
    closeSectionMenu,
    openSectionMenu,
    goToSection,
    handleSectionButtonClick,
    clearRibbonSwipe,
    handleRibbonPointerDown,
    handleRibbonPointerUp,
  };
}
