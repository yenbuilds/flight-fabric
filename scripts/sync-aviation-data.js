#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const OURAIRPORTS_DIR = path.join(ROOT, 'backend', 'data-sync', 'data', 'ourairports');
const OURAIRPORTS_BASE = 'https://davidmegginson.github.io/ourairports-data';
const MANIFEST_FILE_NAME = 'manifest.json';
const MANIFEST_VERSION = 1;

const REQUIRED_FILES = [
  'airports.csv',
  'runways.csv',
];

const EXTENDED_FILES = [
  'countries.csv',
  'regions.csv',
  'airport-frequencies.csv',
  'navaids.csv',
];

const PREVIOUS_SHA256 = {
  'airports.csv': '4aef566aa1ff068cf95b9759cd5d906c02523de720f031647245fc563317daa4',
  'runways.csv': 'b6aafe6375c6fcb596e2d3f851b3b87385bd0aedf25c90cddf99758511c60eb2',
  'countries.csv': '2a9dbee691125b0cdb8ceb5fe227c48c903f99c488963b8e53e2ab366521c639',
  'regions.csv': '20f2d772989805a211302535b8742b72621d31ba2c019f51973383377784cabe',
  'airport-frequencies.csv': '80c4269a3f7dd5d63045e39d14f891393ddbd7afe1ffb571f07708173ddfbdd3',
  'navaids.csv': '5fb96a63197b067f59728dd60daec0a686ec89166d7a19c1b33e58177df372e5',
};

const EXPECTED_CSV_COLUMNS = {
  'airports.csv': ['id', 'ident', 'type', 'name', 'latitude_deg', 'longitude_deg'],
  'runways.csv': ['id', 'airport_ref', 'airport_ident', 'length_ft', 'le_ident', 'he_ident'],
  'countries.csv': ['id', 'code', 'name'],
  'regions.csv': ['id', 'code', 'local_code', 'name', 'continent', 'iso_country'],
  'airport-frequencies.csv': ['id', 'airport_ref', 'airport_ident', 'type', 'frequency_mhz'],
  'navaids.csv': ['id', 'filename', 'ident', 'name', 'type', 'frequency_khz'],
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function downloadToFile(url, targetPath) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        'User-Agent': 'flight-fabric-data-sync/1.0',
      },
    }, (res) => {
      const statusCode = res.statusCode || 0;
      const location = res.headers.location;

      if (statusCode >= 300 && statusCode < 400 && location) {
        res.resume();
        const redirectedUrl = location.startsWith('http')
          ? location
          : new URL(location, url).toString();
        downloadToFile(redirectedUrl, targetPath).then(resolve).catch(reject);
        return;
      }

      if (statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${statusCode} for ${url}`));
        return;
      }

      ensureDir(path.dirname(targetPath));
      const tmpPath = `${targetPath}.tmp`;
      const out = fs.createWriteStream(tmpPath);

      res.pipe(out);

      out.on('finish', () => {
        out.close(() => {
          try {
            fs.renameSync(tmpPath, targetPath);
            resolve({
              lastModified: typeof res.headers['last-modified'] === 'string'
                ? res.headers['last-modified']
                : null,
              etag: typeof res.headers.etag === 'string' ? res.headers.etag : null,
            });
          } catch (err) {
            reject(err);
          }
        });
      });

      out.on('error', (err) => {
        out.destroy();
        try { fs.rmSync(tmpPath, { force: true }); } catch {}
        reject(err);
      });
    });

    request.on('error', reject);
    request.setTimeout(30000, () => {
      request.destroy(new Error(`Timeout while downloading ${url}`));
    });
  });
}

function fileSizeKb(filePath) {
  const bytes = fs.statSync(filePath).size;
  return Math.round(bytes / 1024);
}

function fileSizeBytes(filePath) {
  return fs.statSync(filePath).size;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const content = fs.readFileSync(filePath);
  hash.update(content);
  return hash.digest('hex').toLowerCase();
}

function parseCsvHeader(line) {
  const columns = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      columns.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  columns.push(current.trim());
  return columns;
}

function validateCsvShape(fileName, filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size <= 0) {
    throw new Error(`${fileName} is empty`);
  }

  const expectedColumns = EXPECTED_CSV_COLUMNS[fileName];
  if (!expectedColumns) return;

  const sample = fs.readFileSync(filePath, 'utf8').slice(0, 4096);
  const firstLine = sample.split(/\r?\n/, 1)[0] || '';
  const columns = new Set(parseCsvHeader(firstLine));
  const missing = expectedColumns.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(`${fileName} is missing expected column(s): ${missing.join(', ')}`);
  }
}

function writeManifest(results, options) {
  const downloaded = results.filter((item) => item.ok);
  const files = {};
  const downloadedAt = new Date().toISOString();
  const refreshedOn = downloadedAt.slice(0, 10);

  for (const item of downloaded) {
    const filePath = path.join(OURAIRPORTS_DIR, item.fileName);
    const sha256 = sha256File(filePath);
    const previousSha256 = PREVIOUS_SHA256[item.fileName] || null;
    files[item.fileName] = {
      url: `${OURAIRPORTS_BASE}/${item.fileName}`,
      required: REQUIRED_FILES.includes(item.fileName),
      sizeBytes: fileSizeBytes(filePath),
      sha256,
      previousSha256,
      changedSincePreviousPin: Boolean(previousSha256 && previousSha256 !== sha256),
      upstreamLastModified: item.lastModified,
      upstreamEtag: item.etag,
      shapeValidated: options.skipShapeValidation !== true,
    };
  }

  const manifest = {
    version: MANIFEST_VERSION,
    source: 'OurAirports',
    sourceBaseUrl: OURAIRPORTS_BASE,
    mutableUpstream: true,
    downloadedAt,
    refreshedOn,
    requiredFiles: REQUIRED_FILES,
    files,
  };

  const manifestPath = path.join(OURAIRPORTS_DIR, MANIFEST_FILE_NAME);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`[data-sync] wrote ${MANIFEST_FILE_NAME}`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const requiredOnly = args.has('--required-only');
  const skipShapeValidation = args.has('--skip-shape-validation');

  const files = requiredOnly
    ? [...REQUIRED_FILES]
    : [...REQUIRED_FILES, ...EXTENDED_FILES];

  ensureDir(OURAIRPORTS_DIR);

  console.log(`[data-sync] target directory: ${OURAIRPORTS_DIR}`);
  console.log(`[data-sync] downloading ${files.length} file(s)...`);
  if (skipShapeValidation) {
    console.log('[data-sync] WARNING: CSV shape validation is disabled (--skip-shape-validation)');
  }

  const results = [];

  for (const fileName of files) {
    const url = `${OURAIRPORTS_BASE}/${fileName}`;
    const targetPath = path.join(OURAIRPORTS_DIR, fileName);
    process.stdout.write(`[data-sync] ${fileName} ... `);
    try {
      const downloadMetadata = await downloadToFile(url, targetPath);
      if (!skipShapeValidation) {
        validateCsvShape(fileName, targetPath);
      }
      const sha256 = sha256File(targetPath);
      const previousSha256 = PREVIOUS_SHA256[fileName];
      const sizeKb = fileSizeKb(targetPath);
      const changeNote = previousSha256 && previousSha256 !== sha256
        ? `, upstream hash changed from previous pin (${sha256})`
        : '';
      console.log(`ok (${sizeKb} KB${changeNote})`);
      results.push({ fileName, ok: true, sizeKb, ...downloadMetadata });
    } catch (err) {
      try { fs.rmSync(targetPath, { force: true }); } catch {}
      console.log(`failed (${err.message})`);
      results.push({ fileName, ok: false, error: err.message });
    }
  }

  const failed = results.filter((r) => !r.ok);
  const downloaded = results.filter((r) => r.ok);

  console.log(`\n[data-sync] downloaded: ${downloaded.length}, failed: ${failed.length}`);

  if (failed.length > 0) {
    for (const item of failed) {
      console.log(`[data-sync] missing: ${item.fileName} -> ${item.error}`);
    }
    process.exitCode = 1;
    return;
  }

  writeManifest(results, { skipShapeValidation });
  console.log('[data-sync] complete');
}

main().catch((err) => {
  console.error('[data-sync] fatal:', err.message);
  process.exit(1);
});
