import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const src = fileURLToPath(new URL('../src/', import.meta.url));
const read = (path) => readFileSync(join(src, path), 'utf8');

test('postAuthSync calls only methods exported by cloudSync', () => {
  const source = read('app/cloudSync.js');
  const exported = new Set(Array.from(
    source.matchAll(/\bexport\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/g),
    (match) => match[1],
  ));
  for (const [, names] of source.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    for (const name of names.split(',').map((part) => part.trim()).filter(Boolean)) {
      exported.add(name.split(/\s+as\s+/).at(-1));
    }
  }
  const calls = new Set(Array.from(read('app/postAuthSync.js').matchAll(/\bcloudSync\.(\w+)\s*\(/g), (match) => match[1]));
  assert.ok(calls.size > 0, 'must find cloudSync method calls');
  assert.deepEqual([...calls].filter((name) => !exported.has(name)), [], 'cloudSync calls without a matching export');
});

test('src contains no reference to the removed prepareCloudSyncConflict API', () => {
  const matches = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && readFileSync(path, 'utf8').includes('prepareCloudSyncConflict')) matches.push(path);
    }
  }
  visit(src);
  assert.deepEqual(matches, []);
});
