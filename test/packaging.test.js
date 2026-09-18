/**
 * Packaging guard.
 *
 * A deployment once died with `Cannot find module '/var/task/src/output/result.js'`
 * because an unanchored `output/` rule in .gitignore matched `src/output/` as
 * well as the root artefacts folder. The files were on disk, every test passed,
 * and the repo was missing two modules — nothing local could see it.
 *
 * So: assert that every module the runtime imports is actually committed, and
 * that the ignore rules which caused it stay anchored.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
    return new Set(out.split(/\r?\n/).filter(Boolean).map((p) => p.replace(/\\/g, '/')));
  } catch {
    return null; // not a git checkout (tarball, vendored copy) — nothing to assert
  }
}

/** Every .js file under a directory, recursively. */
function jsFiles(dir) {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.js') || entry.endsWith('.mjs')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Relative specifiers from both static and dynamic imports. */
function relativeImports(source) {
  const specs = [];
  const patterns = [
    /(?:^|\n)\s*import\s[^'"]*?from\s*['"](\.[^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /(?:^|\n)\s*export\s[^'"]*?from\s*['"](\.[^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source))) specs.push(m[1]);
  }
  return specs;
}

test('every module the runtime imports is committed to the repo', () => {
  const tracked = trackedFiles();
  if (!tracked) return; // not a git checkout

  const sources = [...jsFiles(path.join(root, 'src')), ...jsFiles(path.join(root, 'api'))];
  assert.ok(sources.length > 10, `expected to find the source tree, found ${sources.length} files`);

  const missing = [];
  for (const file of sources) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    assert.ok(tracked.has(rel), `${rel} exists on disk but is not tracked by git`);

    for (const spec of relativeImports(readFileSync(file, 'utf8'))) {
      const resolved = path.relative(root, path.resolve(path.dirname(file), spec)).replace(/\\/g, '/');
      if (!existsSync(path.join(root, resolved))) {
        missing.push(`${rel} imports ${spec} -> ${resolved} (does not exist on disk)`);
      } else if (!tracked.has(resolved)) {
        missing.push(`${rel} imports ${spec} -> ${resolved} (on disk but NOT in the repo)`);
      }
    }
  }

  assert.deepEqual(missing, [], `untracked runtime modules:\n  ${missing.join('\n  ')}`);
});

test('the ignore rules that caused it stay anchored to the repo root', () => {
  for (const name of ['.gitignore', '.vercelignore']) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));

    for (const line of lines) {
      // A bare directory name matches at every depth. `output/` is the one that
      // bit us; `node_modules/` and `__pycache__/` are meant to match anywhere.
      const anywhereIsFine = ['node_modules/', '__pycache__/', '.vscode/', '.idea/'];
      if (anywhereIsFine.includes(line)) continue;
      if (line.startsWith('/') || line.startsWith('*') || line.startsWith('.')) continue;
      assert.ok(
        !line.endsWith('/'),
        `${name}: "${line}" is unanchored and will match that name at ANY depth ` +
          `(this is how src/output/ got excluded). Write "/${line}" instead.`,
      );
    }
  }
});

test('the package entry points referenced in package.json exist and are tracked', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const tracked = trackedFiles();
  const entries = [pkg.main, ...Object.values(pkg.bin ?? {})].filter(Boolean);
  for (const entry of entries) {
    const rel = entry.replace(/^\.\//, '').replace(/\\/g, '/');
    assert.ok(existsSync(path.join(root, rel)), `package.json points at ${rel}, which does not exist`);
    if (tracked) assert.ok(tracked.has(rel), `package.json points at ${rel}, which is not committed`);
  }
});

test('Vercel serves public directly without Express framework detection', () => {
  const config = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.equal(config.framework, null, 'Vercel framework detection must stay disabled');
  assert.equal(config.buildCommand, 'echo "no build step — public/ is served as-is"');
  assert.equal(config.outputDirectory, 'public');
  assert.ok(config.rewrites.some(({ source, destination }) => source === '/api/(.*)' && destination === '/api/index.js'));

  const publicFiles = jsFiles(path.join(root, 'public'));
  assert.deepEqual(
    publicFiles.map((file) => path.basename(file)),
    ['ui.js'],
    'public must not contain app.js, which Vercel can mistake for an Express entrypoint',
  );
  assert.match(readFileSync(path.join(root, 'public', 'index.html'), 'utf8'), /src="ui\.js"/);
});
