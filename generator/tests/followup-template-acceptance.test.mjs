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

import { citedTokens, isDistinctiveToken } from '../../scripts/ci/followup-resolution-match.mjs';

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
        'verificabile. Serve un token con punteggiatura di codice, es. `nomeFunzione()`.',
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

test('il prompt non ammette item sotto una barra piu\' bassa di quella che li chiude', () => {
  // Passo 2 di #953. Il conio e la chiusura devono misurare la stessa cosa:
  // ammettere un item che nessun check potra' mai dichiarare fatto lo mette in
  // coda per sempre. La regola vive SOLO nel prompt — `post-merge-followup.yml`
  // e' `adapted`, quindi non scende col mirror e nessun drift check la porta.
  assert.match(
    WORKFLOW,
    /no-acceptance-condition/,
    'post-merge-followup.yml: sparito l\'hard-exclude `no-acceptance-condition`. ' +
      'Senza, un rischio in sola prosa torna a diventare un item che nessuna ' +
      'evidenza potra\' chiudere (issue #953).',
  );
  assert.match(
    WORKFLOW,
    /citedTokens\(\)/,
    'post-merge-followup.yml: la regola non nomina piu\' `citedTokens()`. E\' il ' +
      'punto della regola: conio e chiusura devono usare LO STESSO oracolo, non ' +
      'una sua parafrasi in prosa.',
  );
  // Il quarto hard-exclude deve avere la sua sezione come gli altri tre: il
  // prompt la cita per nome, e un rimando che punta al vuoto e' come non averlo
  // (era lo stato di `## Output` prima di #993).
  assert.match(
    FOLLOWUP,
    /^### Hard-exclude: rischio senza condizione di accettazione$/m,
    'FOLLOWUP.md: manca la sezione del quarto hard-exclude, che il prompt cita per nome',
  );
});

test('la regola misura la Suggested action, non il bullet grezzo', () => {
  // Il divario che questa clausola chiude, dimostrato con le funzioni vere:
  // su un testo senza la regione `Suggested action` l'oracolo ricade
  // sull'INTERO testo, quindi un token che finira' in `Original text` — che la
  // chiusura esclude per costruzione — ammetterebbe un item gia' non
  // chiudibile. Ammettere piu' largo di quanto si libera e' la costruzione che
  // genera la coda immortale, cioe' proprio cio' che la regola combatte.
  const bulletGrezzo = 'Nessun controllo impedisce che `manifest.counts` resti stale.';
  const itemConiato = [
    '- Original text:',
    '  > Nessun controllo impedisce che `manifest.counts` resti stale.',
    '- Suggested action: aggiungere un controllo esplicito, da decidere dove',
  ].join('\n');
  assert.ok(citedTokens(bulletGrezzo).length > 0, 'premessa: il bullet grezzo sembra citare un token');
  assert.equal(
    citedTokens(itemConiato).length,
    0,
    'premessa: una volta coniato quel token vale zero, perche\' vive in `Original text`',
  );
  assert.match(
    WORKFLOW,
    /`Suggested action` CHE STAI PER SCRIVERE/,
    'post-merge-followup.yml: sparita la clausola che ancora il metro alla ' +
      '`Suggested action` invece che al bullet grezzo. Senza, il conio torna a ' +
      'misurare col fallback whole-body e ammette item che la chiusura leggera\' ' +
      '`no-valid-item`.',
  );
});

/**
 * Ogni esempio di token che la documentazione o il prompt offrono deve passare
 * l'oracolo VERO. Sembra pedanteria e non lo e': gli esempi sono la cosa che un
 * modello copia letteralmente, quindi un esempio che non qualifica conia item
 * che la chiusura leggera' `no-valid-item` — cioe' riapre l'asimmetria
 * ammissione/chiusura proprio nella riga che la dichiara chiusa.
 *
 * E' successo due volte in questa stessa PR, in entrambi i casi su regole «non
 * ovvie» che a occhio sembrano giuste: `percorso/file.mjs` e `nomeCampo`
 * (rifiutati come bare path e bare identifier) nel prompt, e `recordScore:
 * false` nel template — quest'ultimo era passato inosservato anche alla review,
 * perche' `:` seguito da spazio non e' `:\d`. Il controllo a occhio non regge:
 * qui l'esempio viene ESEGUITO.
 *
 * Contratto: gli esempi si dichiarano dopo il marcatore letterale
 * `token-esempio:` e valgono fino alla fine della parentesi o della riga.
 */
const TOKEN_EXAMPLE_SOURCES = [
  ['FOLLOWUP.md', FOLLOWUP],
  ['.github/workflows/post-merge-followup.yml', WORKFLOW],
];

/**
 * I CONTROesempi sono l'altra meta' della rete, e servono per una ragione
 * asimmetrica: il test sugli esempi verifica che cio' che il prompt offre
 * qualifichi, ma non impedisce al prompt di INDURRE forme che non qualificano.
 * `isDistinctiveToken()` rifiuta per tre ragioni — bare path, bare identifier e
 * `s.length < 6` — e la terza e' invisibile a occhio: `run()`, `sha()`, `f()` e
 * `a.b` hanno tutti la forma giusta e valgono `false`. Fra i corti passa solo
 * `n >= 1`, che nessuno scrive spontaneamente. Un token DERIVATO — proprio quelli
 * che la clausola DERIVALO chiede di costruire — di forma corretta ma breve
 * conia un `no-valid-item`.
 *
 * Un controesempio che smette di essere tale (perche' qualcuno lo "corregge"
 * in una forma valida) svuota l'avvertimento senza che nessuno se ne accorga:
 * per questo anche i controesempi vengono ESEGUITI, e devono fallire.
 */
function declaredTokenCounterExamples(text) {
  const out = [];
  for (const m of text.matchAll(/token-controesempio:((?:\s*`[^`]+`\s*,?)+)/g)) {
    for (const t of m[1].matchAll(/`([^`]+)`/g)) out.push(t[1]);
  }
  return out;
}

function declaredTokenExamples(text) {
  const out = [];
  // La lista finisce dove finisce la FORMA di una lista: span fra backtick
  // separati solo da virgole/spazi. Delimitarla su `)` non funziona — la prima
  // parentesi chiusa e' quella di `funzione()`, dentro il primo esempio.
  for (const m of text.matchAll(/token-esempio:((?:\s*`[^`]+`\s*,?)+)/g)) {
    for (const t of m[1].matchAll(/`([^`]+)`/g)) out.push(t[1]);
  }
  return out;
}

test('ogni token-esempio dichiarato passa davvero isDistinctiveToken()', () => {
  let total = 0;
  for (const [label, text] of TOKEN_EXAMPLE_SOURCES) {
    const examples = declaredTokenExamples(text);
    assert.ok(
      examples.length > 0,
      `${label}: nessun \`token-esempio:\` dichiarato — se gli esempi esistono ma non ` +
        'portano il marcatore, questo test non li vede e la rete si apre in silenzio',
    );
    for (const ex of examples) {
      assert.ok(
        isDistinctiveToken(ex),
        `${label}: l'esempio \`${ex}\` NON passa isDistinctiveToken(). Un item coniato ` +
          'copiandolo nascerebbe `no-valid-item`. Qualificano solo le forme con ' +
          'punteggiatura di codice: chiamata `f()`, dot-member `a.b`, confronto `n >= 1`.',
      );
      total++;
    }
  }
  assert.ok(total >= 6, `attesi almeno 6 esempi dichiarati, trovati ${total}`);
});

test('`Suggested action` resta l\'ULTIMO campo di ogni item del template', () => {
  // Adversarial check della review su 3d42bc271: `suggestedActionText()` chiude
  // la regione solo su `#{2,3}\s`, `- Source:`, `- Original text:` e
  // `- Funnel impact:`. `- Rationale:` e `- Stato dichiarato nella PR:` NON
  // sono terminatori, quindi se un giro futuro riordinasse i campi la regione
  // assorbirebbe quelli che seguono e la CHIUSURA conterebbe token che
  // l'ammissione non ha giudicato: di nuovo due barre diverse, stavolta con la
  // chiusura piu' larga. Finche' `Suggested action` e' ultimo il rischio non
  // esiste — e questo test e' l'ancoraggio che finora mancava.
  const m = FOLLOWUP.match(/^````markdown\n([\s\S]*?)^````$/m);
  assert.ok(m, 'FOLLOWUP.md: manca il blocco del template');
  for (const [i, item] of m[1].split(/^### \d+\./m).slice(1).entries()) {
    const fields = [...item.matchAll(/^\s*- ([A-Z][^:\n]*):/gm)].map((x) => x[1]);
    assert.equal(
      fields.at(-1),
      'Suggested action',
      `item ${i + 1}: l'ultimo campo e' \`${fields.at(-1)}\`, non \`Suggested action\`. ` +
        'Ordine dei campi: ' + fields.join(' → '),
    );
  }
});

test('ogni token-controesempio dichiarato viene davvero RIFIUTATO dall\'oracolo', () => {
  let total = 0;
  for (const [label, text] of TOKEN_EXAMPLE_SOURCES) {
    const counter = declaredTokenCounterExamples(text);
    assert.ok(
      counter.length >= 3,
      `${label}: attesi almeno 3 \`token-controesempio:\` (bare path, bare identifier, ` +
        `token corto), trovati ${counter.length}. La terza ragione di rifiuto ` +
        '(`s.length < 6`) e\' quella che un lettore non vede, e senza il suo ' +
        'controesempio il prompt torna a indurre `run()` al posto di `nomeFunzione()`.',
    );
    for (const ex of counter) {
      assert.equal(
        isDistinctiveToken(ex),
        false,
        `${label}: il controesempio \`${ex}\` in realta' PASSA isDistinctiveToken(). ` +
          'Un controesempio valido non avverte di niente: o e\' sbagliato, o la ' +
          'soglia dell\'oracolo e\' cambiata e il testo va riscritto.',
      );
      total++;
    }
  }
  assert.ok(total >= 6, `attesi almeno 6 controesempi dichiarati, trovati ${total}`);
});
