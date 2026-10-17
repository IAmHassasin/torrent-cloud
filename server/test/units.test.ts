import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { resolveInside, sanitizeKeyPath } from '../src/paths.js';
import { checkTorrentBytes, parseMagnet } from '../src/sources.js';
import { LocalStorage } from '../src/storage/local.js';
import { contentDisposition } from '../src/storage/provider.js';

const HASH = 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c';

describe('parseMagnet', () => {
  it('accepts a btih magnet and extracts hash and name', () => {
    expect(parseMagnet(`magnet:?xt=urn:btih:${HASH.toUpperCase()}&dn=Big+Buck+Bunny`)).toEqual({
      infoHash: HASH,
      name: 'Big Buck Bunny',
    });
  });

  it.each([
    'http://example.com/file.torrent',
    'magnet:?dn=no-hash',
    'magnet:?xt=urn:sha1:abc',
    'not a url',
    `magnet:?xt=urn:btih:${HASH}zz`,
  ])('rejects %s', (input) => {
    expect(() => parseMagnet(input)).toThrow();
  });
});

describe('checkTorrentBytes', () => {
  it('accepts a bencoded dict with info', () => {
    expect(() => checkTorrentBytes(Buffer.from('d8:announce3:abc4:infod4:name1:aee'), 1024)).not.toThrow();
  });
  it('rejects empty, oversized and non-torrent data', () => {
    expect(() => checkTorrentBytes(Buffer.alloc(0), 10)).toThrow(/empty/);
    expect(() => checkTorrentBytes(Buffer.from('d4:infodee'), 5)).toThrow(/larger/);
    expect(() => checkTorrentBytes(Buffer.from('<html>'), 1024)).toThrow(/not a valid/);
  });
});

describe('paths', () => {
  it('keeps paths inside the root', () => {
    expect(resolveInside('/downloads/job', '/downloads/job/a/b.txt')).toMatch(/b\.txt$/);
  });
  it.each(['/downloads/other/x', '../x', '/etc/passwd', '/downloads/job'])('rejects %s', (p) => {
    expect(() => resolveInside('/downloads/job', p)).toThrow();
  });
  it('sanitizes key segments', () => {
    expect(sanitizeKeyPath('a/../b\u0001/./c')).toBe('a/_/b_/_/c');
  });
});

describe('redactUrl', () => {
  it('redacts plain and percent-encoded link paths only', () => {
    expect(redactUrl('/files/abc.def')).toBe('/files/[redacted]');
    expect(redactUrl('/%66iles/abc.def')).toBe('/files/[redacted]');
    expect(redactUrl('/v1/jobs')).toBe('/v1/jobs');
    expect(redactUrl('/%E0%A4%A')).toBe('/%E0%A4%A');
  });
});

describe('contentDisposition', () => {
  it('encodes non-ASCII names', () => {
    expect(contentDisposition('naïve "café".mkv')).toBe(
      `attachment; filename="na_ve _caf__.mkv"; filename*=UTF-8''na%C3%AFve%20%22caf%C3%A9%22.mkv`,
    );
  });
});

describe('LocalStorage links', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-local-'));
  const storage = new LocalStorage(root, 'http://localhost:8080/', 'x'.repeat(32));

  it('round-trips a signed link', async () => {
    const url = await storage.link('job/file.bin', 'file.bin', 60);
    expect(url.startsWith('http://localhost:8080/files/')).toBe(true);
    const token = url.split('/files/')[1]!;
    expect(storage.verify(token)).toEqual({ path: join(root, 'job', 'file.bin'), fileName: 'file.bin' });
  });

  it('rejects tampered and expired tokens', async () => {
    const token = (await storage.link('job/file.bin', 'file.bin', 60)).split('/files/')[1]!;
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ k: '../../etc/passwd', n: 'x', e: 9e9 })).toString('base64url');
    expect(storage.verify(`${forged}.${sig}`)).toBeNull();
    expect(storage.verify(`${body}.AAAA`)).toBeNull();
    const expired = (await storage.link('job/file.bin', 'file.bin', -10)).split('/files/')[1]!;
    expect(storage.verify(expired)).toBeNull();
  });
});

describe('loadConfig', () => {
  it('requires a strong API token and does not print values', () => {
    expect(() => loadConfig({ TC_API_TOKEN: 'short-secret', ARIA2_RPC_SECRET: 'y'.repeat(20) })).toThrow(
      /TC_API_TOKEN must be at least 24/,
    );
    try {
      loadConfig({ TC_API_TOKEN: 'short-secret', ARIA2_RPC_SECRET: 'y'.repeat(20) });
    } catch (err) {
      expect(String(err)).not.toContain('short-secret');
    }
  });

  it('requires S3 credentials for the s3 provider', () => {
    expect(() => loadConfig({ TC_API_TOKEN: 'x'.repeat(30), ARIA2_RPC_SECRET: 'y'.repeat(20) })).toThrow(
      /S3_ENDPOINT/,
    );
  });
});
