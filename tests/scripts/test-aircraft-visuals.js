const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const zlib = require('zlib');

const repoRoot = path.resolve(__dirname, '..', '..');
const profileRoot = path.join(repoRoot, 'backend', 'aircraft', 'profiles', 'bundled');
const assetRoot = path.join(repoRoot, 'frontend', 'assets', 'aircraft');
const manifestPath = path.join(repoRoot, 'frontend', 'src', 'aircraft', 'visual-manifest.js');

function collectJsonFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) return collectJsonFiles(entryPath);
    return entry.isFile() && entry.name.endsWith('.json') ? [entryPath] : [];
  });
}

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function readPng(filePath) {
  const buffer = fs.readFileSync(filePath);
  assert(buffer.length > 32, `${path.basename(filePath)} must not be empty`);
  assert.strictEqual(
    buffer.subarray(0, 8).toString('hex'),
    '89504e470d0a1a0a',
    `${path.basename(filePath)} must be a PNG`,
  );
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  const interlace = buffer[28];
  assert.strictEqual(bitDepth, 8, `${path.basename(filePath)} must use 8-bit channels`);
  assert.strictEqual(colorType, 6, `${path.basename(filePath)} must use RGBA color`);
  assert.strictEqual(interlace, 0, `${path.basename(filePath)} must use non-interlaced PNG encoding`);

  const idatChunks = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') idatChunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const bytesPerPixel = 4;
  const rowBytes = width * bytesPerPixel;
  assert.strictEqual(raw.length, height * (rowBytes + 1), `${path.basename(filePath)} has unexpected pixel data`);
  const pixels = Buffer.alloc(height * rowBytes);

  for (let y = 0; y < height; y += 1) {
    const rawRowStart = y * (rowBytes + 1);
    const filter = raw[rawRowStart];
    const rowStart = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const encoded = raw[rawRowStart + 1 + x];
      const left = x >= bytesPerPixel ? pixels[rowStart + x - bytesPerPixel] : 0;
      const above = y > 0 ? pixels[rowStart + x - rowBytes] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel
        ? pixels[rowStart + x - rowBytes - bytesPerPixel]
        : 0;
      let decoded = encoded;
      if (filter === 1) decoded += left;
      else if (filter === 2) decoded += above;
      else if (filter === 3) decoded += Math.floor((left + above) / 2);
      else if (filter === 4) decoded += paethPredictor(left, above, upperLeft);
      else assert.strictEqual(filter, 0, `${path.basename(filePath)} uses unknown PNG filter ${filter}`);
      pixels[rowStart + x] = decoded & 0xff;
    }
  }

  return {
    bytes: buffer.length,
    hash: crypto.createHash('sha256').update(buffer).digest('hex'),
    height,
    pixels,
    width,
  };
}

async function main() {
  const manifest = await import(pathToFileURL(manifestPath).href);
  const {
    AIRCRAFT_PROFILE_VISUALS,
    AIRCRAFT_VISUAL_ASSETS,
    getAircraftVisualAssetKeys,
    resolveAircraftVisual,
  } = manifest;

  const concreteProfiles = collectJsonFiles(profileRoot)
    .map((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8')))
    .filter((profile) => profile.abstract !== true);

  for (const profile of concreteProfiles) {
    const qualifiedId = `${profile.namespace}/${profile.simulator}/${profile.id}`;
    assert(AIRCRAFT_PROFILE_VISUALS[qualifiedId], `${qualifiedId} needs an explicit aircraft visual mapping`);
  }

  for (const [qualifiedId, mapping] of Object.entries(AIRCRAFT_PROFILE_VISUALS)) {
    assert(AIRCRAFT_VISUAL_ASSETS[mapping.assetKey], `${qualifiedId} references unknown asset ${mapping.assetKey}`);
    assert(['exact', 'family', 'class'].includes(mapping.fidelity), `${qualifiedId} needs an honest fidelity label`);
    assert.strictEqual(
      resolveAircraftVisual({ profileId: qualifiedId }).assetKey,
      mapping.assetKey,
      `${qualifiedId} must resolve its declared aircraft visual`,
    );
  }

  const fallbackAssetKeys = new Set([
    'general-aviation',
    'generic-aircraft',
    'regional-jet',
    'turboprop',
    'widebody',
  ]);
  const ambiguousProfileNameCorpus = new Set([
    // This profile intentionally covers adjacent ToLiss A319/A320/A321 variants.
    // Its family label alone must not pretend to identify one exact airframe.
    'bundled/xplane/toliss-a320-family',
  ]);
  for (const profile of concreteProfiles) {
    const qualifiedId = `${profile.namespace}/${profile.simulator}/${profile.id}`;
    const mapping = AIRCRAFT_PROFILE_VISUALS[qualifiedId];
    if (!mapping
      || fallbackAssetKeys.has(mapping.assetKey)
      || ambiguousProfileNameCorpus.has(qualifiedId)) {
      continue;
    }
    const knownNames = [
      profile.name,
      ...(Array.isArray(profile.integration?.matching?.titleContains)
        ? profile.integration.matching.titleContains
        : []),
    ].filter((value) => typeof value === 'string' && value.trim());
    for (const aircraftName of knownNames) {
      assert.strictEqual(
        resolveAircraftVisual({ aircraftName }).assetKey,
        mapping.assetKey,
        `${qualifiedId} known name ${JSON.stringify(aircraftName)} must resolve its declared artwork`,
      );
    }
  }

  let totalBytes = 0;
  const assetKeys = getAircraftVisualAssetKeys();
  const shippedAssetKeys = fs.readdirSync(assetRoot)
    .filter((name) => name.endsWith('.png'))
    .map((name) => path.basename(name, '.png'))
    .sort();
  assert.deepStrictEqual(shippedAssetKeys, assetKeys.slice().sort(), 'runtime aircraft art must not contain orphan PNGs');
  const payloadHashes = new Set();
  for (const assetKey of assetKeys) {
    const filePath = path.join(assetRoot, `${assetKey}.png`);
    assert(fs.existsSync(filePath), `missing runtime aircraft art: ${assetKey}.png`);
    const png = readPng(filePath);
    assert.strictEqual(png.width, 720, `${assetKey}.png must be 720px wide`);
    assert.strictEqual(png.height, 480, `${assetKey}.png must be 480px high`);
    assert(png.bytes <= 200 * 1024, `${assetKey}.png exceeds the 200 KiB per-image ceiling`);
    assert(!payloadHashes.has(png.hash), `${assetKey}.png duplicates another runtime asset`);
    payloadHashes.add(png.hash);

    let visiblePixels = 0;
    let coloredPixels = 0;
    for (let offset = 0; offset < png.pixels.length; offset += 4) {
      const [red, green, blue, alpha] = png.pixels.subarray(offset, offset + 4);
      if (alpha === 0) continue;
      visiblePixels += 1;
      if (Math.max(red, green, blue) - Math.min(red, green, blue) > 1) coloredPixels += 1;
    }
    const alphaAt = (x, y) => png.pixels[(y * png.width + x) * 4 + 3];
    assert(visiblePixels > 0, `${assetKey}.png must contain a visible aircraft`);
    assert.strictEqual(coloredPixels, 0, `${assetKey}.png must stay neutral grayscale`);
    assert.strictEqual(alphaAt(0, 0), 0, `${assetKey}.png top-left corner must be transparent`);
    assert.strictEqual(alphaAt(png.width - 1, 0), 0, `${assetKey}.png top-right corner must be transparent`);
    assert.strictEqual(alphaAt(0, png.height - 1), 0, `${assetKey}.png bottom-left corner must be transparent`);
    assert.strictEqual(alphaAt(png.width - 1, png.height - 1), 0, `${assetKey}.png bottom-right corner must be transparent`);
    totalBytes += png.bytes;
  }
  assert(totalBytes <= 4 * 1024 * 1024, 'aircraft visual catalog exceeds the 4 MiB PNG budget');

  assert.strictEqual(
    resolveAircraftVisual({ profileId: 'bundled/msfs/fbw-a32nx' }).assetKey,
    'airbus-a320neo',
  );
  assert.strictEqual(resolveAircraftVisual({ profileId: 'zibo-737-800' }).assetKey, 'boeing-737-800');
  assert.strictEqual(
    resolveAircraftVisual({ profileId: 'bundled/msfs/generic', aircraftName: 'Boeing 787-9 Dreamliner' }).assetKey,
    'boeing-787-9',
  );

  const legacyNameCases = new Map([
    ['airbus-a380-800', ['FlyByWire A380X', 'FBW A380X', 'A388']],
    ['airbus-a400m', ['iniBuilds Airbus A400M Atlas', 'Microsoft_A400M']],
    ['airbus-a330-900neo', ['Headwind A330', 'Headwind Airbus A330 Standard Cabin', 'Headwind A330-900neo', 'Headwind_A339X', 'Airbus A330-941']],
    ['airbus-a330-family', ['Airbus A330-200', 'A332', 'A33F']],
    ['airbus-a321lr', ['Microsoft_Airbus_A321LR', 'Airbus A321 LR']],
    ['airbus-a321', ['Fenix Simulations Airbus A321 LR', 'FNX_321']],
    ['airbus-a320neo', ['FlyByWire A320', 'FBW A320', 'A32NX', 'A20N']],
    ['airbus-a320ceo', ['Fenix A320neo', 'FNX_32X']],
    ['airbus-a319', ['Fenix FNX_319', 'A19N']],
    ['airbus-a220-300', ['A220-300', 'BCS3', 'CS300', 'BD-500']],
    ['boeing-787-10', ['Boeing 787-10 Dreamliner', 'Asobo_B787_10', 'B78X']],
    ['boeing-787-9', ['Horizon B787-9', 'B789']],
    ['boeing-787-8', ['Kuro_B787-8', 'B788']],
    ['boeing-777-300er', ['777-300ER', 'B777-300ER', 'B77W']],
    ['boeing-737-max-8', ['Boeing 737 MAX 8', 'Asobo_B737_MAX8', 'iFly 737MAX8', 'iFly MAX8', 'B38M']],
    ['boeing-737-800', ['Boeing B737-800', 'Zibo Boeing 737-800X', 'B738', 'Laminar Research 737']],
    ['boeing-747-8', ['747-8i', 'Boeing 747-8F', 'Asobo_B747_8i', 'B748']],
    ['embraer-e170-e175', ['FlightSim Studio E175', 'Embraer 175', 'E75S', 'E75L']],
    ['bae-146-family', ['Just Flight 146 Professional', 'JF 146', 'JFA BAe 146', 'Avro RJ100']],
    ['atr-72-600', ['Microsoft_ATR_72_600', 'ATR72-600', 'AT76']],
    ['lockheed-l1011-500', ['L1011-500 Standard Cabin', 'L-1011-500', 'L101', 'TriStar']],
    ['mcdonnell-douglas-md11', ['TFDi Design MD-11 Passenger GE', 'MD11']],
    ['citation-longitude', ['Cessna Citation Longitude', 'Working Title Longitude', 'Cessna Model 700 Executive', 'Longitude', 'Model 700']],
    ['citation-cj4', ['Citation CJ4', 'CJ4', 'Cessna Model 525C Executive', 'Model 525C']],
  ]);
  for (const [assetKey, aircraftNames] of legacyNameCases) {
    for (const aircraftName of aircraftNames) {
      assert.strictEqual(
        resolveAircraftVisual({ aircraftName }).assetKey,
        assetKey,
        `${aircraftName} must resolve ${assetKey} without a recorded profile`,
      );
    }
  }

  assert.strictEqual(
    resolveAircraftVisual({
      profileId: 'bundled/msfs/inibuilds-tristar',
      aircraftName: 'FlyByWire A380X',
    }).assetKey,
    'lockheed-l1011-500',
    'a concrete recorded profile must remain authoritative over a conflicting legacy name',
  );

  const conservativeNameCases = new Map([
    ['Atlas Air Boeing 747-8F', 'boeing-747-8'],
    ['Atlas Air Boeing 747-400', 'generic-aircraft'],
    ['Atlas Cheetah', 'generic-aircraft'],
    ['Longitude 151 East', 'generic-aircraft'],
    ['Some Model 700', 'generic-aircraft'],
    ['Model 700X', 'generic-aircraft'],
    ['Airbus A330-800neo', 'airbus-a330-family'],
    ['Boeing 777-300', 'generic-aircraft'],
    ['B77L', 'generic-aircraft'],
    ['B773', 'generic-aircraft'],
    ['Boeing 737 MAX 9', 'generic-aircraft'],
    ['Boeing 737-700', 'generic-aircraft'],
    ['Boeing 747-400', 'generic-aircraft'],
    ['Boeing 787-11', 'generic-aircraft'],
    ['Embraer E190', 'generic-aircraft'],
    ['ATR 42-600', 'generic-aircraft'],
    ['Trislander', 'generic-aircraft'],
    ['A3200', 'generic-aircraft'],
  ]);
  for (const [aircraftName, assetKey] of conservativeNameCases) {
    assert.strictEqual(
      resolveAircraftVisual({ aircraftName }).assetKey,
      assetKey,
      `${aircraftName} must not be promoted to dishonest adjacent-model artwork`,
    );
  }

  assert.strictEqual(resolveAircraftVisual({ aircraftName: 'Unknown Experimental Type' }).assetKey, 'generic-aircraft');

  console.log(`Aircraft visuals: ${concreteProfiles.length} profiles, ${assetKeys.length} assets, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
