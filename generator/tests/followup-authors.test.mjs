/**
 * followup-authors.test.mjs — il triage post-merge deve poter vedere le PR di
 * QUESTO repo.
 *
 * `collect-followup-batch.mjs` filtra le PR mergiate per autore. La costante
 * di default è quella del sito (`valerielinc-ops`, `frontaliere-automation`):
 * lasciata così, sul corpus scarterebbe TUTTO — il workflow girerebbe ogni tre
 * ore, non troverebbe mai niente e uscirebbe verde. Nessun errore, nessun
 * follow-up, nessun indizio.
 *
 * L'override vive in `post-merge-followup.yml` come
 * `FOLLOWUP_ELIGIBLE_AUTHORS`. Questo test lega le due cose.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalLogin, parseMergedPRs } from '../../scripts/ci/collect-followup-batch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WF = path.join(ROOT, '.github/workflows/post-merge-followup.yml');

function configuredAuthors() {
  const src = fs.readFileSync(WF, 'utf8');
  const m = src.match(/^\s*FOLLOWUP_ELIGIBLE_AUTHORS:\s*['"]?([^'"\n]+)['"]?\s*$/m);
  return m ? m[1].split(',').map((s) => canonicalLogin(s)).filter(Boolean) : [];
}

test('post-merge-followup dichiara gli autori di questo repo', () => {
  const authors = configuredAuthors();
  assert.ok(
    authors.length > 0,
    'post-merge-followup.yml non imposta FOLLOWUP_ELIGIBLE_AUTHORS: il filtro resterebbe quello del sito e il batch sarebbe sempre vuoto.',
  );
  // Il proprietario del repo deve esserci: le PR umane passano da lì.
  assert.ok(
    authors.includes('nanakokyobashi-rgb'),
    `L'owner del repo non è fra gli autori eleggibili (${authors.join(', ')}): le sue PR non riceverebbero mai triage post-merge.`,
  );
  // E le due automazioni che aprono PR qui: il fixer e il mirror dell'engine.
  for (const bot of ['claude', 'github-actions']) {
    assert.ok(
      authors.includes(bot),
      `\`${bot}\` non è fra gli autori eleggibili: le PR che apre non riceverebbero triage post-merge.`,
    );
  }
});

test('il filtro accetta le forme bot e scarta gli estranei', async () => {
  // `canonicalLogin` normalizza `claude[bot]` e `app/github-actions`: se quella
  // normalizzazione si rompesse, il filtro scarterebbe proprio le PR delle
  // automazioni — cioè la maggioranza di quelle che questo repo produce.
  //
  // L'env va impostato PRIMA del load del modulo: `ELIGIBLE_AUTHORS` è un const
  // di modulo, valutato una volta sola al caricamento. Gli import statici sono
  // hoistati, quindi qui serve un import dinamico — altrimenti il modulo
  // avrebbe già letto il default (gli account del SITO) e il test misurerebbe
  // quello. In produzione non si pone: l'env è nel blocco `env:` dello step,
  // quindi esiste prima che node parta.
  process.env.FOLLOWUP_ELIGIBLE_AUTHORS = configuredAuthors().join(',');
  const { parseMergedPRs } = await import(
    `../../scripts/ci/collect-followup-batch.mjs?authors=${encodeURIComponent(process.env.FOLLOWUP_ELIGIBLE_AUTHORS)}`
  );
  const prs = JSON.stringify([
    { number: 1, title: 'fixer', author: { login: 'claude[bot]' }, mergedAt: '2026-08-06T10:00:00Z', headRefName: 'a' },
    { number: 2, title: 'mirror', author: { login: 'app/github-actions' }, mergedAt: '2026-08-06T10:00:00Z', headRefName: 'b' },
    { number: 3, title: 'estraneo', author: { login: 'qualcun-altro' }, mergedAt: '2026-08-06T10:00:00Z', headRefName: 'c' },
  ]);
  const kept = parseMergedPRs(prs).map((p) => p.number);
  assert.deepEqual(kept, [1, 2], `attese le PR 1 e 2 (bot interni), scartata la 3; ottenute: ${kept}`);
});
