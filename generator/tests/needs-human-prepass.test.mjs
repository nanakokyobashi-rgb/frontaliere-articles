/**
 * needs-human-prepass.test.mjs — la metà deterministica dello sweep `needs-human`.
 *
 * Il difetto che chiude, misurato il 2026-08-25: `needs-human` è ASSORBENTE su
 * questo repo — zero workflow sotto `.github/workflows/` nomina `needs-human` o
 * `vision`. Sono **17 issue aperte**, la più ferma dal 2026-08-18, mentre nello
 * stesso istante la coda del ciclo è VUOTA (`agent:fix-queued` 0, `agent:fix` 0,
 * PR aperte 0) con ~105 PR mergiate nei 7 giorni precedenti. Il fixer girava a
 * vuoto mentre 17 issue erano parcheggiate dove nessuno le andava a prendere.
 *
 * Il pre-pass le rimette in coda a costo zero. Questo test difende le due cose
 * che possono farlo sbagliare in modo costoso: ri-accodare ciò che è del
 * proprietario, e scorporare ciò che non è un aggregato.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepassDecision,
  latestVerdict,
  MONITOR_TITLE_PATTERNS,
  OWNER_ONLY_TITLE_PATTERNS,
  STALE_BLOCK_VERDICTS,
  needsVerdictLookup,
} from '../../scripts/ci/needs-human-prepass.mjs';

// ── Le famiglie riconosciute sono QUELLE DI QUESTO REPO ────────────────────
// Non sono copiabili dal sito: i titoli li scrivono i monitor di qui. Ogni voce
// cita nel sorgente il file che la produce.

for (const title of [
  'Workflow Failure: Generate Blog Article', //          scan-failed-runs.mjs (#249, reale)
  'Workflow Failure: Post-merge follow-up triage', //     scan-failed-runs.mjs (#170, reale)
  'CI Failure: tests', //                                 close-recovered-failure-issues.mjs
  'Crawler Failure: Update Coop', //                      github-issue-creator.mjs
  'follow-up(#386): tetto TESTIMONE_GIRI_MAX', //         post-merge-followup.yml (#404, reale)
  'Watchdog generazione: nessun articolo da nessuna sezione', // scan-generation-health.mjs
  'Watchdog generazione, sezione frontaliere: pool evergreen saturo',
  'Watchdog news-ticker: articoli shadowed da canonical-override', // ticker-shadow-alert.mjs
  'Roster LLM invecchiato: 8 modelli non rispondono', //  scan-generation-health.mjs
  'Loop drift: il ciclo autonomo diverge dal sito', //    loop-drift-check.mjs
  'gate content su main: offender nel corpus generato dai bot', // content-gates-main.mjs
  'Lockstep engine incagliata: il mirror non chiude', //  lockstep-stall-watch.mjs
]) {
  test(`famiglia di monitor riconosciuta → requeue: ${title.slice(0, 48)}`, () => {
    assert.equal(prepassDecision({ title }).action, 'requeue');
  });
}

// ── La famiglia CREDENZIALI è owner-only, e non è un dettaglio ─────────────

test('la famiglia PAT resta al proprietario, non si ri-accoda', () => {
  // È aperta da un nostro monitor con prefisso stabile, quindi cadrebbe
  // naturalmente nell'allowlist ragionando «è un nostro script, è tecnica». Ma
  // una rotazione di credenziale non è codice, il proprietario l'ha DECLINATA il
  // 2026-08-18, e quando quell'alert è acceso il fixer non ha il PAT: ri-accodarla
  // è futile per costruzione. Il sito non ha questa classe perché instrada la sua
  // identità con una GitHub App.
  for (const title of [
    'Agent loop down: GITHUB_PAT failed to load',
    'GH_PAT expiry warning: rotate the Remote Config PAT',
  ]) {
    const d = prepassDecision({ title });
    assert.equal(d.action, 'keep', title);
    assert.match(d.reason, /proprietario/i);
  }
});

test('la famiglia PAT batte anche un verdetto superato', () => {
  // L'ordine conta: un `blocked-secrets` registrato da un fixer che è passato di
  // lì non trasforma una rotazione di credenziale in lavoro normale.
  assert.equal(prepassDecision({
    title: 'Agent loop down: GITHUB_PAT failed to load', verdict: 'blocked-secrets',
  }).action, 'keep');
});

// ── Ciò che NON deve toccare ───────────────────────────────────────────────

for (const title of [
  'Il drenaggio C0 ha tolto il byte ma non la corruzione: 18 pagine live su 27', // #94
  'Handoff generazione articoli 2026-08-19/20: split verificato, haiku diagnosticato', // #517
  'FAQ: writer valida >=1 coppie ma l\'engine ne pretende >=2', // #396
  'breaker timeout per-provider: 8 modelli nvidia pagano 900s prima di tacere', // #458
]) {
  test(`titolo non generato da un monitor → keep: ${title.slice(0, 44)}`, () => {
    // Sono issue REALI di questo repo. Il default `keep` non è un ramo di errore:
    // significa «non so dirlo senza giudizio», ed è il run Claude a darlo.
    assert.equal(prepassDecision({ title }).action, 'keep');
  });
}

test('un tracker permanente resta dov\'è', () => {
  assert.equal(prepassDecision({
    title: 'Workflow Failure: Generate Blog Article', labels: ['agent:no-age-out'],
  }).action, 'keep');
});

for (const label of ['agent:fix', 'agent:fix-queued', 'agent:decompose', 'agent:decompose-queued', 'agent:in-progress']) {
  test(`già in lavorazione (${label}) → keep, mai un doppio instradamento`, () => {
    assert.equal(prepassDecision({ title: 'CI Failure: tests', labels: [label] }).action, 'keep');
  });
}

test('il default è keep, anche su input vuoto', () => {
  assert.equal(prepassDecision({}).action, 'keep');
  assert.equal(prepassDecision({ title: 'qualcosa che nessuno ha previsto' }).action, 'keep');
});

// ── Aggregati: il rilevatore è CONDIVISO, e legge il solo titolo ───────────

test('un container che DICHIARA il conteggio si scorpora', () => {
  assert.equal(
    prepassDecision({ title: 'follow-up(#6205): 3 items deferred — REST files-cap' }).action,
    'decompose',
  );
});

test('una follow-up singola si ri-accoda, non si scorpora', () => {
  assert.equal(prepassDecision({ title: 'follow-up(#6100): rimisura la soglia' }).action, 'requeue');
});

test('il body NON entra nella decisione: era un falso aggregato misurato', () => {
  // Misurato il 2026-08-25 sulle 17 `needs-human` reali: passando anche il body a
  // `isAggregate`, TRE issue finivano in `decompose` per la sola parola «batch»
  // capitata nel testo, senza che nessuna dichiarasse un conteggio — #170
  // («Workflow Failure: Post-merge follow-up triage», 662 caratteri, UN singolo
  // guasto), #407 e #403 (~4.700 caratteri l'una).
  //
  // Il fallback a parole chiave di `isAggregate` (`sweep|batch|bulk`) esiste per
  // i titoli che non dichiarano un conteggio («Sweep: ~30 crawlers»), e su un
  // body lungo è rumore. Se questa firma tornasse ad accettare un body, il test
  // fallirebbe qui invece che in produzione.
  const d = prepassDecision({
    title: 'Workflow Failure: Post-merge follow-up triage',
    body: 'il drainer processa il batch e poi si ferma', // ignorato per costruzione
  });
  assert.equal(d.action, 'requeue');
});

// ── Verdetti superati ──────────────────────────────────────────────────────

test('blocked-secrets → requeue (decisione del proprietario, 2026-08-24)', () => {
  // Il verdetto descriveva una configurazione — il fixer senza credenziali — non
  // un limite. `issue-fix.yml` di questo repo carica Remote Config prima del run
  // Claude, quindi la issue è lavoro normale.
  const d = prepassDecision({ title: 'una cosa qualunque', verdict: 'blocked-secrets' });
  assert.equal(d.action, 'requeue');
  assert.match(d.reason, /secret/i);
});

test('gli altri verdetti di blocco NON sono superati', () => {
  // `blocked-workflows-scope` dipende dal fatto che GITHUB_PAT_NANAKO sia stato
  // caricato in QUEL run: è una condizione runtime, non una decisione superata.
  for (const v of ['blocked-workflows-scope', 'blocked-admin-settings', 'no-root-cause', 'max-turns']) {
    assert.equal(STALE_BLOCK_VERDICTS.has(v), false, v);
    assert.equal(prepassDecision({ title: 'una cosa qualunque', verdict: v }).action, 'keep', v);
  }
});

test('le label di lavorazione battono il verdetto', () => {
  assert.equal(prepassDecision({
    title: 'una cosa qualunque', labels: ['agent:fix'], verdict: 'blocked-secrets',
  }).action, 'keep');
});

// ── latestVerdict ──────────────────────────────────────────────────────────

test('latestVerdict legge created_at (REST) e createdAt (GraphQL), vince il più recente', () => {
  assert.equal(latestVerdict([
    { body: '<!-- FIX_OUTCOME: no-root-cause -->', created_at: '2026-08-19T10:00:00Z' },
    { body: '<!-- FIX_OUTCOME: blocked-secrets -->', createdAt: '2026-08-22T10:00:00Z' },
  ]), 'blocked-secrets');
});

test('latestVerdict: null senza marker, e tollera input vuoto', () => {
  assert.equal(latestVerdict([{ body: 'solo testo' }]), null);
  assert.equal(latestVerdict([]), null);
  assert.equal(latestVerdict(null), null);
});

// ── L'allowlist è un contratto, non un'euristica ───────────────────────────

test('ogni pattern è ancorato all\'inizio del titolo', () => {
  // I prefissi li scrive un nostro script e fanno parte del contratto di dedup
  // sul titolo canonico (taglio a 60 caratteri, `DEDUP_TITLE_PREFIX_LEN` in
  // `scripts/lib/github-issue-creator.mjs`). Un pattern non ancorato matcherebbe
  // a metà frase, e una issue che CITA un guasto verrebbe ri-accodata.
  for (const re of [...MONITOR_TITLE_PATTERNS, ...OWNER_ONLY_TITLE_PATTERNS]) {
    assert.equal(re.source.startsWith('^'), true, re.source);
  }
});

test('un titolo che NOMINA un guasto senza esserne uno resta keep', () => {
  assert.equal(prepassDecision({
    title: 'Decidere se accettare i CI Failure: tests come rumore accettabile',
  }).action, 'keep');
});

test('nessuna sovrapposizione fra allowlist e famiglia owner-only', () => {
  // Se un titolo PAT matchasse anche l'allowlist, l'esito dipenderebbe
  // dall'ordine dei rami invece che dall'intenzione. Qui si pretende che le due
  // liste siano disgiunte, così l'ordine è una comodità e non un requisito.
  for (const owner of ['Agent loop down: GITHUB_PAT failed to load', 'GH_PAT expiry warning: rotate']) {
    assert.equal(MONITOR_TITLE_PATTERNS.some((re) => re.test(owner)), false, owner);
  }
});

// ── La lettura del verdetto si paga solo quando serve ──────────────────────

test('needsVerdictLookup: le famiglie decise dal titolo non pagano una gh api', () => {
  // Il verdetto conta SOLO nel ramo `STALE_BLOCK_VERDICTS`, che `prepassDecision`
  // valuta dopo aver gia' scartato le due famiglie riconosciute sul titolo.
  // Pagarlo per quelle e' una chiamata buttata (nit della review di #595).
  for (const t of ['Workflow Failure: Generate Blog Article', 'follow-up(#386): x', 'Loop drift: il ciclo autonomo diverge dal sito']) {
    assert.equal(needsVerdictLookup(t), false, t);
  }
  for (const t of ['Agent loop down: GITHUB_PAT failed to load', 'GH_PAT expiry warning: rotate']) {
    assert.equal(needsVerdictLookup(t), false, t);
  }
});

test('needsVerdictLookup: un titolo non riconosciuto lo paga, ed e\' giusto', () => {
  // E' l'unico caso in cui il verdetto puo' cambiare l'esito: senza la lettura,
  // un `blocked-secrets` superato resterebbe parcheggiato per sempre.
  assert.equal(needsVerdictLookup('breaker timeout per-provider: 8 modelli nvidia'), true);
  assert.equal(needsVerdictLookup(''), true);
});
