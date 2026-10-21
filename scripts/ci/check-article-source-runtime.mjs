#!/usr/bin/env node

import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';

const expectedVersion = '5.8.3';
const configuredEntry = process.env.ARTICLE_SOURCE_TYPESCRIPT;

if (typeof configuredEntry !== 'string' || configuredEntry.trim() === '' || !isAbsolute(configuredEntry)) {
  throw new Error('ARTICLE_SOURCE_TYPESCRIPT must be an absolute path to the pinned TypeScript compiler entry.');
}

const compilerEntry = resolve(configuredEntry);
const require = createRequire(import.meta.url);
const typescript = require(compilerEntry);

if (typescript.version !== expectedVersion) {
  throw new Error(`Expected TypeScript ${expectedVersion} at ARTICLE_SOURCE_TYPESCRIPT, received ${String(typescript.version)} from ${compilerEntry}.`);
}

if (typeof typescript.createSourceFile !== 'function' || typeof typescript.SyntaxKind !== 'object') {
  throw new Error(`TypeScript ${expectedVersion} is missing the compiler API needed by article source readers.`);
}

process.stdout.write(`Article source runtime available: TypeScript ${typescript.version}\n`);
