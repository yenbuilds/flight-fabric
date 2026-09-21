import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import '../../../shared/violation-rules.js';
import { useLandingStore } from '../vue/stores/landing.js';
import {
  LANDING_SHARE_HEIGHT,
  LANDING_SHARE_MAX_TAGS,
  LANDING_SHARE_SITE,
  LANDING_SHARE_WIDTH,
  buildLandingShareModel,
  canCopyLandingShareImage,
  copyLandingShareImage,
  paintLandingShareCard,
  renderLandingShareCanvas,
  saveLandingShareImage,
  toneColor,
} from './share-image.js';

const LANDING = {
  final: true,
  vs: -467.3,
  color: '#00ff88',
  grade: 'Firm',
  gforce: 1.23,
  icao: 'YSSY',
  runway: '34L',
  iasKts: 136,
  gsKts: 142,
  crosswind: -8,
  windSpeed: 12,
  windDirectionTrueDeg: 240,
  approachType: 'ILS',
  pitchDeg: 3.1,
  bankDeg: -1.4,
  centerlineDev: 0.4,
  touchdownDistance: {
    distanceFt: 305,
    grade: 'Outstanding',
    lateralOffsetFt: 3,
    lateralOffsetGrade: 'Outstanding',
    lateralOffsetScore: 98,
    bounceGrade: 'Clean',
    bounceScore: 100,
    bounceCount: 0,
    tdzAchieved: true,
  },
  ultimateStability: { score: 91, verdict: 'stable', samples: 120 },
};

function landingCardFor(message = LANDING, options = {}) {
  setActivePinia(createPinia());
  const landing = useLandingStore();
  landing.applyLandingCardMessage(message, options);
  return landing.landingCard;
}

// A 2D context that remembers what was drawn; width is one unit per glyph so
// truncation decisions are deterministic.
function createFakeContext() {
  const calls = { text: [], images: [], rects: 0, fills: 0 };
  const ctx = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: 'left', textBaseline: 'alphabetic', letterSpacing: '0px',
    measureText: (text) => ({ width: String(text).length * 8 }),
    fillText: (text, x, y) => { calls.text.push({ text: String(text), x, y, font: ctx.font, color: ctx.fillStyle, align: ctx.textAlign }); },
    fillRect: () => { calls.rects += 1; },
    fill: () => { calls.fills += 1; },
    stroke: () => {},
    beginPath: () => {}, closePath: () => {}, moveTo: () => {}, lineTo: () => {}, quadraticCurveTo: () => {},
    drawImage: (image, x, y, w, h) => { calls.images.push({ image, x, y, w, h }); },
    createLinearGradient: () => ({ addColorStop: () => {} }),
    scale: (x, y) => { calls.scale = [x, y]; },
  };
  return { ctx, calls };
}

test('tone classes map to the colours the screen uses, with a fallback', () => {
  assert.equal(toneColor('text-green-400'), '#4ade80');
  assert.equal(toneColor('mt-1 text-amber-500'), '#f59e0b');
  assert.equal(toneColor('text-nothing', '#123456'), '#123456');
  assert.equal(toneColor(''), '#e5e7eb');
});

test('the share model is built from the same landing-card state the screen shows', () => {
  const card = landingCardFor(LANDING, { capturedAtMs: Date.UTC(2026, 8, 19, 4, 32) });
  const model = buildLandingShareModel({
    landingCard: card, aircraftName: 'Boeing 737-800 Qantas', profileName: 'PMDG 737-800', capturedAtMs: card.capturedAtMs, versionText: 'v0.9.9',
  });
  assert.equal(model.placeText, 'YSSY · RWY 34L');
  assert.equal(model.gradeText, 'FIRM');
  assert.equal(model.gradeColor, card.gradeColor);
  assert.equal(model.rateLine, '-467 fpm · 1.23 G');
  assert.equal(model.aircraftText, 'Boeing 737-800 Qantas');
  assert.equal(model.contextText, 'PMDG 737-800');
  assert.equal(model.siteText, LANDING_SHARE_SITE);
  assert.equal(model.versionText, 'v0.9.9');
  assert.ok(model.dateText, 'a captured time gives a date line');
  assert.deepEqual(model.tiles.map((tile) => tile.label), ['Touchdown', 'Approach', 'Bounce', 'Wind at touchdown']);
  assert.equal(model.tiles[0].value, '305 ft');
  assert.equal(model.tiles[1].value, card.approach.stabilityText);
  assert.equal(model.tiles[1].valueColor, toneColor(card.approach.stabilityTone));
  assert.equal(model.tiles[2].value, 'Clean');
  assert.equal(model.tiles[2].note, '', 'a bounce note that repeats the value is dropped');
  assert.equal(model.tiles[3].value, '240°T 12 kt');
  assert.equal(model.tiles[3].note, 'XW 8 kt from left');
  assert.ok(model.tags.length > 0 && model.tags.length <= LANDING_SHARE_MAX_TAGS, 'factor tags travel with the image');
  assert.deepEqual(model.tags.map((tag) => tag.text), card.debrief.reasons.slice(0, LANDING_SHARE_MAX_TAGS).map((reason) => reason.text));
  assert.equal(model.confidenceText, card.debrief.confidenceText);
  assert.match(model.filename, /^flightfabric-landing-yssy-34l-\d{8}-\d{4}\.png$/);
});

test('a bare card still makes an honest image and filename', () => {
  const card = landingCardFor({ final: true, vs: -120, grade: 'Smooth', color: '#00e070' });
  const model = buildLandingShareModel({ landingCard: card });
  assert.equal(model.placeText, 'Unknown airport');
  assert.equal(model.aircraftText, 'Aircraft');
  assert.equal(model.contextText, '');
  assert.equal(model.dateText, '', 'no capture time, no invented date');
  assert.equal(model.rateLine, '-120 fpm', 'no G value is simply omitted');
  assert.equal(model.tiles[0].value, '--', 'a "-- ft" placeholder is not printed with a unit');
  assert.equal(model.tiles[1].note, '', 'an "Approach score --" note is dropped');
  assert.equal(model.tiles[3].value, '--');
  assert.match(model.filename, /^flightfabric-landing-airport-rwy-\d{8}-\d{4}\.png$/);
  assert.equal(buildLandingShareModel({ landingCard: null }), null);
});

test('the painter puts every fact, the tags and the site mark on the card and never overflows it', () => {
  const card = landingCardFor(LANDING);
  const model = buildLandingShareModel({ landingCard: card, aircraftName: 'PMDG 737-800', capturedAtMs: Date.now(), versionText: 'v0.9.9' });
  const { ctx, calls } = createFakeContext();
  assert.equal(paintLandingShareCard(ctx, model), true);
  const drawn = calls.text.map((entry) => entry.text);
  for (const expected of ['FlightFabric', 'LANDING DEBRIEF', 'YSSY · RWY 34L', 'FIRM', '-467 fpm · 1.23 G', 'PMDG 737-800', LANDING_SHARE_SITE, 'Telemetry confidence']) {
    assert.ok(drawn.includes(expected), `the card draws "${expected}"`);
  }
  for (const tile of model.tiles) {
    assert.ok(drawn.includes(tile.label.toUpperCase()), `tile label ${tile.label}`);
    assert.ok(drawn.includes(tile.value), `tile value ${tile.value}`);
  }
  for (const tag of model.tags) assert.ok(drawn.includes(tag.text), `tag ${tag.text}`);
  assert.ok(drawn.some((text) => text.includes('MSFS 2024 simulator debrief')), 'the footer says what kind of debrief this is');
  const grade = calls.text.find((entry) => entry.text === 'FIRM');
  assert.equal(grade.color, card.gradeColor, 'the grade keeps the colour it has on screen');
  const site = calls.text.find((entry) => entry.text === LANDING_SHARE_SITE);
  assert.equal(site.align, 'right');
  assert.ok(site.x <= LANDING_SHARE_WIDTH && site.y <= LANDING_SHARE_HEIGHT);
  for (const entry of calls.text) {
    assert.ok(entry.x >= 0 && entry.x <= LANDING_SHARE_WIDTH && entry.y >= 0 && entry.y <= LANDING_SHARE_HEIGHT, `${entry.text} stays inside the card`);
  }
  assert.equal(calls.images.length, 0, 'without an icon the brand mark is drawn, not an image');
  assert.ok(drawn.includes('FF'));

  const withIcon = createFakeContext();
  const icon = { width: 512, height: 512 };
  paintLandingShareCard(withIcon.ctx, model, { icon });
  assert.equal(withIcon.calls.images[0]?.image, icon, 'a loaded icon replaces the drawn mark');
  assert.ok(!withIcon.calls.text.map((entry) => entry.text).includes('FF'));
});

test('long text is cut with an ellipsis and tags that do not fit are left off', () => {
  const card = landingCardFor(LANDING);
  card.debrief.reasons = Array.from({ length: LANDING_SHARE_MAX_TAGS }, (_, index) => ({
    key: String(index), text: `A very long debrief factor label number ${index} that keeps going`, color: '#f59e0b', backgroundColor: '#f59e0b22', borderColor: '#f59e0b44',
  }));
  const model = buildLandingShareModel({ landingCard: card, aircraftName: 'An aircraft whose livery title is far longer than any header could ever reasonably hold on one line' });
  const { ctx, calls } = createFakeContext();
  paintLandingShareCard(ctx, model);
  const aircraft = calls.text.find((entry) => entry.text.startsWith('An aircraft whose'));
  assert.ok(aircraft.text.endsWith('…'), 'the aircraft name is cut, not overflowed');
  const tagsDrawn = calls.text.filter((entry) => entry.text.startsWith('A very long debrief factor')).length;
  assert.ok(tagsDrawn >= 1 && tagsDrawn < LANDING_SHARE_MAX_TAGS, `only the tags that fit on one line are drawn (${tagsDrawn})`);
});

test('the footer never lets the confidence reason and the origin line run into each other', () => {
  const card = landingCardFor({ final: true, vs: -300, grade: 'Firm', color: '#f59e0b', icao: 'YSSY', runway: '34L' });
  card.debrief.confidenceText = 'Low';
  card.debrief.confidenceReason = 'No stability data, No touchdown position, Runway geometry unverified, Runway condition inferred, and more besides';
  const model = buildLandingShareModel({ landingCard: card, versionText: 'v0.9.9-alpha.12+build.2026.09.19' });
  const { ctx, calls } = createFakeContext();
  paintLandingShareCard(ctx, model);
  const footer = calls.text.filter((entry) => entry.y === LANDING_SHARE_HEIGHT - 56 + 4);
  const left = footer.filter((entry) => entry.align !== 'right');
  const right = footer.filter((entry) => entry.align === 'right');
  const leftEnd = Math.max(...left.map((entry) => entry.x + entry.text.length * 8));
  const rightStart = Math.min(...right.map((entry) => entry.x - entry.text.length * 8));
  assert.ok(left.some((entry) => entry.text.startsWith('· No stability data')), 'the reason is drawn');
  assert.ok(right.some((entry) => entry.text === LANDING_SHARE_SITE), 'the site mark is drawn');
  assert.ok(rightStart > leftEnd, `right block (${rightStart}) starts after the left block ends (${leftEnd})`);
});

test('render, copy and save use only the document and clipboard they are given', async () => {
  const card = landingCardFor(LANDING);
  const model = buildLandingShareModel({ landingCard: card });
  const contexts = [];
  const links = [];
  const documentRef = {
    fonts: { ready: Promise.resolve() },
    body: { appendChild: () => {} },
    createElement(tag) {
      if (tag === 'canvas') {
        const fake = createFakeContext();
        contexts.push(fake);
        return {
          width: 0, height: 0,
          getContext: () => fake.ctx,
          toBlob: (callback, type) => callback({ type, size: 1234 }),
        };
      }
      if (tag === 'a') {
        const link = { style: {}, click() { links.push({ href: this.href, download: this.download }); }, remove() {} };
        return link;
      }
      throw new Error(`unexpected element ${tag}`);
    },
  };

  const canvas = await renderLandingShareCanvas(model, { documentRef, icon: null });
  assert.equal(canvas.width, LANDING_SHARE_WIDTH * 2);
  assert.equal(canvas.height, LANDING_SHARE_HEIGHT * 2);
  assert.deepEqual(contexts[0].calls.scale, [2, 2], 'the card is painted at 2x for crisp pasting');

  const written = [];
  class ClipboardItem { constructor(items) { this.items = items; } }
  const navigatorRef = { clipboard: { write: async (items) => { written.push(items); } } };
  const windowRef = { ClipboardItem, URL: { createObjectURL: () => 'blob:card', revokeObjectURL: () => {} }, setTimeout: (fn) => { fn(); return 1; } };
  assert.equal(canCopyLandingShareImage({ navigatorRef, windowRef }), true);
  assert.equal(canCopyLandingShareImage({ navigatorRef: {}, windowRef }), false, 'no clipboard write means no copy button');
  assert.equal(await copyLandingShareImage(model, { documentRef, navigatorRef, windowRef, icon: null }), true);
  assert.equal((await written[0][0].items['image/png']).type, 'image/png', 'the clipboard receives a PNG, promised inside the click');
  assert.equal(await copyLandingShareImage(model, { documentRef, navigatorRef: {}, windowRef, icon: null }), false);

  assert.equal(await saveLandingShareImage(model, { documentRef, windowRef, icon: null }), true);
  assert.equal(links[0].href, 'blob:card');
  assert.equal(links[0].download, model.filename);
});
