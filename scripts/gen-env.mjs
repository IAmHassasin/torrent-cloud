#!/usr/bin/env node
// Creates .env from .env.example with freshly generated random secrets.
// Refuses to overwrite an existing .env unless --force is passed.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, '.env');
const force = process.argv.includes('--force');

if (existsSync(target) && !force) {
  console.error('.env already exists. Use --force to regenerate it.');
  process.exit(1);
}

const secret = (bytes = 24) => randomBytes(bytes).toString('base64url');
const generated = {
  TC_API_TOKEN: secret(32),
  ARIA2_RPC_SECRET: secret(32),
  S3_ACCESS_KEY_ID: `tc${randomBytes(8).toString('hex')}`,
  S3_SECRET_ACCESS_KEY: secret(30),
  LOCAL_LINK_SECRET: secret(32),
};

const lines = readFileSync(join(root, '.env.example'), 'utf8')
  .split(/\r?\n/)
  .map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    return match && match[1] in generated ? `${match[1]}=${generated[match[1]]}` : line;
  });

writeFileSync(target, lines.join('\n'), { mode: 0o600 });
console.log(`Wrote ${target}. Your API token is in TC_API_TOKEN.`);
