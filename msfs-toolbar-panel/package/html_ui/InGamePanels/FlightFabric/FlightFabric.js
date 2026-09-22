/*
 * FlightFabric toolbar panel loader for MSFS 2024.
 *
 * This file runs inside the simulator's Coherent GT browser. It registers
 * the toolbar panel element and hosts the panel page served by the running
 * FlightFabric desktop app in an iframe, so product UI updates ship with the
 * desktop release and this package only has to know the local ports.
 *
 * Coherent GT does not support optional chaining or nullish coalescing;
 * keep this file to ES2017 syntax.
 */

(function () {
  "use strict";

  var PAGE_SOURCE = "flightfabric-toolbar";
  var LOADER_SOURCE = "flightfabric-toolbar-loader";
  var RETRY_INTERVAL_MS = 5000;
  var RETRY_MAX_MS = 30000;
  var LOOPBACK_HOST = "127.0.0.1";

  function isValidPort(value) {
    return typeof value === "number" && isFinite(value) && Math.floor(value) === value && value >= 1024 && value <= 65535;
  }

  function readConfig() {
    var config = window.FLIGHTFABRIC_TOOLBAR_CONFIG;
    if (!config || typeof config !== "object") return { error: "The toolbar package configuration is missing." };
    if (!isValidPort(config.httpPort) || !isValidPort(config.wsPort) || config.httpPort === config.wsPort) {
      return { error: "The toolbar package configuration has invalid ports." };
    }
    return {
      httpPort: config.httpPort,
      wsPort: config.wsPort,
      packageVersion: typeof config.packageVersion === "string" ? config.packageVersion : "",
    };
  }

  class FlightFabricToolbarPanel extends TemplateElement {
    constructor() {
      super(...arguments);
      this.ingameUi = null;
      this.iframe = null;
      this.fallback = null;
      this.fallbackTitle = null;
      this.fallbackText = null;
      this.fallbackDetail = null;
      this.origin = "";
      this.pageUrl = "";
      this.ready = false;
      this.panelActive = false;
      this.retryTimer = null;
      this.visibilityObserver = null;
      this.attempts = 0;
      this.initialized = false;
      // The simulator keeps handling keyboard bindings (Backspace resets the
      // view, letters toggle systems) until a text field claims the keyboard
      // the way the simulator's own input elements do. The page reports its
      // text-field focus and this loader forwards it with a stable field id.
      this.keyboardFocused = false;
      this.keyboardFieldId = "FLIGHTFABRIC_TOOLBAR_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      this.onDomReady = this.initialize.bind(this);
      this.onMessage = this.onMessage.bind(this);
      this.syncPanelVisibility = this.syncPanelVisibility.bind(this);
      this.onMousePressOutsideView = this.onMousePressOutsideView.bind(this);
    }

    connectedCallback() {
      super.connectedCallback();
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", this.onDomReady, { once: true });
      } else {
        this.initialize();
      }
    }

    initialize() {
      if (this.initialized || !this.isConnected) return;
      this.ingameUi = this.querySelector("ingame-ui");
      this.iframe = this.querySelector("#flightfabric-panel-content");
      this.fallback = this.querySelector("#flightfabric-panel-fallback");
      this.fallbackTitle = this.querySelector("#flightfabric-panel-fallback-title");
      this.fallbackText = this.querySelector("#flightfabric-panel-fallback-text");
      this.fallbackDetail = this.querySelector("#flightfabric-panel-fallback-detail");
      if (!this.ingameUi || !this.iframe || !this.fallback) return;
      this.initialized = true;

      var config = readConfig();
      if (config.error) {
        this.showFallback("Toolbar package needs a reinstall", config.error, "Open FlightFabric > Settings > MSFS toolbar panel and choose Reinstall.");
        return;
      }

      this.origin = "http://" + LOOPBACK_HOST + ":" + config.httpPort;
      this.pageUrl = this.origin + "/toolbar/?wsPort=" + config.wsPort
        + "&packageVersion=" + encodeURIComponent(config.packageVersion);

      window.addEventListener("message", this.onMessage);
      this.ingameUi.addEventListener("panelActive", this.syncPanelVisibility);
      this.ingameUi.addEventListener("panelInactive", this.syncPanelVisibility);
      // MSFS also changes visibility/minimization without activation events.
      // Observe only this frame's classes; no polling or descendant observer.
      this.visibilityObserver = new MutationObserver(this.syncPanelVisibility);
      this.visibilityObserver.observe(this.ingameUi, { attributes: true, attributeFilter: ["class"] });
      this.showFallback("Connecting to FlightFabric", "Start FlightFabric on this PC. This panel reconnects on its own.", "Waiting on port " + config.httpPort + ".");
      this.syncPanelVisibility();
    }

    disconnectedCallback() {
      this.cancelRetry();
      this.setKeyboardFocus(false);
      if (this.visibilityObserver) this.visibilityObserver.disconnect();
      this.visibilityObserver = null;
      document.removeEventListener("DOMContentLoaded", this.onDomReady);
      window.removeEventListener("message", this.onMessage);
      if (this.ingameUi) {
        this.ingameUi.removeEventListener("panelActive", this.syncPanelVisibility);
        this.ingameUi.removeEventListener("panelInactive", this.syncPanelVisibility);
      }
      if (this.iframe) {
        try { this.iframe.src = "about:blank"; } catch (error) { /* frame already gone */ }
      }
      this.ingameUi = null;
      this.iframe = null;
      this.fallback = null;
      this.fallbackTitle = null;
      this.fallbackText = null;
      this.fallbackDetail = null;
      this.ready = false;
      this.panelActive = false;
      this.initialized = false;
      this.attempts = 0;
      this.origin = "";
      this.pageUrl = "";
      super.disconnectedCallback();
    }

    loadPage() {
      if (!this.panelActive || !this.iframe || !this.pageUrl) return;
      this.ready = false;
      this.setKeyboardFocus(false);
      this.attempts += 1;
      // A cache-busting value so a failed navigation is retried rather than
      // served from the simulator browser cache.
      this.iframe.src = this.pageUrl + "&attempt=" + this.attempts + "&t=" + Date.now();
      this.scheduleRetry();
    }

    scheduleRetry() {
      this.cancelRetry();
      if (!this.panelActive || this.ready || !this.iframe) return;
      var self = this;
      // Avoid repeatedly destroying the Coherent frame throughout a long outage.
      var delay = Math.min(RETRY_MAX_MS, RETRY_INTERVAL_MS * Math.pow(2, Math.min(3, this.attempts - 1)));
      this.retryTimer = setTimeout(function () {
        self.retryTimer = null;
        if (!self.panelActive || self.ready || !self.iframe) return;
        if (self.fallbackDetail) {
          self.fallbackDetail.textContent = "Still waiting (attempt " + (self.attempts + 1) + ").";
        }
        self.loadPage();
      }, delay);
    }

    cancelRetry() {
      if (this.retryTimer !== null) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
    }

    onMessage(event) {
      if (!this.iframe || event.source !== this.iframe.contentWindow) return;
      if (event.origin !== this.origin) return;
      var data = event.data;
      if (!data || typeof data !== "object" || data.source !== PAGE_SOURCE) return;
      if (data.action === "ready") {
        this.ready = true;
        this.cancelRetry();
        // A freshly loaded page has no focused field yet.
        this.setKeyboardFocus(false);
        this.showPage();
        this.postToPage({ action: "visibility", visible: this.panelActive });
      } else if (data.action === "reload") {
        // The page saw a newer FlightFabric build and asked for a fresh copy.
        this.ready = false;
        this.loadPage();
      } else if (data.action === "keyboard") {
        // Only a visible, ready page may take the keyboard from the simulator.
        this.setKeyboardFocus(data.focused === true && this.ready && this.panelActive);
      }
    }

    setKeyboardFocus(focused) {
      if (focused === this.keyboardFocused) return;
      var coherent = typeof Coherent !== "undefined" && Coherent && typeof Coherent.trigger === "function" ? Coherent : null;
      if (!coherent) return;
      this.keyboardFocused = focused;
      try {
        if (focused) {
          coherent.trigger("FOCUS_INPUT_FIELD", this.keyboardFieldId, "", "", "", false);
          if (typeof coherent.on === "function") coherent.on("mousePressOutsideView", this.onMousePressOutsideView);
        } else {
          if (typeof coherent.off === "function") coherent.off("mousePressOutsideView", this.onMousePressOutsideView);
          coherent.trigger("UNFOCUS_INPUT_FIELD", this.keyboardFieldId);
        }
      } catch (error) { /* the simulator keeps its keyboard; typing still reaches the page */ }
    }

    onMousePressOutsideView() {
      // The user clicked the cockpit or another panel: the simulator gets the
      // keyboard back and the page drops its field focus so a later click on
      // the field claims the keyboard again.
      if (!this.keyboardFocused) return;
      this.setKeyboardFocus(false);
      this.postToPage({ action: "keyboardReleased" });
    }

    syncPanelVisibility() {
      if (!this.ingameUi || !this.isConnected) return;
      var classes = this.ingameUi.classList;
      var active = this.ingameUi.active === true && !classes.contains("panelInvisible")
        && !classes.contains("minimized") && !classes.contains("hide");
      if (active === this.panelActive) return;
      this.panelActive = active;
      if (!active) {
        this.cancelRetry();
        // A hidden panel must never keep the simulator's keyboard.
        this.setKeyboardFocus(false);
      }
      this.postToPage({ action: "visibility", visible: active });
      if (active && !this.ready && this.retryTimer === null) this.loadPage();
    }

    postToPage(message) {
      if (!this.ready || !this.iframe || !this.iframe.contentWindow) return;
      try {
        this.iframe.contentWindow.postMessage(Object.assign({ source: LOADER_SOURCE }, message), this.origin);
      } catch (error) { /* page navigated away; the next ready message re-syncs */ }
    }

    showPage() {
      if (this.fallback) this.fallback.classList.add("ff-hidden");
      if (this.iframe) this.iframe.classList.add("ff-visible");
    }

    showFallback(title, text, detail) {
      if (this.iframe) this.iframe.classList.remove("ff-visible");
      if (this.fallback) this.fallback.classList.remove("ff-hidden");
      if (this.fallbackTitle) this.fallbackTitle.textContent = title;
      if (this.fallbackText) this.fallbackText.textContent = text;
      if (this.fallbackDetail) this.fallbackDetail.textContent = detail || "";
    }
  }

  window.customElements.define("flightfabric-panel", FlightFabricToolbarPanel);
  checkAutoload();
})();
