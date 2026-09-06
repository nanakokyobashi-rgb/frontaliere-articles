/**
 * followup-template-acceptance.test.mjs — il template di `FOLLOWUP.md` deve
 * essere leggibile dall'oracolo che CHIUDE le follow-up, non solo dall'umano.
 *
 * ## Il guasto che pinna, misurato e non ipotetico
 *
 * `scripts/ci/reconcile-followups.mjs` e `scripts/ci/followup-resolution-match.mjs`
 * sono `identical` nel `loop-sync-manifest.json`: quello che il sito ci mette
 * scende qui col mirror, e nessuno lo rinegozia. Il sito ci ha messo il 2026-09-05
 * `aggregateCloseGate()` + `hasFalsifiableAcceptance()`, che decidono se
 * un'aggregata è auto-chiudibile leggendo DUE cose nel corpo della issue:
 *
 *   1. gli heading `### <n>.` — senza, il verdetto è `aggregate-unparsed` e
 *      l'aggregata non si chiude MAI («non so leggerlo» non è «vuoto»);
 *   2. per ogni item, una regione `Suggested action` che cita fra backtick
 *      almeno un token con punteggiatura di codice — senza, `no-valid-item`.
 *
 * Il conio invece sta di qua ed è `adapted`: lo scrive il prompt di
 * `post-merge-followup.yml` seguendo `FOLLOWUP.md`. Fino al 2026-09-06 il
 * `## Output` di `FOLLOWUP.md` diceva soltanto «una sola issue aggregata per
 * PR» e NON dichiarava nessun formato di item. Risultato misurato sulle 227
 * follow-up di questo repo, ogni stato: 201 corpi senza `### <n>.`, 26 con la
 * struttura ma zero item validi, e **0 corpi contenenti la stringa
 * `Suggested action`** — gli item dicevano `Prossimo passo:` (es. #941).
 *
 * Il gate era quindi ARMATO e non ancora scattato: al primo mirror di
 * `reconcile-followups.mjs` ogni singola aggregata del corpus sarebbe diventata
 * non auto-chiudibile. E `followup-reconcile.yml` gira **verde ogni giorno**
 * anche così — il verde conta le run, non gli item — quindi il colore del
 * workflow non avrebbe segnalato niente.
 *
 * ## Perché un test sul documento e non sulle issue
 *
 * Le issue già coniate sono passato: si riscrivono a mano o si lasciano
 * scadere. Quello che va tenuto fermo è la sorgente del conio. Questo test
 * prende il blocco di esempio di `FOLLOWUP.md` e lo passa allo STESSO
 * `citedTokens()` che usa la chiusura: se qualcuno riscrive il template
 * togliendo gli heading, rinominando `Suggested action`, o lasciando l'esempio
 * senza un token fra backtick, la sorgente torna a coniare item che nessuno
 * potrà mai chiudere — e questo test diventa rosso invece di lasciarlo
 * scoprire fra sei mesi a coda piena.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { citedTokens } from '../../scripts/ci/followup-resolution-match.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FOLLOWUP = readFileSync(`${ROOT}FOLLOWUP.md`, 'utf8');
const WORKFLOW = readFileSync(`${ROOT}.github/workflows/post-merge-followup.yml`, 'utf8');

/**
 * Il blocco di esempio, delimitato da un fence a QUATTRO backtick: il template
 * contiene a sua volta dei backtick singoli (sono il punto), quindi un fence a
 * tre si chiuderebbe in mezzo all'esempio.
 */
function templateBlock() {
  const m = FOLLOWUP.match(/^````markdown\n([\s\S]*?)^````$/m);
  assert.ok(m, 'FOLLOWUP.md: manca il blocco ````markdown col template del corpo della issue');
  return m[1];
}

/** Stessa spezzatura di `splitFollowupItems()` in followup-resolution-match.mjs. */
const splitItems = (body) => body.split(/^### \d+\./m).slice(1);

test('il template di FOLLOWUP.md ha la struttura a item che il reconciler sa leggere', () => {
  const items = splitItems(templateBlock());
  assert.ok(
    items.length >= 2,
    `il template deve mostrare almeno due sezioni \`### <n>.\` (trovate ${items.length}): ` +
      'un corpo senza quegli heading vale `aggregate-unparsed` e non si chiude mai',
  );
});

test('ogni item del template porta una condizione di accettazione falsificabile', () => {
  for (const [i, item] of splitItems(templateBlock()).entries()) {
    const n = i + 1;
    // Le due condizioni di `ACCEPTANCE_CONDITION.holds` in
    // followup-resolution-match.mjs. `citedTokens()` è importato da lì — non
    // riscritto qui — perché è quello, e non una copia, a decidere la chiusura.
    assert.match(
      item,
      /^\s*- Suggested action:/m,
      `item ${n}: manca la riga \`- Suggested action:\` (nome del campo letterale: ` +
        '`Prossimo passo:` / `Next step:` non vengono visti)',
    );
    const tokens = citedTokens(item);
    assert.ok(
      tokens.length > 0,
      `item ${n}: la \`Suggested action\` di esempio non cita nessun token di codice fra ` +
        'backtick. Un item cosi\' vale `no-valid-item`: e\' un rischio in prosa, non lavoro ' +
        'verificabile. Serve un token con punteggiatura di codice, es. `markStale()`.',
    );
  }
});

test('il prompt di post-merge-followup.yml rimanda al formato invece di inventarne uno', () => {
  // Il prompt e' `adapted`: puo' divergere dal sito, ma non puo' smettere di
  // nominare il campo, altrimenti il conio torna a scrivere prosa libera.
  assert.match(
    WORKFLOW,
    /Suggested action/,
    'post-merge-followup.yml: il prompt non nomina piu\' `Suggested action` — ' +
      'era esattamente lo stato in cui 227 follow-up su 227 sono nate non chiudibili',
  );
  assert.match(
    WORKFLOW,
    /### <n>\./,
    'post-merge-followup.yml: il prompt non chiede piu\' la struttura `### <n>.`',
  );
});
