import { defineStore } from 'pinia';

export const useDataSourcesUiStore = defineStore('dataSourcesUi', {
  state: () => ({
    modalOpen: false,
  }),

  actions: {
    openModal() {
      this.modalOpen = true;
    },

    closeModal() {
      this.modalOpen = false;
    },
  },
});
