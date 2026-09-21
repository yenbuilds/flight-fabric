/** Read only the installed, unambiguous wheel geometry selected by AircraftLoaded.
 * Contact properties and units: https://docs.flightsimulator.com/msfs2024/html/5_Content_Configuration/CFG_Files/flight_model_cfg.htm
 * Modular presets: https://docs.flightsimulator.com/msfs2024/html/5_Content_Configuration/Modular_SimObjects/Modular_SimObject_Merging.htm
 * This is deliberately not a general MSFS configuration merger: dynamic parameters,
 * transformed geometry and conflicting attachment geometry remain unavailable.
 */
const fs = require('node:fs') as typeof import('node:fs');
import path from 'node:path';
import crypto from 'node:crypto';
const { isPathInside } = require('../utils/path-guard.js') as {
  isPathInside: (parentDir: string, childPath: string, options?: { allowEqual?: boolean }) => boolean;
};
const { getAppDataBaseDir, getHomeDir } = require('../utils/storage-paths.js') as {
  getAppDataBaseDir: () => string;
  getHomeDir: () => string;
};

export type TaxiAircraftConfigResult = Readonly<{
  ok: true;
  identity: string;
  sourceFiles: readonly string[];
  fingerprint: string;
  wheelbaseM: number;
  maxSteeringDeg: number;
  /** Lateral span of the outermost main-wheel contact points. */
  wheelTrackM: number;
  lengthM: number;
  /** CONTACT_POINTS max_speed_full_steering, converted from feet/second. */
  fullSteeringSpeedKts?: number;
  /** Nose-wheel longitudinal position relative to the configuration datum. */
  noseOffsetM: number;
}> | Readonly<{ ok: false; reason: string }>;
export type TaxiAircraftConfigOptions = {
  /** Package containers (Community, Official/OneStore, etc.) or individual packages. */
  packageRoots?: readonly string[];
  userCfgPaths?: readonly string[];
};
type Sections = Map<string, Map<string, string>>;
type Geometry = Map<string, string>;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 256;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 6;
const MAX_PACKAGES = 2048;
const CACHE_MS = 1000;
const cache = new Map<string, { time: number; result: TaxiAircraftConfigResult }>();
const normalized = (name: string) => path.resolve(name).replace(/\\/g, '/').toLowerCase();
const unquote = (value: string) => value.trim().replace(/^"(.*)"$/, '$1');
const asPath = (value: string) => value.replace(/[\\/]/g, path.sep);
const fail = (message: string): never => { throw new Error(message); };

export function clearTaxiAircraftConfigCache(): void { cache.clear(); }

function withoutComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    if (!quoted && (line[i] === ';' || line.slice(i, i + 2) === '//')) return line.slice(0, i);
  }
  return line;
}

function parse(text: string): Sections {
  const sections: Sections = new Map();
  let section = '';
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (raw.length > 16384) fail('An aircraft configuration line is too long.');
    const line = withoutComment(raw).trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) { section = header[1].trim().toLowerCase(); continue; }
    const equal = line.indexOf('=');
    if (equal < 1) continue;
    const key = line.slice(0, equal).trim().toLowerCase();
    const value = line.slice(equal + 1).trim();
    if (!sections.has(section)) sections.set(section, new Map());
    const fields = sections.get(section)!;
    if (fields.has(key) && fields.get(key) !== value
      && ['contact_points', 'airplane_geometry', 'variation', 'livery', 'modular_merge', 'inherit'].includes(section)) {
      fail('Aircraft configuration contains conflicting definitions.');
    }
    fields.set(key, value);
  }
  return sections;
}

function boundedText(file: string): string {
  const handle = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) fail('An aircraft configuration file is unavailable or too large.');
    const buffer = Buffer.alloc(stat.size + 1);
    const size = fs.readSync(handle, buffer, 0, buffer.length, 0);
    if (size !== stat.size) fail('Aircraft configuration changed while it was being read.');
    const text = buffer.subarray(0, size).toString('utf8');
    if (text.includes('\0')) fail('Aircraft configuration is not readable text.');
    return text;
  } finally { fs.closeSync(handle); }
}

function knownUserCfgPaths(): string[] {
  if (process.platform !== 'win32') return [];
  const roaming = getAppDataBaseDir();
  const local = path.join(getHomeDir(), 'AppData', 'Local');
  return [
    // Live taxi facilities belong to MSFS 2024. An unrelated 2020 installation
    // must not satisfy a VFS path absent from the running simulator's packages.
    ...(roaming ? [path.join(roaming, 'Microsoft Flight Simulator 2024', 'UserCfg.opt')] : []),
    ...(local ? ['Microsoft.Limitless_8wekyb3d8bbwe']
      .map(name => path.join(local, 'Packages', name, 'LocalCache', 'UserCfg.opt')) : []),
  ];
}

function discoverRoots(options: TaxiAircraftConfigOptions): string[] {
  if (options.packageRoots) return [...new Set(options.packageRoots.map(root => path.resolve(root)))];
  const roots: string[] = [];
  for (const file of options.userCfgPaths ?? knownUserCfgPaths()) {
    if (!fs.existsSync(file)) continue;
    const match = /^\s*InstalledPackagesPath\s+"([^"\r\n]+)"\s*$/mi.exec(boundedText(file));
    if (!match) continue;
    const packages = match[1];
    for (const child of ['Community', 'Community2024', 'Official', 'Official/OneStore', 'Official/Steam', 'Official2020', 'Official2024', 'StreamedPackages']) {
      roots.push(path.resolve(packages, asPath(child)));
    }
  }
  return [...new Set(roots)];
}

function airplanesRoot(file: string): string {
  const slash = path.resolve(file).replace(/\\/g, '/');
  const match = /^(.*\/SimObjects\/Airplanes)(?:\/|$)/i.exec(slash);
  if (!match) fail('Aircraft configuration must be inside SimObjects/Airplanes.');
  return asPath(match[1]);
}

function inside(file: string, root: string): boolean {
  return isPathInside(root, file, { allowEqual: true });
}

function packageRoot(file: string): string { return path.dirname(path.dirname(airplanesRoot(file))); }

function relevantGeometry(sections: Sections): Geometry {
  const result: Geometry = new Map();
  for (const [section, keys] of sections) {
    for (const [key, value] of keys) {
      if ((section === 'contact_points' && (/^point\.\d+$/.test(key) || key === 'max_speed_full_steering'))
        || (section === 'airplane_geometry' && key === 'fuselage_length')) {
        if (/\[|\]|attachmentrebind/i.test(value)) fail('Dynamic aircraft wheel geometry is not supported yet.');
        result.set(`${section}/${key}`, value);
      }
    }
  }
  return result;
}

/** Results are cached for one second (at most 32 selected aircraft). All selected
 * source paths and their contents participate in the next resolved fingerprint. */
export function resolveTaxiAircraftConfig(aircraftCfgPath: string, options: TaxiAircraftConfigOptions = {}): TaxiAircraftConfigResult {
  if (typeof aircraftCfgPath !== 'string' || !aircraftCfgPath.trim() || aircraftCfgPath.length > 4096) {
    return { ok: false, reason: 'Waiting for the loaded aircraft configuration path.' };
  }
  const key = JSON.stringify([aircraftCfgPath, options]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.time >= 0 && Date.now() - hit.time < CACHE_MS) return hit.result;
  let result: TaxiAircraftConfigResult;
  try {
    const roots = discoverRoots(options);
    if (roots.length > 32) fail('Too many simulator package locations were found.');
    let packageDirectories: string[] | null = null;
    const simObjectPackages = new Map<string, string[]>();
    const files = new Map<string, string>();
    const parsedFiles = new Map<string, Sections>();
    let totalBytes = 0;
    let attachmentVisits = 0;
    const read = (file: string, optional = false): Sections | null => {
      // The VFS can overlay flight_model.cfg without also supplying aircraft.cfg.
      // Check every source, including optional sources absent in this package.
      const matches = vfsMatches(path.relative(packageRoot(file), file), packageRoot(file));
      if (matches.length > 1) fail('More than one installed package defines a selected aircraft configuration source.');
      if (!fs.existsSync(file)) {
        if (matches.length) fail('A selected aircraft configuration source is overlaid by another package.');
        if (optional) return null;
        return fail('A selected aircraft configuration file is unavailable.');
      }
      const real = fs.realpathSync(file);
      airplanesRoot(real);
      if (!files.has(real)) {
        if (files.size >= MAX_FILES) fail('Aircraft configuration includes too many files.');
        const text = boundedText(real);
        totalBytes += Buffer.byteLength(text);
        if (totalBytes > MAX_TOTAL_BYTES) fail('Selected aircraft configuration is too large to inspect.');
        files.set(real, text);
        parsedFiles.set(real, parse(text));
      }
      return parsedFiles.get(real)!;
    };
    const vfsMatches = (value: string, preferredPackage?: string): string[] => {
      const relative = value.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!/^SimObjects\/Airplanes\//i.test(relative) || relative.split('/').some(part => part === '..' || part === '.')) {
        return fail('The selected aircraft configuration path cannot be resolved safely.');
      }
      if (!packageDirectories) {
        packageDirectories = [];
        let directoryEntries = 0;
        for (const root of roots) {
          if (!fs.existsSync(root)) continue;
          if (fs.existsSync(path.join(root, 'SimObjects', 'Airplanes'))) packageDirectories.push(root);
          const directory = fs.opendirSync(root);
          try {
            let item: import('node:fs').Dirent | null;
            while ((item = directory.readSync()) !== null) {
              if (++directoryEntries > MAX_PACKAGES * 2) fail('Too many entries in simulator package locations.');
              if (item.isDirectory() || item.isSymbolicLink()) packageDirectories.push(path.join(root, item.name));
              if (packageDirectories.length > MAX_PACKAGES) fail('Too many aircraft packages to resolve this configuration.');
            }
          } finally { directory.closeSync(); }
        }
      }
      const aircraftRoot = relative.split('/').slice(0, 3).join('/');
      const selectionKey = `${aircraftRoot.toLowerCase()}\0${preferredPackage || ''}`;
      if (!simObjectPackages.has(selectionKey)) {
        simObjectPackages.set(selectionKey, [...new Set([...(preferredPackage ? [preferredPackage] : []), ...packageDirectories])]
          .filter(root => fs.existsSync(path.join(root, asPath(aircraftRoot)))));
      }
      const candidates = new Set<string>();
      for (const root of simObjectPackages.get(selectionKey)!) {
        const candidate = path.join(root, asPath(relative));
        if (fs.existsSync(candidate)) candidates.add(fs.realpathSync(candidate));
      }
      return [...candidates];
    };
    const resolveVfs = (value: string, preferredPackage?: string): string => {
      const candidates = vfsMatches(value, preferredPackage);
      if (candidates.length !== 1) fail(candidates.length ? 'More than one installed package matches the loaded aircraft configuration.' : 'The loaded aircraft configuration is not available in installed packages.');
      return candidates[0];
    };
    const rawPath = asPath(unquote(aircraftCfgPath));
    const initial = path.isAbsolute(rawPath) && fs.existsSync(rawPath) ? fs.realpathSync(rawPath) : resolveVfs(rawPath);
    if (path.basename(initial).toLowerCase() !== 'aircraft.cfg') fail('The loaded aircraft path does not identify aircraft.cfg.');
    airplanesRoot(initial);

    function registerModularContacts(source: string, geometry: Geometry, contributors: Set<string>): void {
      if (![...geometry.keys()].some(name => /^contact_points\/point\.\d+$/.test(name))) return;
      // Indexed points append/reindex in MSFS modular merge; Map.set would
      // silently invent an override. Support only one contact contributor.
      const id = normalized(source);
      if (contributors.size) fail('Several modular sources define contact points; their merged geometry is unsupported.');
      contributors.add(id);
    }
    function attachmentGeometry(root: string, visited: Set<string>, depth: number, contributors: Set<string>): Geometry {
      if (++attachmentVisits > MAX_FILES) fail('Aircraft attachment graph has too many references.');
      if (depth > MAX_DEPTH) fail('Aircraft attachment nesting is too deep.');
      if (!fs.existsSync(root)) fail('A selected aircraft attachment is unavailable.');
      const real = fs.realpathSync(root);
      if (visited.has(normalized(real))) fail('Aircraft attachment inheritance contains a cycle.');
      const next = new Set(visited).add(normalized(real));
      let combined: Geometry = new Map();
      const descriptor = read(path.join(real, 'attachment.cfg'), true);
      const base = unquote(descriptor?.get('inherit')?.get('base') ?? '');
      if (base) combined = attachmentGeometry(resolveAttachment(base, real), next, depth + 1, contributors);
      const modelPath = path.join(real, 'config', 'flight_model.cfg');
      const model = read(modelPath, true);
      if (model?.has('dynamicparameters')) fail('Dynamic aircraft attachment geometry is not supported yet.');
      const ownGeometry = relevantGeometry(model ?? new Map());
      registerModularContacts(modelPath, ownGeometry, contributors);
      for (const [name, value] of ownGeometry) combined.set(name, value);
      const children = read(path.join(real, 'config', 'attached_objects.cfg'), true);
      for (const [name, value] of selectedAttachments(children, real, next, depth + 1, contributors)) {
        if (combined.has(name)) fail('Several aircraft attachments define the wheel geometry.');
        combined.set(name, value);
      }
      return combined;
    }
    function resolveAttachment(reference: string, origin: string): string {
      const relative = reference.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!/^SimObjects\/Airplanes\//i.test(relative) || relative.split('/').some(part => part === '..' || part === '.')) {
        return fail('Aircraft attachment path is outside its aircraft package.');
      }
      const target = path.resolve(packageRoot(origin), asPath(relative));
      if (!inside(target, airplanesRoot(origin))) fail('Aircraft attachment path is outside its aircraft package.');
      if (fs.existsSync(target) && !inside(fs.realpathSync(target), fs.realpathSync(airplanesRoot(origin)))) {
        fail('Aircraft attachment path leaves its aircraft package.');
      }
      return target;
    }
    function selectedAttachments(sections: Sections | null, origin: string, visited: Set<string>, depth: number, contributors: Set<string>): Geometry {
      const combined: Geometry = new Map();
      const aliases = new Set<string>();
      for (const [section, values] of sections ?? []) {
        if (!/^sim_attachment\.\d+$/.test(section)) continue;
        const alias = unquote(values.get('alias') ?? '').toLowerCase();
        if ([...values.keys()].some(name => /^cfg_parameter\.|attachmentrebind/.test(name))) fail('Dynamic aircraft attachment overrides are not supported yet.');
        const reference = unquote(values.get('attachment_root') ?? '');
        if (!reference) fail('Aircraft attachment reference is not a supported static path.');
        const geometry = attachmentGeometry(resolveAttachment(reference, origin), visited, depth, contributors);
        // A visual-only attachment cannot override the selected geometry. Some
        // shipped 737 presets reuse the exterior alias for both winglets; still
        // inspect those graphs so an added geometry source cannot go unnoticed.
        if (geometry.size) {
          if (!alias || aliases.has(alias)) fail('Aircraft geometry attachments need unique, non-empty aliases.');
          aliases.add(alias);
        }
        const vectorTransform = ['attach_offset', 'attach_pbh', 'translation', 'rotation'].some(name => {
          const value = values.get(name);
          return value !== undefined && unquote(value).split(',').some(part => !part.trim() || Number(part.trim()) !== 0);
        });
        const scaleTransform = ['attach_scale', 'scale'].some(name => values.has(name) && Number(unquote(values.get(name)!)) !== 1);
        if (geometry.size && (vectorTransform || scaleTransform || unquote(values.get('attach_to_node') ?? ''))) {
          fail('Transformed aircraft attachment geometry is not supported yet.');
        }
        for (const [name, value] of geometry) {
          if (combined.has(name)) fail('Several aircraft attachments define the wheel geometry.');
          combined.set(name, value);
        }
      }
      return combined;
    }
    function loadAircraft(file: string, visited: Set<string>, depth: number): Geometry {
      if (depth > MAX_DEPTH) fail('Aircraft configuration inheritance is too deep.');
      const real = fs.realpathSync(file);
      const id = normalized(real);
      if (visited.has(id)) fail('Aircraft configuration inheritance contains a cycle.');
      const next = new Set(visited).add(id);
      const cfg = read(real)!;
      const folder = path.dirname(real);
      const base = unquote(cfg.get('variation')?.get('base_container') ?? cfg.get('livery')?.get('base_container') ?? '');
      let combined: Geometry = new Map();
      if (base) {
        let candidate: string;
        if (/^[\\/]*SimObjects[\\/]Airplanes[\\/]/i.test(base)) {
          candidate = resolveVfs(`${base.replace(/[\\/]$/, '')}/aircraft.cfg`, packageRoot(real));
        } else {
          const target = path.resolve(folder, asPath(base));
          if (!inside(target, airplanesRoot(real))) fail('Aircraft base_container leaves SimObjects/Airplanes.');
          candidate = path.join(target, 'aircraft.cfg');
          if (fs.existsSync(candidate)) {
            if (!inside(fs.realpathSync(candidate), fs.realpathSync(airplanesRoot(real)))) fail('Aircraft base_container leaves its aircraft package.');
          } else {
            const relative = path.relative(packageRoot(real), candidate);
            candidate = resolveVfs(relative, packageRoot(real));
          }
        }
        combined = loadAircraft(candidate, next, depth + 1);
      }
      const slash = real.replace(/\\/g, '/');
      const preset = /^(.*\/SimObjects\/Airplanes\/[^/]+)\/presets\//i.exec(slash);
      const contributors = new Set<string>();
      if (preset) {
        registerModularContacts(real, combined, contributors);
        const commonPath = path.join(asPath(preset[1]), 'common', 'config', 'flight_model.cfg');
        const common = read(commonPath, true);
        const commonGeometry = relevantGeometry(common ?? new Map());
        registerModularContacts(commonPath, commonGeometry, contributors);
        for (const [name, value] of commonGeometry) combined.set(name, value);
        const attached = read(path.join(folder, 'attached_objects.cfg'), true);
        for (const [name, value] of selectedAttachments(attached, real, new Set(), 0, contributors)) combined.set(name, value);
      }
      const model = read(path.join(folder, 'flight_model.cfg'), true);
      if (model?.has('dynamicparameters') || /^(false|0)$/i.test(unquote(model?.get('modular_merge')?.get('auto') ?? ''))) {
        fail('Dynamic or manually merged aircraft wheel geometry is not supported yet.');
      }
      const ownGeometry = relevantGeometry(model ?? new Map());
      if (preset) registerModularContacts(path.join(folder, 'flight_model.cfg'), ownGeometry, contributors);
      for (const [name, value] of ownGeometry) combined.set(name, value);
      return combined;
    }
    const geometry = loadAircraft(initial, new Set(), 0);
    const wheels: { longitudinal: number; lateral: number; brake: number; steering: number }[] = [];
    for (const [key, raw] of geometry) {
      if (!/^contact_points\/point\.\d+$/.test(key)) continue;
      const props = /(?:^|#)\s*properties\s*:\s*([^#]+)/i.exec(raw)?.[1] ?? raw;
      const tokens = props.split(',');
      const values = tokens.map(value => value.trim() ? Number(value.trim()) : NaN);
      if (!Number.isInteger(values[0]) || values[0] < 0) fail('Aircraft contact-point type is invalid.');
      if (values[0] !== 1) continue;
      if (values.length < 8 || !values.slice(0, 8).every(Number.isFinite)) fail('Aircraft wheel geometry contains invalid numbers.');
      wheels.push({ longitudinal: values[1], lateral: values[2], brake: values[5], steering: values[7] });
      if (wheels.length > 128) fail('Aircraft has too many wheel contact points.');
    }
    const steerable = wheels.filter(wheel => wheel.steering !== 0);
    if (steerable.length !== 1 || steerable[0].steering <= 0 || steerable[0].steering >= 90) {
      fail('Autotaxi needs one steerable nose wheel; tailwheels and free-castering wheels are not supported.');
    }
    const nose = steerable[0];
    const mains = wheels.filter(wheel => wheel !== nose && wheel.steering === 0 && [1, 2, 3].includes(wheel.brake));
    const left = mains.filter(wheel => wheel.lateral < 0 && [1, 3].includes(wheel.brake));
    const right = mains.filter(wheel => wheel.lateral > 0 && [2, 3].includes(wheel.brake));
    if (!left.length || !right.length || wheels.length !== mains.length + 1 || mains.length !== left.length + right.length || Math.abs(nose.lateral) > 0.5 || nose.brake !== 0
      || mains.some(wheel => wheel.longitudinal >= nose.longitudinal)) fail('Aircraft nose wheel and braked main wheels are not unambiguous.');
    // Multi-bogie aircraft may have several physical contact points. Require a
    // symmetric left/right group, then use the mean main-gear station.
    left.sort((a, b) => a.longitudinal - b.longitudinal || Math.abs(a.lateral) - Math.abs(b.lateral));
    right.sort((a, b) => a.longitudinal - b.longitudinal || Math.abs(a.lateral) - Math.abs(b.lateral));
    if (left.length !== right.length || left.some((wheel, index) => Math.abs(wheel.longitudinal - right[index].longitudinal) >= 0.5
      || Math.abs(wheel.lateral + right[index].lateral) >= 0.5)) fail('Aircraft main-wheel geometry is not a symmetric pair.');
    const average = (list: typeof wheels, field: 'longitudinal' | 'lateral') => list.reduce((sum, wheel) => sum + wheel[field], 0) / list.length;
    const wheelbaseM = (nose.longitudinal - average(mains, 'longitudinal')) * 0.3048;
    const wheelTrackM = (Math.max(...right.map(wheel => wheel.lateral)) - Math.min(...left.map(wheel => wheel.lateral))) * 0.3048;
    const lengthM = Number(geometry.get('airplane_geometry/fuselage_length')) * 0.3048;
    const fullSteeringSpeed = geometry.get('contact_points/max_speed_full_steering');
    const fullSteeringSpeedKts = fullSteeringSpeed === undefined ? undefined : Number(fullSteeringSpeed) * 0.3048 / (1852 / 3600);
    if (fullSteeringSpeedKts !== undefined && (!Number.isFinite(fullSteeringSpeedKts) || fullSteeringSpeedKts <= 0 || fullSteeringSpeedKts > 200)) {
      fail('Aircraft full-steering speed is outside the supported ground-control range.');
    }
    if (![wheelbaseM, wheelTrackM, lengthM].every(Number.isFinite) || wheelbaseM < 1 || wheelbaseM > 60
      || wheelTrackM < 0.5 || wheelTrackM > 40 || lengthM < wheelbaseM || lengthM > 100) fail('Aircraft dimensions are missing or outside the supported ground-control range.');
    const sourceFiles = [...files.keys()].sort();
    const digest = crypto.createHash('sha256');
    for (const file of sourceFiles) digest.update(normalized(file)).update('\0').update(files.get(file)!).update('\0');
    result = Object.freeze({ ok: true, identity: normalized(initial), sourceFiles: Object.freeze(sourceFiles), fingerprint: digest.digest('hex'),
      wheelbaseM, wheelTrackM, lengthM, maxSteeringDeg: nose.steering, noseOffsetM: nose.longitudinal * 0.3048 });
    if (fullSteeringSpeedKts !== undefined) result = Object.freeze({ ...result, fullSteeringSpeedKts });
  } catch (error) {
    const reason = error instanceof Error && !('code' in error) ? error.message : 'The loaded aircraft configuration could not be read.';
    result = Object.freeze({ ok: false, reason });
  }
  if (cache.size >= 32) cache.delete(cache.keys().next().value!);
  cache.set(key, { time: Date.now(), result });
  return result;
}
