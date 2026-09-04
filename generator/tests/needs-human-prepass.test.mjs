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
  latestVerdictEntry,
  VERDICT_MAX_AGE_DAYS,
} from '../../scripts/ci/needs-human-prepass.mjs';
import { isDecomposeEligible } from '../../scripts/ci/followup-drainer.mjs';

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

test('needsVerdictLookup: la famiglia monitor ORA lo paga, altrimenti la guardia e\' morta', () => {
  // Invertito rispetto al #595, e deliberatamente. Allora il verdetto contava
  // solo nel ramo `STALE_BLOCK_VERDICTS`, valutato dopo aver scartato le
  // famiglie sul titolo, quindi pagarlo per quelle era una chiamata buttata.
  // Ora esiste il ramo `PREPASS_VERDICT_BEATS_FAMILY`, che si applica PROPRIO ai
  // titoli di famiglia: saltare la lettura per loro renderebbe la guardia codice
  // morto esattamente sul caso che l'ha motivata (site #7313: `Crawler Failure:
  // Run zurich` e `Run volg` ri-accodate col verdetto `max-turns` intatto).
  for (const t of ['Workflow Failure: Generate Blog Article', 'Crawler Failure: Run zurich', 'follow-up(#386): x', 'Loop drift: il ciclo autonomo diverge dal sito']) {
    assert.equal(needsVerdictLookup(t), true, t);
  }
  // La sola famiglia owner-only resta esente: `prepassDecision` la decide PRIMA
  // di guardare il verdetto, quindi leggerlo non cambierebbe l'esito.
  for (const t of ['Agent loop down: GITHUB_PAT failed to load', 'GH_PAT expiry warning: rotate']) {
    assert.equal(needsVerdictLookup(t), false, t);
  }
});

test('regressione site #7313/#7307: il verdetto batte il riconoscimento di famiglia', () => {
  // Questa guardia non era MAI scesa su questa meta': il gemello del sito ce
  // l'ha dal #5608, il file qui e' `adapted` e il drift check confronta solo gli
  // `identical`. Senza, una issue di famiglia monitor gia' chiusa da un verdetto
  // tornava in coda a costo zero per riprodurlo.
  for (const v of ['no-root-cause', 'max-turns', 'blocked-workflows-scope', 'already-fixed']) {
    for (const t of ['Crawler Failure: Run zurich', 'Workflow Failure: Generate Blog Article']) {
      const d = prepassDecision({ title: t, verdict: v });
      assert.equal(d.action, 'keep', `${v} / ${t}`);
      assert.match(d.reason, new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  }
  // Senza verdetto la famiglia decide come prima: la fix non chiude l'uscita.
  assert.equal(prepassDecision({ title: 'Crawler Failure: Run zurich' }).action, 'requeue');
  assert.equal(prepassDecision({ title: 'Crawler Failure: Run zurich', verdict: 'pr-created' }).action, 'requeue');
});

test('il verdetto batte il requeue ma NON lo scorporo (🔴 della review di #778)', () => {
  // La guardia stava PRIMA del ramo `isAggregate` e gli toglieva il `decompose`.
  // E' l'opposto del criterio che la costante dichiara: lo scorporo CAMBIA
  // l'input del fixer esattamente come la scheda dello sweep — e' il ramo che il
  // drainer stesso sceglie su `max-turns` (DECOMPOSE-ROUTE). Un container di
  // famiglia monitor con un verdetto catturato deve continuare a scorporarsi.
  for (const v of ['max-turns', 'no-root-cause']) {
    for (const t of [
      'follow-up(#386): 3 items deferred — qualcosa',
      'Workflow Failure: sweep dei crawler',
    ]) {
      assert.equal(prepassDecision({ title: t, verdict: v }).action, 'decompose', `${v} / ${t}`);
    }
  }
});

test('needsVerdictLookup: un titolo non riconosciuto lo paga, ed e\' giusto', () => {
  // E' l'unico caso in cui il verdetto puo' cambiare l'esito: senza la lettura,
  // un `blocked-secrets` superato resterebbe parcheggiato per sempre.
  assert.equal(needsVerdictLookup('breaker timeout per-provider: 8 modelli nvidia'), true);
  assert.equal(needsVerdictLookup(''), true);
});

// ── #780/1: lo scorporo si propone solo se il promotore lo accetterebbe ─────

test('#780: un container con una label che il promotore rifiuta NON va in decompose-queued', () => {
  // `isDecomposeEligible` (followup-drainer) esclude i padri gia' decomposti, le
  // figlie e le gia' triagiate `already-resolved`. Il pre-pass decideva sul solo
  // titolo: toglieva `needs-human` e metteva `agent:decompose-queued`, il
  // promotore rifiutava, e la issue restava fuori da OGNI coda — la forma
  // «smette di avanzare in silenzio».
  for (const l of ['decomposed:1', 'from-decompose', 'maybe-resolved']) {
    const d = prepassDecision({
      title: 'follow-up(#6205): 3 items deferred — REST files-cap',
      labels: [l],
    });
    assert.equal(d.action, 'keep', l);
    assert.match(d.reason, new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  // Senza quelle label lo scorporo resta la decisione giusta.
  assert.equal(prepassDecision({
    title: 'follow-up(#6205): 3 items deferred — REST files-cap',
  }).action, 'decompose');
});

test('#780: il predicato e\' QUELLO del promotore, non una parafrasi', () => {
  // Se il drainer aggiunge un'esclusione, il pre-pass la eredita gratis: qui si
  // pretende che le due letture non possano divergere per costruzione.
  const title = 'follow-up(#6205): 3 items deferred — REST files-cap';
  for (const l of ['decomposed:1', 'from-decompose', 'maybe-resolved', 'agent:decompose', 'agent:decompose-queued']) {
    const eligible = isDecomposeEligible({ labels: [{ name: l }] });
    assert.equal(eligible, false, l);
    assert.equal(prepassDecision({ title, labels: [l] }).action, 'keep', l);
  }
});

// ── #780/2: lookup fallito ≠ nessun verdetto ───────────────────────────────

test('#780: un lookup del verdetto fallito da\' keep, non il requeue di famiglia', () => {
  // Su secondary rate-limit ogni lettura tornava `null` e la famiglia decideva
  // `requeue` esattamente come prima di #778: il loop si riapriva senza una riga
  // di log. `keep` costa un giro di sweep; il requeue costa un run del fixer che
  // riproduce un verdetto gia' pagato.
  for (const t of ['Crawler Failure: Run zurich', 'Workflow Failure: Generate Blog Article']) {
    const d = prepassDecision({ title: t, verdict: null, verdictLookupFailed: true });
    assert.equal(d.action, 'keep', t);
    assert.match(d.reason, /lookup fallito/i);
  }
  // E non tocca nemmeno lo scorporo: senza verdetto leggibile non si muta nulla.
  assert.equal(prepassDecision({
    title: 'follow-up(#6205): 3 items deferred — REST files-cap', verdictLookupFailed: true,
  }).action, 'keep');
});

test('#780: la famiglia owner-only resta owner-only anche col lookup fallito', () => {
  const d = prepassDecision({
    title: 'Agent loop down: GITHUB_PAT failed to load', verdictLookupFailed: true,
  });
  assert.equal(d.action, 'keep');
  assert.match(d.reason, /proprietario/i);
});

// ── #780/3: il verdetto vincolante ha una finestra di validita' ────────────

test('#780: un verdetto piu\' vecchio della finestra non e\' piu\' vincolante', () => {
  const now = Date.parse('2026-09-04T00:00:00Z');
  const old = now - (VERDICT_MAX_AGE_DAYS + 1) * 86400000;
  const d = prepassDecision({
    title: 'Crawler Failure: Run zurich', verdict: 'max-turns', verdictAt: old, now,
  });
  assert.equal(d.action, 'requeue');
  assert.match(d.reason, /scadut/i);
});

test('#780: dentro la finestra il verdetto resta vincolante (nessuna regressione su #778)', () => {
  const now = Date.parse('2026-09-04T00:00:00Z');
  const fresh = now - (VERDICT_MAX_AGE_DAYS - 1) * 86400000;
  for (const v of ['max-turns', 'no-root-cause', 'already-fixed']) {
    assert.equal(prepassDecision({
      title: 'Crawler Failure: Run zurich', verdict: v, verdictAt: fresh, now,
    }).action, 'keep', v);
  }
  // Verdetto senza data parsabile: si resta al comportamento conservativo.
  assert.equal(prepassDecision({
    title: 'Crawler Failure: Run zurich', verdict: 'max-turns', verdictAt: null, now,
  }).action, 'keep');
});

test('#780: latestVerdictEntry restituisce l\'istante del verdetto vincente', () => {
  // Senza l'istante, la finestra di validita' non e' calcolabile: e' il motivo
  // per cui `latestVerdict` diventa un wrapper invece di restare la sorgente.
  const e = latestVerdictEntry([
    { body: '<!-- FIX_OUTCOME: no-root-cause -->', created_at: '2026-08-19T10:00:00Z' },
    { body: '<!-- FIX_OUTCOME: max-turns -->', createdAt: '2026-08-22T10:00:00Z' },
  ]);
  assert.equal(e.outcome, 'max-turns');
  assert.equal(e.at, Date.parse('2026-08-22T10:00:00Z'));
  // Nessun marker → nessuna data: «assente» non deve poter passare per «antico».
  assert.deepEqual(latestVerdictEntry([{ body: 'solo testo' }]), { outcome: null, at: null });
  assert.deepEqual(latestVerdictEntry(null), { outcome: null, at: null });
  // Un commento con data non parsabile non vince: `at` resta coerente con l'esito.
  const bad = latestVerdictEntry([{ body: '<!-- FIX_OUTCOME: max-turns -->', created_at: 'non-una-data' }]);
  assert.equal(bad.outcome, null);
  assert.equal(bad.at, null);
});
