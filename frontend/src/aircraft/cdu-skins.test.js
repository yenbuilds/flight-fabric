import test from 'node:test';
import assert from 'node:assert/strict';
import { CDU_SKINS, DEFAULT_CDU_SKIN, normalizeCduSkin, persistCduSkin, readCduSkin } from './cdu-skins.js';

test('skins have unique ids and unknown or unreadable choices fall back to the default', () => {
  assert.equal(new Set(CDU_SKINS.map(skin => skin.id)).size, CDU_SKINS.length);
  assert.equal(normalizeCduSkin('neon'), 'neon');
  assert.equal(normalizeCduSkin('not-a-skin'), DEFAULT_CDU_SKIN);
  assert.equal(readCduSkin(null), DEFAULT_CDU_SKIN);
  assert.equal(readCduSkin({ getItem() { throw new Error('blocked'); } }), DEFAULT_CDU_SKIN);
  const store = new Map();
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  persistCduSkin('toon', storage); assert.equal(readCduSkin(storage), 'toon');
  persistCduSkin('bogus', storage); assert.equal(readCduSkin(storage), DEFAULT_CDU_SKIN);
  assert.doesNotThrow(() => persistCduSkin('crt', { setItem() { throw new Error('quota'); } }));
});
