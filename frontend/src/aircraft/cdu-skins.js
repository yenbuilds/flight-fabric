// Visual skins for the remote MCDU / CDU panel. Skins only restyle the bezel,
// keys and display; the aircraft's own colour semantics stay distinguishable in
// every skin. Fonts are system stacks because the renderer CSP allows no web fonts.
export const CDU_SKINS = Object.freeze([
  { id: 'flight-deck', label: 'Flight deck', description: 'Charcoal bezel, phosphor glow and sculpted keys.' },
  { id: 'crt', label: 'Retro CRT', description: 'Beige eighties terminal with an amber tube and scanlines.' },
  { id: 'orbit', label: 'Deep space', description: 'Starfield bezel, indigo glow and pill keys.' },
  { id: 'neon', label: 'Neon grid', description: 'Cyberpunk magenta and cyan on a wireframe bezel.' },
  { id: 'toon', label: 'Cartoon', description: 'Sky-blue bezel, chunky outlines and comic lettering.' },
  { id: 'pastel', label: 'Pastel cloud', description: 'Soft pinks and lavenders with bubbly keys.' },
  { id: 'blackout', label: 'Blackout', description: 'Black on black with red edges and heavy capitals.' },
  { id: 'brass', label: 'Brass & leather', description: 'Steampunk brass buttons on a leather bezel.' },
]);
export const DEFAULT_CDU_SKIN = CDU_SKINS[0].id;
export const CDU_SKIN_STORAGE_KEY = 'ff-cdu-skin';

export function normalizeCduSkin(id) {
  return CDU_SKINS.some(skin => skin.id === id) ? id : DEFAULT_CDU_SKIN;
}

export function readCduSkin(storage = globalThis.localStorage) {
  try { return normalizeCduSkin(storage?.getItem(CDU_SKIN_STORAGE_KEY)); } catch { return DEFAULT_CDU_SKIN; }
}

export function persistCduSkin(id, storage = globalThis.localStorage) {
  try { storage?.setItem(CDU_SKIN_STORAGE_KEY, normalizeCduSkin(id)); } catch {}
}
