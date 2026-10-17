import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatBytes, sourceToBody } from '../dist/tc.js';

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GB');
});

test('sourceToBody: magnet is passed through', async () => {
  assert.deepEqual(await sourceToBody('magnet:?xt=urn:btih:abc'), { magnet: 'magnet:?xt=urn:btih:abc' });
});

test('sourceToBody: local .torrent is base64 encoded', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tc-cli-')), 'a.torrent');
  writeFileSync(file, 'd4:infodee');
  assert.deepEqual(await sourceToBody(file), { torrentBase64: Buffer.from('d4:infodee').toString('base64') });
});

test('sourceToBody: missing file fails', async () => {
  await assert.rejects(sourceToBody('nope.torrent'), /File not found/);
});
