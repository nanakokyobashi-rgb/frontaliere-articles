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
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * La radice del workspace, dedotta dalla posizione di questo modulo
 * (`generator/scripts/lib/` -> repo). In CI coincide con `$GITHUB_WORKSPACE`,
 * cioe' con l'albero su cui lo step di generazione fa `git add -A`.
 */
const WORKSPACE_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** La stessa radice dopo i symlink, per non mancare un target gia' realpathato. */
const WORKSPACE_ROOT_REAL = (() => {
  try { return realpathSync(WORKSPACE_ROOT); } catch { return WORKSPACE_ROOT; }
})();

/**
 * `true` se `target` (assoluto) sta sotto `root`. Il confronto e' per SEGMENTI:
 * `<repo>-diagnostics/x` non e' dentro `<repo>`, ma lo sarebbe per prefisso.
 */
function isInside(root, target) {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

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
 * `corpusPath()`: sono il choke point che traduce `services/locales/…` in
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
 * NOTA PER CHI EDITA QUESTO COMMENTO: qui sopra `corpusPath()` e' nominato in
 * prosa, e per un giro cio' e' bastato a far fallire il censimento di
 * `corpus-write-atomic.test.mjs`, che cerca quel letterale nella sorgente
 * raggiungibile di ogni file che scrive — non solo nel file che lo contiene,
 * ma anche in quella dei suoi import. Il difetto non stava nella prosa: stava
 * nel criterio, che guardava anche i commenti, e li' e' stato riparato
 * (`codeOnly()`). Vale comunque saperlo: questo modulo non scrive niente sotto
 * una radice pubblicata, e da #922 non e' piu' una promessa della prosa ma un
 * `throw` — il body della funzione rifiuta qualunque target dentro il
 * workspace. Se un giorno dovesse scriverci davvero, il posto dove dirlo e'
 * una delle liste di quel test, non un commento riscritto per non farsi
 * vedere.
 *
 * @param {string} file path della card (assoluto o relativo al cwd)
 * @param {any} report il `RUN_REPORT`
 * @returns {string} il path assoluto scritto
 * @throws se il target risolve dentro il workspace del repo
 */
export function writeRunCard(file, report) {
  const target = path.resolve(file);
  // L'INVARIANTE STA QUI, NON NEL COMMENTO SOPRA. Fino a #922 il «non scrive
  // niente sotto una radice pubblicata» si fondava sul fatto che il workflow
  // punti la card in `$RUNNER_TEMP`: una prosa vera oggi e falsificabile da
  // chiunque cambi `RUN_CARD_FILE`, o passi un path relativo (che `resolve()`
  // aggancia al cwd, cioe' al workspace in CI). Il danno sarebbe muto due
  // volte — artifact assente per `if-no-files-found: ignore`, e il file
  // portato su `main` dal `git add -A` dello step di commit, ora senza
  // nemmeno il falso positivo del censimento a far rumore.
  //
  // Il chiamante (`create-article.mjs`) avvolge questa chiamata in try/catch e
  // logga: un target sbagliato diventa un avviso rumoroso e la run prosegue,
  // che e' esattamente il baratto giusto per uno strumento diagnostico.
  if (isInside(WORKSPACE_ROOT, target) || isInside(WORKSPACE_ROOT_REAL, target)) {
    throw new Error(
      `run card: target dentro il workspace (${target}). La card deve stare fuori`
      + " dall'albero del repo — in CI $RUNNER_TEMP/generate-diagnostics — o il"
      + ' `git add -A` dello step di commit la porta su main.',
    );
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(buildRunCard(report))}\n`);
  return target;
}

/**
 * L'aggregato su N card. Vive qui e non nel reporter perche' e' la parte
 * testabile: il reporter fa rete (scarica gli artifact), questa funzione no.
 *
 * ── I DUE NUMERI CHE NON SONO LO STESSO NUMERO (#924 item 2) ───────────────
 *
 * `runsWithEchoes` e' il campo per cui #832 esisteva: quante cascate avessero
 * DAVVERO degli echi di cooldown, perche' una finestra in cui
 * `providerCooldownSkips` e' sempre 0 non contiene nemmeno un campione utile e
 * senza questo campo la si scambia per «la soglia non cambierebbe niente»
 * (esattamente il flip 0/28 del 2026-09-05). Resta contato sugli echi
 * DICHIARATI dal breakdown, perche' quella e' la domanda che risponde: il
 * fenomeno c'e' o non c'e'.
 *
 * Ma non e' il numero su cui le soglie si tagliano, e la prima stesura le
 * confondeva: calcolava `remaining = grossTotal - echiDichiarati`, una
 * sottrazione LINEARE che `deferralTally` non fa. Li' gli echi si clampano al
 * proprio secchio, la parte non attribuita entra solo se ci sta nella massa
 * ambigua (altrimenti vale zero), e il totale netto e' cio' che resta dopo quei
 * clamp. Conseguenza misurata: `{transient: 53, persistent: 53, total: 106,
 * providerCooldownSkips: {total: 53}}` sembrava «la parita' esatta» mentre il
 * predicato sottrae ZERO righe — e viceversa una cascata dove la sottrazione
 * morde davvero poteva restare fuori dal conteggio. Il numero su cui si sarebbe
 * deciso di spostare un exit code di produzione da `>` a `>=` non era il numero
 * su cui l'exit code si decide.
 *
 * Ora i tre campi di parita' leggono `qd.share`, cioe' l'output di
 * `quotaDeferralShare` — gli STESSI numeri su cui i predicati hanno votato,
 * gia' dentro la card. Nessuna aritmetica riscritta qui (AGENTS.md #6):
 *
 *   `echoesSubtracted`   quante cascate hanno righe DAVVERO sottratte
 *                        (`share.providerCooldownSkips > 0`). E' la
 *                        popolazione su cui una soglia puo' tagliare: le altre
 *                        dichiarano echi che il tally non colloca.
 *   `nearParity`         |echi netti - totale netto| <= 1, cioe' il guardrail
 *                        `providerCooldownSkips > total` di
 *                        `isLegitimateQuotaDeferral`.
 *   `nearMajorityTie`    |transitorio netto - persistente netto| <= 1, cioe'
 *                        il `wins()` di `isTransientMajority`, il `>` che
 *                        #357/#767 hanno invertito sul solo pareggio.
 *
 * Una card senza `share` numerica non viene fatta sparire in silenzio: si conta
 * in `cascadesWithoutTally`, per la stessa ragione per cui `readCards` conta le
 * card illeggibili.
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
    // #924 item 1 — le cascate uscite dal veto input-cap, cioe' quelle in cui
    // `verdict` NON e' l'esito che la run ha applicato. Prima erano assenti
    // dalla card per costruzione: il veto esce sopra il punto in cui la card
    // veniva scritta.
    inputCapVetoed: 0,
    shares: [],
    // #832 item 2 — «il fenomeno c'e'?» e «su quante la soglia taglia?».
    runsWithEchoes: 0,
    echoesSubtracted: 0,
    nearParity: 0,
    nearMajorityTie: 0,
    cascadesWithoutTally: 0,
    samples: [],
  };
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
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
    if (qd.inputCapVeto === true) out.inputCapVetoed += 1;
    const share = qd.share && typeof qd.share === 'object' ? qd.share : {};
    if (Number.isFinite(Number(share.share))) out.shares.push(Number(share.share));
    // Gli echi DICHIARATI dal produttore: rispondono a «il fenomeno c'e'».
    const b = qd.breakdown && typeof qd.breakdown === 'object' ? qd.breakdown : {};
    const echoDecl = (b.providerCooldownSkips && typeof b.providerCooldownSkips === 'object')
      ? Math.max(0, Number(b.providerCooldownSkips.total) || 0)
      : 0;
    const grossTotal = Math.max(0, Number(b.total) || 0);
    if (echoDecl > 0) out.runsWithEchoes += 1;
    // ...e i numeri del PREDICATO: quelli su cui le due soglie decidono.
    const netEchoes = num(share.providerCooldownSkips);
    const netTotal = num(share.total);
    const netTransient = num(share.transient);
    const netPersistent = num(share.persistent);
    if (netEchoes === null || netTotal === null || netTransient === null || netPersistent === null) {
      out.cascadesWithoutTally += 1;
      continue;
    }
    if (netEchoes > 0) {
      out.echoesSubtracted += 1;
      // «Vicino alla parita'» = un voto sposta il verdetto. Tolleranza 1 e non
      // 0: la parita' esatta e' un punto e non si aspetta un punto.
      if (Math.abs(netEchoes - netTotal) <= 1) out.nearParity += 1;
    }
    // Solo dove il voto esiste: con entrambi i secchi netti a zero non e'
    // rimasta una riga indipendente, e `transientMajorityVerdict` esce dal
    // pavimento senza mai arrivare al confronto — contarla come «pareggio»
    // gonfierebbe il numeratore con le cascate su cui la soglia non decide.
    if (netTransient + netPersistent > 0 && Math.abs(netTransient - netPersistent) <= 1) {
      out.nearMajorityTie += 1;
    }
    if (echoDecl > 0 || netEchoes > 0) {
      out.samples.push({
        runId: c.runId,
        section: c.section,
        echoes: echoDecl,
        netEchoes,
        remaining: netTotal,
        netTransient,
        netPersistent,
        grossTotal,
        verdict: qd.verdict === true,
        inputCapVeto: qd.inputCapVeto === true,
      });
    }
  }
  return out;
}
