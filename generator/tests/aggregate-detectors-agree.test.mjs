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
 * come sezioni numerate (#374, #505) o come bullet in grassetto (#466) — non
 * venivano riconosciuti.
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

test('isAggregate non corto-circuita un multi-item enumerato nel corpo (#374, #466)', () => {
  const { numberedSections: a, boldLeadBullets: b, singleItem: s } = BODIES;
  assert.equal(isAggregate(a.title, a.body), true, 'sezioni numerate: 5 item, nessun conteggio nel titolo');
  assert.equal(isAggregate(b.title, b.body), true, 'bullet in grassetto: 3 item, nessun conteggio nel titolo');
  assert.equal(isAggregate(s.title, s.body), false, 'un follow-up a un solo item resta corto-circuitabile');
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
  for (const c of [BODIES.numberedSections, BODIES.boldLeadBullets]) {
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
