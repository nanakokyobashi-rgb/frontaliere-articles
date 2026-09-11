/**
 * Il rilevatore di aggregati multi-item, e il legame fra le sue TRE copie.
 *
 * Un follow-up aggregato non si risolve in un giro: la sua risoluzione e'
 * scaglionata su piu' PR. Tre punti del ciclo devono saperlo, e ognuno paga un
 * prezzo diverso se non lo sa:
 *
 *   - `check-issue-already-resolved.mjs` (`isAggregate`) corto-circuiterebbe il
 *     fixer al PRIMO item risolto, togliendo `agent:fix` e lasciando cadere gli
 *     altri;
 *   - `reconcile-followups.mjs` (`isAggregateTitle`) auto-CHIUDEREBBE la issue
 *     sulla prova di un solo item;
 *   - `harvest-agent-lessons.mjs` (`isAvoidableAlreadyFixed`,
 *     `isAvoidableMaxTurns`) conterebbe come burn "evitabile" un esito che
 *     nessun gate poteva prevenire, gonfiando l'escalation (#560).
 *
 * Fino al #568 tutti e tre leggevano SOLO il titolo: un conteggio esplicito
 * ("N items deferred", N>=2) o le parole `sweep|batch|bulk`. I follow-up
 * multi-item generati senza conteggio nel titolo — item enumerati nel CORPO
 * come sezioni numerate (#374, #505), come lista ordinata con lead in grassetto
 * (#831, #832) o come bullet in grassetto (#466) — non venivano riconosciuti.
 *
 * Questo file e' anche la copertura che AGENTS.md #6 chiede quando una logica
 * condivisa NON puo' essere estratta in un modulo: i tre file sono
 * `mode: identical` nel manifest, quindi la de-duplicazione e' lavoro del sito
 * (una fatta qui viene sovrascritta al mirror successivo). Il legame allora e'
 * un test, nella stessa forma di `ci-check-name.test.mjs`: se una copia di
 * `hasEnumeratedItems` diverge dalle altre, qui diventa rosso.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAggregate, hasEnumeratedItems as fromPreflight } from '../../scripts/ci/check-issue-already-resolved.mjs';
import { isAggregateTitle, hasEnumeratedItems as fromReconcile } from '../../scripts/ci/reconcile-followups.mjs';
import {
  isAvoidableAlreadyFixed, isAvoidableMaxTurns, hasEnumeratedItems as fromHarvest,
} from '../../scripts/ci/harvest-agent-lessons.mjs';
import {
  countBacklogItems,
  countAggregateItems,
  detectBacklogTracker,
  detectWideScopeAggregate,
} from '../../scripts/ci/followup-drainer.mjs';

/** Le tre copie devono concordare: se divergono, il test dedicato sotto lo dice. */
const hasEnumeratedItemsAll = (body) => fromPreflight(body);

/**
 * Le forme reali osservate sulle issue di questo repo, non forme inventate.
 * `aggregate` e' la risposta attesa da `hasEnumeratedItems` sul solo corpo.
 */
const BODIES = Object.freeze({
  // #374 — 5 item, titolo con clausole unite da "+", nessun conteggio.
  numberedSections: {
    aggregate: true,
    title: 'follow-up(#373): gemello sito da portare + retry 8410 sopra cap (blocked) + floor non garantito',
    body: [
      'Da `## Non implementato (ancora)` di #373.',
      '',
      '## 1. Gemello sul sito da portare',
      '',
      'Testo.',
      '',
      '## 2. Il retry resta sopra il cap (8410 vs 8000)',
      '',
      'Altro testo.',
    ].join('\n'),
  },
  // #466 — 3 item come checklist con lead in grassetto, nessun conteggio.
  boldLeadBullets: {
    aggregate: true,
    title: 'follow-up(#450): 4 modelli del bracket 4000 irraggiungibili + 2 rischi non verificati',
    body: [
      'Item residui, non coperti da #454/#460:',
      '',
      '- [ ] **4 modelli del bracket 4000 restano irraggiungibili.** Testo.',
      '- [ ] **Verifica: output-token cap non controllato.** Altro testo.',
    ].join('\n'),
  },
  // #832 — 2 item come lista ordinata con lead in grassetto, nessun conteggio.
  orderedBoldItems: {
    aggregate: true,
    title: 'follow-up(#830): ramo lordo del guardrail che si autodisattiva + soglia stretta',
    body: [
      'Da `## Non implementato (ancora)` di #830.',
      '',
      '1. **Il ramo lordo del guardrail si autodisattiva.** Testo.',
      '2. **Soglia del guardrail `>` stretta.** Altro testo.',
    ].join('\n'),
  },
  // Una procedura numerata SENZA lead in grassetto non enumera item: sono passi.
  numberedSteps: {
    aggregate: false,
    title: 'follow-up(#9): una cosa sola, con una procedura',
    body: '## Come riprodurre\n\n1. Lancia il workflow.\n2. Guarda il log.\n3. Nota il conteggio.',
  },
  // Il caso a UN item: e' il bersaglio vero dei gate e non deve sparire.
  singleItem: {
    aggregate: false,
    title: 'follow-up(#9): il guard di scrittura strippa in silenzio',
    body: [
      '## Scheda',
      '',
      '- CAUSA: una cosa sola.',
      '- FIX: toccare un file.',
      '',
      '## Origine',
      '',
      'Parent: #560.',
    ].join('\n'),
  },
  // Una sola sezione numerata non enumera niente: un item resta un item.
  oneNumberedSection: {
    aggregate: false,
    title: 'follow-up(#9): una cosa sola',
    body: '## 1. La cosa\n\nTesto.',
  },
  // #926 — un item solo, ma il corpo incolla uno snippet markdown: le righe dentro
  // un blocco recintato non sono item della issue. Contarle INVENTA un aggregato,
  // che reconcile non auto-chiude piu' e resta in coda a tempo indefinito.
  fencedSnippet: {
    aggregate: false,
    title: 'follow-up(#9): una cosa sola, con uno snippet citato',
    body: [
      'Il reviewer ha sondato questa forma:',
      '',
      '```markdown',
      '1. **A**',
      '2. **B**',
      '```',
      '',
      'Fine.',
    ].join('\n'),
  },
  // #551/#549 — la forma di lead-titolo piu' comune di questo repo: grassetto che
  // finisce con inline-code e prosegue con testo qualsiasi, nessun conteggio nel
  // titolo e nessuna parola `sweep|batch|bulk`. Un criterio che chiedesse la
  // punteggiatura dentro il grassetto o un separatore dopo la scarterebbe, e
  // `reconcile-followups.mjs` auto-chiuderebbe la issue sulla prova di UN solo item.
  boldInlineCodeLead: {
    aggregate: true,
    title: 'follow-up(#548): due sorgenti da allineare',
    body: [
      '- **`GUIDE_INTENT_RE`** (alimenta il router delle guide) e\' fuori sync.',
      '- **`MIRROR_CARRIED_PREFIXES`** (`mirror.test.mjs:33`) e\' una copia stantia.',
    ].join('\n'),
  },
});

test('hasEnumeratedItems riconosce le forme multi-item senza conteggio nel titolo (#568)', () => {
  for (const [name, c] of Object.entries(BODIES)) {
    assert.equal(fromPreflight(c.body), c.aggregate, `${name}: enumerazione nel corpo`);
  }
});

test('le tre copie di hasEnumeratedItems non sono divergenti (AGENTS.md #6)', () => {
  // I tre file sono `identical` nel manifest e non possono importarsi fra loro:
  // il legame e' questo test. Un corpo su cui le copie non concordano significa
  // che una meta' del ciclo vede un aggregato e l'altra no.
  for (const [name, c] of Object.entries(BODIES)) {
    assert.equal(fromReconcile(c.body), fromPreflight(c.body), `${name}: reconcile diverge dalla pre-flight`);
    assert.equal(fromHarvest(c.body), fromPreflight(c.body), `${name}: harvester diverge dalla pre-flight`);
  }
  assert.equal(fromPreflight.toString(), fromReconcile.toString(),
    'la copia di reconcile-followups.mjs non e\' piu\' identica a quella della pre-flight');
  assert.equal(fromPreflight.toString(), fromHarvest.toString(),
    'la copia di harvest-agent-lessons.mjs non e\' piu\' identica a quella della pre-flight');
});

test('isAggregate non corto-circuita un multi-item enumerato nel corpo (#374, #466, #832)', () => {
  const { numberedSections: a, boldLeadBullets: b, orderedBoldItems: o, singleItem: s } = BODIES;
  assert.equal(isAggregate(a.title, a.body), true, 'sezioni numerate: 5 item, nessun conteggio nel titolo');
  assert.equal(isAggregate(b.title, b.body), true, 'bullet in grassetto: 3 item, nessun conteggio nel titolo');
  assert.equal(isAggregate(o.title, o.body), true, 'lista ordinata in grassetto: 2 item, nessun conteggio nel titolo');
  assert.equal(isAggregate(s.title, s.body), false, 'un follow-up a un solo item resta corto-circuitabile');
});

test('un conteggio CITATO nel corpo non sopprime l\'aggregazione (#926)', () => {
  // La scheda del fixer cita per costruzione il `## Non implementato` del parent.
  // Letto su titolo+corpo, quel «1 item deferred» corto-circuitava a false una issue
  // i cui item sono comunque enumerati sotto: il fixer si sarebbe fermato al primo.
  const body = [
    'Dal `## Non implementato (ancora)` del parent: 1 item deferred.',
    '',
    '## 1. Primo item',
    '',
    'Testo.',
    '',
    '## 2. Secondo item',
    '',
    'Altro testo.',
  ].join('\n');
  const title = 'follow-up(#898): due cose distinte';
  assert.equal(isAggregate(title, body), true, 'il conteggio vale solo se sta nel TITOLO');
  // I due gemelli leggevano gia' il conteggio sul solo titolo: ora concordano.
  assert.equal(isAggregateTitle(title, body), true);
  assert.equal(isAvoidableAlreadyFixed(title, ['follow-up'], body), false);
});

test('un fence non inventa un aggregato (#926)', () => {
  const { fencedSnippet: f } = BODIES;
  assert.equal(isAggregate(f.title, f.body), false, 'le righe recintate non sono item');
  assert.equal(isAggregateTitle(f.title, f.body), false,
    'un aggregato inventato non e\' piu\' auto-chiudibile e resta in coda per sempre');
});

test('il lead in grassetto può chiudersi anche dopo un a capo (#1073 item 2)', () => {
  // Tutte le forme di lead-titolo restano item: chiusura dentro il grassetto,
  // riga intera, separatore dopo il grassetto, inline-code seguito da prosa.
  assert.equal(hasEnumeratedItemsAll('1. **Titolo.** Testo.\n2. **Altro:** Testo.'), true);
  assert.equal(hasEnumeratedItemsAll('- **Titolo**: testo\n- **Altro** — testo'), true);
  assert.equal(hasEnumeratedItemsAll('1. **A**\n2. **B**'), true);
  const multilineLead = '1. **Un titolo che\n continua** resta un item.\n2. **Altro titolo** resta distinto.';
  assert.equal(fromPreflight(multilineLead), true);
  assert.equal(fromReconcile(multilineLead), true);
  assert.equal(fromHarvest(multilineLead), true);
  // #551/#549: grassetto che finisce con inline-code e prosegue con testo qualsiasi.
  const { boldInlineCodeLead: c } = BODIES;
  assert.equal(isAggregate(c.title, c.body), true,
    'due item genuini: un criterio piu\' stretto li renderebbe auto-chiudibili sulla prova di uno solo');
  assert.equal(isAggregateTitle(c.title, c.body), true);
  assert.equal(isAvoidableAlreadyFixed(c.title, ['follow-up'], c.body), false);
  // Il grassetto d'enfasi in mezzo alla prosa non e' separabile lessicalmente da quella
  // forma: conta come item, di proposito. Fa crescere la coda invece di far cadere item.
  assert.equal(hasEnumeratedItemsAll('1. **Solo un item.** e poi\n2. **nota** finale'), true);
  // Il grassetto che NON chiude sulla riga resta fuori.
  assert.equal(hasEnumeratedItemsAll('1. **apertura senza chiusura\n2. **altra apertura'), false);
});

test('il drainer non conta fence indentati e conserva il fallback dei fence aperti (#1073 item 1, 3, 4)', () => {
  const closedFence = [
    '## 1. Item reale',
    '',
    '    ```markdown',
    '    ## 2. Item inventato',
    '    - [ ] voce inventata',
    '    ```',
    '',
    '## 2. Secondo item reale',
  ].join('\n');
  assert.equal(countBacklogItems(closedFence), 2);
  assert.equal(countAggregateItems(closedFence), 2);
  assert.equal(detectBacklogTracker('Backlog dalla sessione', closedFence), false);

  // Un fence aperto non può far sparire il testo che segue: il segmento viene
  // ripristinato grezzo, quindi il conteggio resta conservativo (3, non 1).
  const unclosedFence = [
    '## 1. Primo item',
    '```markdown',
    '## 2. Testo dentro il segmento aperto',
    '## 3. Item successivo da non perdere',
  ].join('\n');
  assert.equal(countBacklogItems(unclosedFence), 3);
  assert.equal(countAggregateItems(unclosedFence), 3);

  const wideBody = [
    '### 1. A',
    '### 2. B',
    '### 3. C',
    '### 4. D',
    '```md',
    '### 5. Finto',
    '```',
  ].join('\n');
  assert.deepEqual(detectWideScopeAggregate('follow-up(#9): 4 items deferred', wideBody), {
    items: 4,
    titleItems: 4,
    bodyItems: 4,
  });
});

test('i tre gemelli restano allineati su conteggio stretto e scope del titolo (#1073 item 5, 6)', () => {
  const proseCount = 'follow-up(#9): 3 items — testo descrittivo';
  assert.equal(isAggregate(proseCount, ''), false);
  assert.equal(isAggregateTitle(proseCount, ''), false);

  const explicitCount = 'follow-up(#9): 3 items deferred — testo descrittivo';
  assert.equal(isAggregate(explicitCount, ''), true);
  assert.equal(isAggregateTitle(explicitCount, ''), true);

  // Parole come `sweep|batch|bulk` nel corpo non trasformano una issue a un
  // solo item in aggregata: il fallback è deliberatamente title-only.
  const singleTitle = 'follow-up(#9): 1 item deferred — batch backfill';
  const keywordBody = 'Il corpo cita sweep, batch e bulk come prosa, non come item.';
  assert.equal(isAggregate(singleTitle, keywordBody), false);
  assert.equal(isAggregateTitle(singleTitle, keywordBody), false);
  assert.equal(isAvoidableAlreadyFixed(singleTitle, ['follow-up'], keywordBody), true);
  assert.equal(isAvoidableMaxTurns(singleTitle, [], false, keywordBody), true);
});

test('il conteggio esplicito nel titolo resta autoritativo sopra il corpo (#3378)', () => {
  // Un item solo, dichiarato, ma con due bullet in grassetto per due sotto-punti
  // dello stesso lavoro: il titolo vince, o si rianima il falso positivo #3378.
  const body = '- **Sotto-punto A.** Testo.\n- **Sotto-punto B.** Testo.';
  assert.equal(isAggregate('follow-up(#9): 1 item deferred', body), false);
  assert.equal(isAggregate('follow-up(#9): 3 items deferred', ''), true);
});

test('reconcile non auto-chiude un aggregato enumerato nel corpo (#568)', () => {
  const { numberedSections: a, singleItem: s } = BODIES;
  assert.equal(isAggregateTitle(a.title, a.body), true,
    'senza questo `closeEligible` puo\' chiudere sulla prova di UN item');
  assert.equal(isAggregateTitle(s.title, s.body), false);
  assert.equal(isAggregateTitle(a.title), false,
    'chiamata senza corpo: il comportamento storico (solo titolo) resta invariato');
});

test('l\'harvester non conta come burn evitabile un aggregato enumerato nel corpo (#560)', () => {
  const FU = ['follow-up'];
  for (const c of [BODIES.numberedSections, BODIES.boldLeadBullets, BODIES.orderedBoldItems]) {
    assert.equal(isAvoidableAlreadyFixed(c.title, FU, c.body), false,
      'un aggregato e\' la conferma attesa della pre-flight, non burn prevenibile');
    assert.equal(isAvoidableMaxTurns(c.title, [], false, c.body), false,
      'un aggregato sfora il budget per costruzione: e\' il bersaglio del circuit-breaker');
  }
  const s = BODIES.singleItem;
  assert.equal(isAvoidableAlreadyFixed(s.title, FU, s.body), true,
    'il follow-up a un solo item resta contato: e\' il segnale vero');
  assert.equal(isAvoidableMaxTurns(s.title, [], false, s.body), true);
});
