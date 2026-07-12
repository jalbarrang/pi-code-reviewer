#!/usr/bin/env node

import { cp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const fromIndex = args.indexOf('--from');

if (fromIndex !== -1 && !args[fromIndex + 1]) {
  console.error('Usage: node scripts/sync-canonical.mjs [--from <skill-dir>]');
  process.exit(1);
}

const source = resolve(
  repoRoot,
  fromIndex === -1
    ? (process.env.CODE_REVIEWER_CANONICAL ?? '../skills/code-reviewer')
    : args[fromIndex + 1],
);
const destination = resolve(repoRoot, 'skills/code-reviewer');

await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });

console.log(`Synced ${source} -> ${destination}`);
