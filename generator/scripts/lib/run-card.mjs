/**
 * run-card.mjs — la proiezione minima del report di run che sopravvive al runner.
 *
 * ## Il difetto che questo modulo chiude, e perche' non e' una sonda per issue
 *
 * Cinque follow-up del backlog (#621, #625, #804, #832, #787) erano parcheggiate
 * sulla stessa frase: «blocked, servono numeri da run reali». Nessuna aspettava
 * una decisione; aspettavano un dato che nessuno produceva, perche' l'unico modo
 * di leggerlo era `gh run view <id> --log | grep` — e su un evento raro quel
 * metodo non funziona per tre ragioni che si sommano:
 *
 *   1. VOLUME. Un log di `generate-article.yml` pesa 300-500 KB. Campionare 400
 *      run significa scaricare ~160 MB per contare un intero.
 *   2. RETENTION. Il log scade prima che il campione si accumuli, quindi la
 *      finestra osservabile e' sempre piu' corta della frequenza dell'evento.
 *   3. IL CAMPIONE MENTE IN SILENZIO. E' successo il 2026-09-05 su #832:
 *      `exhaustion-reason-report.mjs --deferral-verdicts --runs 400` ha reso
 *      «28 cascate confrontabili, flip 0/28». Quello zero sembrava un verdetto
 *      («la soglia non cambierebbe niente») e invece era l'assenza del
 *      fenomeno: tutte e 28 avevano `echi=0`, cioe' nessuna era il caso su cui
 *      la soglia si taglia. Un denominatore che non distingue «non e' successo»
 *      da «non l'ho visto» non e' una misura.
 *
 * La card e' la risposta a (3) per costruzione: porta il DENOMINATORE accanto al
 * numeratore (`rebracket.calls` accanto a `rebracket.viaFallbackUnsat`) e porta
 * il breakdown GREZZO accanto al verdetto, cosi' ogni ricalibrazione futura si
 * rigioca offline sulle funzioni esportate da `exhaustion-disposition.mjs`
 * invece di richiedere una seconda strumentazione e un'altra finestra di run.
 *
 * ## Perche' un file separato dal report intero
 *
 * `CREATE_ARTICLE_REPORT_FILE` esiste da prima e viene gia' scritto su ogni
 * percorso terminale, ma dentro il workspace, dove muore col runner. Portarlo
 * fuori sarebbe stato piu' corto di una riga — e sbagliato: quel report ha liste
 * campionate e note e non ha un tetto, quindi il costo dell'artifact
 * crescerebbe con esse e nessuno potrebbe dichiararlo. La card ha uno schema
 * fisso e una taglia misurabile (~0,5 KB contro i 1.951 B del solo scheletro
 * del report, che e' il suo minimo e non il suo massimo).
 *
 * Zero dipendenze npm: `create-article.mjs` la importa a caldo e i workflow che
 * la leggono girano anche PRIMA di `npm ci`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Versione dello schema. Un lettore che non la riconosce deve dirlo, non indovinare. */
export const RUN_CARD_SCHEMA = 'run-card/1';

/**
 * La proiezione. Tutto opzionale e tutto difensivo: la card viene costruita nel
 * percorso di finalizzazione, che gira anche quando la run sta gia' morendo, e
 * un `TypeError` qui trasformerebbe uno strumento diagnostico nella causa di un
 * esito perso.
 *
 * @param {any} report il `RUN_REPORT` di `create-article.mjs`
 * @returns {{schema:string,runId:string,section:string|null,status:string,endedAt:string|null,rebracket:{calls:number,viaFallbackUnsat:number},quotaDeferral:object|null}}
 */
export function buildRunCard(report) {
  const r = (report && typeof report === 'object') ? report : {};
  const rare = (r.rareEvents && typeof r.rareEvents === 'object') ? r.rareEvents : {};
  const rb = (rare.rebracket && typeof rare.rebracket === 'object') ? rare.rebracket : {};
  return {
    schema: RUN_CARD_SCHEMA,
    runId: String(r.runId || 'local'),
    section: typeof r.section === 'string' ? r.section : null,
    status: String(r.status || 'unknown'),
    endedAt: typeof r.endedAt === 'string' ? r.endedAt : null,
    rebracket: {
      calls: Number(rb.calls) || 0,
      viaFallbackUnsat: Number(rb.viaFallbackUnsat) || 0,
    },
    quotaDeferral: (rare.quotaDeferral && typeof rare.quotaDeferral === 'object')
      ? rare.quotaDeferral
      : null,
  };
}

/**
 * ── LA SCRITTURA STA QUI, E NON NEL CHIAMANTE ───────────────────────────────
 *
 * `create-article.mjs` ha un proprio `write()`/`resolve()` che passano da
 * `corpusPath`: sono il choke point che traduce `services/locales/…` in
 * `content/…`, e presuppongono un path RELATIVO al repo. Con un path assoluto
 * — che e' esattamente cio' che `$RUNNER_TEMP/generate-diagnostics/…` e' —
 * `resolve()` produce `${PROJECT_ROOT}/` + il path assoluto, cioe' fa atterrare
 * la card in `<repo>/home/runner/…`. Due danni, entrambi muti: `$diag_dir`
 * resta vuota (`if-no-files-found: ignore` fa sparire l'artifact e l'intera
 * strumentazione diventa un no-op che non fa fallire niente), e l'albero
 * `home/` creato sotto il workspace finisce su `main` col `git add -A` dello
 * step di commit.
 *
 * La scrittura vive quindi accanto alla costruzione, con `path.resolve` e
 * `writeFileSync` di Node: un path assoluto resta assoluto, uno relativo si
 * risolve sul cwd, e nessun sanitize corpus tocca un file che corpus non e'.
 * Vive qui anche perche' sia TESTABILE: `create-article.mjs` non e'
 * importabile, quindi finche' la scrittura stava li' dentro nessun test poteva
 * accorgersi che la card atterrava altrove — ed e' precisamente cio' che e'
 * successo.
 *
 * NOTA PER CHI EDITA QUESTO COMMENTO: sopra, `corpusPath` e' scritto SENZA la
 * parentesi aperta, e va lasciato cosi'. Il censimento di
 * `corpus-write-atomic.test.mjs` cerca quel nome seguito da una parentesi
 * aperta, e non guarda solo il file che lo contiene: `reachableSource()`
 * concatena la sorgente di ogni import relativo, quindi quella sola parentesi
 * in questa prosa farebbe fallire il censimento a QUALUNQUE file sotto
 * `generator/scripts` che importi questo modulo e usi `writeFileSync`, per una
 * ragione che non lo riguarda. (Scritta la prima volta con la parentesi, questa
 * nota faceva fallire il censimento spiegando come non farlo fallire.) Il
 * modulo non scrive niente sotto una radice pubblicata: il suo unico target e'
 * `RUN_CARD_FILE`, in `$RUNNER_TEMP`.
 *
 * @param {string} file path della card (assoluto o relativo al cwd)
 * @param {any} report il `RUN_REPORT`
 * @returns {string} il path assoluto scritto
 */
export function writeRunCard(file, report) {
  const target = path.resolve(file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(buildRunCard(report))}\n`);
  return target;
}

/**
 * L'aggregato su N card. Vive qui e non nel reporter perche' e' la parte
 * testabile: il reporter fa rete (scarica gli artifact), questa funzione no.
 *
 * `runsWithEchoes` e' il campo per cui #832 esisteva. La soglia `>` contro `>=`
 * del guardrail di maggioranza si taglia sulle cascate in cui gli echi tolti si
 * AVVICINANO alle righe rimaste; una finestra in cui `providerCooldownSkips` e'
 * sempre 0 non contiene nemmeno un campione utile, e senza questo campo lo si
 * scambia per «la soglia non cambierebbe niente» (esattamente il flip 0/28 del
 * 2026-09-05). `nearParity` conta i campioni in cui la parita' e' davvero in
 * gioco: e' il numeratore che sblocca la decisione, non lo share medio.
 *
 * @param {Array<any>} cards
 */
export function summariseRunCards(cards) {
  const list = Array.isArray(cards) ? cards : [];
  const out = {
    cards: list.length,
    unknownSchema: 0,
    // #621 — il ramo `viaFallbackUnsat` e il suo denominatore.
    rebracketCalls: 0,
    rebracketViaFallbackUnsat: 0,
    // #804 / #787 — lo share transitorio su run reali.
    deferralCascades: 0,
    deferralAccepted: 0,
    shares: [],
    // #832 item 2 — i soli campioni su cui la parita' decide qualcosa.
    runsWithEchoes: 0,
    nearParity: 0,
    samples: [],
  };
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    if (c.schema !== RUN_CARD_SCHEMA) { out.unknownSchema += 1; continue; }
    const rb = c.rebracket || {};
    out.rebracketCalls += Number(rb.calls) || 0;
    out.rebracketViaFallbackUnsat += Number(rb.viaFallbackUnsat) || 0;
    const qd = c.quotaDeferral;
    if (!qd || typeof qd !== 'object') continue;
    out.deferralCascades += 1;
    if (qd.verdict === true) out.deferralAccepted += 1;
    const share = qd.share && typeof qd.share === 'object' ? qd.share : {};
    if (Number.isFinite(Number(share.share))) out.shares.push(Number(share.share));
    // Gli echi DICHIARATI dal produttore, non quelli ricostruiti: e' il numero
    // che `deferralTally` sottrae, ed e' quello su cui la parita' si misura.
    const b = qd.breakdown && typeof qd.breakdown === 'object' ? qd.breakdown : {};
    const echoDecl = (b.providerCooldownSkips && typeof b.providerCooldownSkips === 'object')
      ? Math.max(0, Number(b.providerCooldownSkips.total) || 0)
      : 0;
    const grossTotal = Math.max(0, Number(b.total) || 0);
    const remaining = Math.max(0, grossTotal - echoDecl);
    if (echoDecl > 0) {
      out.runsWithEchoes += 1;
      // «Vicino alla parita'» = la sottrazione lascia in piedi un campione della
      // stessa taglia degli echi tolti, cioe' il caso in cui un voto ribalta il
      // verdetto. Tolleranza 1 e non 0: la parita' esatta e' un punto e non si
      // aspetta un punto.
      if (Math.abs(echoDecl - remaining) <= 1) out.nearParity += 1;
      out.samples.push({
        runId: c.runId,
        section: c.section,
        echoes: echoDecl,
        remaining,
        grossTotal,
        verdict: qd.verdict === true,
      });
    }
  }
  return out;
}
