import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

for (const [file, marker] of [
  ['pr-redflag-fixer.yml', 'REDFLAG_FIX_ROUND'],
  ['pr-redcheck-fixer.yml', 'REDCHECK_FIX_ROUND'],
]) {
  test(`${file}: il modello parte solo dopo marker trusted verificato`, () => {
    const source = readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8');
    const trustedAt = source.indexOf('Materialize trusted round-marker helper from main');
    const helperAt = source.indexOf('steps.trusted_marker.outputs.path');
    const markerAt = source.indexOf(`--marker ${marker}`, helperAt);
    const proceedAt = source.indexOf('echo "proceed=true"', markerAt);
    assert.ok(trustedAt >= 0, `${file}: materializzazione trusted assente`);
    assert.ok(source.indexOf('git show "$trusted_sha:scripts/ci/fixer-round-marker.mjs"', trustedAt) > trustedAt,
      `${file}: helper non pinned al main SHA`);
    assert.ok(helperAt > trustedAt && markerAt > helperAt, `${file}: helper marker trusted assente`);
    assert.ok(proceedAt > markerAt, `${file}: proceed=true deve seguire la verifica`);
    assert.match(source.slice(markerAt, proceedAt), /retryable=true/);
    assert.ok(source.indexOf('echo "marker_verified=true"', markerAt) > markerAt,
      `${file}: marker_verified=true assente dopo il read-back`);
    assert.doesNotMatch(source, new RegExp(`gh pr comment[\\s\\S]{0,220}${marker}`));
    const finalVerifyAt = source.indexOf('--verify-current', proceedAt);
    assert.ok(finalVerifyAt > proceedAt, `${file}: verifica finale HEAD/body assente`);
    assert.ok(source.indexOf('if: steps.guard.outputs.proceed == \'true\'', finalVerifyAt) > finalVerifyAt,
      `${file}: finalizzazione Codex non vincolata al guard`);
  });
}
