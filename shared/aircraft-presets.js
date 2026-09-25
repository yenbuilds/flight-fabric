/* Shared preset presentation rules. ES2017 for MSFS Coherent. */
(function (root) {
  'use strict';
  var LIGHT_ORDER = ['configuration.lights.takeoff', 'configuration.lights.afterTakeoff', 'configuration.lights.landing', 'configuration.lights.afterLanding'];
  var SOURCE_FIELDS = ['lights.landing', 'lights.noseMode', 'lights.strobeMode', 'lights.nav', 'lights.navMode',
    'lights.landingLeftPosition', 'lights.landingRightPosition', 'lights.nosePosition',
    'lights.turnoffLeft', 'lights.turnoffRight', 'lights.strobe', 'systems.busVoltage',
    'systems.apuMaster', 'systems.apuStart', 'systems.apuAvailable', 'systems.apuMasterFault',
    'mcp.courseCaptainDeg', 'mcp.courseFirstOfficerDeg', 'radios.nav1ActiveMhz', 'radios.nav2ActiveMhz'];
  function groups(commands) {
    var list = (Array.isArray(commands) ? commands : Object.values(commands || {})).filter(function (command) {
      return command && command.kind === 'preset' && command.input && ['none', 'number'].includes(command.input.kind);
    });
    var light = function (command) { return command.id.startsWith('configuration.lights.'); };
    var brightness = function (command) { return command.id.startsWith('configuration.lighting.'); };
    return {
      cards: list.filter(function (command) { return !light(command) && !brightness(command); }),
      lights: list.filter(light).sort(function (a, b) {
        var order = function (c) { var i = LIGHT_ORDER.indexOf(c.id); return i < 0 ? LIGHT_ORDER.length : i; };
        return order(a) - order(b) || a.id.localeCompare(b.id);
      }),
      brightness: ['configuration.lighting.cockpit', 'configuration.lighting.displays'].map(function (id) {
        return list.find(function (command) { return command.id === id; });
      }).filter(Boolean),
    };
  }
  function numberValue(command, draft) {
    var text = String(draft === undefined ? '' : draft).trim(), input = command.input || {};
    if (!text) return null;
    var value = Number(text), position = (value - input.min) / input.step;
    return Number.isFinite(value) && value >= input.min && value <= input.max
      && Math.abs(position - Math.round(position)) < 1e-7 ? value : null;
  }
  function brightnessLabel(id) { return id === 'configuration.lighting.cockpit' ? 'Global cockpit lighting' : 'All flight displays'; }
  function readbackFields(commands) {
    var fields = SOURCE_FIELDS.slice();
    (commands || []).filter(function (command) { return command && command.kind === 'preset'; }).forEach(function (command) {
      fields = fields.concat(command.brightnessFields || [], (command.observations || []).map(function (entry) { return entry.fieldId; }));
    });
    return Array.from(new Set(fields)).filter(function (id) { return typeof id === 'string' && /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/.test(id); }).slice(0, 192);
  }
  var api = Object.freeze({ groups: groups, numberValue: numberValue, brightnessLabel: brightnessLabel, readbackFields: readbackFields });
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.FlightFabricPresets = api;
// @ts-expect-error Legacy Coherent has window; the Node typecheck has no DOM globals.
})(typeof globalThis !== 'undefined' ? globalThis : window);
