#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const expectedCommit = process.env.HUB_REFRESH_COMMIT || '';
if (!/^[0-9a-f]{40}$/.test(expectedCommit)) {
  process.stderr.write('HUB_REFRESH_COMMIT non valido; rifiuto il push con receipt\n');
  process.exit(1);
}

let currentHead = '';
try {
  currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  process.stderr.write('HEAD non leggibile; rifiuto il push con receipt\n');
  process.exit(1);
}

if (currentHead !== expectedCommit) {
  process.stderr.write(`HEAD rebased (${currentHead}) diverso dal commit autenticato (${expectedCommit}); rifiuto il push\n`);
  process.exit(1);
}
process.stdout.write(`receipt commit invariato: ${currentHead}\n`);
