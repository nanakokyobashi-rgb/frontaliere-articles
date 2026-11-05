import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const read = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');

test('rebase diagnostics capture Git output and redact generated conflict paths', () => {
  const source = read('scripts/lib/rebase-onto-remote.sh');
  assert.match(source, /git pull --rebase "\$REMOTE" "\$TARGET" >"\$rebase_log" 2>&1/);
  assert.match(source, /conflict_count=.*paths redacted|count=\$conflict_count, paths redacted/);
  assert.match(source, /resolved per-article conflict\(s\).*paths redacted/);
  assert.doesNotMatch(source, /echo[^\n]*\$f/);
  assert.doesNotMatch(source, /echo[^\n]*\$conflicted/);
});

test('post-rebase diagnostics expose counts and categories without candidate identity', () => {
  const source = read('scripts/ci/check-post-rebase-uniqueness.mjs');
  assert.match(source, /new_ids=\$\{newIds\.length\}/);
  assert.doesNotMatch(source, /new_ids=\$\{newIds\.map/);

  const formatStart = source.indexOf('export function formatViolation');
  const formatEnd = source.indexOf('\n}', formatStart);
  assert.ok(formatStart >= 0 && formatEnd > formatStart, 'formatViolation non trovato');
  const format = source.slice(formatStart, formatEnd);
  assert.match(format, /id=\$\{v\.id \? '\[redacted\]'/);
  assert.match(format, /otherId=\[redacted\]/);
  assert.match(format, /slug=\[redacted\]/);
  assert.match(format, /url=\[redacted\]/);
  assert.doesNotMatch(format, /parts\.push\(`topicValue=|v\.slug\}|v\.url\}/);
});

test('corpus scan failures report counts, not article IDs, paths, or values', () => {
  const slugTest = read('generator/tests/article-slug-i18n.test.mjs');
  const echoTest = read('generator/tests/article-source-echo.test.mjs');
  const languageTest = read('generator/tests/wrong-latin-language-adoption.test.mjs');

  assert.doesNotMatch(slugTest, /offenders\.slice\(0,\s*10\).*\.id/);
  assert.doesNotMatch(slugTest, /long\.slice\(0,\s*10\)/);
  assert.doesNotMatch(echoTest, /offenders\.map\(\(o\) => `\$\{o\.file\}/);
  assert.doesNotMatch(languageTest, /offender\.map\(\(\[valore, esito\]\)/);
  assert.doesNotMatch(languageTest, /offender\.map\(\(\{ file, id, campo, value/);
});
