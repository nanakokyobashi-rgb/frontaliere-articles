/**
 * ── L'UNICA SORGENTE DEL VOTO DI DEFERRAL (#855 / #857 / #873) ──────────────
 *
 * `isTransientMajority` e' il predicato da cui passano TUTTI i votanti su
 * «transitorio contro persistente»: `isInputCapDeferralVeto` (tie persistente,
 * la polarita' di #357) e `err.transientExhaustion` in ai-models.mjs (tie
 * transitorio, il `>=` di sempre). Da quel flag discende `isQuotaExhaustedError`
 * e quindi l'exit code di produzione: verde con differimento, oppure rosso con
 * Workflow-Failure. Un errore di aritmetica qui e' dieci ore di silenzio.
 *
 * Questo file e' l'osservatore di quell'aritmetica. Non prova il cablaggio dei
 * chiamanti — quello lo provano `roster-exhaustion-red.test.mjs` per il veto e
 * `ai-models-host-unreachable.test.mjs` per `transientExhaustion` — prova la
 * REGOLA che entrambi ereditano, sui casi che l'hanno prodotta.
 *
 * Ogni caso gira in ENTRAMBE le polarita' dove il verdetto atteso non dipende
 * dal pareggio: e' il modo di accorgersi che una modifica al pavimento o alla
 * coerenza degli echi ha spostato di soppiatto anche la polarita', che #357 e
 * #767 hanno gia' fissato e che nessuno dei due controlli deve toccare.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isTransientMajority, quotaDeferralShare } from '../scripts/lib/exhaustion-disposition.mjs';

/** Il verdetto nelle due polarita', per asserirle insieme. */
const bothTies = (breakdown) => ({
  transient: isTransientMajority(breakdown, { tie: 'transient' }),
  persistent: isTransientMajority(breakdown, { tie: 'persistent' }),
});

test('il pavimento: secchi netti VUOTI non sono una maggioranza (#873, item 2)', () => {
  // Cinque fratelli saltati dallo stesso host: cinque righe, UN guasto. Al
  // netto non resta nulla. Prima di questo pavimento `wins(0, 0)` era vero col
  // pareggio al transitorio, il guardrail (5 > 0) tornava al LORDO 5 vs 0 e lo
  // CONFERMAVA — «maggioranza transitoria» su un campione netto vuoto, cioe' il
  // differimento silenzioso di #313 con `err.transientExhaustion` vero.
  const soloEchi = {
    transient: 5,
    persistent: 0,
    total: 5,
    providerCooldownSkips: { total: 5, transient: 5, persistent: 0 },
  };
  assert.deepEqual(bothTies(soloEchi), { transient: false, persistent: false },
    'un guasto solo, ripetuto, non e\' la prova che aspettare aiuti');
});

test('il pavimento assorbe la clausola `transient > 0` del calcolo LORDO (#857)', () => {
  // `err.transientExhaustion` era `transient > 0 && transient >= persistent`:
  // quella prima meta' esisteva perche' `wins(0, 0)` col pareggio al
  // transitorio e' vero. Passando dall'helper la clausola non si ri-aggiunge al
  // call site — sarebbe una seconda copia della stessa regola — e il pavimento
  // deve coprirla, altrimenti una cascata VUOTA torna verde.
  for (const vuoto of [undefined, null, {}, { transient: 0, persistent: 0, total: 0 }]) {
    assert.equal(isTransientMajority(vuoto, { tie: 'transient' }), false,
      `nessuna prova, nessuna maggioranza: ${JSON.stringify(vuoto)}`);
  }
});

test('la run 31823202761: gli echi che nella massa ambigua non ci stanno sono nei secchi (#873, item 1)', () => {
  // 53 vs 52 e' un margine di UNO. Il breakdown dichiara 11 echi e non ne
  // colloca nessuno, ma la massa ambigua e' UNA riga sola (106 - 53 - 52):
  // dieci di quegli echi sono dentro i due secchi senza etichetta. La
  // sottrazione di #805 non toccava niente e il guardrail non entrava
  // (11 < 105), quindi l'helper tornava `true` — il verdetto PRE-fix,
  // riportato in silenzio.
  const run31823202761 = {
    transient: 53,
    persistent: 52,
    total: 106,
    providerCooldownSkips: { total: 11 },
  };
  assert.deepEqual(bothTies(run31823202761), { transient: false, persistent: false },
    'undici echi non collocati non decidono una maggioranza che si gioca per un voto');
});

test('...ma se la massa ambigua li ospita, il controllo NON entra', () => {
  // 200 righe, 90 transitorie e 60 persistenti: 50 ambigue. I 120 echi
  // dichiarati sono 60 attribuiti e 60 no, e 50 dei 60 stanno comodi nella
  // massa ambigua — solo 10 sono nascosti nei secchi. Lordo (90 vs 60) e netto
  // (60 vs 30) concordano: non c'e' nessun veto da inventare. Senza il clamp
  // alla massa ambigua il controllo toglierebbe tutti e 60 gli echi non
  // attribuiti da un secchio in cui non sono mai entrati, e ribalterebbe.
  const ambiguiCapienti = {
    transient: 90,
    persistent: 60,
    total: 200,
    providerCooldownSkips: { total: 120, transient: 30, persistent: 30 },
  };
  assert.deepEqual(bothTies(ambiguiCapienti), { transient: true, persistent: true },
    'la coerenza degli echi non deve inventare un veto che nessuno dei due campioni mette');
});

test('la polarita\' di #357/#767 resta intatta: il pareggio e\' l\'unica cosa che `tie` decide', () => {
  // L'unico caso in cui i due chiamanti DEVONO divergere, e nessuno dei due
  // controlli nuovi lo tocca: 10 vs 10 al netto, campione pieno, nessun eco.
  assert.deepEqual(bothTies({ transient: 10, persistent: 10, total: 20 }),
    { transient: true, persistent: false },
    'pareggio: differisce se nessuno ha rifiutato su taglia, veto se qualcuno l\'ha fatto');
});

test('senza `providerCooldownSkips` il verdetto e\' quello LORDO, byte per byte (#805)', () => {
  // Un breakdown serializzato prima di #805, o un mock che non popola il campo:
  // niente echi da togliere, niente eccedenza da nascondere nei secchi, e i due
  // controlli devono degradare a zero invece di inventare una sottrazione.
  assert.deepEqual(bothTies({ transient: 53, persistent: 52, total: 106 }),
    { transient: true, persistent: true },
    'il campo assente non e\' un campo a zero da cui dedurre qualcosa');
});

test('il guardrail di maggioranza degli echi regge ancora sopra i due controlli nuovi', () => {
  // Il caso che il guardrail esiste per fermare: 120 echi dichiarati contro 80
  // righe rimaste nei secchi. Qui la massa ambigua (90) ospita tutti i 90 echi
  // non attribuiti, quindi il controllo di coerenza NON entra e il verdetto
  // deve venire dal guardrail, che torna al lordo 50 vs 60.
  const echiDominanti = {
    transient: 50,
    persistent: 60,
    total: 200,
    providerCooldownSkips: { total: 120, persistent: 30 },
  };
  assert.deepEqual(bothTies(echiDominanti), { transient: false, persistent: false },
    'quando gli echi sono la maggioranza delle prove, la sottrazione conferma e non ribalta');
});

test('una notte di quota VERA con un host morto resta un differimento (niente rosso gratuito)', () => {
  // La regressione che i due controlli non devono causare: ogni provider a 429,
  // gli echi votano `cooling down` e sono attribuiti al transitorio, quindi
  // nessuna eccedenza e nessun pavimento. Il netto 89 vs 5 differisce, com'e'
  // giusto: quella condizione si cura da sola a mezzanotte UTC.
  const notteDiQuota = {
    transient: 100,
    persistent: 5,
    total: 110,
    providerCooldownSkips: { total: 11, transient: 11, persistent: 0 },
  };
  assert.deepEqual(bothTies(notteDiQuota), { transient: true, persistent: true },
    'il fix non deve costare un rosso su una notte di quota genuina');
});

test('le due politiche sul MEDESIMO `echoUnattributed` sono opposte, e devono restarlo (#888, item 3)', () => {
  // Il commento di `isTransientMajority` dichiarava questo clamp «la STESSA
  // coerenza» di quello di `deferralTally`. Non lo e': sullo stesso numero —
  // gli echi dichiarati che nella massa ambigua non ci stanno — il tally
  // scarta TUTTO O NIENTE, il voto di maggioranza toglie la sola ECCEDENZA al
  // secchio vincente. Nessuna delle due va dedotta dall'altra, quindi la
  // divergenza vive qui e non solo in prosa.
  const run31823202761 = {
    transient: 53,
    persistent: 52,
    total: 106,
    providerCooldownSkips: { total: 11 },
  };
  // Tally: 11 echi non attribuiti contro UNA riga di massa ambigua. Non ci
  // stanno ⇒ non se ne toglie NESSUNO, nemmeno quell'uno che ci starebbe: il
  // denominatore resta il lordo 106 e lo share e' 0,5 esatto, sotto soglia.
  const tally = quotaDeferralShare({
    code: 'ALL_MODELS_EXHAUSTED',
    exhaustionBreakdown: run31823202761,
  });
  assert.deepEqual(
    { transient: tally.transient, total: tally.total, providerCooldownSkips: tally.providerCooldownSkips },
    { transient: 53, total: 106, providerCooldownSkips: 0 },
    'tally: un `echo.total` che non ci sta non compra sconti sul denominatore, per intero',
  );
  // Voto: la stessa forma toglie DIECI righe (11 - 1) al vincitore, non zero e
  // non undici. Se qui si applicasse la regola tutto-o-niente del tally,
  // l'eccedenza sarebbe 0 e 53 vs 52 tornerebbe `true` in tie transitorio.
  assert.deepEqual(bothTies(run31823202761), { transient: false, persistent: false },
    'voto: la sola eccedenza si addebita al vincitore, e ribalta un margine di UNO');
});
