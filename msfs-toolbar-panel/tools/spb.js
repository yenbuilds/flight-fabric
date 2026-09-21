'use strict';

/**
 * SimProp binary (SPB) writer and reader for MSFS `InGamePanels` documents.
 *
 * MSFS loads toolbar panels from a compiled `InGamePanels/<package>.spb`
 * file, the binary form of this SDK source document:
 *
 *   <SimBase.Document Type="InGamePanels" version="1,0">
 *     <Filename>flightfabric-toolbar.spb</Filename>
 *     <InGamePanels.InGamePanelDefinition id="..." Name="..." url="..."
 *         resizeDirections="Both" minWidth=".." minHeight=".." defaultWidth=".."
 *         defaultHeight=".." defaultTop=".." defaultRight=".." icon="..."
 *         buttonVisible="true" />
 *   </SimBase.Document>
 *
 * The SDK compiles that XML with `fspackagetool.exe`, which needs the SDK
 * installed and launches the simulator. The layout below was recovered from
 * working MSFS 2024 panel definitions so the package can be produced
 * deterministically at build time and checked in tests:
 *
 *   26-byte constant header
 *   u32 entry count
 *   entries (20 bytes each): 16-byte property GUID + i32 value kind
 *     entry 0 is the null GUID; kinds are -1 (string or node), 4 (float,
 *     integer, boolean or enum stored in 4 bytes) and 8 (two u32 values)
 *   records: `u32 entry index` followed by the value
 *     node   -> u32 byte length, child records, u32 0 terminator (the
 *               length includes the terminator)
 *     string -> u32 byte length, bytes including a NUL terminator, each
 *               byte XOR-ed with a keystream
 *     float / u32 -> 4 bytes little-endian
 *
 * The string keystream restarts for every string: it starts 42, 7, 43 and
 * continues with k[n] = (k[n-2] + k[n-3]) mod 251. The entry table lists the
 * properties in the order the source document used them; record indices
 * refer to that table, so an encoder must keep the two consistent.
 */

const HEADER_PREFIX = Buffer.from('aceb140000000100000000000000000200000100000000000000', 'hex');
const KEYSTREAM_MODULUS = 251;
const KEYSTREAM_SEED = Object.freeze([42, 7, 43]);
const NULL_GUID = '00000000000000000000000000000000';

const KIND_STRING_OR_NODE = -1;
const KIND_SCALAR = 4;
const KIND_PAIR = 8;

// Property GUIDs as they appear in the compiled file, keyed by the source
// document attribute or element they encode.
const PROPERTY_GUIDS = Object.freeze({
  document: '7bd76feebb147c49ae590ccdd90eaa68',
  documentType: '5e89acbdd05e0d488d09c4085785c2ff',
  documentVersion: '209482e0a24fb54c82b2f18b6d0f9256',
  filename: 'bafe14e7cabd184d865fee991266d625',
  panelDefinition: '29cef350adaba54f83a2e6f24df78991',
  id: 'c57fa5d3ffdec94eb84fdc9b29018ab4',
  name: 'a222fa5a9abede4b886da1a072879fda',
  url: '5f7db56813f5d14bb321615d0acf8d47',
  icon: 'd93bc7fbc791e84594443bc75da6651d',
  resizeDirections: '547fce57e6bb6f44bff865ce02b53009',
  minWidth: 'bcb73abae28f6b4d972931831d4252df',
  minHeight: '3e4dcef03682b248a5b7559bec77810a',
  defaultWidth: 'd8b042325ba6b1469fcf9f4bdf367da6',
  defaultHeight: '317ea32f663dee44a95efcacc9aa93e5',
  defaultTop: 'e5e1e4e6551b8348b1ff14895c73c2ee',
  defaultRight: '1f7f83448e01e04bb4167aa70d2cfb4b',
  buttonVisible: 'fe209e9d40ee8144b975076f58e8e14c',
});

const PROPERTY_KINDS = Object.freeze({
  document: 'node',
  documentType: 'string',
  documentVersion: 'pair',
  filename: 'string',
  panelDefinition: 'node',
  id: 'string',
  name: 'string',
  url: 'string',
  icon: 'string',
  resizeDirections: 'enum',
  minWidth: 'float',
  minHeight: 'float',
  defaultWidth: 'float',
  defaultHeight: 'float',
  defaultTop: 'float',
  defaultRight: 'float',
  buttonVisible: 'bool',
});

const RESIZE_DIRECTIONS = Object.freeze({
  None: 0,
  Horizontal: 1,
  Vertical: 2,
  Both: 3,
});

// The panel definition attributes that may appear, in the order the SDK
// sample projects list them. Any subset is allowed; the encoder emits the
// entry table in this order so the record indices stay stable.
const PANEL_ATTRIBUTE_ORDER = Object.freeze([
  'id',
  'name',
  'url',
  'resizeDirections',
  'minWidth',
  'minHeight',
  'defaultWidth',
  'defaultHeight',
  'defaultTop',
  'defaultRight',
  'icon',
  'buttonVisible',
]);
const REQUIRED_PANEL_ATTRIBUTES = Object.freeze(['id', 'name', 'url']);

function keystream(length) {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = index < KEYSTREAM_SEED.length
      ? KEYSTREAM_SEED[index]
      : (bytes[index - 2] + bytes[index - 3]) % KEYSTREAM_MODULUS;
  }
  return bytes;
}

function assertAsciiString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (/[^\x20-\x7e]/.test(value)) {
    throw new TypeError(`${label} must be printable ASCII without control characters`);
  }
  return value;
}

function encodeString(value, label = 'string') {
  const plain = Buffer.from(`${assertAsciiString(value, label)}\0`, 'latin1');
  const key = keystream(plain.length);
  const encoded = Buffer.alloc(plain.length);
  for (let index = 0; index < plain.length; index += 1) encoded[index] = plain[index] ^ key[index];
  return encoded;
}

function decodeString(bytes) {
  const key = keystream(bytes.length);
  const plain = Buffer.alloc(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) plain[index] = bytes[index] ^ key[index];
  if (plain.length === 0 || plain[plain.length - 1] !== 0) {
    throw new Error('SPB string is not NUL-terminated');
  }
  return plain.subarray(0, plain.length - 1).toString('latin1');
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function i32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value, 0);
  return buffer;
}

function f32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(value, 0);
  return buffer;
}

function assertFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function encodeScalar(property, value) {
  switch (PROPERTY_KINDS[property]) {
    case 'float':
      return f32(assertFinite(value, property));
    case 'bool':
      if (typeof value !== 'boolean') throw new TypeError(`${property} must be a boolean`);
      return u32(value ? 1 : 0);
    case 'enum': {
      if (!Object.prototype.hasOwnProperty.call(RESIZE_DIRECTIONS, value)) {
        throw new TypeError(`${property} must be one of ${Object.keys(RESIZE_DIRECTIONS).join(', ')}`);
      }
      return u32(RESIZE_DIRECTIONS[value]);
    }
    default:
      throw new TypeError(`${property} is not a scalar property`);
  }
}

function entryKind(property) {
  switch (PROPERTY_KINDS[property]) {
    case 'node':
    case 'string':
      return KIND_STRING_OR_NODE;
    case 'pair':
      return KIND_PAIR;
    default:
      return KIND_SCALAR;
  }
}

function encodeNode(index, children) {
  const content = Buffer.concat([...children, u32(0)]);
  return Buffer.concat([u32(index), u32(content.length), content]);
}

function encodeStringRecord(index, value, label) {
  const encoded = encodeString(value, label);
  return Buffer.concat([u32(index), u32(encoded.length), encoded]);
}

/**
 * Build the compiled panel definition.
 *
 * @param {object} definition
 * @param {string} definition.filename  the SPB file name recorded in the document
 * @param {object} definition.panel     panel attributes (see PANEL_ATTRIBUTE_ORDER)
 * @param {string[]} [definition.attributeOrder]  attribute order override; defaults
 *   to PANEL_ATTRIBUTE_ORDER filtered to the attributes present
 * @returns {Buffer}
 */
function encodeInGamePanelsDocument(definition) {
  if (!definition || typeof definition !== 'object') throw new TypeError('definition is required');
  const panel = definition.panel;
  if (!panel || typeof panel !== 'object') throw new TypeError('definition.panel is required');
  for (const attribute of REQUIRED_PANEL_ATTRIBUTES) {
    assertAsciiString(panel[attribute], `panel.${attribute}`);
  }
  const order = Array.isArray(definition.attributeOrder)
    ? definition.attributeOrder
    : PANEL_ATTRIBUTE_ORDER.filter((attribute) => panel[attribute] !== undefined);
  for (const attribute of order) {
    if (!PANEL_ATTRIBUTE_ORDER.includes(attribute)) throw new TypeError(`unknown panel attribute: ${attribute}`);
    if (panel[attribute] === undefined) throw new TypeError(`panel.${attribute} is listed in attributeOrder but missing`);
  }
  if (new Set(order).size !== order.length) throw new TypeError('attributeOrder repeats an attribute');
  for (const attribute of Object.keys(panel)) {
    if (!order.includes(attribute)) throw new TypeError(`panel.${attribute} is not part of the attribute order`);
  }

  const tableOrder = ['document', 'documentType', 'documentVersion', 'filename', 'panelDefinition', ...order];
  const indexOf = new Map(tableOrder.map((property, position) => [property, position + 1]));

  const header = Buffer.concat([
    HEADER_PREFIX,
    u32(tableOrder.length + 1),
    Buffer.from(NULL_GUID, 'hex'),
    u32(0),
    ...tableOrder.map((property) => Buffer.concat([
      Buffer.from(PROPERTY_GUIDS[property], 'hex'),
      i32(entryKind(property)),
    ])),
  ]);

  const panelRecords = order.map((attribute) => {
    const index = indexOf.get(attribute);
    return PROPERTY_KINDS[attribute] === 'string'
      ? encodeStringRecord(index, panel[attribute], `panel.${attribute}`)
      : Buffer.concat([u32(index), encodeScalar(attribute, panel[attribute])]);
  });

  const document = encodeNode(indexOf.get('document'), [
    encodeStringRecord(indexOf.get('documentType'), 'InGamePanels', 'documentType'),
    Buffer.concat([u32(indexOf.get('documentVersion')), u32(1), u32(0)]),
    encodeStringRecord(indexOf.get('filename'), definition.filename, 'filename'),
    encodeNode(indexOf.get('panelDefinition'), panelRecords),
  ]);

  return Buffer.concat([header, document]);
}

/**
 * Parse a compiled panel definition back into its source values. Used by
 * tests and by the package build to prove the emitted file is well-formed.
 */
function decodeInGamePanelsDocument(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('buffer is required');
  if (buffer.length < HEADER_PREFIX.length + 4 || !buffer.subarray(0, HEADER_PREFIX.length).equals(HEADER_PREFIX)) {
    throw new Error('not an SPB InGamePanels document');
  }
  let offset = HEADER_PREFIX.length;
  const readU32 = () => {
    if (offset + 4 > buffer.length) throw new Error('truncated SPB document');
    const value = buffer.readUInt32LE(offset);
    offset += 4;
    return value;
  };
  const entryCount = readU32();
  if (entryCount < 1 || entryCount > 64) throw new Error('unexpected SPB entry count');
  const guidToProperty = new Map(Object.entries(PROPERTY_GUIDS).map(([property, guid]) => [guid, property]));
  const entries = [];
  for (let position = 0; position < entryCount; position += 1) {
    if (offset + 20 > buffer.length) throw new Error('truncated SPB entry table');
    const guid = buffer.subarray(offset, offset + 16).toString('hex');
    const kind = buffer.readInt32LE(offset + 16);
    offset += 20;
    if (position === 0) {
      if (guid !== NULL_GUID || kind !== 0) throw new Error('SPB entry table must start with the null entry');
      entries.push(null);
      continue;
    }
    const property = guidToProperty.get(guid);
    if (!property) throw new Error(`unknown SPB property GUID ${guid}`);
    if (entryKind(property) !== kind) throw new Error(`unexpected value kind for ${property}`);
    entries.push(property);
  }

  function readRecords(end, target, requireTerminator) {
    while (offset < end) {
      const index = readU32();
      if (index === 0) {
        if (offset !== end) throw new Error('SPB node terminator before the end of the node');
        return;
      }
      const property = entries[index];
      if (!property) throw new Error(`SPB record refers to unknown entry ${index}`);
      switch (PROPERTY_KINDS[property]) {
        case 'node': {
          const length = readU32();
          const nodeEnd = offset + length;
          if (nodeEnd > end) throw new Error(`SPB node ${property} overruns its parent`);
          const child = {};
          readRecords(nodeEnd, child, true);
          target[property] = child;
          break;
        }
        case 'string': {
          const length = readU32();
          if (offset + length > end) throw new Error(`SPB string ${property} overruns its node`);
          target[property] = decodeString(buffer.subarray(offset, offset + length));
          offset += length;
          break;
        }
        case 'pair':
          target[property] = [readU32(), readU32()];
          break;
        case 'float':
          if (offset + 4 > end) throw new Error(`SPB float ${property} overruns its node`);
          target[property] = buffer.readFloatLE(offset);
          offset += 4;
          break;
        case 'bool':
          target[property] = readU32() !== 0;
          break;
        case 'enum': {
          const raw = readU32();
          const name = Object.keys(RESIZE_DIRECTIONS).find((key) => RESIZE_DIRECTIONS[key] === raw);
          if (!name) throw new Error(`unknown resizeDirections value ${raw}`);
          target[property] = name;
          break;
        }
        default:
          throw new Error(`unsupported SPB property ${property}`);
      }
    }
    if (requireTerminator) throw new Error('SPB node is missing its terminator');
  }

  const root = {};
  readRecords(buffer.length, root, false);
  if (offset !== buffer.length) throw new Error('SPB document has trailing bytes');
  const document = root.document;
  if (!document || document.documentType !== 'InGamePanels' || !document.panelDefinition) {
    throw new Error('SPB document is not an InGamePanels definition');
  }
  return {
    filename: document.filename,
    version: document.documentVersion,
    panel: document.panelDefinition,
    attributeOrder: entries.slice(6),
  };
}

module.exports = {
  PANEL_ATTRIBUTE_ORDER,
  PROPERTY_GUIDS,
  RESIZE_DIRECTIONS,
  decodeInGamePanelsDocument,
  decodeString,
  encodeInGamePanelsDocument,
  encodeString,
  keystream,
};
