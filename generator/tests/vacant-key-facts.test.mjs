/**
 * Regression gate for the historical empty key-fact rows tracked by #1057.
 *
 * This is intentionally a corpus observer, not a generator fixture: the
 * published body is the source of truth and a future cleanup must not replace
 * a missing fact with an invented value.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BODY_ROOTS = [
  path.join(ROOT, 'content', 'blog-body'),
  path.join(ROOT, 'content', 'blog-body-ch'),
];
const VACANT_KEY_FACT = /(Cosa|Quando|Dove|Chi|Perch[ée]|What|When|Where|Who|Why|Was|Wann|Wo|Wer|Warum|Quoi|Quand|Où|Qui|Pourquoi)\*{0,2}: ?(non specificato|not specified|nicht angegeben|non spécifié)/g;

function bodyFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...bodyFiles(full));
    else if (entry.isFile() && full.endsWith('.ts')) files.push(full);
  }
  return files;
}

test('#1057: nessuna riga di fatto chiave vacua resta nei corpi pubblicati', () => {
  const files = BODY_ROOTS.flatMap(bodyFiles);
  assert.ok(files.length > 1000, 'lo scan non sta leggendo il corpus dei corpi');
  const offenders = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(VACANT_KEY_FACT)) {
      offenders.push({
        file: path.relative(ROOT, file),
        value: match[0],
      });
    }
  }
  assert.deepEqual(offenders, [], 'un fatto mancante non va sostituito con «non specificato»');
});
