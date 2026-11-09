import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'generator/scripts/repair-plain-excerpts.mjs');

test('il matcher dei meta include la chiusura della chiave prima dei due punti', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  assert.match(
    source,
    /\.\(excerpt\|seoDescription\|ogDescription\)'\\s\*:\\s\*'/,
    'il repair deve riconoscere la forma reale blog.article.<id>.excerpt\':\' <valore>',
  );
  assert.match(source, /if \(\['a', 'b', 'd'\]\.includes\(strategy\) && !isCompleteSourceCandidate\(repaired,/u);
  assert.doesNotMatch(source, /strategy !== 'd' && \['description', 'structuredData\.description', 'seoDescription'\]/u);
  assert.match(source, /SIBLING_DESCRIPTION_FIELDS\.has\(recordSource\.field\)/u);
  assert.match(source, /isSemanticallyCompatibleSibling\(candidate,\s*\{\s*target:\s*value/u);
  assert.ok(
    source.indexOf('isCompleteSourceCandidate(repaired') < source.indexOf('assertPlainExcerpt(repaired'),
    'i candidati testuali vanno scartati prima dell’assert finale e della scrittura',
  );
  assert.match(source, /assertPlainExcerpt\(repaired,\s*\{\s*\.\.\.context,\s*body\s*\}\)/u);
});

test('il repair SEO registra i C0 dalla sorgente subito prima dello snapshot', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  assert.match(source, /import \{ reportStrippedControlChars \} from '\.\/lib\/control-char-write-report\.mjs';/u);
  assert.match(source, /import \{ sanitizeText \} from '\.\.\/\.\.\/scripts\/lib\/sanitize-control-chars\.mjs';/u);
  assert.match(
    source,
    /function atomicWrite\(file, before, after\) \{\s*const clean = sanitizeText\(after\);\s*reportStrippedControlChars\(file, after, clean\);\s*assertDecodedSeoStringsAreSafe\(file, after\);\s*writeFileSnapshotAtomically\(file, before, clean\);\s*\}/u,
  );
});

test('il repair SEO controlla i C0 escapati dopo il decode di structuredData', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  assert.match(
    source,
    /function assertDecodedStructuredDataIsSafe\(file, source\) \{[\s\S]*reportDecodedStringIsSafe\(file, match\[2\], '"'\);/u,
  );
  assert.match(
    source,
    /function assertDecodedSeoStringsAreSafe\(file, source\) \{[\s\S]*description\|ogDescription[\s\S]*reportDecodedStringIsSafe\(file, match\[1\], "'"\);[\s\S]*assertDecodedStructuredDataIsSafe\(file, source\);/u,
  );
  assert.match(
    source,
    /function atomicWrite\(file, before, after\) \{[\s\S]*assertDecodedSeoStringsAreSafe\(file, after\);[\s\S]*writeFileSnapshotAtomically\(file, before, clean\);/u,
  );
});

test('il repair storico include i chunk SEO cantonali e conserva solo i casi c', () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.files >= 24, 'il report deve includere i chunk SEO cantonali');
  assert.equal(report.changedValues, 0, 'lo sweep deve essere già stato scritto nel corpus');
  assert.equal(report.needsRepairValues, report.byStrategy.c, 'restano solo casi non riparabili automaticamente');
  assert.ok(report.nonRepairable.every((item) => item.before === item.after));
});
