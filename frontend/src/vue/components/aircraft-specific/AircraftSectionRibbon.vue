<script setup>
import { computed } from 'vue';
import { useAircraftPageSections, useAircraftSectionNavigation } from './aircraft-page-sections.js';

const props = defineProps({
  sections: { type: Array, required: true },
  sectionIdPrefix: { type: String, required: true },
  aircraftLabel: { type: String, required: true },
  memoryKey: { type: String, default: '' },
});

const sections = useAircraftPageSections(() => props.sections);

const {
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
} = useAircraftSectionNavigation({
  sections,
  sectionIdPrefix: () => props.sectionIdPrefix,
  memoryKey: () => props.memoryKey,
});
const menuId = computed(() => `${props.sectionIdPrefix}menu`);
const menuTitleId = computed(() => `${props.sectionIdPrefix}menu-title`);
</script>

<template>
  <div class="aircraft-section-ribbon-anchor aircraft-desktop-section-anchor" data-aircraft-section-ribbon>
    <nav
      ref="sectionRibbon"
      class="aircraft-section-ribbon aircraft-desktop-section-nav"
      :aria-label="`${aircraftLabel} page sections`"
      data-no-swipe
      @pointerdown="handleRibbonPointerDown"
      @pointerup="handleRibbonPointerUp"
      @pointercancel="clearRibbonSwipe"
    >
      <div class="aircraft-desktop-section-choices" @pointerdown.stop @pointerup.stop>
        <span>Sections</span>
        <button
          v-for="(section, index) in sections"
          :key="section.id"
          type="button"
          :aria-current="index === activeSectionIndex ? 'location' : undefined"
          :title="section.title"
          @click="goToSection(index)"
        >{{ section.label }}</button>
      </div>
      <button
        type="button"
        class="aircraft-section-ribbon__neighbor"
        :disabled="!previousSection"
        :aria-label="previousSection ? `Open previous section: ${previousSection.title}` : 'Already at the first section'"
        @pointerdown.stop="clearRibbonSwipe"
        @pointerup.stop="clearRibbonSwipe"
        @click="handleSectionButtonClick(activeSectionIndex - 1)"
      >
        <span aria-hidden="true">&lsaquo;</span>
        <span>{{ previousSection?.label || 'Start' }}</span>
      </button>
      <button
        ref="sectionMenuButton"
        type="button"
        class="aircraft-section-ribbon__current"
        aria-haspopup="dialog"
        :aria-expanded="sectionMenuOpen ? 'true' : 'false'"
        :aria-controls="menuId"
        :aria-label="`Open all ${aircraftLabel} sections`"
        @click="openSectionMenu"
      >
        <strong>{{ activeSection?.label }}</strong>
        <small>{{ activeSectionIndex + 1 }} of {{ sections.length }} &middot; All sections</small>
      </button>
      <button
        type="button"
        class="aircraft-section-ribbon__neighbor"
        :disabled="!nextSection"
        :aria-label="nextSection ? `Open next section: ${nextSection.title}` : 'Already at the final section'"
        @pointerdown.stop="clearRibbonSwipe"
        @pointerup.stop="clearRibbonSwipe"
        @click="handleSectionButtonClick(activeSectionIndex + 1)"
      >
        <span>{{ nextSection?.label || 'End' }}</span>
        <span aria-hidden="true">&rsaquo;</span>
      </button>
    </nav>
  </div>

  <div
    v-if="sectionMenuOpen"
    :id="menuId"
    class="aircraft-section-menu-overlay ff-keyboard-safe-overlay"
    data-aircraft-section-menu
    data-no-swipe
    @click.self="closeSectionMenu({ restoreFocus: true })"
  >
    <section
      ref="sectionMenu"
      class="aircraft-section-menu"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="menuTitleId"
    >
      <header class="aircraft-section-menu__header">
        <div>
          <div class="dashboard-section-kicker">{{ aircraftLabel }}</div>
          <h4 :id="menuTitleId">Choose a section</h4>
        </div>
        <button type="button" class="aircraft-section-menu__close" aria-label="Close section menu" @click="closeSectionMenu({ restoreFocus: true })">&times;</button>
      </header>
      <div class="aircraft-section-menu__choices">
        <button
          v-for="(section, index) in sections"
          :key="section.id"
          type="button"
          data-aircraft-section-choice
          :aria-current="index === activeSectionIndex ? 'location' : undefined"
          @click="goToSection(index)"
        >
          <span class="aircraft-section-menu__number">{{ index + 1 }}</span>
          <span class="min-w-0">
            <strong>{{ section.title }}</strong>
            <small v-if="section.detail">{{ section.detail }}</small>
          </span>
        </button>
      </div>
    </section>
  </div>
</template>

<style src="./aircraft-desktop-sections.css"></style>

<style scoped>
.aircraft-section-ribbon-anchor,
.aircraft-section-ribbon {
  display: none;
}

.aircraft-section-menu-overlay {
  z-index: 125;
  display: grid;
  align-items: end;
  margin: 0 !important;
  padding: 0.75rem max(0.75rem, env(safe-area-inset-right, 0px)) max(0.75rem, env(safe-area-inset-bottom, 0px)) max(0.75rem, env(safe-area-inset-left, 0px));
  background: rgb(0 0 0 / 0.72);
  overscroll-behavior: contain;
  touch-action: none;
}

.aircraft-section-menu {
  width: min(100%, 34rem);
  max-height: calc(var(--ff-visual-viewport-height, 100dvh) - 1.5rem);
  margin-inline: auto;
  overflow: hidden;
  border: 1px solid rgb(var(--border-strong) / 0.82);
  border-radius: 14px 14px 8px 8px;
  background: rgb(var(--panel) / 0.995);
  box-shadow: 0 -24px 70px rgb(0 0 0 / 0.62);
  touch-action: pan-y;
}

.aircraft-section-menu__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.85rem 0.9rem;
  border-bottom: 1px solid rgb(var(--border) / 0.72);
}

.aircraft-section-menu__header h4 {
  margin-top: 0.2rem;
  color: rgb(var(--foreground));
  font-size: 1rem;
  font-weight: 700;
}

.aircraft-section-menu__close {
  width: 3rem;
  min-width: 3rem;
  height: 3rem;
  border: 1px solid rgb(var(--border) / 0.8);
  border-radius: 8px;
  color: rgb(var(--muted-foreground));
  font-size: 1.5rem;
}

.aircraft-section-menu__choices {
  display: grid;
  gap: 0.55rem;
  max-height: min(70dvh, 36rem);
  padding: 0.75rem;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.aircraft-section-menu__choices > button {
  display: grid;
  grid-template-columns: 2.25rem minmax(0, 1fr);
  min-height: 4rem;
  align-items: center;
  gap: 0.75rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid rgb(var(--border) / 0.78);
  border-radius: 9px;
  background: rgb(var(--panel-subtle) / 0.74);
  text-align: left;
}

.aircraft-section-menu__choices > button[aria-current="location"] {
  border-color: rgb(var(--selection) / 0.62);
  background: rgb(var(--selection) / 0.12);
}

.aircraft-section-menu__number {
  display: grid;
  width: 2.25rem;
  height: 2.25rem;
  place-items: center;
  border-radius: 9999px;
  background: rgb(var(--panel-elevated) / 0.9);
  color: rgb(var(--selection));
  font-family: var(--ff-font-mono);
  font-size: 0.72rem;
  font-weight: 700;
}

.aircraft-section-menu__choices strong,
.aircraft-section-menu__choices small {
  display: block;
}

.aircraft-section-menu__choices strong {
  color: rgb(var(--foreground));
  font-size: 0.82rem;
}

.aircraft-section-menu__choices small {
  margin-top: 0.18rem;
  color: rgb(var(--muted-foreground));
  font-size: 0.68rem;
  line-height: 1.35;
}

@media (max-width: 760px), (max-height: 500px) and (pointer: coarse) {
  .aircraft-section-ribbon-anchor {
    position: sticky;
    top: max(0.5rem, env(safe-area-inset-top, 0px));
    z-index: 45;
    display: block;
    height: 2.75rem;
    overflow: visible;
    pointer-events: none;
  }

  .aircraft-section-ribbon {
    display: grid;
    grid-template-columns: 2.75rem minmax(0, 1fr) 2.75rem;
    width: min(100%, 32rem);
    min-height: 2.75rem;
    margin-left: auto;
    overflow: hidden;
    border: 1px solid rgb(var(--border-strong) / 0.72);
    border-radius: 9px;
    background: rgb(var(--panel-elevated) / 0.98);
    box-shadow: 0 10px 24px rgb(0 0 0 / 0.3);
    pointer-events: auto;
    touch-action: pan-y;
    user-select: none;
    -webkit-user-select: none;
  }

  .aircraft-section-ribbon button {
    min-width: 0;
    min-height: 2.75rem;
    padding: 0.3rem;
  }

  .aircraft-section-ribbon__neighbor {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    color: rgb(var(--muted-foreground));
    font-family: var(--ff-font-mono);
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .aircraft-section-ribbon__neighbor span:not([aria-hidden="true"]) {
    display: none;
  }

  .aircraft-section-ribbon__neighbor span[aria-hidden="true"] {
    color: rgb(var(--selection));
    font-size: 1.25rem;
  }

  .aircraft-section-ribbon__neighbor:disabled {
    opacity: 0.38;
  }

  .aircraft-section-ribbon__current {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    border-right: 1px solid rgb(var(--border) / 0.72);
    border-left: 1px solid rgb(var(--border) / 0.72);
    background: rgb(var(--panel-subtle) / 0.9);
    text-align: center;
  }

  .aircraft-section-ribbon__current strong,
  .aircraft-section-ribbon__current small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .aircraft-section-ribbon__current strong {
    color: rgb(var(--selection));
    font-size: 0.78rem;
    font-weight: 750;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .aircraft-section-ribbon__current small {
    color: rgb(var(--muted-foreground));
    font-size: 0.62rem;
  }
}

@media (max-height: 500px) and (pointer: coarse) {
  .aircraft-section-ribbon,
  .aircraft-section-ribbon button {
    min-height: 2.5rem;
  }

  .aircraft-section-menu__choices {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    max-height: calc(var(--ff-visual-viewport-height, 100dvh) - 5.5rem);
  }
}
</style>
