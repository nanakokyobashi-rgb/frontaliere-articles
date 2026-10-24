/**
 * La voce di `dist/api/articles.json` / `swiss-articles.json` ha ESATTAMENTE i
 * campi dell'allowlist pubblica. Run with `node --test`.
 *
 * IL DIFETTO. `scripts/build-api.mjs` pubblicava la voce del registry con
 * `{ ...article, commit }`: aggiungere `articleType` (campo interno, letto solo
 * dall'audit evergreen) al registry cambiava anche il contratto HTTP verso il
 * sito, senza che nessuno lo decidesse.
 *
 * Diventa rosso quando:
 *   - un campo interno del registry (es. `articleType`, `verifiedAt`, o una
 *     chiave nuova qualsiasi) compare nella voce pubblica;
 *   - `build-api.mjs` torna a copiare la voce con uno spread invece di passare
 *     da `toPublicRegistryEntry`;
 *   - l'allowlist cambia senza aggiornare questo test (cambio di contratto
 *     esplicito, da concordare con i consumatori del sito).
 *
 * Solo builtin `node:` e il modulo della proiezione: gira senza `npm ci`.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PUBLIC_REGISTRY_FIELDS,
  toPublicRegistryEntry,
} from '../../scripts/lib/registry-api-entry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Misurati il 2026-10-04 sull'API pubblicata al commit 50e046f4e
// (articles.json 4125 voci, swiss-articles.json 2552), con il campo di
// provenienza aggiunto esplicitamente dal contratto site #15125.
const EXPECTED_PUBLIC_REGISTRY_FIELDS = [
  'id',
  'category',
  'date',
  'updatedAt',
  'image',
  'hasCalculator',
  'authorSlug',
  'authorName',
  'aiAssisted',
];

describe('voce pubblica del registry (allowlist)', () => {
  test('l\'allowlist espone anche la provenienza dichiarata, non i campi interni', () => {
    assert.deepEqual([...PUBLIC_REGISTRY_FIELDS].sort(), [...EXPECTED_PUBLIC_REGISTRY_FIELDS].sort());
    assert.ok(!PUBLIC_REGISTRY_FIELDS.includes('articleType'));
    assert.ok(!PUBLIC_REGISTRY_FIELDS.includes('verifiedAt'));
    assert.ok(Object.isFrozen(PUBLIC_REGISTRY_FIELDS));
  });

  test('i campi interni del registry non escono nell\'API', () => {
    const registryEntry = {
      id: 'esempio-evergreen',
      category: 'pratico',
      date: '2026-10-04',
      updatedAt: '2026-10-05',
      image: 'https://example.invalid/a.webp',
      hasCalculator: false,
      articleType: 'evergreen',
      verifiedAt: '2026-10-06',
      authorSlug: 'redazione',
      authorName: 'Redazione',
      aiAssisted: false,
      campoInternoFuturo: { qualunque: true },
    };
    const out = toPublicRegistryEntry(registryEntry, 'abc123');
    assert.deepEqual(Object.keys(out).sort(), [...EXPECTED_PUBLIC_REGISTRY_FIELDS, 'commit'].sort());
    assert.equal(out.commit, 'abc123');
    assert.equal(out.id, 'esempio-evergreen');
    assert.equal('articleType' in out, false);
    assert.equal('verifiedAt' in out, false);
    assert.equal('campoInternoFuturo' in out, false);
    assert.equal(out.aiAssisted, false);
    // la voce sorgente non viene toccata
    assert.equal(registryEntry.articleType, 'evergreen');
    assert.equal('commit' in registryEntry, false);
  });

  test('campi opzionali assenti o undefined restano assenti; ordine della sorgente', () => {
    const out = toPublicRegistryEntry(
      { image: 'i', id: 'x', articleType: 'news', category: 'novita', date: '2026-10-04', hasCalculator: true, aiAssisted: false, updatedAt: undefined },
      'c',
    );
    assert.deepEqual(Object.keys(out), ['image', 'id', 'category', 'date', 'hasCalculator', 'aiAssisted', 'commit']);
  });

  test('build-api.mjs pubblica il registry solo tramite la proiezione', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'build-api.mjs'), 'utf8');
    assert.match(src, /import \{ toPublicRegistryEntry \} from '\.\/lib\/registry-api-entry\.mjs'/);
    const mark = src.match(/const markRegistryRelease = [^\n]*/);
    assert.ok(mark, 'markRegistryRelease non trovato in build-api.mjs');
    assert.match(mark[0], /toPublicRegistryEntry\(article, commit\)/);
    assert.doesNotMatch(mark[0], /\.\.\.article/);
    // Dal 2026-10 (C1) i registri pubblicati (articles.json, swiss-articles.json)
    // si scrivono in un loop sulle sezioni del core, sempre via la proiezione.
    assert.match(src, /write\(section\.api\.registry, markRegistryRelease\(SECTION_REGISTRIES\[section\.section\]\)\)/);
    assert.equal((src.match(/write\(section\.api\.registry,/g) ?? []).length, 1, 'un solo writer dei registri pubblicati');
  });
});
