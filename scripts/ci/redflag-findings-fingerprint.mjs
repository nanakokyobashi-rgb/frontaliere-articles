#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { REDFLAG_IMPORTANT_RE } from './lib/constants.mjs';

/**
 * Stable identity of the incoming Important findings, independent of review
 * whitespace and ordering. `null` means the body could not be fingerprinted
 * and is deliberately fail-open for the caller.
 */
export function redflagFindingsFingerprint(body) {
  const findings = String(body || '')
    .split(/\r?\n/)
    .filter((line) => {
      REDFLAG_IMPORTANT_RE.lastIndex = 0;
      return REDFLAG_IMPORTANT_RE.test(line);
    })
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .sort();
  if (findings.length === 0) return null;
  return createHash('sha256').update(findings.join('\n')).digest('hex');
}

if (process.argv[1] && process.argv[1].endsWith('redflag-findings-fingerprint.mjs')) {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(chunk);
  process.stdout.write(redflagFindingsFingerprint(chunks.join('')) || 'NULL');
}
