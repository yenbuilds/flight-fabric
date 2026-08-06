#!/usr/bin/env node
/**
 * Release Profile Loader
 * 
 * Loads and resolves release profiles with inheritance.
 * Used by build scripts to determine what files to include.
 * 
 * Usage:
 *   const { loadProfile, resolveProfile, listProfiles } = require('./release-profile-loader');
 *   const profile = loadProfile('user');
 *   const resolved = resolveProfile('developer'); // includes inherited from 'user'
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROFILES_DIR = path.join(ROOT, 'release-profiles');

/**
 * Load a single profile without inheritance resolution
 */
function loadProfile(name) {
  const profilePath = path.join(PROFILES_DIR, `${name}.json`);
  
  if (!fs.existsSync(profilePath)) {
    throw new Error(`Profile not found: ${name} (looked in ${profilePath})`);
  }
  
  return JSON.parse(fs.readFileSync(profilePath, 'utf8'));
}

/**
 * Resolve a profile with full inheritance chain
 * Returns merged include lists from all ancestors
 */
function resolveProfile(name, visited = new Set()) {
  // Prevent circular inheritance
  if (visited.has(name)) {
    throw new Error(`Circular inheritance detected: ${[...visited, name].join(' -> ')}`);
  }
  visited.add(name);
  
  const profile = loadProfile(name);
  
  // Base case: no parent
  if (!profile.extends) {
    return {
      name: profile.name,
      displayName: profile.displayName,
      description: profile.description,
      include: {
        backend: [...(profile.include.backend || [])],
        backend_dirs: [...(profile.include.backend_dirs || [])],
        frontend: [...(profile.include.frontend || [])],
        tools: [...(profile.include.tools || [])],
        root: [...(profile.include.root || [])],
      },
      exclude_patterns: [...(profile.exclude_patterns || [])],
    };
  }
  
  // Recursive case: resolve parent first
  const parent = resolveProfile(profile.extends, visited);
  
  // Merge includes (child adds to parent)
  return {
    name: profile.name,
    displayName: profile.displayName,
    description: profile.description,
    include: {
      backend: [...parent.include.backend, ...(profile.include.backend || [])],
      backend_dirs: [...parent.include.backend_dirs, ...(profile.include.backend_dirs || [])],
      frontend: [...parent.include.frontend, ...(profile.include.frontend || [])],
      tools: [...parent.include.tools, ...(profile.include.tools || [])],
      root: [...parent.include.root, ...(profile.include.root || [])],
    },
    // Exclude patterns: child can add but not remove
    exclude_patterns: [...parent.exclude_patterns, ...(profile.exclude_patterns || [])],
  };
}

/**
 * List all available profiles
 */
function listProfiles() {
  const files = fs.readdirSync(PROFILES_DIR);
  return files
    .filter(f => f.endsWith('.json') && !f.includes('schema'))
    .map(f => f.replace('.json', ''));
}

/**
 * Validate that all included files actually exist
 */
function validateProfile(name) {
  const resolved = resolveProfile(name);
  const missing = [];
  
  // Check backend files
  for (const file of resolved.include.backend) {
    const fullPath = path.join(ROOT, 'backend', file);
    if (!fs.existsSync(fullPath)) {
      missing.push(`backend/${file}`);
    }
  }
  
  // Check backend directories
  for (const dir of resolved.include.backend_dirs) {
    const fullPath = path.join(ROOT, 'backend', dir);
    if (!fs.existsSync(fullPath)) {
      missing.push(`backend/${dir}/`);
    }
  }
  
  // Check frontend files
  for (const file of resolved.include.frontend) {
    const fullPath = path.join(ROOT, 'frontend', file);
    if (!fs.existsSync(fullPath)) {
      missing.push(`frontend/${file}`);
    }
  }
  
  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Get file list for a profile (fully expanded)
 * Returns absolute paths of all files that should be included
 */
function getProfileFiles(name) {
  const resolved = resolveProfile(name);
  const files = [];
  
  // Backend files
  for (const file of resolved.include.backend) {
    files.push(path.join(ROOT, 'backend', file));
  }
  
  // Backend directories (recursive)
  for (const dir of resolved.include.backend_dirs) {
    const dirPath = path.join(ROOT, 'backend', dir);
    if (fs.existsSync(dirPath)) {
      files.push(...listFilesRecursive(dirPath));
    }
  }
  
  // Frontend files
  for (const file of resolved.include.frontend) {
    files.push(path.join(ROOT, 'frontend', file));
  }
  
  // Filter by exclude patterns
  const excluded = new Set();
  for (const file of files) {
    for (const pattern of resolved.exclude_patterns) {
      if (matchesGlob(file, pattern) && !isReleaseProfileException(file)) {
        excluded.add(file);
        break;
      }
    }
  }
  
  return files.filter(f => !excluded.has(f));
}

function isReleaseProfileException(_filePath) {
  return false;
}

/**
 * Simple glob matching
 */
function matchesGlob(filePath, pattern) {
  const normalizedPath = String(filePath).replace(/\\/g, '/');
  const normalizedPattern = String(pattern).replace(/\\/g, '/');
  const basename = path.basename(normalizedPath);
  const normalizedRoot = String(ROOT).replace(/\\/g, '/');
  const relativePath = normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : null;

  // Convert glob to regex.
  // Supports: * and **
  const escaped = normalizedPattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  const regex = new RegExp(
    '^' + escaped
      .replace(/\*\*/g, '<<<GLOBSTAR>>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<<GLOBSTAR>>>/g, '.*') + '$'
  );

  return (
    regex.test(normalizedPath)
    || regex.test(basename)
    || (relativePath ? regex.test(relativePath) : false)
  );
}

/**
 * Recursively list files in directory
 */
function listFilesRecursive(dir) {
  const files = [];
  
  if (!fs.existsSync(dir)) return files;
  
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  
  return files;
}

module.exports = {
  loadProfile,
  resolveProfile,
  listProfiles,
  validateProfile,
  getProfileFiles,
  PROFILES_DIR,
  __private: {
    matchesGlob,
    isReleaseProfileException,
  },
};

// CLI mode
if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Available profiles:');
    for (const name of listProfiles()) {
      const profile = loadProfile(name);
      console.log(`  ${name}: ${profile.displayName}`);
    }
    console.log('\nUsage: node release-profile-loader.js <profile> [--validate]');
    process.exit(0);
  }
  
  const profileName = args[0];
  const shouldValidate = args.includes('--validate');
  
  try {
    const resolved = resolveProfile(profileName);
    console.log(`\n${resolved.displayName}`);
    console.log('='.repeat(resolved.displayName.length));
    console.log(resolved.description);
    console.log('');
    
    console.log('Backend files:', resolved.include.backend.length);
    console.log('Backend dirs:', resolved.include.backend_dirs.length);
    console.log('Frontend files:', resolved.include.frontend.length);
    console.log('Tools:', resolved.include.tools.length);
    console.log('Exclude patterns:', resolved.exclude_patterns.length);
    
    if (shouldValidate) {
      console.log('\nValidating...');
      const result = validateProfile(profileName);
      if (result.valid) {
        console.log('✓ All files exist');
      } else {
        console.log('✗ Missing files:');
        for (const f of result.missing) {
          console.log(`  - ${f}`);
        }
        process.exit(1);
      }
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
