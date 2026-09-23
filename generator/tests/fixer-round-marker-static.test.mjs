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
    assert.match(source.slice(trustedAt, helperAt), /available=false/,
      `${file}: helper assente non produce stato retryable esplicito`);
    assert.ok(helperAt > trustedAt && markerAt > helperAt, `${file}: helper marker trusted assente`);
    assert.match(source, /--current-round[\s\S]{0,180}--marker/,
      `${file}: cap non calcolato dal helper trusted`);
    assert.doesNotMatch(source, /ROUND=\$\(printf '%s' "\$comments" \| grep -oE '[A-Z]+_FIX_ROUND:/,
      `${file}: cap ancora basato su token body-only`);
    assert.ok(proceedAt > markerAt, `${file}: proceed=true deve seguire la verifica`);
    assert.match(source.slice(markerAt, proceedAt), /retryable=true/);
    assert.ok(source.indexOf('echo "marker_verified=true"', markerAt) > markerAt,
      `${file}: marker_verified=true assente dopo il read-back`);
    assert.doesNotMatch(source, new RegExp(`gh pr comment[\\s\\S]{0,220}${marker}`));
    const finalVerifyAt = source.indexOf('--verify-current', proceedAt);
    assert.ok(finalVerifyAt > proceedAt, `${file}: verifica finale HEAD/body assente`);
    assert.match(source.slice(finalVerifyAt, finalVerifyAt + 700), /--comment-id/,
      `${file}: finalizzazione non lega la prova allo stesso ID del marker`);
    assert.match(source.slice(finalVerifyAt - 500, finalVerifyAt + 700), /EXPECTED_COMMENT_ID/,
      `${file}: ID marker finale non proviene dall'output trusted del POST`);
    const precodexStart = source.lastIndexOf('      - name: ', finalVerifyAt);
    assert.ok(precodexStart >= 0, `${file}: step precodex non trovato`);
    assert.match(source.slice(precodexStart, finalVerifyAt), /continue-on-error:\s*true/,
      `${file}: un mismatch stantio deve arrivare al classificatore senza autorizzare Codex`);
    const supersededAt = source.indexOf('echo "::warning::SUPERSEDED:');
    assert.ok(supersededAt >= 0, `${file}: ramo SUPERSEDED assente`);
    assert.match(source.slice(Math.max(0, supersededAt - 1100), supersededAt + 1600), /--delete-verified/,
      `${file}: cleanup SUPERSEDED non usa la prova trusted dell'ID marker`);
    assert.match(source.slice(Math.max(0, supersededAt - 1100), supersededAt + 1600), /MARKER_COMMENT_ID/,
      `${file}: cleanup SUPERSEDED non usa l'ID restituito dal marker`);
    assert.doesNotMatch(source, /comment_id=\$\(printf '%s' "\$comments_json"/,
      `${file}: cleanup SUPERSEDED seleziona ancora commenti con token body-only`);
    assert.ok(source.indexOf('if: steps.guard.outputs.proceed == \'true\'', finalVerifyAt) > finalVerifyAt,
      `${file}: finalizzazione Codex non vincolata al guard`);
    assert.match(source, /jq -r ['"](?:\([^\n]*\.body|\.body)/,
      `${file}: body revision non usa la fence jq contrattuale`);
    assert.match(source, /printf '%s' "\$marker_result" \| jq -r '\.bodyRevision'/,
      `${file}: estrazione bodyRevision non passa il JSON marker come argomento shell unico`);
    assert.match(source, /printf '%s' "\$marker_result" \| jq -r '\.commentId'/,
      `${file}: estrazione commentId non passa il JSON marker come argomento shell unico`);
    assert.match(source, /--expected-author github-actions\[bot\]/,
      `${file}: l'identita' trusted del token installation non e' esplicita`);
  });
}

test('helper marker: snapshot paginata e prova finale restano fail-closed', () => {
  const helper = readFileSync(path.join(ROOT, 'scripts/ci/fixer-round-marker.mjs'), 'utf8');
  assert.match(helper, /const afterComments = readPr\(repo, pr\)/);
  assert.match(helper, /PR HEAD\/body cambiati durante la lettura paginata/);
  assert.match(helper, /verifyCurrentMarker/);
  assert.match(helper, /legacy\/incompleto/);
  assert.match(helper, /deleteVerifiedMarker/);
  assert.match(helper, /stesso ID\/autore\/body subito prima del modello/);
  assert.match(helper, /TRUSTED_MARKER_ACTOR = 'github-actions\[bot\]'/);
  assert.doesNotMatch(helper, /api', 'user/);
});
