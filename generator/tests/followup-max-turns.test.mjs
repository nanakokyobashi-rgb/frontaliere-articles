/**
 * followup-max-turns.test.mjs — il tetto di `maxTurnsFor` non deve tornare a
 * sabotare i batch grandi (issue #170).
 *
 * `post-merge-followup.yml` triagia in una sessione Claude sola tutte le PR
 * mergiate dalla finestra precedente: `--max-turns` è proporzionato al numero
 * di PR (`26 + 8*n`) perché il lavoro reale scala con n. Un tetto troppo
 * basso vanifica quella proporzionalità per ogni batch che lo supera — e con
 * un backlog (quota esaurita, bwrap rotto) i batch REALMENTE osservati sono
 * arrivati a 30 PR. La run 31380568598 (batch_count=11, formula non troncata
 * = 114) ha consegnato tutte le 11 PR in 113 turni ma è stata marcata
 * failure perché il tetto storico (80) l'aveva già troncata a 80.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maxTurnsFor } from '../../scripts/ci/collect-followup-batch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WF = path.join(ROOT, '.github/workflows/post-merge-followup.yml');

test('maxTurnsFor: floor 26, mai sotto (AGENTS.md vieta di abbassare i turni)', () => {
  assert.equal(maxTurnsFor(0), 26);
  assert.equal(maxTurnsFor(1), 34);
});

test('maxTurnsFor: scala proporzionalmente al batch fino al tetto', () => {
  // Il batch reale che ha innescato la #170: 11 PR, formula non troncata 114,
  // consegnate davvero in 113 turni — il tetto deve lasciarla passare intera.
  assert.equal(maxTurnsFor(11), 26 + 8 * 11);
  assert.equal(maxTurnsFor(20), 26 + 8 * 20);
});

test('maxTurnsFor: il tetto resta un backstop anti-runaway, non un pavimento silenzioso a n=7', () => {
  // A n=7 la formula non troncata (82) superava già il vecchio tetto (80): un
  // batch di 7 PR — tutt'altro che anomalo per una finestra di 3h dopo un
  // backlog — bastava a innescare la stessa classe di fallimento osservata.
  // Il nuovo tetto deve lasciare passare la formula ben oltre quella soglia.
  assert.equal(maxTurnsFor(7), 26 + 8 * 7, 'un batch di 7 PR non deve più toccare il tetto');
  assert.ok(maxTurnsFor(26) < 240, 'la formula deve restare non troncata fino ad almeno 26 PR');
  // Il tetto esiste ancora, per batch davvero anomali.
  assert.equal(maxTurnsFor(1000), 240);
});

test('workflow_dispatch: il fallback letterale "max_turns=34" resta allineato a maxTurnsFor(1)', () => {
  // post-merge-followup.yml calcola max_turns inline per il path
  // workflow_dispatch (batch di 1 PR, nessun subprocess node) invece di
  // chiamare questa funzione — il commento lì dichiara l'allineamento, questo
  // test lo dimostra: se la formula cambia senza aggiornare lo YAML, questo
  // test rompe invece di lasciare i due lati a divergere in silenzio.
  const src = fs.readFileSync(WF, 'utf8');
  const m = src.match(/max_turns=(\d+)"?\s*#\s*=\s*maxTurnsFor\(1\)/);
  assert.ok(m, 'post-merge-followup.yml non ha più il fallback letterale "max_turns=<n> # = maxTurnsFor(1)" atteso');
  assert.equal(Number(m[1]), maxTurnsFor(1));
});
