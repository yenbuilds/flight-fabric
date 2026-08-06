// frame-contract.js
// Single source of truth for telemetry frame structure.
// Tests validate against this. Docs are generated from this.
//
// RULE: If you change frame shape, change THIS FILE. Everything else follows.

const units = require('../utils/units.js') as {
  FT_TO_M: number;
  M_TO_FT: number;
  FPS_TO_FPM: number;
  MS_TO_FPM: number;
  KTS_TO_IAS_RAW?: number;
};

type TransformStep = {
  stage: string;
  unit: string;
  formula: string;
};

type CriticalField = {
  description: string;
  sdkSimvar: string;
  sdkNativeUnit: string;
  sdkDocUrl: string;
  transformChain: TransformStep[];
  consumerField: string;
  warnings: string[];
};

type FieldSpec = {
  type: string;
  unit: string;
  description: string;
};

type FrameLike = {
  display?: Record<string, unknown> | null;
  [key: string]: unknown;
};

type ValidationResult = {
  valid: boolean;
  errors: string[];
};

const CRITICAL_FIELDS: Record<string, CriticalField> = {
  vs: {
    description: 'Vertical Speed',
    sdkSimvar: 'VERTICAL SPEED',
    sdkNativeUnit: 'feet per second',
    sdkDocUrl: 'https://docs.flightsimulator.com/html/Programming_Tools/SimVars/Aircraft_SimVars/Aircraft_Misc_Variables.htm',
    transformChain: [
      { stage: 'sdk', unit: 'fps', formula: 'raw from SimConnect' },
      { stage: 'this._data', unit: 'fps', formula: 'stored as-is' },
      { stage: 'frame.vs', unit: 'm/s', formula: 'fps × 0.3048' },
      { stage: 'frame.display.vsFpm', unit: 'fpm', formula: 'fps × 60' },
    ],
    consumerField: 'display.vsFpm',
    warnings: ['SDK returns feet per SECOND, not feet per minute!'],
  },

  ra: {
    description: 'Radio Altitude',
    sdkSimvar: 'RADIO HEIGHT',
    sdkNativeUnit: 'feet',
    sdkDocUrl: 'https://docs.flightsimulator.com/html/Programming_Tools/SimVars/Aircraft_SimVars/Aircraft_RadioNavigation_Variables.htm',
    transformChain: [
      { stage: 'sdk', unit: 'feet', formula: 'raw from SimConnect' },
      { stage: 'this._data', unit: 'feet', formula: 'stored as-is' },
      { stage: 'frame.ra', unit: 'meters', formula: 'feet × 0.3048' },
      { stage: 'frame.display.raFt', unit: 'feet', formula: 'passthrough' },
    ],
    consumerField: 'display.raFt',
    warnings: [],
  },

  ias: {
    description: 'Indicated Airspeed',
    sdkSimvar: 'AIRSPEED INDICATED',
    sdkNativeUnit: 'knots',
    sdkDocUrl: 'https://docs.flightsimulator.com/html/Programming_Tools/SimVars/Aircraft_SimVars/Aircraft_Misc_Variables.htm',
    transformChain: [
      { stage: 'sdk', unit: 'knots', formula: 'raw from SimConnect' },
      { stage: 'this._data', unit: 'knots', formula: 'stored as-is' },
      { stage: 'frame.ias', unit: 'knots', formula: 'passthrough (source knots)' },
      { stage: 'frame.display.iasKts', unit: 'knots', formula: 'passthrough' },
    ],
    consumerField: 'display.iasKts',
    warnings: [],
  },

  gs: {
    description: 'Ground Speed',
    sdkSimvar: 'GROUND VELOCITY',
    sdkNativeUnit: 'knots',
    sdkDocUrl: 'https://docs.flightsimulator.com/html/Programming_Tools/SimVars/Aircraft_SimVars/Aircraft_Misc_Variables.htm',
    transformChain: [
      { stage: 'sdk', unit: 'knots', formula: 'raw from SimConnect' },
      { stage: 'this._data', unit: 'knots', formula: 'stored as-is' },
      { stage: 'frame.gs', unit: 'knots', formula: 'passthrough' },
      { stage: 'frame.display.gsKts', unit: 'knots', formula: 'passthrough' },
    ],
    consumerField: 'display.gsKts',
    warnings: [],
  },
};

const REQUIRED_DISPLAY_FIELDS: Record<string, FieldSpec> = {
  iasKts: { type: 'number', unit: 'knots', description: 'Indicated airspeed' },
  vsFpm: { type: 'number', unit: 'fpm', description: 'Vertical speed' },
  raFt: { type: 'number', unit: 'feet', description: 'Radio altitude' },
  gsKts: { type: 'number', unit: 'knots', description: 'Ground speed' },
};

const REQUIRED_SOURCE_FIELDS: Record<string, FieldSpec> = {
  ias: { type: 'number', unit: 'knots', description: 'Indicated airspeed (SimConnect native)' },
  vs: { type: 'number', unit: 'm/s', description: 'Vertical speed' },
  ra: { type: 'number', unit: 'meters', description: 'Radio altitude' },
  wow: { type: 'boolean', unit: 'bool', description: 'Weight on wheels' },
  gs: { type: 'number', unit: 'knots', description: 'Ground speed' },
  heading: { type: 'number', unit: 'degrees', description: 'True heading' },
  lat: { type: 'number|null', unit: 'degrees', description: 'GPS latitude' },
  lon: { type: 'number|null', unit: 'degrees', description: 'GPS longitude' },
  gforce: { type: 'number|null', unit: 'G', description: 'Measured normal load factor when available' },
  flaps: { type: 'number', unit: 'percent (0-100)', description: 'Flap handle position (SimConnect FLAPS HANDLE PERCENT)' },
  spoilers: { type: 'object', unit: 'object', description: 'Spoiler state {percent, fraction, state, armed}' },
  gearNose: { type: 'number', unit: 'percent (0-100)', description: 'Nose gear position' },
  gearLeft: { type: 'number', unit: 'percent (0-100)', description: 'Left gear position' },
  gearRight: { type: 'number', unit: 'percent (0-100)', description: 'Right gear position' },
};

const CONVERSION_CONSTANTS = {
  FT_TO_M: units.FT_TO_M,
  M_TO_FT: units.M_TO_FT,
  FPS_TO_FPM: units.FPS_TO_FPM,
  FPS_TO_MS: units.FT_TO_M,
  MS_TO_FPM: units.MS_TO_FPM,
  IAS_RAW_SCALE: units.KTS_TO_IAS_RAW,
};

function validateFrame(frame: FrameLike): ValidationResult {
  const errors: string[] = [];

  if (!frame.display) {
    errors.push('Missing frame.display object');
  } else {
    for (const [field, spec] of Object.entries(REQUIRED_DISPLAY_FIELDS)) {
      if (!(field in frame.display)) {
        errors.push(`Missing display.${field}`);
      } else if (spec.type === 'number' && typeof frame.display[field] !== 'number') {
        errors.push(`display.${field} should be number, got ${typeof frame.display[field]}`);
      }
    }
  }

  for (const field of Object.keys(REQUIRED_SOURCE_FIELDS)) {
    if (!(field in frame)) {
      errors.push(`Missing frame.${field}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function generateMarkdown(): string {
  let md = '## Critical Field Transformations (Auto-Generated)\n\n';
  md += '> This section is auto-generated from `frame-contract.js`. Do not edit manually.\n\n';

  for (const [key, field] of Object.entries(CRITICAL_FIELDS)) {
    md += `### ${field.description} (${key})\n\n`;
    md += `- **SimVar**: \`${field.sdkSimvar}\`\n`;
    md += `- **SDK Native Unit**: ${field.sdkNativeUnit}\n`;
    md += `- **Consumer Uses**: \`${field.consumerField}\`\n`;

    if (field.warnings.length > 0) {
      md += '- **Warnings**:\n';
      for (const warning of field.warnings) {
        md += `  - ${warning}\n`;
      }
    }

    md += '\n**Transformation Chain**:\n';
    md += '| Stage | Unit | Formula |\n';
    md += '|-------|------|--------|\n';
    for (const step of field.transformChain) {
      md += `| ${step.stage} | ${step.unit} | ${step.formula} |\n`;
    }
    md += '\n';
  }

  md += '## Required Display Fields\n\n';
  md += '| Field | Type | Unit | Description |\n';
  md += '|-------|------|------|-------------|\n';
  for (const [field, spec] of Object.entries(REQUIRED_DISPLAY_FIELDS)) {
    md += `| \`display.${field}\` | ${spec.type} | ${spec.unit} | ${spec.description} |\n`;
  }

  return md;
}

const frameContractApi = {
  CRITICAL_FIELDS,
  REQUIRED_DISPLAY_FIELDS,
  REQUIRED_SOURCE_FIELDS,
  CONVERSION_CONSTANTS,
  validateFrame,
  generateMarkdown,
};

module.exports = frameContractApi;

export {};
