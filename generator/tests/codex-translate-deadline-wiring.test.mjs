/**
 * Osservatore del confine della scadenza Codex di create-article (review di
 * #1931).
 *
 * create-article dichiara al tier Codex di free-translate la propria scadenza
 * (`RUN_START_MS + RUN_WALL_BUDGET_MS - 30 s`), perche' il `timeout` del
 * workflow lo uccide a `cap` secondi. Quel tetto e' del PROCESSO CLI: i
 * producer secondari importano il modulo solo per `registerArticleFiles()` e
 * simili, non hanno dichiarato alcun tetto, e installare la scadenza
 * all'import gli faceva ereditare il default di 30 minuti — lane Codex ferma a
 * meta' drenaggio, body non tradotti, superficie scritta comunque.
 *
 * COSA PINNA
 *   #1 nessuna chiamata a livello di modulo: l'import non ha effetti sulla
 *      scadenza (sul commit 253f2f98e fallisce);
 *   #2 la scadenza si installa dentro `if (invokedDirectly) {`, cioe' solo
 *      quando create-article gira come CLI;
 *   #3 `setCodexTranslateProcessDeadline` e' chiamata solo dall'installer e
 *      dalla fermata cooperativa (registrata anch'essa solo nel ramo CLI);
 *   #4 senza dichiarazione il tier non ha scadenza di processo: la deadline
 *      della chiamata resta il tetto di 180 s.
 *
 * Test sul sorgente per necessita': create-article.mjs non e' importabile
 * senza `npm ci` (jsdom), e l'import eseguirebbe comunque il resto del modulo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codexCallDeadlineMs } from '../scripts/lib/free-translate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.resolve(HERE, '../scripts/create-article.mjs'), 'utf-8');

/** Blocco che parte da `anchor` e chiude alla prima `}` in colonna 0. */
function blockFrom(anchor) {
  const a = src.indexOf(anchor);
  assert.notEqual(a, -1, `anchor non trovata — aggiornare questo test: ${anchor}`);
  const rel = src.slice(a).indexOf('\n}\n');
  assert.notEqual(rel, -1, `chiusura non trovata per ${anchor}`);
  return { start: a, end: a + rel + 2, text: src.slice(a, a + rel + 2) };
}

test('#1 nessuna installazione della scadenza a livello di modulo', () => {
  assert.doesNotMatch(src, /^(?:setCodexTranslateProcessDeadline|installCodexTranslateProcessDeadline)\(/m,
    'chiamata in colonna 0: ogni import di create-article eredita la scadenza del processo CLI');
});

test('#2 la scadenza si installa solo nel ramo CLI', () => {
  const cli = blockFrom('if (invokedDirectly) {');
  const calls = [...src.matchAll(/installCodexTranslateProcessDeadline\(\);/g)].map((m) => m.index);
  assert.ok(calls.length >= 1, 'installCodexTranslateProcessDeadline() non e\' mai chiamata');
  for (const at of calls) {
    assert.ok(at > cli.start && at < cli.end, 'installCodexTranslateProcessDeadline() chiamata fuori da `if (invokedDirectly)`');
  }
  const installer = blockFrom('function installCodexTranslateProcessDeadline(');
  assert.match(installer.text, /setCodexTranslateProcessDeadline\(RUN_START_MS \+ RUN_WALL_BUDGET_MS - TRANSLATE_DEADLINE_MARGIN_MS\)/);
});

test('#3 setCodexTranslateProcessDeadline solo nell\'installer e nella fermata cooperativa', () => {
  const allowed = [
    blockFrom('function installCodexTranslateProcessDeadline('),
    blockFrom('function requestCooperativeStop('),
  ];
  const calls = [...src.matchAll(/setCodexTranslateProcessDeadline\(/g)]
    .map((m) => m.index)
    // L'import non e' una chiamata.
    .filter((at) => !src.slice(src.lastIndexOf('\n', at), at).includes('import'));
  assert.ok(calls.length >= 2);
  for (const at of calls) {
    assert.ok(allowed.some((b) => at > b.start && at < b.end),
      `setCodexTranslateProcessDeadline chiamata fuori dai due punti ammessi (offset ${at})`);
  }
  // La fermata cooperativa e' raggiungibile solo dal ramo CLI.
  const cli = blockFrom('if (invokedDirectly) {');
  for (const m of src.matchAll(/process\.on\('SIG(?:TERM|INT)', \(\) => requestCooperativeStop/g)) {
    assert.ok(m.index > cli.start && m.index < cli.end, 'requestCooperativeStop registrata fuori dal ramo CLI');
  }
});

test('#4 senza dichiarazione il tier non ha scadenza di processo', () => {
  const now = Date.now();
  assert.equal(codexCallDeadlineMs({ now, budgetRemainingMs: 300_000 }), now + 180_000);
});
