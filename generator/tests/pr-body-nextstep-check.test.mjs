/**
 * pr-body-nextstep-check — il gate sul PIANO di completamento (escalation #140).
 *
 * Le fixture NON sono inventate: sono le voci reali delle PR che hanno prodotto
 * il bucket `reviewer-finding/pr-body-contract`. Ogni caso porta il numero della
 * PR da cui viene, cosi' una futura modifica alla soglia si misura contro cio'
 * che il reviewer ha davvero bocciato o approvato, non contro un'intuizione.
 *
 * Questo file e' anche il PRIMO test della famiglia `pr-body-*` su questo repo:
 * il sito ne ha tre (`tests/pr-body-{sections,closes,check-gate}*.test.ts`), il
 * corpus ne aveva zero pur essendo l'unico dei due lati che ESEGUE i moduli
 * condivisi. E' il punto cieco che CLAUDE.md descrive — `loop-drift-check`
 * confronta i file uno per uno e non vede l'assenza di un test da un lato.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkNextStepStates,
  suggestedSection,
  bulletState,
  escapeHatchIn,
  topLevelBullets,
  sectionIsNessuno,
} from '../../scripts/lib/pr-body-nextstep-check.mjs';

const withSection = (bullets) =>
  ['## Implementato', '', '- qualcosa di concreto', '', '## Non implementato (ancora)', '', ...bullets].join('\n');

// ---------------------------------------------------------------------------
// BLOCCANTE: la scappatoia al posto dello stato
// ---------------------------------------------------------------------------

test('blocca la voce che rimanda con «un giro dedicato» (forma reale di #118, diventata il finding di #124)', () => {
  const body = withSection([
    '- **Non è stato censito se altri file abbiano la stessa forma** — una dichiarazione «touch both» ' +
      'scritta su una sola delle due copie. Vale un giro dedicato.',
  ]);
  const res = checkNextStepStates(body);
  assert.equal(res.ok, false);
  assert.equal(res.violations.length, 1);
  assert.equal(res.violations[0].type, 'escape-hatch-instead-of-state');
  assert.equal(res.violations[0].escapeHatch, 'un giro dedicato');
});

test('blocca «è in corso separatamente» (voce 1 di #89, 🟡 del reviewer)', () => {
  const body = withSection([
    "- **Il recupero del deferred work gia' perso non e' automatico.** Vanno rilette a mano; e' in corso separatamente.",
  ]);
  const res = checkNextStepStates(body);
  assert.equal(res.ok, false);
  assert.equal(res.violations[0].escapeHatch, 'separatamente');
});

test('blocca «prima o poi» (voce 2 di #89)', () => {
  const body = withSection([
    "- **`crawler-transient` resta in `selfCreated`**: la doppia sorgente di verita' e' un bordo che prima o poi va scelto.",
  ]);
  assert.equal(checkNextStepStates(body).violations[0].escapeHatch, 'prima o poi');
});

test('blocca le due scappatoie che REVIEW.md §98 nomina alla lettera', () => {
  for (const [text, quote] of [
    ['- La riparazione del sito resta out of scope.', 'out of scope'],
    ['- Il backfill è posposto.', 'posposto'],
  ]) {
    const res = checkNextStepStates(withSection([text]));
    assert.equal(res.ok, false, `«${quote}» doveva bloccare`);
    assert.equal(res.violations[0].escapeHatch, quote);
  }
});

test('il messaggio dice QUALE scappatoia e QUALI stati la sostituiscono', () => {
  const res = checkNextStepStates(withSection(['- Il resto è posposto.']));
  const m = res.violations[0].message;
  assert.match(m, /posposto/);
  assert.match(m, /in questa PR/);
  assert.match(m, /PR concatenata #N/);
  assert.match(m, /blocked: <causa>/);
});

// ---------------------------------------------------------------------------
// Le forme di stato che DEVONO passare — prese dai body approvati dal reviewer
// ---------------------------------------------------------------------------

test('passano i body corretti in risposta alla review (#108 e #124)', () => {
  // #108, tutte e cinque le voci nella forma «Stato: …»
  const pr108 = withSection([
    "- **Il budget token non e' stato misurato.** Stato: blocked — richiede una generazione live, non riproducibile in test.",
    '- **Resta non verificato contro una fonte ufficiale.** Stato: blocked — richiede giudizio umano di dominio.',
    '- **Il fork del sito conserva i difetti.** Stato: blocked — fuori da questo repo, richiede una PR sul sito.',
    "- **Non e' provato end-to-end.** Stato: in questa PR una volta mergiata (azione post-merge, non codice).",
    '- **`Post-pre-spend gate: 0/N`**: Stato: PR concatenata — tracciata in #113, non ancora lavorata.',
  ]);
  assert.equal(checkNextStepStates(pr108).ok, true);
  assert.equal(checkNextStepStates(pr108).advisories.length, 0);

  // #124, la versione post-review: ref di tracciamento, «Nessun lavoro dovuto», «in questa PR»
  const pr124 = withSection([
    "- **Il manifest non ha un grado per «serve e manca»** — la differenza vive nella `reason`. **Issue #126**, che contiene anche il test mancante.",
    '- **`scripts/publish-article-fast.mjs` resta registrato** dalla #118 come coppia. **Nessun lavoro dovuto.**',
    "- **L'audit sulle altre voci: fatto in questa PR.** Tutte e 178 le voci verificate.",
  ]);
  assert.equal(checkNextStepStates(pr124).ok, true);
});

test('scappatoia + decisione: esentata ma VISIBILE, non silenziosa (review #144)', () => {
  // Il messaggio della violazione suggerisce «per scelta»/«by construction» come
  // rimedio. Un fixer che aggiunge la frase SENZA togliere la scappatoia usciva
  // da entrambi i rami: né violation né advisory, la voce passava senza traccia,
  // e il rimedio suggerito diventava un bypass del gate.
  const body = withSection(['- Il backfill è posposto, per scelta: toccare un’edizione indicizzata vale meno del rischio.']);
  const res = checkNextStepStates(body);
  assert.equal(res.ok, true, 'la decisione motivata resta esente: non blocca');
  assert.equal(res.violations.length, 0);
  assert.equal(res.advisories.length, 1, 'ma non deve sparire in silenzio');
  assert.equal(res.advisories[0].type, 'hatch-exempted-by-decision');
  assert.equal(res.advisories[0].escapeHatch, 'posposto');
  assert.match(res.advisories[0].message, /non un rinvio rietichettato/);
});

test('la voce esentata dalla decisione non entra nella sezione riscritta', () => {
  // Ha già uno stato terminale: proporle uno `**Stato:**` direbbe di riparare
  // una cosa che non è rotta.
  const body = withSection(['- Il backfill è posposto, per scelta: vale meno del rischio.']);
  assert.equal(suggestedSection(body), null);
});

test('una decisione motivata non è una scappatoia', () => {
  const body = withSection([
    "- `content/` stays out of scope by construction: la allowlist fail-closed sul diff staged non può nominarlo.",
  ]);
  assert.equal(checkNextStepStates(body).ok, true, 'by construction esenta');
  assert.equal(
    checkNextStepStates(withSection(['- I 28 slug non sono riscritti: è una decisione, non una dimenticanza. Posposto il resto.'])).ok,
    true,
  );
});

test('«Nessuno» da solo chiude la sezione, «Nessun controllo che…» no', () => {
  assert.equal(sectionIsNessuno('\n\nNessuno\n'), true);
  assert.equal(sectionIsNessuno('\n- Nessuno\n'), true);
  // La voce di #89: dichiara una LACUNA, e la parola «Nessun» non deve assolverla.
  assert.equal(sectionIsNessuno('\n- **Nessun controllo che la label esista DAVVERO sul repo**.\n'), false);
  assert.equal(bulletState('- **Nessun controllo che la label esista DAVVERO sul repo**.'), null);
  // Mentre lo stato terminale esplicito passa.
  assert.equal(bulletState('- La voce resta com’è. **Nessun lavoro dovuto.**').id, 'no-work-owed');
});

// ---------------------------------------------------------------------------
// Il ref nudo non è un piano — la distinzione che separava accettati da bocciati
// ---------------------------------------------------------------------------

test('un `#N` di contesto non vale come stato, uno di tracciamento sì', () => {
  // #124: «si ferma a un'analogia con #97» — bocciata dal reviewer
  assert.equal(bulletState("si ferma a un'analogia con #97, senza issue di follow-up"), null);
  // #75: «the sibling issue mentioned in #66 is vague» — bocciata dal reviewer
  assert.equal(bulletState('già coperta dalla sibling issue mentioned in #66 about republishing'), null);
  // Le forme di tracciamento vere
  assert.equal(bulletState('tracciata in **#126**').id, 'tracked-in');
  assert.equal(bulletState('**Issue #126**, che contiene il test mancante').id, 'tracking-ref');
  assert.equal(bulletState('Stato: PR concatenata #113').id, 'tracking-ref');
  assert.equal(bulletState('Stato: blocked — richiede una generazione live').id, 'blocked');
  assert.equal(bulletState('fatto in questa PR').id, 'in-questa-pr');
});

test('«non in questa PR» è la negazione, non lo stato (#862)', () => {
  // La voce che ha prodotto il 🔴 sulla PR #862: dichiarava lavoro ancora
  // dovuto e il gate la leggeva come «già fatta», cioè restava verde proprio
  // sul caso che esiste per prendere.
  assert.equal(bulletState('Stato: non in questa PR'), null);
  assert.equal(bulletState("Stato: non e' in questa PR"), null);
  assert.equal(bulletState('Stato: non ancora in questa PR'), null);
  // L'affermazione resta uno stato.
  assert.equal(bulletState('Stato: in questa PR').id, 'in-questa-pr');
  assert.equal(bulletState('già fatto in questa PR').id, 'in-questa-pr');
});

test('la voce che nega «in questa PR» non passa il gate (#862)', () => {
  const res = checkNextStepStates(
    withSection(['- Lavoro ancora dovuto, descritto per esteso. Stato: non in questa PR.']),
  );
  assert.equal(res.ok, true, 'senza scappatoia resta un avviso, non un blocco');
  assert.equal(res.violations.length, 0);
  assert.equal(res.advisories.length, 1);
  assert.equal(res.advisories[0].type, 'no-literal-state');
  assert.match(suggestedSection(withSection(['- Voce. Stato: non in questa PR.'])), /\*\*Stato:\*\*/);
});

test('`blocked` senza causa non è uno stato', () => {
  assert.equal(bulletState('il lavoro è blocked'), null);
  assert.equal(bulletState('Stato: blocked — quota Anthropic esaurita').id, 'blocked');
});

// ---------------------------------------------------------------------------
// AVVISO: non blocca
// ---------------------------------------------------------------------------

test('la voce senza forma letterale ma senza scappatoia avvisa e NON blocca', () => {
  // #116 voce 1: un piano concreto in prosa, che il reviewer ha accettato.
  const body = withSection([
    "- **La meta' che ripara davvero.** `engine/rssFeeds.mjs` non usa ancora il parametro. Va fatta **sul sito**, " +
      "perche' `engine/` scende da li' via `mirror-articles-engine.yml`.",
  ]);
  const res = checkNextStepStates(body);
  assert.equal(res.ok, true, 'non deve bloccare');
  assert.equal(res.violations.length, 0);
  assert.equal(res.advisories.length, 1);
  assert.equal(res.advisories[0].type, 'no-literal-state');
});

// ---------------------------------------------------------------------------
// L'output ripara: la sezione riscritta
// ---------------------------------------------------------------------------

test('la sezione proposta annota SOLO le voci difettose e lascia intatte le altre', () => {
  const body = withSection([
    '- Prima voce, senza piano. Posposto.',
    '- Seconda voce. Stato: blocked — richiede una generazione live.',
  ]);
  const out = suggestedSection(body);
  assert.match(out, /^## Non implementato \(ancora\)/);
  assert.match(out, /Prima voce, senza piano\. Posposto\. \*\*Stato:\*\*/);
  assert.match(out, /`in questa PR` \| `PR concatenata #N` \| `blocked: <causa esterna reale>`/);
  // la voce già a posto non viene toccata
  assert.match(out, /- Seconda voce\. Stato: blocked — richiede una generazione live\.$/m);
  assert.equal(/Seconda voce.*\*\*Stato:\*\* `in questa PR`/.test(out), false);
});

test('nessuna proposta quando non c’è niente da proporre', () => {
  assert.equal(suggestedSection(withSection(['- Stato: in questa PR.'])), null);
});

// ---------------------------------------------------------------------------
// Confini: non invadere il dominio di checkPrBodySections
// ---------------------------------------------------------------------------

test('sezione assente → nessuna violazione (è dominio di checkPrBodySections)', () => {
  const res = checkNextStepStates('## Implementato\n\n- qualcosa\n');
  assert.deepEqual(res, { ok: true, violations: [], advisories: [] });
});

test('accetta anche l’header senza «(ancora)», così il modulo serve a entrambi i repo', () => {
  const body = '## Implementato\n\n- x\n\n## Non implementato\n\n- Il resto è posposto.\n';
  assert.equal(checkNextStepStates(body).ok, false);
});

test('la sezione si chiude al primo heading di qualunque livello', () => {
  const body = [
    '## Non implementato (ancora)',
    '',
    '- Voce posposta.',
    '',
    '### Dettaglio',
    '',
    '- Questa riga NON è una voce della sezione.',
  ].join('\n');
  const res = checkNextStepStates(body);
  assert.equal(res.violations.length, 1);
  assert.match(res.violations[0].snippet, /Voce posposta/);
});

test('i sotto-bullet appartengono alla voce che li precede', () => {
  const section = '\n- Voce principale senza stato qui.\n  - Stato: in questa PR.\n';
  const bullets = topLevelBullets(section);
  assert.equal(bullets.length, 1);
  assert.equal(bulletState(bullets[0].text).id, 'in-questa-pr');
});

test('i blocchi di codice e i commenti HTML non contano come voci', () => {
  const body = withSection([
    '<!-- - Voce fantasma posposta -->',
    '```markdown',
    '- Esempio posposto nel template',
    '```',
    '- Stato: in questa PR.',
  ]);
  assert.equal(checkNextStepStates(body).ok, true);
});

test('escapeHatchIn è puro e riconosce le forme osservate', () => {
  assert.equal(escapeHatchIn('vale un giro separato'), 'un giro dedicato');
  assert.equal(escapeHatchIn('lo si vedrà più avanti'), 'più avanti');
  assert.equal(escapeHatchIn('resta da valutare'), 'da valutare');
  // L'ordine di `ESCAPE_HATCHES` decide quale nome esce quando ce n'è più d'una:
  // è deterministico, e il messaggio ne cita una sola.
  assert.equal(escapeHatchIn('da valutare in seguito'), 'in seguito');
  assert.equal(escapeHatchIn('con uno stato concreto e nessun rinvio'), null);
});

// ---------------------------------------------------------------------------
// #933 (gemello) — la stessa classe della guardia di `pr-body-closes-check`:
// l'enfasi markdown non è una parola, ma per un lookbehind e per una locuzione
// lo è. Qui il verso costoso è il verde: `**non** in questa PR` dichiara che il
// lavoro NON c'è, e il gate lo leggeva come stato «fatto».
// ---------------------------------------------------------------------------

test('«non in questa PR» resta una negazione anche in grassetto, in codice o con l’accento', () => {
  for (const t of [
    '- Stato: non in questa PR',
    '- Stato: **non** in questa PR',
    '- Stato: `non` in questa PR',
    "- Stato: non e' ancora in questa PR",
    '- Stato: non è in questa PR',
    '- Stato: **non è** in questa PR',
  ]) {
    assert.equal(bulletState(t), null, t);
  }
  // Lo stato affermativo continua a valere, in chiaro e in grassetto.
  assert.equal(bulletState('- Stato: in questa PR')?.id, 'in-questa-pr');
  assert.equal(bulletState('- Stato: **in questa PR**')?.id, 'in-questa-pr');
  assert.equal(bulletState('- Stato: **blocked:** quota')?.id, 'blocked');
});

test('una scappatoia a metà in grassetto resta una scappatoia', () => {
  assert.equal(escapeHatchIn('- Il resto è fuori **scope**'), 'fuori scope');
  assert.equal(escapeHatchIn('- Vale un giro **dedicato**'), 'un giro dedicato');
  assert.equal(escapeHatchIn('- Tutto coperto qui'), null);
});

test('l’esenzione «decisione motivata» legge il testo normalizzato come la scappatoia', () => {
  // Se solo uno dei due lati vedesse l'enfasi, una decisione motivata verrebbe
  // segnalata come rinvio: i due lati della stessa condizione devono leggere lo
  // stesso testo.
  const res = checkNextStepStates(
    withSection(['- Il backfill è **posposto**, per **scelta**: vale meno del rischio.']),
  );
  assert.deepEqual(res.violations, []);
  assert.equal(res.advisories[0]?.type, 'hatch-exempted-by-decision');
});
