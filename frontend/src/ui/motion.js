import { watch } from 'vue';

function animateSectionEntrance(section, { requestAnimationFrameRef }) {
  if (!section) return;
  const targets = Array.from(section.querySelectorAll([
    '#tab-flight > *:not(.menu-overlay)',
    '#flight-live-shell > *',
    '.page-stack > *',
    '.telemetry-grid-primary > *',
    '.telemetry-grid-secondary > *',
    '.telemetry-grid > *',
    '.systems-grid > *',
    '.engine-grid > *',
    '.environment-grid > *',
    '.data-grid > *',
    '.ap-grid > *',
    '.timeline-grid > *',
    '.timeline-section-stack > *',
    '.timeline-split > *',
    '#tab-livemap > *:not(.menu-overlay)',
    '.live-map-inline-meta > *'
  ].join(', ')));
  if (targets.length === 0) return;
  targets.slice(0, 24).forEach((el, index) => {
    el.classList.add('ff-motion-target', 'ff-motion-queued');
    el.style.setProperty('--ff-motion-index', String(index));
    el.classList.remove('ff-motion-in');
  });
  requestAnimationFrameRef(() => {
    targets.slice(0, 24).forEach((el) => el.classList.add('ff-motion-in'));
  });
}

export function bindSectionMotion({
  documentRef = document,
  requestAnimationFrameRef = requestAnimationFrame,
  MutationObserverRef = MutationObserver,
  tabsStore = null,
} = {}) {
  const sections = Array.from(documentRef.querySelectorAll('.tab-section'));
  if (sections.length === 0) return;
  let activeId = null;

  const animateActiveSection = (tabId = null) => {
    const active = tabId
      ? documentRef.getElementById(`tab-${tabId}`)
      : documentRef.querySelector('.tab-section.active');
    if (!active || active.id === activeId) return;
    activeId = active.id;
    animateSectionEntrance(active, { requestAnimationFrameRef });
  };

  if (tabsStore) {
    return watch(
      () => tabsStore.activeTabId,
      (tabId) => {
        animateActiveSection(tabId);
      },
      { immediate: true },
    );
  }

  const observer = new MutationObserverRef(animateActiveSection);
  sections.forEach((section) => observer.observe(section, { attributes: true, attributeFilter: ['class'] }));
  animateActiveSection();
}
