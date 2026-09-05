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
  parseVisionRegistry,
  matchRegistry,
  registryRowState,
  registryRowScope,
  citedRefs,
  blockedRefs,
  prepassNote,
  noteMarker,
  latestVerdict,
  MONITOR_TITLE_PATTERNS,
  OWNER_ONLY_TITLE_PATTERNS,
  STALE_BLOCK_VERDICTS,
  needsVerdictLookup,
  latestVerdictEntry,
  VERDICT_MAX_AGE_DAYS,
  countExpiryRequeues,
  PREPASS_EXPIRY_MARKER,
  EXPIRY_REQUEUE_MAX_CYCLES,
  isLookupDegraded,
  LOOKUP_FAILURE_MIN_COUNT,
  posNum,
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
  // `verdictAt` e' esplicito da #815: un verdetto senza data non e' piu' trattato
  // come fresco, quindi la regressione che questo test difende si esprime su un
  // verdetto DATABILE — che e' anche l'unico caso in cui la finestra di #780 ha
  // qualcosa da dire.
  const now = Date.parse('2026-09-04T00:00:00Z');
  const fresh = now - 86400000;
  for (const v of ['no-root-cause', 'max-turns', 'blocked-workflows-scope', 'already-fixed']) {
    for (const t of ['Crawler Failure: Run zurich', 'Workflow Failure: Generate Blog Article']) {
      const d = prepassDecision({ title: t, verdict: v, verdictAt: fresh, now });
      assert.equal(d.action, 'keep', `${v} / ${t}`);
      assert.match(d.reason, new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  }
  // Senza verdetto la famiglia decide come prima: la fix non chiude l'uscita.
  assert.equal(prepassDecision({ title: 'Crawler Failure: Run zurich' }).action, 'requeue');
  assert.equal(prepassDecision({
    title: 'Crawler Failure: Run zurich', verdict: 'pr-created', verdictAt: fresh, now,
  }).action, 'requeue');
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
  // #815/1: un verdetto senza data NON viene piu' scartato — emerge con
  // `at: null`. Scartarlo sembrava conservativo e non lo era: rendeva «verdetto
  // illeggibile» indistinguibile da «nessun fixer e' mai passato», e la
  // decisione su che farne spariva dal punto in cui si prende.
  const bad = latestVerdictEntry([{ body: '<!-- FIX_OUTCOME: max-turns -->', created_at: 'non-una-data' }]);
  assert.equal(bad.outcome, 'max-turns');
  assert.equal(bad.at, null);
  // Ma un verdetto DATATO batte sempre uno senza data, a qualunque distanza:
  // un `at` inventato per ordinarli sarebbe «assente» travestito da «antico».
  const mixed = latestVerdictEntry([
    { body: '<!-- FIX_OUTCOME: max-turns -->' },
    { body: '<!-- FIX_OUTCOME: no-root-cause -->', created_at: '2020-01-01T00:00:00Z' },
  ]);
  assert.equal(mixed.outcome, 'no-root-cause');
  assert.equal(mixed.at, Date.parse('2020-01-01T00:00:00Z'));
});

// ── #815/1: «senza data» non e' «fresco» ───────────────────────────────────

test('#815: un verdetto senza data leggibile non e\' piu\' vincolante per sempre', () => {
  // Il ramo era `ageMs == null → expired = false`, cioe' esattamente lo stato
  // assorbente che la finestra di validita' esiste per chiudere: la issue
  // restava in `keep` PER SEMPRE e l'unico segnale era la sua immobilita'. La
  // finestra e' un bound sull'ETA': se l'eta' non e' calcolabile, il bound non
  // e' dimostrabile, e un vincolo indimostrabile non si applica.
  const now = Date.parse('2026-09-04T00:00:00Z');
  for (const v of ['max-turns', 'no-root-cause', 'already-fixed']) {
    const d = prepassDecision({
      title: 'Crawler Failure: Run zurich', verdict: v, verdictAt: null, now,
    });
    assert.equal(d.action, 'requeue', v);
    assert.match(d.reason, /senza data/i);
    // E conta come giro di oscillazione, o il contatore dell'item 3 non lo vede.
    assert.equal(d.expiryRequeue, true, v);
  }
});

test('#815: «senza data» non scavalca le guardie che vengono prima', () => {
  // L'ordine non cambia: owner-only e lookup fallito decidono prima, e un
  // verdetto non databile non li deve trasformare in una mutazione.
  assert.equal(prepassDecision({
    title: 'Agent loop down: GITHUB_PAT failed to load', verdict: 'max-turns', verdictAt: null,
  }).action, 'keep');
  assert.equal(prepassDecision({
    title: 'Crawler Failure: Run zurich', verdict: 'max-turns', verdictAt: null,
    verdictLookupFailed: true,
  }).action, 'keep');
});

// ── #815/3: l'oscillazione mensile ha un tetto ─────────────────────────────

test('#815: dopo N cicli scadenza→requeue lo stadio smette di ri-accodare', () => {
  const now = Date.parse('2026-09-04T00:00:00Z');
  const old = now - (VERDICT_MAX_AGE_DAYS + 1) * 86400000;
  const base = { title: 'Crawler Failure: Run zurich', verdict: 'max-turns', verdictAt: old, now };

  // Sotto il tetto il ri-accodo resta quello di prima (nessuna regressione su
  // #780), ma ora e' marcato: e' il marker a rendere contabile il giro.
  for (let n = 0; n < EXPIRY_REQUEUE_MAX_CYCLES; n++) {
    const d = prepassDecision({ ...base, expiryRequeues: n });
    assert.equal(d.action, 'requeue', `giro ${n}`);
    assert.equal(d.expiryRequeue, true, `giro ${n}`);
  }

  // Al tetto ci si ferma: la scadenza non accerta che la causa sia cambiata, e
  // il terzo tentativo che fallisce come i primi due non e' un'ipotesi nuova —
  // e' un'oscillazione a periodo mensile che nel riassunto somiglia a un
  // ri-accodo legittimo. `keep` = giudizio dello sweep settimanale.
  const stop = prepassDecision({ ...base, expiryRequeues: EXPIRY_REQUEUE_MAX_CYCLES });
  assert.equal(stop.action, 'keep');
  assert.match(stop.reason, /oscillazione/i);
  assert.equal(stop.expiryRequeue, undefined);
});

test('#815: il contatore dei cicli si legge dai commenti dello stadio stesso', () => {
  // Il pre-pass e' stateless per costruzione (zero-Claude, nessun artifact): la
  // sola memoria disponibile e' quella che scrive dove la rilegge.
  assert.equal(countExpiryRequeues([]), 0);
  assert.equal(countExpiryRequeues(null), 0);
  assert.equal(countExpiryRequeues([
    { body: `nota\n\n${PREPASS_EXPIRY_MARKER}` },
    { body: 'un requeue di famiglia normale, senza marker' },
    { body: `altra nota\n\n${PREPASS_EXPIRY_MARKER}` },
    { body: '<!-- FIX_OUTCOME: max-turns -->' },
  ]), 2);
});

test('#815: il tetto non tocca il requeue di famiglia senza verdetto', () => {
  // Il contatore vale solo per il ramo scadenza: una famiglia riconosciuta e
  // senza verdetto vincolante si ri-accoda come sempre, anche con dei giri alle
  // spalle. Altrimenti il tetto diventerebbe un nuovo stato assorbente.
  const d = prepassDecision({
    title: 'Crawler Failure: Run zurich', verdict: null,
    expiryRequeues: EXPIRY_REQUEUE_MAX_CYCLES + 5,
  });
  assert.equal(d.action, 'requeue');
  assert.equal(d.expiryRequeue, undefined);
});

// ── #815/2: un fallimento SISTEMATICO del lookup non e' una run normale ────

test('#815: la soglia distingue il fallimento sporadico da quello sistematico', () => {
  // Sporadico: la guardia per-issue degrada bene, e la run resta normale.
  assert.equal(isLookupDegraded(0, 17), false);
  assert.equal(isLookupDegraded(1, 17), false);
  assert.equal(isLookupDegraded(LOOKUP_FAILURE_MIN_COUNT - 1, 4), false);
  // Sistematico (PAT scaduto, permessi revocati): ogni lettura fallisce, TUTTE
  // le issue diventano `keep`, e senza soglia il riassunto `requeue=0 keep=17`
  // e' identico a quello di una run in cui non c'era niente da fare.
  assert.equal(isLookupDegraded(17, 17), true);
  assert.equal(isLookupDegraded(9, 17), true);
  // Il minimo assoluto protegge il repo con poche issue: un solo 502 di rete su
  // una sola lettura e' rumore, non una porta chiusa.
  assert.equal(isLookupDegraded(1, 1), false);
  // Nessun lookup tentato non e' un degrado: e' una lista vuota.
  assert.equal(isLookupDegraded(0, 0), false);
});

// ── la manopola illeggibile non spegne la guardia ─────────────────────────

test('#815: una manopola non numerica torna al default invece di mutare la guardia', () => {
  // `Number(env || d)` dava `NaN` su `30d` o su un incolla con uno spazio, e
  // ogni confronto con `NaN` e' `false`: la finestra non scadeva MAI e la
  // guardia diventava codice morto senza una riga di log. E' la stessa forma
  // dell'item 1 — una guardia disattivata da un input degenere.
  assert.equal(posNum(undefined, 30), 30);
  assert.equal(posNum('', 30), 30);
  assert.equal(posNum('30d', 30), 30);
  assert.equal(posNum('  ', 30), 30);
  assert.equal(posNum('0', 30), 30);
  assert.equal(posNum('-5', 30), 30);
  assert.equal(posNum('7', 30), 7);
  assert.equal(posNum('0.5', 1), 0.5);
  // E i valori vivi restano numeri utilizzabili.
  assert.ok(Number.isFinite(VERDICT_MAX_AGE_DAYS) && VERDICT_MAX_AGE_DAYS > 0);
  assert.ok(Number.isFinite(EXPIRY_REQUEUE_MAX_CYCLES) && EXPIRY_REQUEUE_MAX_CYCLES > 0);
});

/**
 * ## Il riconoscimento del registro di VISION.md (#7280 sul sito)
 *
 * ADATTAMENTO — qui la fixture e' VERBATIM e non un file letto, ed e' l'unica
 * differenza di sostanza rispetto al gemello del sito, dove gli stessi casi
 * girano sul `VISION.md` reale del repo.
 *
 * La ragione e' la stessa che rende `needs-human-sweep.yml` `adapted`:
 * `VISION.md` NON esiste in questo repo, e' sorgente unica sul sito, e a
 * runtime si recupera via `gh api`. Un test `node --test` non fa rete e non
 * deve farla — un gate che dipende dalla disponibilita' di un'API di un altro
 * repo e' un gate che diventa rosso per motivi che non c'entrano col codice.
 *
 * Il prezzo e' che questa fixture puo' invecchiare rispetto al registro vero.
 * Per questo le righe qui sotto sono COPIATE ALLA LETTERA dal registro del
 * 2026-09-05 invece di essere riscritte in forma comoda: se un domani il
 * proprietario riscrive la riga di #5995, questa copia resta la prova di cosa
 * il criterio ha promesso di leggere il giorno in cui e' stato scritto.
 */
const REGISTRY_FIXTURE = `## Decisioni del proprietario già prese

| Data | Decisione | Fonte |
|---|---|---|
| 2026-08-12 | Re-permission consensi: NON si fa, per ora | #5681 (commento 12-08) |
| 2026-08-24 | #6280 (candidatura assistita 0,99€, A/B 60/40): **SÌ, procedi** | istruzione diretta, sessione 24-08 |
| 2026-08-24 | #4854 (verticale aste targhe cantonali): **SÌ, procedi** | istruzione diretta, sessione 24-08 |
| 2026-08-24 | #5926 (CMP unificata ads+comunicazioni): **SÌ**, con vincolo esplicito: l'implementazione deve preservare la compatibilità della frase di consenso col parser publisher-blast (vedi issue → rischio di azzerare l'audience) e mantenere la prova di consenso per la CMP. Requisito tecnico, non approvazione preventiva | istruzione diretta, sessione 24-08 |
| 2026-08-24 | #5995 (repo weight): leve **1** (batch commit bot), **3** (cache derivate fuori git), **4** (file append-only partizionati per shard) autorizzate. Leve **2** (snapshot fuori git) e **5** (immagini→CDN, tentativo precedente ritirato) restano BACKLOG, non autorizzate: non aprire lavoro su quelle finché non arriva una decisione dedicata | istruzione diretta, sessione 24-08 |
| 2026-08-25 | #5983 (text-html-ratio + max-bfs-depth, entrambi migliorati): **NO, non stringere la baseline** — i due file restano com'erano (6912/26398). Lettura iniziale errata ("migliorato → rebaseline in autonomia"), corretta lo stesso giorno: "rendiamo le baseline più ampie" significava lasciarle larghe/permissive, non ottimizzarle verso il basso. La stessa logica vale per OGNI futuro gate SEO "nice-to-have": bloccare publish/validate per un warning che Google non richiede non ha senso, quindi il gate diventa advisory (issue #6462) — non si stringe la soglia — vedi driver **D9** | istruzione diretta, sessione 25-08, issue #6458 (corretta stessa sessione) |

## Manutenzione di questo documento
`;

const REGISTRY = parseVisionRegistry(REGISTRY_FIXTURE);

/** L'esito del pre-pass su un corpo che cita `#n` del SITO, senza altri segnali. */
function verdictFor(n) {
  // Qualificato: sul corpus un `#N` nudo e' un numero DI QUESTO repo, non del
  // registro del sito. E' precisamente la collisione che `homeScope` chiude.
  const g = matchRegistry(
    `Scheda\n\nContesto: vedi valerielinc-ops/frontaliere-si-o-no#${n}.`,
    REGISTRY,
    { homeScope: 'corpus' },
  );
  if (!g.unconditional.length && !g.conditional.length) return 'nessuna-riga';
  return g.unconditional.length && !g.conditional.length ? 'sblocca' : 'annota';
}

test('la fixture del registro si parsa: sei righe, tutte con almeno un riferimento', () => {
  assert.equal(REGISTRY.length, 6);
  for (const r of REGISTRY) assert.ok(r.refs.length > 0, `riga senza riferimenti: ${r.decision}`);
});

test('#6280 «SÌ, procedi» e un si pieno -> SBLOCCA', () => {
  assert.equal(verdictFor(6280), 'sblocca');
});

test('#4854 «SÌ, procedi» -> SBLOCCA', () => {
  assert.equal(verdictFor(4854), 'sblocca');
});

test('#5995: leve 2 e 5 «non autorizzate» -> NON sblocca da solo', () => {
  // E' la trappola centrale. Una regola «cita una riga registrata -> requeue»
  // riaprirebbe qui lavoro che il proprietario ha esplicitamente NEGATO, che e'
  // un danno peggiore del non-riconoscimento che questo meccanismo ripara.
  assert.equal(verdictFor(5995), 'annota');
  const row = REGISTRY.find((r) => r.refs.includes(5995));
  assert.equal(row.state, 'conditional');
  assert.ok(/NON è autorizzata|BACKLOG/.test(row.why.join(' ')), row.why.join(' '));
});

test('#5983 e un NO -> NON sblocca', () => {
  assert.equal(verdictFor(5983), 'annota');
  assert.ok(REGISTRY.find((r) => r.refs.includes(5983)).why.includes('decisione negativa'));
});

test('#5681 «NON si fa, per ora» -> NON sblocca', () => {
  assert.equal(verdictFor(5681), 'annota');
});

test('#5926 «SÌ, con vincolo esplicito» -> NON sblocca', () => {
  assert.equal(verdictFor(5926), 'annota');
});

test('una issue che non cita nessuna riga non aggancia niente', () => {
  assert.equal(verdictFor(999999), 'nessuna-riga');
});

test('il silenzio non e un si: senza marcatore affermativo la riga e condizionata', () => {
  const r = registryRowState('Publisher doppio sulla stessa coda: spento lo schedule del sito');
  assert.equal(r.state, 'conditional');
  assert.match(r.why[0], /nessun marcatore affermativo/);
});

test('`si` pronome NON e un si: ogni riga negativa lo contiene', () => {
  // Un `/\\bsi\\b/i` leggerebbe come affermative esattamente le righe che negano.
  assert.equal(registryRowState('NON si fa, per ora').state, 'conditional');
  assert.equal(registryRowState('Le issue della famiglia job-alert si lasciano stare').state, 'conditional');
});

test('«non solo per questa issue» resta un si pieno', () => {
  // Un qualificatore su `\\bnon\\b` spegnerebbe il riconoscimento proprio sulle
  // righe piu larghe, che sono quelle che vale di piu riconoscere.
  assert.equal(
    registryRowState('**SÌ, e i futuri deploy sono autonomi da ora** — non solo per questa issue').state,
    'unconditional',
  );
});

test('sul corpus un #N NUDO non aggancia una riga del sito', () => {
  // La collisione di numerazione: `#5995` nudo qui significa
  // nanakokyobashi-rgb/frontaliere-articles#5995, che non esiste. Leggerlo come
  // la riga del registro del sito sarebbe un riconoscimento inventato.
  const g = matchRegistry('vedi #6280 per il contesto', REGISTRY, { homeScope: 'corpus' });
  assert.deepEqual(g.refs, []);
});

test('una riga che parla del corpus decide sui numeri NUDI di questo repo', () => {
  assert.equal(registryRowScope('Cinque issue del corpus (#621, #625, #787)'), 'corpus');
  assert.equal(registryRowScope('#6280 (candidatura assistita): **SÌ, procedi**'), 'site');
  const corpusRow = {
    date: '2026-09-05', decision: 'x', source: '', refs: [832],
    scope: 'corpus', state: 'unconditional', why: [],
  };
  assert.deepEqual(matchRegistry('vedi #832', [corpusRow], { homeScope: 'corpus' }).refs, [832]);
  assert.deepEqual(matchRegistry('vedi #832', [corpusRow], { homeScope: 'site' }).refs, []);
});

test('`AGENTS.md #1` non e la issue #1', () => {
  assert.deepEqual([...citedRefs('vedi AGENTS.md #1 per il dettaglio')], []);
  assert.deepEqual([...citedRefs('vedi la issue #1 per il dettaglio')], [1]);
});

test('il registro non scavalca `max-turns`', () => {
  const body = 'vedi valerielinc-ops/frontaliere-si-o-no#6280';
  assert.equal(prepassDecision({ title: 'lavoro', body, registry: REGISTRY }).action, 'requeue');
  assert.notEqual(
    prepassDecision({ title: 'lavoro', body, registry: REGISTRY, verdict: 'max-turns' }).action,
    'requeue',
  );
});

test('una riga condizionata basta a fermare lo sblocco, anche accanto a un si pieno', () => {
  const d = prepassDecision({
    title: 'lavoro misto',
    body: 'tocca valerielinc-ops/frontaliere-si-o-no#6280 e valerielinc-ops/frontaliere-si-o-no#5995',
    registry: REGISTRY,
  });
  assert.equal(d.action, 'keep');
  assert.match(d.note, /condizionata o negativa/);
});

test('la riga condizionata viene ALLEGATA, col marker di idempotenza', () => {
  const d = prepassDecision({
    title: 'repo weight', body: 'leva 2 di valerielinc-ops/frontaliere-si-o-no#5995', registry: REGISTRY,
  });
  assert.equal(d.action, 'keep');
  assert.match(d.note, /Registro di `VISION.md`/);
  assert.equal(d.marker, '<!-- PREPASS_NOTE: r=5995 -->');
});

test('il tracker permanente non si annota', () => {
  const d = prepassDecision({
    title: 'digest', body: 'vedi valerielinc-ops/frontaliere-si-o-no#5995',
    labels: ['agent:no-age-out'], registry: REGISTRY,
  });
  assert.equal(d.note, undefined);
});

/**
 * ## Blocchi scaduti — la forma reale di #471
 *
 * #471 era `blocked` su `valerielinc-ops#6023`, MERGIATA il 2026-08-18:
 * diciotto giorni oltre la fine del suo blocco, e nessuno se n'era accorto.
 */
const BODY_471 = [
  'Scope residuo dal body di PR #433 (mergiata, merge commit ce67d8c).',
  '',
  '## 1. Gemello sito non ancora portato — blocked su PR esterna aperta',
  '',
  'Stato dichiarato nel body: `PR concatenata valerielinc-ops/frontaliere-si-o-no#6023`, non ancora mergiata.',
  '',
  '## 2. Ledger diagnostico — nessun blocco dichiarato qui',
  '',
  'Si fa nello stesso giro, vedi #999.',
].join('\n');

test('il riferimento sta tre paragrafi sotto la parola `blocked`: la riga non basta, la sezione si', () => {
  const refs = blockedRefs(BODY_471, { homeScope: 'corpus' });
  assert.deepEqual(refs.map((r) => r.key), ['valerielinc-ops/frontaliere-si-o-no#6023']);
});

test('una sezione senza `blocked` non contribuisce riferimenti', () => {
  assert.ok(!blockedRefs(BODY_471, { homeScope: 'corpus' }).some((r) => r.number === 999));
});

test('un corpo che non nomina mai `blocked` costa zero letture', () => {
  assert.deepEqual(blockedRefs('nessun blocco qui, solo #123', { homeScope: 'corpus' }), []);
});

test('la nota dice stato e data, e il blocco scaduto da solo NON instrada', () => {
  const stale = [{ key: 'a#1', link: 'valerielinc-ops/frontaliere-si-o-no#6023', state: 'MERGED', at: '2026-08-18' }];
  const d = prepassDecision({ title: 'gemello sito ai-models.mjs non portato', staleBlocks: stale });
  assert.equal(d.action, 'keep');
  assert.match(d.note, /MERGED/);
  assert.match(d.note, /2026-08-18/);
  assert.equal(noteMarker({ refs: [] }, stale), '<!-- PREPASS_NOTE: b=a#1 -->');
});

test('senza righe e senza blocchi non si scrive niente (nessun commento a vuoto)', () => {
  assert.equal(prepassNote({ unconditional: [], conditional: [], refs: [] }, []), null);
  assert.equal(noteMarker({ refs: [] }, []), null);
});
