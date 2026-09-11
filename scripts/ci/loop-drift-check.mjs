#!/usr/bin/env node
/**
 * loop-drift-check.mjs — sorveglia la divergenza fra il ciclo autonomo di
 * questo repo e quello di `valerielinc-ops/frontaliere-si-o-no`, e per ogni
 * file divergente dice **perché** diverge.
 *
 * ## Il problema che risolve
 *
 * Il ciclo agentico è nato sul sito ed è stato portato qui. Da questo momento i
 * due lati evolvono in parallelo, e un diff a due vie ("i file sono diversi?")
 * non serve a niente: sono diversi **per costruzione**. `vitest` non esiste qui,
 * `npm ci` nemmeno, `functions/` neppure. Un checker a due vie segnalerebbe
 * quelle differenze per sempre, ogni giorno, finché nessuno lo guarda più.
 *
 * La domanda utile non è "sono diversi" ma "**chi si è mosso, e da quando**".
 *
 * ## Il confronto a tre vie
 *
 * Il manifest registra, per ogni file, l'hash di ENTRAMBI i lati al momento
 * dell'ultimo allineamento cosciente (la `baseline`). Con tre hash — sito oggi,
 * corpus oggi, baseline — la diagnosi diventa deterministica:
 *
 *   sito == baseline.site  &&  corpus == baseline.corpus  →  `stable`
 *       Nessuno si è mosso. Le differenze che restano sono quelle dichiarate.
 *
 *   sito != baseline.site  &&  corpus == baseline.corpus  →  `site-ahead`
 *       Il sito ha evoluto, qui no. È il caso che oggi passa inosservato: il
 *       mirror dell'engine ha già dimostrato che un canale di discesa che si
 *       interrompe non lo dice a nessuno — nove commit persi, visibili solo
 *       come un audit passato da 23 a 3608.
 *
 *   sito == baseline.site  &&  corpus != baseline.corpus  →  `corpus-ahead`
 *       Abbiamo migliorato qualcosa QUI. Non è drift da correggere: è una
 *       modifica candidata a risalire verso il sito. Senza questa classe, le
 *       ottimizzazioni locali restano invisibili e vengono cancellate al
 *       prossimo allineamento.
 *
 *   entrambi mossi                                        →  `both-moved`
 *       L'unico caso che richiede davvero un umano: due modifiche indipendenti
 *       sullo stesso file. Nessun merge automatico, per scelta. Eccezione
 *       (issue #680): se i due contenuti ATTUALI coincidono comunque, non c'e'
 *       niente da riconciliare — verdetto `both-moved-converged`, solo
 *       `--init`.
 *
 * ## `stranded-twin`: il `site-ahead` che non arriverà mai (issue #303)
 *
 * Le quattro classi sopra dicono CHI si è mosso, mai DA QUANTO — e per
 * `site-ahead` è la differenza fra due situazioni opposte. Un file che il sito
 * ha toccato ieri è latenza: qualcuno lo porterà. Uno fermo da due settimane
 * non aspetta nessuno, perché **non esiste un trasporto che lo porti**.
 * Producevano la stessa identica riga, ogni giorno, nella stessa issue: e una
 * riga che non cambia mai smette di essere letta. Cinque gemelli sono rimasti
 * indietro fino al 2026-08-14 (fino a 15,75 giorni) con questo check verde su
 * di loro ogni mattina.
 *
 * Il punto strutturale, misurato: `mirror-articles-engine.yml` porta giù
 * `engine/` da solo, e il manifest tiene `engine/` `outOfScope` PROPRIO perché
 * un trasporto ce l'ha. Sorvegliato e trasportato sono quindi insiemi
 * disgiunti per costruzione — **122 voci `identical` su 122 senza trasporto
 * automatico** — e questo script è l'unica cosa che se ne accorge.
 * `stranded-twin` è quel verdetto con l'età attaccata; l'età arriva dal walk
 * di storia che la verifica di provenienza paga già.
 *
 * Un file `mode: "adapted"` non è esente dal confronto: è esente dal
 * REQUISITO DI UGUAGLIANZA. Continua a essere sorvegliato sulla baseline,
 * perché è proprio sui file adattati che una modifica del sito si perde più
 * facilmente — nessuno se ne accorge, visto che "tanto è diverso apposta".
 *
 * ## `corpus-only` vs `corpus-only-pending` (issue #125)
 *
 * `corpus-only` dice "non esiste sul sito" senza distinguere *non serve* da
 * *serve e manca*: la differenza viveva solo in prosa dentro `reason`, che non
 * fa fallire niente. `corpus-only-pending` è il grado che la rende un segnale:
 *
 *   - è sempre `actionable`, a differenza di `corpus-only` — finché il gemello
 *     non compare, c'è un lavoro tracciato (`entry.trackingIssue`) da seguire;
 *   - a differenza di `corpus-only`, QUESTO script interroga davvero il sito
 *     (`sitePath || path`): se il fetch smette di rispondere 404, il gemello è
 *     atterrato e lo stato diventa `corpus-only-pending-landed` — l'istruzione
 *     è promuovere la voce a mano (`identical`/`adapted` + `--init`), perché
 *     un contenuto appena arrivato può non essere ancora quello atteso;
 *   - se il lavoro tracciato viene abbandonato, la retromarcia è manuale: si
 *     toglie `trackingIssue` e si torna a `corpus-only`. Nessuno script lo fa
 *     da solo, per la stessa ragione per cui non mergia né riscrive: è una
 *     decisione, non una meccanica.
 *
 * ## Cosa NON fa
 *
 * Non mergia, non apre PR, non riscrive niente. Emette un report. La correzione
 * è una decisione, e questo script non ha il contesto per prenderla.
 *
 * ## L'invariante di provenienza (issue #148)
 *
 * Il confronto a tre vie sopra presume che `baseline.site`/`baseline.corpus`
 * siano stati reali, registrati da un allineamento cosciente. Non è sempre
 * vero: `scripts/lib/control-char-publish-gate.mjs` aveva una `baseline.site`
 * presa dal ramo di una PR del sito CHIUSA e mai mergiata — un valore
 * plausibile ma mai esistito su `main`. `classify()` non poteva vederlo:
 * confronta `now` contro `base`, e un `base` fabbricato produce comunque un
 * verdetto (qui `not-ported-changed`, per giunta già `actionable: false`).
 *
 * `checkBaselineProvenance()` chiude il buco cercando ogni baseline non-null
 * nella storia REALE del path (fino a `PROVENANCE_HISTORY_CAP` commit, una
 * chiamata `commits` + un fetch per candidato). Se non la trova in TUTTA la
 * storia disponibile, la entry diventa `ghost-baseline` — che sostituisce
 * il verdetto di `classify()`, perché una baseline fantasma rende quel
 * verdetto stesso privo di significato. Se la storia supera il cap senza
 * match, la entry NON viene segnalata: un mancato match parziale non è una
 * prova, ed è meglio un falso negativo raro di un falso rosso ricorrente.
 *
 * Uso:
 *   node scripts/ci/loop-drift-check.mjs             # report leggibile + exit 0
 *   node scripts/ci/loop-drift-check.mjs --json      # report JSON su stdout
 *   node scripts/ci/loop-drift-check.mjs --strict    # exit 1 se c'è drift azionabile
 *   node scripts/ci/loop-drift-check.mjs --init      # (ri)registra le baseline correnti (TUTTE le voci)
 *   node scripts/ci/loop-drift-check.mjs --init --only <path>[,<path>]
 *                                                    # ...solo quelle voci (issue #653)
 *   node scripts/ci/loop-drift-check.mjs --init --only <path> --force
 *                                                    # ...anche su quelle voci se hanno un drift
 *                                                    #    APERTO, che di default vengono SALTATE
 *                                                    #    (le altre si registrano, exit 1; issue #978)
 *   node scripts/ci/loop-drift-check.mjs --no-provenance  # salta la verifica di provenienza (iterazione locale)
 *
 * Env:
 *   SITE_REPO               default `valerielinc-ops/frontaliere-si-o-no`
 *   SITE_REF                default `main`
 *   GH_TOKEN                opzionale; senza, usa raw.githubusercontent (repo pubblico)
 *                           per i contenuti, e va incontro al rate-limit anonimo
 *                           (60/h) per le chiamate `commits` della provenienza.
 *   PROVENANCE_HISTORY_CAP  default 100 (il `per_page` massimo dell'API commits).
 *   STRANDED_AFTER_DAYS     default 3; giorni dopo i quali un `identical` fermo
 *                           in `site-ahead` diventa `stranded-twin`. Con
 *                           `--no-provenance` l'età non è disponibile e
 *                           l'escalation non avviene (fail-open).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';
import { CrossRepoRateLimitError, createRawFetcher } from '../lib/cross-repo-raw-fetch.mjs';
import { parsePositiveNum } from '../lib/parse-positive-num.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_PATH = path.join(ROOT, 'scripts/ci/loop-sync-manifest.json');
const SITE_DEFAULT_REPO = 'valerielinc-ops/frontaliere-si-o-no';
const SITE_REPO = process.env.SITE_REPO || SITE_DEFAULT_REPO;
// Il ref CANONICO del sito: l'unico su cui un hash e' la verita' del giorno.
// UNA sorgente sola (AGENTS.md #6) perche' `initAttestVerdict` deve poter dire
// «questa baseline non viene da `main`» senza duplicare la stringa.
const SITE_DEFAULT_REF = 'main';
const SITE_REF = process.env.SITE_REF || SITE_DEFAULT_REF;
// Il repo di QUESTO checkout — serve a verificare la provenienza di
// `baseline.corpus` con la stessa API usata per il sito, perché il checkout
// del workflow è `fetch-depth: 1` (vedi loop-drift-check.yml): `git log` in
// CI non vede la storia, va chiesta a GitHub.
const CORPUS_REPO = process.env.GITHUB_REPOSITORY || 'nanakokyobashi-rgb/frontaliere-articles';
const CORPUS_REF = process.env.GITHUB_SHA || 'main';
const rawFetch = createRawFetcher({ userAgent: 'loop-drift-check', token: process.env.GH_TOKEN });
// Le API di tracking hanno un verdetto diverso dalle letture raw: un 404
// legittimo di una issue chiusa/non trovata non deve poter latchare
// `tokenRejected` nello stesso fetcher usato per la provenienza dei file
// (issue #1245).
const trackingFetch = createRawFetcher({ userAgent: 'loop-drift-check-tracking', token: process.env.GH_TOKEN });
// Commit massimi esaminati a ritroso per confermare che una baseline sia
// esistita davvero. 100 è il per_page massimo dell'API commits: una singola
// richiesta, nessuna paginazione. Per i file di libreria che questo manifest
// registra (poche righe, pochi autori) è più che sufficiente; se la storia è
// più lunga del cap, un mancato match resta "non verificato", MAI "ghost" —
// vedi `ghostVerdict`.
const PROVENANCE_HISTORY_CAP = parsePositiveNum(process.env.PROVENANCE_HISTORY_CAP, 100, {
  label: 'PROVENANCE_HISTORY_CAP',
  tool: 'loop-drift-check',
  integer: true,
});
// Un walk storico puo' contenere decine di revisioni. Le letture dei blob
// sono indipendenti, ma il ciclo deve restare bounded: una Promise.all su
// tutta la storia trasformerebbe un refuso o una storia lunga in un burst
// incontrollato verso GitHub. Il batch conserva l'ordine del verdetto e paga
// al massimo una finestra oltre il primo match.
const PROVENANCE_FETCH_CONCURRENCY = 8;
// Giorni dopo i quali un gemello `identical` fermo in `site-ahead` smette di
// essere latenza e diventa un `stranded-twin` (issue #303). Vedi
// `strandedVerdict` per la calibrazione del default.
//
// Letto con `parsePositiveNum` e non con `Number(env || 3)` perche' un
// `STRANDED_AFTER_DAYS=tre` dava `NaN`, e `ageDays >= NaN` e' sempre falso:
// la classe `stranded-twin` smetteva di essere emessa, in silenzio e col
// report VERDE (issue #871 item 1). E' l'unico canale che intercetta un
// gemello `identical` fermo che nessun trasporto porterà — un blocco
// `permanent` di `transport-identical-twins.mjs` non alza niente da solo —
// quindi spegnerlo per un refuso in una variabile di repository è il modo
// piu' economico di perdere l'intera sorveglianza.
const STRANDED_AFTER_DAYS = parsePositiveNum(process.env.STRANDED_AFTER_DAYS, 3, {
  label: 'STRANDED_AFTER_DAYS',
  tool: 'loop-drift-check',
});

const RAW_ARGS = process.argv.slice(2);
const ARGS = new Set(RAW_ARGS);
const AS_JSON = ARGS.has('--json');
const STRICT = ARGS.has('--strict');
const INIT = ARGS.has('--init');
const AS_ISSUE = ARGS.has('--issue');
// `--init` su una voce con un drift APERTO lo SEPPELLISCE: scrive `now` su
// entrambi i lati e `alignedAt` di oggi senza che nessuno abbia portato il
// file, e il verdetto sparisce dal report successivo (issue #978). Di default
// quel caso e' rifiutato; `--force` e' il modo di dire ad alta voce «lo sto
// chiudendo io», che e' proprio la distinzione che al codice mancava fra
// «registro una voce nuova» e «chiudo un drift non riconciliato».
const FORCE = ARGS.has('--force');
// Opt-out per iterazione locale: la verifica di provenienza (issue #148) fa
// fino a `PROVENANCE_HISTORY_CAP` fetch aggiuntivi PER LATO PER FILE quando un
// hash e' cambiato dalla baseline. Di routine resta accesa: e' l'unica cosa
// che questo script fa per non ripetere la #148. Su `--init` spegne anche
// l'attestazione della baseline che si sta SCRIVENDO (`initAttestVerdict`):
// e' l'unico modo di registrare senza rete, e lo dice chi lancia.
const NO_PROVENANCE = ARGS.has('--no-provenance');

/**
 * I path elencati in `--only` (`--only=a,b`, oppure `--only a b`).
 *
 * Tre esiti DISTINTI, e la distinzione e' il punto (issue #978):
 * - flag assente        → `null`, cioe' «nessun filtro» = il `--init` storico;
 * - flag con path       → l'array dei path;
 * - flag SENZA path     → `[]`, cioe' «filtro chiesto e risolto vuoto».
 *
 * Prima `[]` e `null` collassavano su `null`: `--init --only` in coda,
 * `--only=`, o `--only "$VAR"` con la variabile non settata chiedevano di
 * toccare UNA voce e ne riscrivevano TRECENTO, bumpando `manifest.alignedAt`.
 * Scrivere la flag otteneva l'atto tutto-o-niente che la flag esiste per
 * evitare — un fail-open, e per giunta invisibile: il comando usciva 0.
 * `[]` non e' `null`, quindi `onlyArgError` puo' fermarlo.
 *
 * PURA: legge argv, non tocca disco ne' rete.
 */
function parseOnly(argv) {
  let present = false;
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--only') {
      present = true;
      // Forma separata: consuma i token finche' non ricomincia una flag.
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.push(argv[(i += 1)]);
    } else if (a.startsWith('--only=')) {
      present = true;
      out.push(a.slice('--only='.length));
    }
  }
  if (!present) return null;
  return out.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
}

/**
 * L'errore d'uso di `--only`, o null se l'uso e' legittimo. PURA, e separata
 * da `main()` per la stessa ragione di `parseOnly`: `main()` fa rete e
 * riscrive il manifest versionato, quindi non e' eseguibile in un test.
 *
 * @param {string[]|null} only  l'esito di `parseOnly`.
 * @param {boolean} init        se `--init` e' presente.
 * @returns {string|null}
 */
function onlyArgError(only, init) {
  if (only === null) return null;
  if (!only.length) {
    // Fail-CLOSED: chi ha scritto `--only` voleva restringere. Trattare la
    // risoluzione vuota come «nessun filtro» esegue l'atto piu' ampio
    // possibile proprio quando l'intenzione dichiarata era il contrario.
    return '`--only` non ha risolto nessun path (`--only` senza valori, `--only=`, o una variabile non settata): serve almeno un path, o si toglie la flag.';
  }
  if (!init) return '`--only` ha senso solo con `--init`: senza, il report va letto per intero.';
  return null;
}

/**
 * Quali voci `--init` deve riscrivere (issue #653).
 *
 * ## Perche' `--init` senza filtro FABBRICA le baseline fantasma
 *
 * `--init` e' tutto-o-niente: riscrive la baseline di TUTTE le voci del
 * manifest. Chi ne deve registrare una sola — il caso normale: si aggiunge un
 * file e lo si dichiara — non puo' usarlo, perche' dichiarerebbe «allineate»
 * altre trecento voci che nessuno ha letto, comprese quelle in `site-ahead`
 * che aspettano una decisione. Quindi la baseline della voce nuova viene
 * scritta A MANO, e una stringa esadecimale scritta a mano e' plausibile ma
 * non e' un hash: e' esattamente il `ghost-baseline` che
 * `checkBaselineProvenance()` scopre solo al cron successivo, dopo il merge.
 *
 * Misurato il 2026-09-05: 13 voci fantasma, 6 delle quali dichiarate DOPO
 * l'apertura della issue che ne contava 7 — la classe si ricrea da sola
 * finche' registrarne una sola resta impossibile.
 *
 * `--only` e' l'affordance mancante: scrive la baseline REALE delle sole voci
 * indicate e non tocca le altre.
 *
 * PURA e senza rete, come `ghostVerdict` e `classify`: e' questo a renderla
 * testabile offline.
 *
 * @param {string[]|null} only          i path chiesti (null → nessun filtro,
 *   `[]` → filtro chiesto e vuoto, che non tocca NIENTE).
 * @param {string[]} manifestPaths      i `path` dichiarati nel manifest.
 * @returns {{targets: Set<string>|null, unknown: string[]}} `targets` null
 *   significa «tutte», cioe' il comportamento storico di `--init`.
 */
function resolveInitTargets(only, manifestPaths) {
  // `only === null` e non `!only`: un array VUOTO significa «filtro chiesto e
  // risolto vuoto» e deve dare un target set vuoto (nessuna voce toccata), non
  // il tutto-o-niente. `onlyArgError` lo ferma prima, ma la funzione pura non
  // deve dipendere da quel chiamante per non fail-open (issue #978).
  if (only === null) return { targets: null, unknown: [] };
  const declared = new Set(manifestPaths);
  return { targets: new Set(only), unknown: only.filter((p) => !declared.has(p)) };
}

/**
 * Gli stati di `classify()` che descrivono un drift APERTO: i due lati sono
 * divergenti e nessuno li ha riconciliati. Non ci sono `stable` mascherati qui
 * dentro — sono esattamente i verdetti che chiedono a un umano di decidere.
 */
const OPEN_DRIFT_STATES = new Set([
  'site-ahead',
  'both-moved',
  'undeclared-drift',
  'removed-on-site',
  'not-ported-changed',
]);

/**
 * Se `--init` puo' riscrivere QUESTA voce, o se riscriverla seppellirebbe un
 * verdetto (issue #978).
 *
 * ## Il buco
 *
 * `--init` scrive `now` su entrambi i lati e `alignedAt` = oggi. Su una voce
 * gia' allineata e' una registrazione; su una voce in `site-ahead` o
 * `both-moved` e' la CHIUSURA di un drift che nessuno ha riconciliato: il file
 * non e' stato portato, ma il giorno dopo il report lo dice `stable`. Niente
 * nel codice distingueva i due atti, e `--only` — che esiste per abbassare la
 * frizione della registrazione singola — abbassa esattamente allo stesso modo
 * la frizione della sepoltura.
 *
 * Stessa forma per il caso simmetrico che oggi usciva come un warning dentro
 * un comando verde: registrare `identical` con i due lati DIVERSI produce un
 * `undeclared-drift` alla passata successiva, e `transportVerdict()` non copia
 * un `undeclared-drift` — il gemello esce dal trasporto senza che niente
 * fallisca. Sono lo stesso bug in due tempi, quindi hanno lo stesso guard.
 *
 * ## Perche' una voce SENZA baseline passa
 *
 * Una entry appena aggiunta ha `baseline` a null su entrambi i lati: non c'e'
 * nessun verdetto da seppellire, perche' non ce n'e' mai stato uno. E' il caso
 * d'uso primario di `--only` (issue #653) e deve restare a frizione zero,
 * altrimenti la baseline torna a scriversi a mano — cioe' torna la classe
 * `ghost-baseline`. Per la stessa ragione un `adapted` nuovo, che ha i due
 * lati diversi PER COSTRUZIONE, non e' un caso bloccato.
 *
 * PURA: nessuna rete, nessun disco. E' cio' che la rende verificabile offline.
 *
 * @param {{mode: string}} entry
 * @param {{site: string|null, corpus: string|null}} now
 * @param {{site: string|null, corpus: string|null}|null} base
 * @param {string} state  lo `state` di `classify()` PRIMA della riscrittura.
 * @returns {{blocked: boolean, why: string}}
 */
function initWriteVerdict(entry, now, base, state) {
  const baseSite = base && base.site != null ? base.site : null;
  const baseCorpus = base && base.corpus != null ? base.corpus : null;
  const registered = baseSite !== null || baseCorpus !== null;

  if (registered && OPEN_DRIFT_STATES.has(state)) {
    return {
      blocked: true,
      why:
        `drift APERTO (\`${state}\`): riscrivere la baseline lo chiude senza che nessuno abbia ` +
        'riconciliato i due lati, e il verdetto sparisce dal report successivo. Porta il file (o ' +
        'riapplica la modifica sopra l\'adattamento), POI registra la baseline; se il drift lo stai ' +
        'chiudendo davvero tu, dillo con `--force`.',
    };
  }

  if (entry.mode === 'identical' && now.site !== null && now.corpus !== null && now.site !== now.corpus) {
    return {
      blocked: true,
      why:
        'registrerebbe `identical` con i due lati DIVERSI: la prossima passata lo leggera\' ' +
        '`undeclared-drift` e il trasporto smettera\' di copiarlo. Riallinea il file, marcalo ' +
        '`adapted` con la sua ragione, oppure conferma con `--force`.',
    };
  }

  return { blocked: false, why: '' };
}

/**
 * La baseline che `--init` sta per SCRIVERE e' attestata dal sito, o e' solo
 * quello che una GET ha risposto? (issue #978)
 *
 * ## Il buco
 *
 * `checkBaselineProvenance()` vive sul percorso NON-init: il ramo `--init`
 * scrive e fa `continue` prima di arrivarci. E anche se ci arrivasse sarebbe
 * un no-op per costruzione — appena scritta, `baseline === now`, quindi
 * `ghostVerdict` chiude su `matchedAt: 'current'` senza guardare niente. La
 * verifica di provenienza sa dire se una baseline VECCHIA e' mai esistita; non
 * sa dire niente su una baseline che nasce in questo istante.
 *
 * Quindi qualunque cosa `siteFile()` abbia risposto diventa «la verita' del
 * giorno»: un `SITE_REF` puntato a un branch o a un fork, una raw servita dalla
 * CDN da una revisione vecchia, un ref che si muove a meta' passata. Il valore
 * e' un hash valido di byte reali — semplicemente non e' l'hash del file che il
 * sito ha su `main`, ed e' esattamente la forma del `ghost-baseline` di #148,
 * fabbricata da un comando invece che a mano. `--only` restringe il danno a una
 * voce, non lo esclude.
 *
 * ## L'attestazione
 *
 * L'inventario dell'albero (`git/trees?recursive=1`, UNA richiesta) porta il
 * git blob SHA di ogni path: e' una seconda sorgente, l'API invece della CDN.
 * Se i byte scaricati sono davvero il blob che l'albero dichiara a quel path,
 * la baseline e' attestata. Se non lo sono, quei byte non stanno su
 * `SITE_REPO@SITE_REF` — e registrarli e' precisamente la fabbricazione.
 *
 * ## Perche' NON e' sbloccabile con `--force`
 *
 * `--force` significa «questo drift lo sto chiudendo io»: e' un'affermazione
 * sul lavoro fatto, che chi lancia puo' fare. «Questo hash e' quello vero del
 * sito» non lo puo' affermare nessuno guardando il terminale, quindi darglielo
 * da confermare sarebbe solo un modo di far sparire il rifiuto. L'unica uscita
 * e' `--no-provenance`, che non finge di verificare: dice che non si verifica.
 *
 * PURA: prende i fatti gia' raccolti e non fa rete, come `ghostVerdict` e
 * `corpusOnlyTwinVerdict`. E' questo a renderla testabile offline.
 *
 * @param {object} a
 * @param {string|null} a.siteBaseline  l'hash che si sta per scrivere in
 *   `baseline.site`; null (`corpus-only`, `corpus-only-pending`, file assente
 *   dal sito) → non c'e' niente da attestare.
 * @param {string} a.sitePath           il path atteso sul sito.
 * @param {string} a.siteRef            `SITE_REF` di questa passata.
 * @param {string} a.defaultRef         il ref canonico (`SITE_DEFAULT_REF`).
 * @param {string[]|null} a.inventoryPaths  i path che nell'albero del sito
 *   portano il blob dei byte scaricati; `[]` = nessuno, `null` = inventario non
 *   disponibile (rete giu', albero troncato).
 * @param {boolean} a.checked           false con `--no-provenance`.
 * @returns {{blocked: boolean, why: string}}
 */
function initAttestVerdict({
  siteBaseline,
  sitePath,
  repo = SITE_REPO,
  defaultRepo = SITE_DEFAULT_REPO,
  siteRef,
  defaultRef,
  inventoryPaths,
  inventoryStatus = 'ok',
  checked,
}) {
  if (!checked) return { blocked: false, why: '' };
  if (siteBaseline == null) return { blocked: false, why: '' };

  if (repo !== defaultRepo) {
    return {
      blocked: true,
      why:
        `\`SITE_REPO\` e' \`${repo}\`, non il repo canonico \`${defaultRepo}\`: una baseline attestata ` +
        'su un fork o su un altro repository non appartiene al lato che il drift check sorveglia. ' +
        'Rimuovi `SITE_REPO` dall\'ambiente o correggilo al repo canonico.',
    };
  }

  if (siteRef !== defaultRef) {
    return {
      blocked: true,
      why:
        `\`SITE_REF\` e' \`${siteRef}\`, non \`${defaultRef}\`: l'hash registrato sarebbe quello di un ref ` +
        'che il drift check non guarda mai, cioe\' una baseline mai esistita sul lato che conta. ' +
        `Rilancia senza \`SITE_REF\` (o con \`${defaultRef}\`).`,
    };
  }

  if (inventoryStatus === 'ref-moved') {
    return {
      blocked: true,
      why:
        `il ref del sito si e' mosso durante la lettura dell'albero per \`${sitePath}\`: ` +
        'la GET raw e l\'inventario potrebbero appartenere a revisioni diverse. ' +
        'Rilancia la passata con il ref fermo prima di registrare la baseline.',
    };
  }

  if (inventoryStatus === 'truncated') {
    return {
      blocked: true,
      why:
        `l'albero GitHub del sito e' stato restituito troncato (stato \`truncated\`) mentre si attestava \`${sitePath}\`: ` +
        'un inventario ricorsivo incompleto non prova la provenienza dei byte. ' +
        'Riprova con un albero completo oppure usa `--no-provenance` dichiarando il limite.',
    };
  }

  if (inventoryPaths === null) {
    return {
      blocked: true,
      why:
        "l'inventario dell'albero del sito non e' disponibile (rete, rate-limit anonimo, o albero " +
        'troncato): i byte scaricati non sono confrontabili con nessuna seconda sorgente, e ' +
        'registrarli sarebbe credere alla CDN sulla parola. Riprova con `GH_TOKEN`, oppure ' +
        'registra senza verificare dicendolo: `--no-provenance`.',
    };
  }

  if (!inventoryPaths.includes(sitePath)) {
    const where = inventoryPaths.length ? ` (l'albero porta quel blob solo in ${inventoryPaths.map((p) => `\`${p}\``).join(', ')})` : '';
    return {
      blocked: true,
      why:
        `i byte serviti da raw.githubusercontent per \`${sitePath}\` non sono il blob che l'albero del sito ` +
        `dichiara a quel path${where}: e' una raw dalla cache, o il ref si e' mosso a meta' passata. ` +
        'Registrarli fabbricherebbe la `ghost-baseline` che il check di provenienza esiste per trovare ' +
        '(issue #148). Riprova; se e\' voluto, `--no-provenance`.',
    };
  }

  return { blocked: false, why: '' };
}

/**
 * L'errore d'uso di `--force`, o null se l'uso e' legittimo (issue #978).
 *
 * `--force` non e' «ignora i guard», e' «QUESTE voci le sto chiudendo io».
 * Senza `--only` riscriverebbe tutte e trecento le voci del manifest, comprese
 * quelle parcheggiate in `both-moved` in attesa di una riconciliazione che
 * nessuno ha fatto — cioe' esattamente la sepoltura di massa che il guard
 * esiste per impedire, ottenuta con la flag che dovrebbe renderla cosciente.
 * Nominare i path e' il costo che rende l'atto cosciente davvero.
 *
 * PURA, come `onlyArgError`.
 *
 * @param {boolean} force
 * @param {boolean} init
 * @param {string[]|null} only  l'esito di `parseOnly`.
 * @returns {string|null}
 */
function forceArgError(force, init, only) {
  if (!force) return null;
  // Stessa regola di `--only`: una flag che non ha effetto sul percorso scelto
  // e' un malinteso su cosa sta per succedere, non un no-op innocuo.
  if (!init) return '`--force` ha senso solo con `--init`: senza, non c\'e\' niente da riscrivere.';
  if (only === null || !only.length) {
    return '`--force` va nominato: serve `--init --only <path>[,<path>] --force`. Senza `--only` riscriverebbe TUTTE le voci del manifest, comprese quelle con un drift aperto che nessuno ha riconciliato.';
  }
  return null;
}

/**
 * Cosa fa la passata `--init` a livello di MANIFEST, dati i conti delle voci
 * riscritte e di quelle che il guard ha bloccato (issue #978).
 *
 * ## Perche' NON e' un rifiuto atomico
 *
 * Il primo taglio rifiutava tutto: una sola voce bloccata e il manifest non
 * veniva scritto affatto. Ma il manifest ha voci parcheggiate di proposito in
 * `both-moved` — `generator/scripts/lib/ai-models.mjs` aspetta #787 — quindi
 * `--init` globale, che e' il comando documentato nell'header, non sarebbe
 * potuto riuscire MAI PIU', e l'unico sblocco (`--force`) avrebbe riscritto
 * anche quelle: l'unico modo di usare il comando sarebbe stato la sepoltura
 * che il guard esiste per impedire.
 *
 * Quindi: si scrivono le voci passate, si lasciano INTATTE le bloccate, e il
 * rifiuto resta visibile dove conta — `manifest.alignedAt` NON viene bumpato
 * (l'allineamento non e' stato integrale, dirlo sarebbe la stessa bugia della
 * sepoltura) e l'exit e' 1, quindi nessun wrapper legge la passata come pulita.
 *
 * PURA: nessun disco.
 *
 * @param {{written: number, blocked: number, targeted: boolean}} counts
 *   `blocked` sono le voci LASCIATE INTATTE (con `--force` non ce ne sono:
 *   sono state riscritte), `targeted` se c'era un `--only`.
 * @returns {{write: boolean, bumpAlignedAt: boolean, exitCode: number}}
 */
function initPassOutcome({ written, blocked, failed = 0, targeted }) {
  return {
    // Zero voci scritte → niente da salvare: riscrivere il file identico
    // produrrebbe un commit vuoto che sembra un `--init` andato a buon fine.
    write: written > 0,
    // `manifest.alignedAt` e' la data dell'ultimo allineamento INTEGRALE: con
    // `--only` non c'e' stato, e con una voce bloccata nemmeno.
    bumpAlignedAt: !targeted && blocked === 0 && failed === 0 && written > 0,
    exitCode: blocked > 0 || failed > 0 ? 1 : 0,
  };
}

/** Costruisce una baseline init; `forcedAt` rende l'atto esplicito nel manifest. */
function initBaseline({ site, corpus, alignedAt, forcedAt = null }) {
  const baseline = { site, corpus, alignedAt };
  if (forcedAt) baseline.forcedAt = forcedAt;
  return baseline;
}

/**
 * Verifica l'invariante di `--init --only` prima di serializzare il manifest.
 * Le entry fuori filtro e le chiavi radice devono essere byte-equivalenti nella
 * loro rappresentazione JSON; solo le entry nominate possono cambiare.
 */
function initOnlyManifestUnchanged(before, after, targets) {
  if (!(targets instanceof Set)) return { ok: true, changed: [] };
  const changed = [];
  const rootKeys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of rootKeys) {
    if (key === 'files') continue;
    if (JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])) changed.push(key);
  }
  const beforeFiles = new Map((before?.files || []).map((entry) => [entry.path, entry]));
  const afterFiles = new Map((after?.files || []).map((entry) => [entry.path, entry]));
  for (const rel of new Set([...beforeFiles.keys(), ...afterFiles.keys()])) {
    if (targets.has(rel)) continue;
    if (JSON.stringify(beforeFiles.get(rel)) !== JSON.stringify(afterFiles.get(rel))) {
      changed.push(`files:${rel}`);
    }
  }
  return { ok: changed.length === 0, changed };
}

const ONLY = parseOnly(RAW_ARGS);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

/** Hash del file locale, o del blob committato durante `--init`. */
function localHash(rel, { committed = false } = {}) {
  const p = path.join(ROOT, rel);
  if (committed) {
    let bytes;
    try {
      bytes = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 });
    } catch {
      if (!fs.existsSync(p)) return null;
      throw new Error(`il file del corpus esiste nel working tree ma non in HEAD (${rel}): committalo prima di --init`);
    }
    if (!fs.existsSync(p)) {
      throw new Error(`il file del corpus e' assente dal working tree ma presente in HEAD (${rel}): ripristinalo prima di --init`);
    }
    const workingHash = sha256(fs.readFileSync(p));
    const committedHash = sha256(bytes);
    if (workingHash !== committedHash) {
      throw new Error(`il file del corpus e' diverso da HEAD (${rel}): committalo prima di --init`);
    }
    return committedHash;
  }
  if (!fs.existsSync(p)) return null;
  return sha256(fs.readFileSync(p));
}

/**
 * Contenuto del file dal sito al ref dato. Il repo è pubblico, quindi
 * raw.githubusercontent basta e non consuma rate-limit autenticato.
 * 404 → null (il file non esiste più là: è un segnale, non un errore).
 */
async function siteFile(rel) {
  const url = `https://raw.githubusercontent.com/${SITE_REPO}/${SITE_REF}/${rel}`;
  const res = await rawFetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${rel} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function scalarFingerprintVerdict(entry, { site, corpus }) {
  const spec = entry.scalarFingerprint;
  if (!spec) return { checked: false, valid: true, matches: true };
  const parse = (raw, side) => {
    if (!raw) return { error: `fingerprint ${side} mancante` };
    try {
      const value = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
      if (value?.version !== 1 || !Number.isInteger(value.scalarFields) || value.scalarFields <= 0 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) {
        return { error: `fingerprint ${side} malformata` };
      }
      return { value };
    } catch {
      return { error: `fingerprint ${side} malformata` };
    }
  };
  const siteParsed = parse(site, 'sito');
  const corpusParsed = parse(corpus, 'corpus');
  if (siteParsed.error || corpusParsed.error) return { checked: true, valid: false, matches: false, detail: siteParsed.error || corpusParsed.error };
  const siteValue = siteParsed.value;
  const corpusValue = corpusParsed.value;
  if (siteValue.scalarFields !== corpusValue.scalarFields || siteValue.sha256 !== corpusValue.sha256) {
    return { checked: true, valid: true, matches: false, detail: 'fingerprint scalare diversa fra sito e corpus' };
  }
  if (siteValue.scalarFields !== spec.scalarFields || siteValue.sha256 !== spec.sha256) {
    return { checked: true, valid: false, matches: false, detail: 'fingerprint scalare incoerente con il digest dichiarato nel manifest' };
  }
  return { checked: true, valid: true, matches: true };
}

/**
 * Cerca `targetHash` nelle revisioni storiche di `filePath` su `repo`@`ref`
 * (issue #148). Prende la lista dei commit che hanno toccato quel path (una
 * sola chiamata, `per_page` = cap) e ne hasha il contenuto uno per uno,
 * fermandosi al primo match.
 *
 * Ritorna `{ match, exhausted, checked }`:
 *   - `match`     true se un blob storico combacia con `targetHash`.
 *   - `exhausted` true se la lista dei commit ricevuta è TUTTA la storia
 *     disponibile per quel path (nessuna pagina oltre il cap, letto dal
 *     header `Link`). Un `match: false` con `exhausted: false` NON è una
 *     prova di niente — la storia non esaminata potrebbe contenerlo.
 *   - `checked`   quanti commit sono stati effettivamente hashati (utile nei
 *     report, per distinguere "un commit solo" da "cento").
 */
async function repoHistoryMatch({
  repo,
  ref,
  filePath,
  targetHash,
  cap = PROVENANCE_HISTORY_CAP,
  fetcher = rawFetch,
}) {
  const perPage = Math.min(cap, 100);
  const url = `https://api.github.com/repos/${repo}/commits?path=${encodeURIComponent(filePath)}&sha=${encodeURIComponent(ref)}&per_page=${perPage}`;
  const res = await fetcher(url, { Accept: 'application/vnd.github+json' });
  if (!res.ok) throw new Error(`GET commits ${repo}/${filePath} → HTTP ${res.status}`);
  const exhausted = !(res.headers.get('link') || '').includes('rel="next"');
  const commits = await res.json();

  let checked = 0;
  let readable = 0;
  for (let start = 0; start < commits.length; start += PROVENANCE_FETCH_CONCURRENCY) {
    const batch = commits.slice(start, start + PROVENANCE_FETCH_CONCURRENCY);
    const inspected = await Promise.all(batch.map(async (commit) => {
      const rawUrl = `https://raw.githubusercontent.com/${repo}/${commit.sha}/${filePath}`;
      const r = await fetcher(rawUrl);
      // 404 a una revisione storica capita per rinomine/spostamenti: non è un
      // errore, è semplicemente un punto della storia dove il path non esisteva
      // sotto questo nome. Si prosegue con gli altri commit.
      if (!r.ok) return { readable: false, hash: null };
      return { readable: true, hash: sha256(Buffer.from(await r.arrayBuffer())) };
    }));

    checked += inspected.length;
    readable += inspected.filter((observation) => observation.readable).length;
    for (let offset = 0; offset < inspected.length; offset += 1) {
      const observation = inspected[offset];
      if (!observation.readable) continue;
      const commit = batch[offset];
      // `matchedDate` — la data del commit PIÙ RECENTE il cui blob è ancora la
      // baseline. I commit arrivano dal più nuovo al più vecchio e si esamina
      // il batch in quell'ordine, quindi questo è l'ultimo istante in cui quel
      // lato ERA allineato: la divergenza è cominciata subito dopo. È la misura
      // che `strandedVerdict` usa per l'età.
      if (observation.hash === targetHash) {
        return { match: true, exhausted: true, checked, readable, historyReadable: true, matchedDate: commit?.commit?.committer?.date || null };
      }
    }
  }
  return { match: false, exhausted, checked, readable, historyReadable: readable > 0, matchedDate: null };
}

/**
 * Decide se una baseline è "ghost" (issue #148): un hash registrato che non
 * corrisponde a NESSUN blob mai esistito nella storia esaminata di quel lato.
 *
 * Pura — prende i fatti già raccolti, non fa fetch. È questo a renderla
 * testabile offline con lo stesso schema di `classify()`.
 *
 *   baselineHash      l'hash registrato in manifest (null → niente da verificare).
 *   currentHash       l'hash ORA di quel lato (null se il file non esiste più).
 *   historyMatch      true/false se un fetch storico ha cercato e trovato/non
 *                      trovato un match; `undefined` se non è stata cercata
 *                      (perché `currentHash` bastava già, o per un errore di
 *                      rete che non deve produrre un falso positivo).
 *   historyExhausted  true solo se la storia cercata è TUTTA quella
 *                      disponibile: un mancato match diventa un verdetto
 *                      definitivo SOLO in questo caso, altrimenti resta
 *                      "non verificato" — mai un falso rosso per un file con
 *                      più storia di quanta ne sia stata esaminata.
 *   historyReadable   false quando tutte le revisioni interrogate hanno
 *                     risposto 404 (per esempio dopo una rinomina): la
 *                     storia del vecchio path è esaurita, ma non è una prova
 *                     che la baseline sia fantasma.
 */
function ghostVerdict({ baselineHash, currentHash, historyMatch, historyExhausted, historyReadable = true }) {
  if (baselineHash == null) return { checked: false, ghost: false };
  if (currentHash === baselineHash) return { checked: true, ghost: false, matchedAt: 'current' };
  if (historyMatch === true) return { checked: true, ghost: false, matchedAt: 'history' };
  if (historyMatch === undefined) return { checked: false, ghost: false };
  if (historyReadable === false) return { checked: true, ghost: false, unresolved: true, historyUnreadable: true };
  if (!historyExhausted) return { checked: true, ghost: false, unresolved: true };
  return { checked: true, ghost: true };
}

/**
 * Verifica la provenienza di ENTRAMBI i lati di una entry, e chiama
 * `repoHistoryMatch` solo quando serve (il lato è cambiato dalla baseline —
 * altrimenti `currentHash === baselineHash` chiude la domanda senza rete).
 * Un fallimento di rete non genera un ghost: si segnala e si prosegue,
 * PROCEED-SAFE come il resto di questo script.
 */
async function checkBaselineProvenance(entry, now, passState = { rateLimited: false, detail: '' }) {
  const rel = entry.path;
  const sitePath = entry.sitePath || rel;
  const base = entry.baseline || {};
  const ghosts = [];
  const notes = [];
  if (passState?.rateLimited) {
    return {
      ghosts,
      detail: passState.detail || 'verifica di provenienza non eseguita: rate limit GitHub',
      siteBaselineLastSeenAt: null,
      rateLimited: true,
    };
  }
  // Ultimo istante in cui il SITO era ancora sulla baseline (vedi `matchedDate`
  // in repoHistoryMatch). Resta null quando il lato sito non si è mosso, quando
  // la baseline non è verificabile, o su errore di rete: in tutti e tre i casi
  // `strandedVerdict` non escalation, per costruzione.
  let siteBaselineLastSeenAt = null;

  async function checkSide(side, { repo, ref, filePath, baselineHash, currentHash }) {
    if (baselineHash == null) return;
    if (passState?.rateLimited) return;
    let historyMatch;
    let historyExhausted;
    let historyReadable;
    if (currentHash !== baselineHash) {
      try {
        const r = await repoHistoryMatch({ repo, ref, filePath, targetHash: baselineHash });
        historyMatch = r.match;
        historyExhausted = r.exhausted;
        historyReadable = r.historyReadable;
        if (side === 'site' && r.match) siteBaselineLastSeenAt = r.matchedDate;
        if (!r.match) {
          notes.push(
            `\`baseline.${side}\` (${baselineHash}) non combacia con l'attuale, e non e' stata trovata in ` +
              `${r.checked} revisioni storiche di \`${filePath}\` su ${repo}@${ref}` +
              `${r.exhausted ? ' (storia intera per questo path)' : ` (fermato al cap di ${PROVENANCE_HISTORY_CAP}, potrebbe essercene altra)`}.`,
          );
        }
      } catch (e) {
        if (e instanceof CrossRepoRateLimitError) {
          passState.rateLimited = true;
          passState.detail = `verifica di provenienza interrotta da rate limit GitHub: ${e.message}`;
          return;
        }
        notes.push(`verifica storica di \`baseline.${side}\` fallita: ${String(e.message || e).slice(0, 120)}`);
        return;
      }
    }
    const verdict = ghostVerdict({ baselineHash, currentHash, historyMatch, historyExhausted, historyReadable });
    if (verdict.ghost) ghosts.push(side);
  }

  await checkSide('site', { repo: SITE_REPO, ref: SITE_REF, filePath: sitePath, baselineHash: base.site, currentHash: now.site });
  await checkSide('corpus', { repo: CORPUS_REPO, ref: CORPUS_REF, filePath: rel, baselineHash: base.corpus, currentHash: now.corpus });

  return {
    ghosts,
    detail: notes.join(' '),
    siteBaselineLastSeenAt,
    rateLimited: Boolean(passState?.rateLimited),
    rateLimitDetail: passState?.detail || '',
  };
}

function provenanceRateLimitVerdict(entry, now, detail, normalVerdict = null) {
  const rateLimitNote = `${detail || 'La verifica storica non ha potuto leggere GitHub.'} Le entry successive restano non verificate nella stessa passata.`;
  const verdict = normalVerdict || {
    state: 'provenance-rate-limited',
    actionable: true,
    headline: 'provenienza non verificata: rate limit GitHub',
  };
  return {
    path: entry.path,
    mode: entry.mode,
    ...verdict,
    actionable: true,
    ...(normalVerdict ? { provenanceState: 'provenance-rate-limited' } : {}),
    detail: [verdict.detail, rateLimitNote].filter(Boolean).join(' '),
    hashes: { ...now, baseline: entry.baseline || {} },
  };
}

/**
 * Un gemello `identical` è fermo in `site-ahead` da troppo tempo? (issue #303)
 *
 * ## Il buco che chiude
 *
 * `classify()` dice CHI si è mosso, mai DA QUANTO. Per `site-ahead` la
 * differenza è tutto: un file che il sito ha toccato ieri è latenza normale —
 * qualcuno lo porterà — mentre uno fermo da due settimane non sta aspettando
 * nessuno, perché **non esiste un trasporto che lo porti**. I due casi
 * producono oggi la stessa riga, nella stessa issue, ogni giorno: e una riga
 * che non cambia mai smette di essere letta. È così che cinque gemelli sono
 * rimasti indietro fino al 2026-08-14 con il drift check verde su di loro ogni
 * mattina.
 *
 * ## Perché non è un doppione del mirror
 *
 * `mirror-articles-engine.yml` porta giù `engine/` da solo, e il manifest lo
 * dichiara `outOfScope` PROPRIO per quello ("hanno gia' un canale di discesa
 * AUTOMATICO"). L'insieme sorvegliato e l'insieme trasportato sono quindi
 * disgiunti per costruzione: misurato il 2026-08-14, **122 voci `identical` su
 * 122 non hanno nessun trasporto automatico**, e l'unica cosa che si accorge
 * che una è rimasta indietro è questo script. Che finora non guardava l'età.
 *
 * ## La soglia
 *
 * Il check gira una volta al giorno, quindi sotto le 24h un `site-ahead` non
 * significa ancora niente. `STRANDED_AFTER_DAYS` default 3 — sopra la latenza
 * del cron, sopra un fine settimana, e calibrato sui cinque casi reali del
 * 2026-08-14: divergenti da 2,50 / 2,50 / 3,88 / 5,96 / 15,75 giorni. A 3
 * giorni i tre più vecchi si accendono e i due appena mossi restano latenza —
 * che è esattamente la separazione voluta.
 *
 * ## Perché `identical` e basta
 *
 * Un `adapted` in `site-ahead` non è "fermo": non è copiabile, e la sua riga
 * chiede già di rileggere la modifica e riapplicarla a mano. Alzare la voce
 * sull'età lì produrrebbe rumore su un lavoro che ha un'istruzione diversa.
 *
 * Pura, come `ghostVerdict`: prende i fatti raccolti e non fa rete. È questo a
 * renderla testabile offline.
 *
 * @param {object} a
 * @param {string} a.mode                   il `mode` della voce di manifest
 * @param {string} a.state                  il verdetto di `classify()`
 * @param {string|null} a.baselineLastSeenAt data ISO dell'ultimo commit del sito
 *   ancora sulla baseline; null se sconosciuta → MAI stranded (fail-open, come
 *   il resto dello script: un dato mancante non deve produrre un rosso).
 * @param {number} a.nowMs
 * @param {number} a.thresholdDays
 * @returns {{stranded: boolean, ageDays: number|null}}
 */
function strandedVerdict({ mode, state, baselineLastSeenAt, nowMs = Date.now(), thresholdDays = STRANDED_AFTER_DAYS }) {
  if (mode !== 'identical' || state !== 'site-ahead') return { stranded: false, ageDays: null };
  const seenMs = baselineLastSeenAt ? Date.parse(baselineLastSeenAt) : NaN;
  if (!Number.isFinite(seenMs)) return { stranded: false, ageDays: null };
  const ageDays = (nowMs - seenMs) / 86_400_000;
  // Una data nel FUTURO (clock skew, o una baseline registrata da un commit
  // non ancora visibile) darebbe un'età negativa: non è stranded, è un dato che
  // non si sa leggere. Stessa fail-open del ramo sopra.
  if (!(ageDays >= 0)) return { stranded: false, ageDays: null };
  return { stranded: ageDays >= thresholdDays, ageDays };
}

/**
 * Git blob SHA-1 di un buffer — `sha1("blob <len>\0" + bytes)`, la stessa
 * identità che GitHub espone nell'albero di un repo. Serve a confrontare un
 * file LOCALE con l'inventario del sito senza scaricare nemmeno un byte di
 * contenuto: la sola API `git/trees?recursive=1` porta già gli SHA di tutti i
 * blob, in UNA richiesta.
 */
function gitBlobSha(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/**
 * Il punto cieco che `corpus-only` apre, e che nessuna classe copriva.
 *
 * `classify()` esce sul ramo `corpus-only` alla PRIMA riga, senza mai
 * interrogare il sito: la dichiarazione "non esiste là" viene creduta per
 * sempre, e se un giorno smette di essere vera nessuno se ne accorge. Il file
 * resta fuori dalla sorveglianza mentre i due lati sono già gemelli, e una fix
 * su un lato lascia l'altro rotto in silenzio.
 *
 * Misurato il 2026-08-14 su 62 voci `corpus-only`: DUE avevano già un gemello
 * byte-identico sul sito — `generator/scripts/lib/headline-selection-protocol.mjs`
 * e `generator/scripts/lib/cross-section-dedup.mjs`, entrambe atterrate in
 * `scripts/lib/` del sito.
 *
 * Il confronto è per CONTENUTO e non per path, ed è questo a renderlo capace di
 * vedere ciò che un fetch su `path` non vedrebbe: quei due file vivono a un
 * path DIVERSO sui due lati, quindi un `siteHash(path)` avrebbe risposto 404 e
 * confermato la classificazione sbagliata. È la stessa forma del punto cieco di
 * `alert-pat-down.mjs` e di `SiteShellContract`: un legame che non ha la forma
 * che il guard sa seguire.
 *
 * PURA: prende i fatti già raccolti e non fa rete, come `ghostVerdict` e
 * `strandedVerdict`. È questo a renderla testabile offline e deterministica.
 *
 * @param {object} a
 * @param {string} a.mode          il `mode` della voce di manifest
 * @param {string} [a.path]        path del file in QUESTO repo
 * @param {string|null} a.blobSha  git blob SHA del file in QUESTO repo; null se
 *   assente o illeggibile → mai un verdetto (fail-open)
 * @param {string} [a.sitePath]    path dichiarato sul sito, se diverso
 * @param {boolean} [a.trackingIssueClosed] abilita il controllo di un pending
 * @param {Map<string,string[]>|null} a.siteBlobIndex  blobSha → path sul sito.
 *   null quando l'inventario non è disponibile (rete giù, `--no-provenance`):
 *   fail-open, come tutto il resto dello script.
 * @returns {{misclassified: boolean, sitePaths: string[]}}
 */
function corpusOnlyTwinVerdict({ mode, path: corpusPath, blobSha, sitePath, trackingIssueClosed = false, siteBlobIndex }) {
  // `corpus-only-pending` resta silenzioso finche' la issue e' aperta: il
  // lavoro e' gia' tracciato. Una issue chiusa senza promozione, invece, e'
  // proprio il caso in cui il backstop deve tornare a guardare.
  if (mode !== 'corpus-only' && !(mode === 'corpus-only-pending' && trackingIssueClosed)) return { misclassified: false, sitePaths: [] };
  if (!blobSha || !siteBlobIndex) return { misclassified: false, sitePaths: [] };
  const contentPaths = [...new Set(siteBlobIndex.get(blobSha) || [])];
  const sitePaths = new Set(contentPaths);
  // Un contenuto ADATTATO non condivide lo sha: per quello si guarda anche la
  // presenza del path dichiarato. Per `corpus-only` il path atteso e' quello
  // della voce; per un pending puo' essere il `sitePath` alternativo.
  const expectedPath = sitePath || corpusPath;
  const pathIndex = siteBlobIndex.paths || new Set([...siteBlobIndex.values()].flat());
  const pathMatch = expectedPath && pathIndex.has(expectedPath);
  if (pathMatch) sitePaths.add(expectedPath);
  if (!sitePaths.size) return { misclassified: false, sitePaths: [] };
  return { misclassified: true, sitePaths: [...sitePaths].sort(), contentPaths, pathMatch: Boolean(pathMatch) };
}

/**
 * Inventario dei blob del sito: `blobSha → [path, ...]`. UNA richiesta per
 * l'intero albero. Fail-open: qualunque problema (rete, troncamento, HTTP)
 * restituisce null, e `corpusOnlyTwinVerdict` con `siteBlobIndex` null non
 * emette nessun verdetto. Un inventario a metà darebbe FALSI NEGATIVI
 * silenziosi, quindi un albero `truncated` viene scartato invece che usato.
 */
async function siteBlobIndex() {
  const url = `https://api.github.com/repos/${SITE_REPO}/git/trees/${SITE_REF}?recursive=1`;
  const res = await rawFetch(url, { Accept: 'application/vnd.github+json' });
  if (!res.ok) return { status: 'unavailable', reason: `HTTP ${res.status}` };
  const tree = await res.json();
  if (tree?.truncated) return { status: 'truncated', reason: 'GitHub ha troncato l’albero ricorsivo' };
  if (!tree || !Array.isArray(tree.tree)) return { status: 'unavailable', reason: 'risposta GitHub senza albero' };
  const index = new Map();
  const shaByPath = new Map();
  for (const node of tree.tree) {
    if (node.type !== 'blob' || !node.sha) continue;
    shaByPath.set(node.path, node.sha);
    if (!index.paths) index.paths = new Set();
    index.paths.add(node.path);
    const at = index.get(node.sha);
    if (at) at.push(node.path);
    else index.set(node.sha, [node.path]);
  }
  return { status: 'ok', index, shaByPath, treeSha: tree.sha || null };
}

/** Rilegge il blob autorevole del tree, non la risposta raw/CDN. */
let siteCommitShaPromise;

/** SHA del commit risolto dal ref, necessario per il fallback dei blob grandi. */
async function siteRefCommitSha() {
  if (!siteCommitShaPromise) {
    siteCommitShaPromise = (async () => {
      try {
        const res = await rawFetch(
          `https://api.github.com/repos/${SITE_REPO}/commits/${encodeURIComponent(SITE_REF)}`,
          { Accept: 'application/vnd.github+json' },
        );
        if (!res.ok) return null;
        const payload = await res.json();
        return typeof payload?.sha === 'string' ? payload.sha : null;
      } catch {
        return null;
      }
    })();
  }
  return siteCommitShaPromise;
}

async function siteGitBlob(blobSha, { sitePath } = {}) {
  const url = `https://api.github.com/repos/${SITE_REPO}/git/blobs/${blobSha}`;
  try {
    const res = await rawFetch(url, { Accept: 'application/vnd.github+json' });
    if (!res.ok) return null;
    const payload = await res.json();
    if (payload?.encoding === 'base64' && typeof payload.content === 'string') {
      return Buffer.from(payload.content, 'base64');
    }
    // GitHub risponde `encoding: none` senza contenuto per blob grandi. Il ref
    // va prima risolto a un COMMIT SHA: il tree SHA dell'inventario non e' un
    // commit-ish accettato da raw.githubusercontent. Il chiamante ricontrolla
    // comunque il blob SHA-1 dei byte riletti.
    if (payload?.encoding !== 'none' || !sitePath) return null;
    const commitSha = await siteRefCommitSha();
    if (!commitSha) return null;
    const immutable = await rawFetch(`https://raw.githubusercontent.com/${SITE_REPO}/${commitSha}/${sitePath}`);
    if (!immutable.ok) return null;
    return Buffer.from(await immutable.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Valida un mismatch raw/tree con una seconda lettura autorevole.
 * Se il ref cambia tra due tree, il verdetto è un rilancio, non un rifiuto dei
 * byte: non si possono confrontare due revisioni diverse nella stessa passata.
 */
async function initInventoryVerdict({ siteBytes, sitePath, inventory, refresh }) {
  if (!inventory || inventory.status !== 'ok') {
    return { paths: null, status: inventory?.status || 'unavailable' };
  }
  const rawSha = gitBlobSha(siteBytes);
  const paths = inventory.index.get(rawSha) || [];
  if (paths.includes(sitePath)) return { paths, status: 'ok' };

  const treeSha = inventory.shaByPath.get(sitePath);
  if (!treeSha) return { paths, status: 'ok' };

  const fresh = await refresh();
  if (
    fresh?.status === 'ok' &&
    inventory.treeSha &&
    fresh.treeSha &&
    inventory.treeSha !== fresh.treeSha
  ) {
    return { paths: null, status: 'ref-moved' };
  }

  const authoritative = await siteGitBlob(treeSha, { sitePath });
  if (!authoritative || gitBlobSha(authoritative) !== treeSha) {
    return { paths: null, status: 'unavailable' };
  }
  return { paths: [], status: 'mismatch-confirmed' };
}

/** True solo quando una issue di tracking risponde esplicitamente `closed`. */
async function trackingIssueClosed(trackingIssue) {
  if (typeof trackingIssue !== 'string') return false;
  let match;
  try {
    match = new URL(trackingIssue).pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/);
  } catch {
    return false;
  }
  if (!match) return false;
  const [, owner, repo, number] = match;
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${number}`;
  try {
    const res = await trackingFetch(url, { Accept: 'application/vnd.github+json' });
    if (!res.ok) return false;
    const issue = await res.json();
    return issue?.state === 'closed';
  } catch {
    return false;
  }
}

/**
 * I due `mode` che dichiarano il file ASSENTE dal sito. `not-ported` e'
 * l'opposto (il sito ce l'ha, qui deliberatamente no) e non blocca niente.
 */
const ABSENT_ON_SITE_MODES = new Set(['corpus-only', 'corpus-only-pending']);

/**
 * Import RELATIVI di un modulo, risolti a path repo-relative e filtrati su
 * cio' che il manifest conosce. PURA: prende il testo, non legge il disco.
 *
 * La regex e' quella di `loop-scripts-closure.test.mjs`, con `export ... from`
 * in piu': solo import a inizio riga (una riga di PROSA che cita un import in
 * un commento non e' una dipendenza), e clausola `[^'";]*?` invece di `.*?`
 * perche' senza `\n` nella classe negata un import BRACED SU PIU' RIGHE viene
 * visto — e' la forma con cui quel guard era cieco su 6 specificatori reali.
 *
 * @param {string} rel     path del file importatore, relativo alla radice
 * @param {string} source  testo del file
 * @param {(candidate: string) => boolean} known  candidato -> il manifest lo conosce
 * @returns {string[]} path repo-relative dei moduli importati e riconosciuti
 */
function resolvedLocalImports(rel, source, known) {
  const re = /^[ \t]*(?:import|export)(?:\s+|(?=[{*'"]))(?:[^'";]*?[\s}*]from\s*)?(['"])([^'"]+)\1/gm;
  const dir = path.posix.dirname(rel);
  const out = [];
  let m;
  while ((m = re.exec(source))) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue; // i pacchetti non hanno un gemello da dichiarare
    const base = path.posix.normalize(path.posix.join(dir, spec));
    // Gli specificatori del ciclo portano l'estensione, ma engine/ e host/
    // usano la forma senza: si prova la stessa risoluzione di Node.
    // I rami `.ts` non sono decorativi: engine/ e host/ sono TypeScript (25
    // voci `.ts` nel manifest), e in TypeScript l'import relativo si scrive
    // senza estensione. Senza `${base}.ts` un modulo raggiunto in quella forma
    // non veniva riconosciuto affatto, quindi la contraddizione che questo
    // scanner esiste per vedere — una voce `identical` che importa un file
    // dichiarato assente dal sito — restava invisibile proprio sull'albero in
    // cui la forma senza estensione e' la norma (#1032).
    // `.ts` PRIMA di `.mjs`/`.js`: la collisione esiste gia' nell'albero
    // (`host/shared/viteAssetHashRx.mjs` e `.ts` sono due voci di manifest
    // distinte, e `host/shared/chunkFiles.ts` importa './viteAssetHashRx').
    // Con i gemelli JS per primi `manifestDepsOf()` attribuiva la dipendenza
    // al gemello SBAGLIATO: finche' entrambi sono `identical` il verdetto
    // coincide per caso, ma appena uno passa a `corpus-only`
    // `unmirrorableDepsVerdict()` (e `transportVerdict()`, che decide la
    // DIREZIONE del mirror) leggerebbe il `mode` dell'altro file. I rami di
    // fallback si attivano solo per un importatore TypeScript (`.ts`/`.tsx`):
    // un `.mjs` sotto Node non puo' scrivere quella forma, quindi far vincere
    // `.ts` e' sicuro solo quando l'importatore lo consente davvero.
    const tsImporter = ['.ts', '.tsx'].includes(path.posix.extname(rel).toLowerCase());
    const candidates = [
      base,
      ...(tsImporter ? [`${base}.ts`] : []),
      `${base}.mjs`,
      `${base}.js`,
      ...(tsImporter ? [`${base}/index.ts`] : []),
      `${base}/index.mjs`,
      `${base}/index.js`,
    ];
    const hit = candidates.find(known);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/**
 * La contraddizione che il manifest puo' dichiarare senza accorgersene: una
 * voce `identical` che importa un modulo dichiarato ASSENTE dal sito (issue
 * #892).
 *
 * Le due dichiarazioni sono coerenti una per una e si contraddicono insieme.
 * `identical` vuol dire "il file la' e' lo stesso, quindi e' copiabile nei due
 * versi"; ma copiarlo porterebbe sul sito un `import` di un modulo che li' non
 * esiste, cioe' un `ERR_MODULE_NOT_FOUND` a carico dei suoi consumer. Il
 * mirror non e' "da fare": e' IMPOSSIBILE finche' la dipendenza resta
 * corpus-only.
 *
 * Senza questo verdetto il file compare come `corpus-ahead` — "modificato qui,
 * fermo sul sito, candidato a risalire" — che e' la riga esatta che invita
 * alla riparazione impossibile. E' successo su
 * `generator/scripts/lib/article-free-mt.mjs` dopo #878: la fix di #831/#868
 * gli ha dato un import di `body2-payload-verdict.mjs`, `corpus-only` e
 * assente sul sito (404).
 *
 * PURA come `ghostVerdict` e `strandedVerdict`: prende i fatti gia' raccolti.
 *
 * @param {object} a
 * @param {string} a.mode  il `mode` della voce di manifest
 * @param {Array<{path: string, mode: string|undefined}>} [a.deps]  dipendenze
 *   locali gia' risolte. Vuoto = nessun verdetto (fail-open: un file
 *   illeggibile o un import che non risolve non deve produrre un rosso).
 * @returns {{blocked: boolean, deps: Array<{path: string, mode: string}>}}
 */
function unmirrorableDepsVerdict({ mode, deps = [] }) {
  // Solo `identical`. `adapted` DICHIARA gia' di differire, e una dipendenza
  // corpus-only e' uno dei modi legittimi di differire: segnalarla sarebbe
  // rumore su 27 voci che stanno bene come sono (misura del 2026-09-05).
  if (mode !== 'identical') return { blocked: false, deps: [] };
  const blocked = (deps || [])
    .filter((d) => d && ABSENT_ON_SITE_MODES.has(d.mode))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { blocked: blocked.length > 0, deps: blocked };
}

/**
 * Il registro delle dichiarazioni appaiate al TESTO di un file sorvegliato.
 *
 * `DECLARED_ABSENT` di `loop-references-exist.test.mjs` e' indicizzato per
 * `<file citante> :: <referente assente>`: ogni voce dice «QUESTO file nomina
 * un path che non esiste qui, ed ecco perche' va bene». La chiave e' quindi
 * appaiata alla PROSA del citante, non alla sua API.
 */
const DECLARED_ABSENT_REGISTRY_REL = 'generator/tests/loop-references-exist.test.mjs';

/**
 * Il registro non fa valere TUTTE le sue voci. `ACTIVE_DECLARED_ABSENT`
 * (`loop-references-exist.test.mjs`) le filtra: quando il contract crawler
 * cross-repo esiste, le 24 dichiarazioni sui workflow `crawler-group-NN.yml` e
 * `translate-pending.yml` diventano DORMIENTI — nessun test le fa piu' valere,
 * quindi una copia che ne rompe una non manda rosso niente e non c'e' niente
 * da avvisare. Riderivarle qui produrrebbe un avviso che sbaglia su meta' dei
 * suoi hit, e un avviso che sbaglia meta' delle volte smette di essere letto:
 * cioe' il silenzio che questo modulo esiste per rompere.
 *
 * La regex e' duplicata dal registro e NON puo' essere importata: il registro
 * e' un file di test, importarlo da uno script CI ne eseguirebbe la suite. Il
 * legame e' quindi coperto da un test (AGENTS.md #6) —
 * `loop-manifest-implicit-pinners.test.mjs` confronta questa sorgente con il
 * testo del registro e diventa rosso se una delle due si muove.
 */
const CRAWLER_CONTRACT_REL = 'generator/data/crawler-cross-repo-contract.json';
const DORMANT_WITH_CRAWLER_CONTRACT = /^\.github\/workflows\/(?:crawler-group-\d{2}|translate-pending)\.yml :: /;

function crawlerContractIsActive(source) {
  try {
    return Boolean(JSON.parse(String(source ?? '')));
  } catch {
    return false;
  }
}

/**
 * I file che hanno una dichiarazione appaiata nel registro, con i loro
 * referenti. PURA: prende il testo del registro, non legge il disco.
 *
 * Il parse e' testuale — le chiavi sono literal in un oggetto letterale — e
 * per questo e' pinnato da `loop-manifest-implicit-pinners.test.mjs` sul
 * registro REALE: se la forma cambia, il test diventa rosso invece di lasciare
 * il rilevatore silenziosamente a zero, che sarebbe un «nessuna dipendenza
 * implicita» indistinguibile da «non ho saputo leggere».
 *
 * @param {string} source  il testo di `loop-references-exist.test.mjs`
 * @param {object} [o]
 * @param {boolean} [o.crawlerContract]  il contract crawler esiste? Se si', le
 *   chiavi che `ACTIVE_DECLARED_ABSENT` spegne restano fuori dall'indice.
 * @returns {Map<string,string[]>} file citante -> referenti dichiarati assenti
 */
function declaredAbsentCiters(source, { crawlerContract = false } = {}) {
  const out = new Map();
  for (const m of String(source || '').matchAll(/^\s*(['"`])((?:(?!\1)[^\n])+?) :: ((?:(?!\1)[^\n])+?)\1:/gm)) {
    const citer = m[2];
    // Una voce dormiente non e' fatta valere da nessun test: avvisarne sarebbe
    // un falso positivo, non una cautela.
    if (crawlerContract && DORMANT_WITH_CRAWLER_CONTRACT.test(citer + ' :: ' + m[3])) continue;
    const at = out.get(citer);
    if (at) at.push(m[3]);
    else out.set(citer, [m[3]]);
  }
  return out;
}

/**
 * La dipendenza IMPLICITA che il manifest non puo' vedere, perche' sorveglia i
 * file uno per uno (issue #975, item 4 di #900).
 *
 * `unmirrorableDepsVerdict` copre la dipendenza ESPLICITA: un `import` e' una
 * riga di codice, e la si legge. Ma un file trasportato ha anche accoppiamenti
 * che non hanno la forma di un import — la classe «un legame che non ha la
 * forma che il guard sa seguire», la stessa di `SiteShellContract`. Qui la
 * forma e' una DICHIARAZIONE appaiata al testo: una voce di `DECLARED_ABSENT`
 * esiste solo finche' il file continua a citare quel referente, e
 * `loop-references-exist.test.mjs` ha DUE test che la fanno valere in tutti e
 * due i versi — «nessuna dichiarazione morta» se la citazione sparisce, e il
 * gate delle citazioni non dichiarate se ne compare una nuova.
 *
 * Portare giu' dal sito un gemello `identical` ne riscrive il testo. Se la
 * versione del sito ha perso quella citazione, o ne ha aggiunta un'altra verso
 * un path che qui non esiste, la copia isolata manda ROSSO un test che vive in
 * un file `corpus-only` — cioe' fuori dall'insieme trasportabile per sempre.
 * E' la PR di trasporto rossa che resta aperta e spegne il canale, la stessa
 * di `permanentBlock`, con un accoppiamento che quel guard non guarda.
 *
 * ## Perche' un avviso sul `site-ahead` e non un blocco
 *
 * Rimisura del 2026-09-08 su `main`, contate le sole dichiarazioni ATTIVE (cioe'
 * al netto di quelle che `ACTIVE_DECLARED_ABSENT` spegne col contract
 * crawler): **20 delle 159 voci `identical`** hanno almeno una dichiarazione
 * appaiata (70 dichiarazioni attive su 142, 37 file citanti su 61). Il registro e'
 * `corpus-only`, quindi non entrera' MAI nell'insieme trasportabile: trattare
 * la coppia come bloccante spegnerebbe il 13% del canale in modo permanente — l'eccesso opposto, e peggiore, del silenzio di oggi. E il
 * legame e' CONDIZIONALE: si rompe solo se la copia cambia proprio quelle
 * righe, il che non si sa prima di averla fatta.
 *
 * Quindi non un nuovo stato ma un avviso agganciato al `site-ahead`, cioe'
 * esattamente nella finestra in cui la copia sta per essere fatta: chi la fa
 * sa che deve portarsi dietro la dichiarazione. Il verdetto NON cambia lo
 * stato, e in particolare non tocca `transportVerdict`, che continua a vedere
 * `site-ahead` e a lavorare come prima.
 *
 * PURA come `ghostVerdict`, `strandedVerdict` e `unmirrorableDepsVerdict`.
 *
 * @param {object} a
 * @param {string} a.mode     il `mode` della voce di manifest
 * @param {string} a.state    lo stato gia' calcolato dal confronto degli hash
 * @param {string[]} [a.pinners]  i referenti dichiarati per questo file. Vuoto
 *   = nessun verdetto (fail-open, come tutto il resto dello script).
 * @returns {{pinned: boolean, pinners: string[]}}
 */
function implicitPinnersVerdict({ mode, state, pinners = [] }) {
  // Solo un `identical` in `site-ahead`: e' l'unica combinazione in cui una
  // copia sta davvero per riscrivere il testo. Su `adapted` la copia non
  // avviene (va riapplicata a mano) e l'avviso sarebbe rumore.
  if (mode !== 'identical' || state !== 'site-ahead') return { pinned: false, pinners: [] };
  const found = [...new Set((pinners || []).filter(Boolean))].sort();
  return { pinned: found.length > 0, pinners: found };
}

/** Indice cache-ato: citante -> referenti dichiarati assenti, invalidato dal testo. */
let PINNER_INDEX = null;
let PINNER_INDEX_KEY = null;
function pinnerIndex() {
  let registrySource = null;
  let contractSource = null;
  try {
    registrySource = fs.readFileSync(path.join(ROOT, DECLARED_ABSENT_REGISTRY_REL), 'utf8');
  } catch {
    // Fail-open: registro assente o illeggibile = nessun avviso, mai un rosso.
  }
  try {
    contractSource = fs.readFileSync(path.join(ROOT, CRAWLER_CONTRACT_REL), 'utf8');
  } catch {
    // File assente = contract inattivo; il valore viene comunque nella chiave.
  }
  const key = String(registrySource ?? '<missing>') + '\u0000' + String(contractSource ?? '<missing>');
  if (PINNER_INDEX && PINNER_INDEX_KEY === key) return PINNER_INDEX;

  PINNER_INDEX_KEY = key;
  PINNER_INDEX = registrySource === null
    ? new Map()
    : declaredAbsentCiters(registrySource, {
      crawlerContract: crawlerContractIsActive(contractSource),
    });
  return PINNER_INDEX;
}

function resetPinnerIndex() {
  PINNER_INDEX = null;
  PINNER_INDEX_KEY = null;
}

/** Le dichiarazioni appaiate di UNA voce, lette dal registro. */
function implicitPinnersOf(entry) {
  if (!entry || entry.mode !== 'identical' || !entry.path) return [];
  return pinnerIndex().get(entry.path) || [];
}

/**
 * La coda che l'avviso aggiunge al `detail` del `site-ahead`. Stringa vuota
 * quando non c'e' niente da dire, cosi' il testo di prima resta identico.
 */
function implicitPinnersDetail({ pinned, pinners }) {
  if (!pinned) return '';
  const names = pinners.map((r) => `\`${r}\``).join(', ');
  return (
    ` ATTENZIONE — dipendenza IMPLICITA: \`${DECLARED_ABSENT_REGISTRY_REL}\` porta ${pinners.length} ` +
    `dichiarazione/i \`DECLARED_ABSENT\` appaiate al TESTO di questo file (${names}). Quel registro e' ` +
    "`corpus-only`, quindi non scende mai insieme alla copia: se la versione del sito ha perso una di " +
    'quelle citazioni la dichiarazione diventa morta, se ne ha aggiunta una nuova va dichiarata. ' +
    'Aggiorna il registro NELLA STESSA PR della copia, o la PR di trasporto resta rossa.'
  );
}

/**
 * La coda dell'avviso per UNA voce che il chiamante sa essere in `site-ahead`.
 * Esiste perche' il `detail` del `site-ahead` viene ricostruito da zero in DUE
 * altri punti — il ramo `scalarFingerprint` e l'escalation `stranded-twin` —
 * e li' la coda che `classify()` aggiunge verrebbe buttata via.
 */
function implicitPinnersTail(entry) {
  return implicitPinnersDetail(
    implicitPinnersVerdict({ mode: entry.mode, state: 'site-ahead', pinners: implicitPinnersOf(entry) }),
  );
}

/** Indice `path -> mode` del manifest, letto una volta sola. */
let MODE_INDEX = null;
function modeIndex() {
  if (!MODE_INDEX) MODE_INDEX = new Map(readManifest().files.map((f) => [f.path, f.mode]));
  return MODE_INDEX;
}

/**
 * Le dipendenze dichiarate di UNA voce, lette dal disco. Sta qui e non nel
 * chiamante perche' `classify()` ha DUE chiamanti — `main()` e
 * `transportVerdict()` di `transport-identical-twins.mjs`, che passa tre
 * argomenti — e un default calcolato dal chiamante avrebbe coperto solo il
 * primo: il trasporto avrebbe continuato a copiare sopra il file la versione
 * del sito, che e' la direzione che cancella il lavoro.
 *
 * Fail-open su ogni errore di lettura: `unmirrorableDepsVerdict` con `deps`
 * vuoto non emette nessun verdetto.
 */
function manifestDepsOf(entry) {
  if (!entry || entry.mode !== 'identical' || !entry.path) return [];
  try {
    const source = fs.readFileSync(path.join(ROOT, entry.path), 'utf8');
    const index = modeIndex();
    return resolvedLocalImports(entry.path, source, (c) => index.has(c)).map((p) => ({ path: p, mode: index.get(p) }));
  } catch {
    return [];
  }
}

/**
 * Classifica UN file. Ritorna {state, actionable, headline, detail}.
 *
 * `actionable` distingue ciò che richiede una decisione da ciò che è solo
 * cronaca: un report che segnala tutto non viene letto.
 */
function classify(entry, now, base, deps = manifestDepsOf(entry), pinners = implicitPinnersOf(entry)) {
  const { path: rel, mode, reason } = entry;

  if (mode === 'corpus-only') {
    return { state: 'corpus-only', actionable: false, headline: 'solo su questo repo', detail: reason || '' };
  }

  if (mode === 'corpus-only-pending') {
    // A differenza di `corpus-only`, qui `now.site` NON è forzato a null: il
    // fetch è stato eseguito davvero (vedi main()), perché la domanda utile è
    // proprio "è ancora assente?". Un 404 che persiste è lo stato normale
    // finché il lavoro tracciato non atterra — non un errore da segnalare come
    // `removed-on-site` (quel branch presume un file che ESISTEVA ed è stato
    // tolto, che è una storia diversa da "non è mai esistito").
    const tracking = entry.trackingIssue ? ` Tracciato in ${entry.trackingIssue}.` : ' ATTENZIONE: nessun `trackingIssue` dichiarato.';
    if (now.site !== null) {
      return {
        state: 'corpus-only-pending-landed',
        actionable: true,
        headline: "il gemello atteso e' comparso sul sito — pronta la promozione",
        detail:
          `${reason || ''}${tracking} Il fetch su ${entry.sitePath || rel} non risponde piu' 404: verifica che il ` +
          "contenuto sia quello atteso, poi promuovi la voce a `identical`/`adapted` e rigenera la " +
          'baseline con `node scripts/ci/loop-drift-check.mjs --init`.',
      };
    }
    return {
      state: 'corpus-only-pending',
      actionable: true,
      headline: "il sito dovrebbe avere questo file — non ce l'ha ancora",
      detail: `${reason || ''}${tracking}`,
    };
  }

  if (now.site === null) {
    // Il file non è (più) raggiungibile sul sito. Il messaggio DEVE distinguere
    // i due casi, perché la reazione è opposta: se qui il file esiste va deciso
    // se rimuoverlo, se qui non esiste è la voce di manifest a essere stale.
    // Nota: `path` deve puntare a un FILE, mai a una cartella — raw.github
    // risponde 404 per le directory e una voce puntata male atterrerebbe qui
    // travestita da rimozione.
    const hereToo = now.corpus !== null;
    return {
      state: 'removed-on-site',
      actionable: true,
      headline: hereToo ? 'rimosso sul sito, ancora presente qui' : 'assente su entrambi i lati',
      detail: hereToo
        ? 'Il sito non ha piu\' questo file. Va rimosso anche qui, oppure e\' stato spostato e il manifest va aggiornato col nuovo path.'
        : 'Ne\' il sito ne\' questo repo hanno il file: la voce di manifest e\' stale, oppure `path` punta a una CARTELLA invece che a un file (raw.githubusercontent risponde 404 sulle directory). Correggi il path o rimuovi la voce.',
    };
  }

  if (mode === 'not-ported') {
    const moved = now.site !== base.site;
    return {
      state: moved ? 'not-ported-changed' : 'not-ported-stable',
      actionable: false,
      headline: moved ? 'non portato — ed e\' cambiato sul sito' : 'non portato (deliberato)',
      detail: reason || '',
    };
  }

  if (now.corpus === null) {
    return {
      state: 'missing-here',
      actionable: true,
      headline: 'dichiarato nel manifest ma assente qui',
      detail: 'Il manifest lo elenca come portato, ma il file non esiste. Portalo, o marcalo `not-ported` con una ragione.',
    };
  }

  // Issue #892: prima di dire CHI si e' mosso, si dice se il mirror e'
  // possibile. Una voce `identical` che importa un modulo assente dal sito e'
  // una contraddizione del manifest, e vale a prescindere dagli hash: il
  // verdetto sul movimento (`corpus-ahead`, "candidato a risalire al sito")
  // manderebbe a fare una copia che sul sito non si carica.
  const unmirrorable = unmirrorableDepsVerdict({ mode, deps });
  if (unmirrorable.blocked) {
    const names = unmirrorable.deps.map((d) => `\`${d.path}\` (${d.mode})`).join(', ');
    return {
      state: 'identical-unmirrorable',
      actionable: true,
      headline: 'marcato `identical`, ma importa un modulo che il sito non ha',
      detail:
        `Import verso ${names}: copiare questo file sul sito ci porterebbe un \`import\` che li' non risolve, ` +
        "e romperebbe i suoi consumer con un `ERR_MODULE_NOT_FOUND`. Il mirror non e' da fare: e' impossibile " +
        'finche\' la dipendenza resta assente. Tre uscite: portare anche la dipendenza sul sito e promuoverla, ' +
        'riclassificare QUESTA voce `adapted` con la `reason` che nomina la dipendenza, oppure estrarre la parte ' +
        'condivisa in un modulo terzo `identical` su entrambi i lati.',
    };
  }

  const siteMoved = now.site !== base.site;
  const corpusMoved = now.corpus !== base.corpus;

  if (!siteMoved && !corpusMoved) {
    // Caso a parte: `identical` che NON e' identico gia' alla baseline. Vuol
    // dire che il manifest e' stato registrato su uno stato gia' divergente.
    if (mode === 'identical' && now.site !== now.corpus) {
      return {
        state: 'undeclared-drift',
        actionable: true,
        headline: 'marcato `identical` ma i due lati differiscono',
        detail: 'Nessuno dei due si e\' mosso dalla baseline, ma gli hash non coincidono: la baseline e\' stata registrata su uno stato gia\' divergente. Riallinea il file, oppure marcalo `adapted` spiegando perche\'.',
      };
    }
    return { state: 'stable', actionable: false, headline: 'allineato', detail: mode === 'adapted' ? reason || '' : '' };
  }

  if (siteMoved && !corpusMoved) {
    return {
      state: 'site-ahead',
      actionable: true,
      headline: 'il sito e\' andato avanti, qui no',
      detail:
        (mode === 'adapted'
          ? `Il sito ha modificato un file che qui e\' ADATTATO (${reason || 'ragione non dichiarata'}). Non e\' copiabile: la modifica va letta e riapplicata a mano sopra l'adattamento.`
          : 'Il file e\' dichiarato identico al sito: la modifica del sito e\' copiabile qui cosi\' com\'e\'.') +
        implicitPinnersDetail(implicitPinnersVerdict({ mode, state: 'site-ahead', pinners })),
    };
  }

  if (!siteMoved && corpusMoved) {
    return {
      state: 'corpus-ahead',
      actionable: true,
      headline: 'modificato qui, fermo sul sito',
      detail:
        // Su una voce `adapted` la `reason` e' gia' la risposta alla domanda
        // che la riga pone ("si porta al sito?"), e a volte e' «non si puo'»
        // (issue #892). Ometterla lasciava il consiglio generico a invitare a
        // una risalita che il sito non puo' ricevere: `site-ahead` la stampa
        // gia' per la stessa ragione, questo verso no.
        (mode === 'adapted' ? `ADATTATO: ${reason || 'ragione non dichiarata'} ` : '') +
        'Una modifica locale che il sito non ha. Se e\' un adattamento a questo repo, aggiorna la baseline (`--init`) e dichiarala nel manifest. Se e\' un MIGLIORAMENTO del meccanismo, vale la pena proporlo al sito: e\' codice che serve a entrambi i cicli.',
    };
  }

  // Entrambi i lati si sono mossi dalla baseline, ma sono arrivati allo STESSO
  // contenuto (issue #680): non c'e' niente da riconciliare, perche' nessuno
  // dei due deve "vincere" sull'altro. Senza questo controllo, `both-moved`
  // manda in coda `needs-human` anche i casi gia' risolti da soli — rumore
  // che si accumula esattamente come il bucket da 25 file che ha fatto
  // scattare questa issue.
  if (now.site === now.corpus) {
    return {
      state: 'both-moved-converged',
      actionable: true,
      headline: 'modificato su entrambi i lati, ma i due contenuti sono gia\' identici',
      detail: 'Due modifiche indipendenti sullo stesso file dalla baseline sono arrivate allo stesso risultato: non serve leggere ne\' riconciliare niente, basta registrare la nuova baseline con `--init`.',
    };
  }

  return {
    state: 'both-moved',
    actionable: true,
    headline: 'modificato su entrambi i lati',
    detail: 'Due modifiche indipendenti sullo stesso file dalla baseline. Nessun allineamento automatico: vanno lette entrambe e riconciliate a mano.',
  };
}

async function main() {
  const onlyError = onlyArgError(ONLY, INIT);
  if (onlyError) {
    console.error(onlyError);
    return 1;
  }
  const forceError = forceArgError(FORCE, INIT, ONLY);
  if (forceError) {
    console.error(forceError);
    return 1;
  }
  const manifest = readManifest();
  const manifestBefore = JSON.parse(JSON.stringify(manifest));
  const { targets: initTargets, unknown: initUnknown } = resolveInitTargets(ONLY, manifest.files.map((f) => f.path));
  if (initUnknown.length) {
    // Un path non dichiarato e' quasi sempre un refuso, e proseguire
    // scriverebbe un manifest che NON contiene la voce che si voleva
    // registrare — cioe' il silenzio che questa flag esiste per togliere.
    console.error(`--only: path non dichiarati nel manifest: ${initUnknown.join(', ')}`);
    return 1;
  }
  const results = [];
  // Le voci che `--init` si rifiuta di riscrivere: o hanno un drift APERTO che
  // la riscrittura seppellirebbe, o diventerebbero un `identical` divergente.
  // Prima erano, rispettivamente, niente e un warning dentro un comando verde
  // (issue #978). `--force --only` le sblocca a una a una, ma allora lo dice
  // chi lancia. Le altre voci si scrivono comunque: vedi `initPassOutcome()`.
  const initBlocked = [];
  const initWritten = [];
  const initFailed = [];
  // Il rate limit di una singola verifica storica invalida la provenienza del
  // resto della passata: continuare a interrogarla produce note duplicate e
  // un report falsamente verde. Le entry restanti vengono marcate esplicitamente
  // come non verificate e il pass diventa actionable.
  const provenancePass = { rateLimited: false, detail: '' };
  // Inventario dell'albero del sito, chiesto UNA volta sola e solo se una voce
  // ha davvero un lato sito da attestare: `--init --only` su una `corpus-only`
  // non deve pagare una richiesta. `undefined` = mai chiesto, `null` = chiesto
  // e non disponibile (che per `initAttestVerdict` e' un rifiuto, non un
  // fail-open: e' una baseline che si sta SCRIVENDO).
  let initInventory;
  let initInventoryRefresh;
  const initSiteBlobIndex = async ({ refresh = false } = {}) => {
    if (!refresh && initInventory !== undefined) return initInventory;
    if (refresh && initInventoryRefresh?.fromTreeSha === initInventory?.treeSha) {
      return initInventoryRefresh.promise;
    }
    const fetchInventory = (async () => {
      try {
        return await siteBlobIndex();
      } catch {
        return { status: 'unavailable', reason: 'errore di rete' };
      }
    })();
    if (refresh) {
      const fromTreeSha = initInventory?.treeSha || null;
      let refreshRecord;
      const promise = fetchInventory.then((fresh) => {
        // Un refresh fallito non deve cancellare l'inventario valido: il
        // verdetto corrente può ancora leggere il blob autorevole del tree
        // precedente, e le voci successive non devono ereditare un falso buio.
        if (fresh?.status === 'ok') initInventory = fresh;
        else if (initInventoryRefresh === refreshRecord) initInventoryRefresh = null;
        return fresh;
      });
      refreshRecord = { fromTreeSha, promise };
      initInventoryRefresh = refreshRecord;
      return promise;
    }
    initInventory = await fetchInventory;
    return initInventory;
  };

  for (const entry of manifest.files) {
    const rel = entry.path;
    const sitePath = entry.sitePath || rel;
    const base = entry.baseline || { site: null, corpus: null };

    // `--init --only`: le voci fuori target non si toccano E non si
    // interrogano — il salto sta PRIMA di `siteHash()`, altrimenti
    // registrarne una costerebbe comunque trecento fetch.
    if (INIT && initTargets && !initTargets.has(rel)) continue;

    let now;
    // I BYTE, non solo l'hash: su `--init` servono per attestare la baseline
    // contro l'inventario dell'albero del sito (`initAttestVerdict`).
    let siteBytes = null;
    try {
      siteBytes = entry.mode === 'corpus-only' ? null : await siteFile(sitePath);
      now = {
        site: siteBytes === null ? null : sha256(siteBytes),
        corpus: localHash(rel, { committed: INIT }),
      };
    } catch (e) {
      // Una fetch fallita non deve rendere il report inutile: si segnala il
      // file come non verificato e si va avanti.
      results.push({ path: rel, mode: entry.mode, state: 'check-failed', actionable: false, headline: `verifica fallita: ${String(e.message).slice(0, 80)}`, detail: '' });
      if (INIT) initFailed.push({ path: rel, reason: String(e.message || e).slice(0, 120) });
      continue;
    }

    if (INIT) {
      // Il verdetto va calcolato PRIMA della riscrittura: dopo, `now` e' anche
      // la baseline e ogni voce e' `stable` per costruzione — che e' esattamente
      // il modo in cui un drift aperto spariva.
      const guard = initWriteVerdict(entry, now, base, classify(entry, now, base).state);
      let forcedAt = null;
      if (guard.blocked) {
        initBlocked.push({ path: rel, why: guard.why, forceable: true });
        // Con `--force` si scrive lo stesso, ma il blocco resta stampato: la
        // conferma esplicita non deve rendere l'atto silenzioso. Senza, si
        // salta QUESTA voce e basta: la sua baseline resta quella di prima e
        // le altre vengono registrate lo stesso.
        if (!FORCE) continue;
        forcedAt = new Date().toISOString();
      }

      // `corpus-only` e `corpus-only-pending` non hanno un sito da tracciare:
      // per il secondo, `now.site` puo' essere non-null (il gemello e' appena
      // atterrato) ma scriverlo qui lo farebbe come effetto collaterale di un
      // `--init` di routine, saltando la verifica del contenuto che il report
      // richiede esplicitamente. La promozione resta un atto cosciente: cambia
      // il `mode` a mano, POI `--init` registra la baseline vera.
      const siteBaseline = (entry.mode === 'corpus-only' || entry.mode === 'corpus-only-pending') ? null : now.site;

      // La baseline che sta per essere scritta e' attestata dall'albero del
      // sito, o e' solo cio' che una GET ha risposto? Il controllo di
      // provenienza non puo' rispondere (vedi `initAttestVerdict`), e questo e'
      // il solo punto del programma in cui la domanda ha ancora senso: dopo la
      // scrittura, la risposta e' la baseline.
      let inventoryPaths = null;
      let inventoryStatus = 'ok';
      if (!NO_PROVENANCE && siteBaseline !== null && siteBytes !== null) {
        const inventory = await initSiteBlobIndex();
        const attested = await initInventoryVerdict({
          siteBytes,
          sitePath,
          inventory,
          refresh: () => initSiteBlobIndex({ refresh: true }),
        });
        inventoryPaths = attested.paths;
        inventoryStatus = attested.status;
      }
      const attest = initAttestVerdict({
        siteBaseline,
        sitePath,
        repo: SITE_REPO,
        defaultRepo: SITE_DEFAULT_REPO,
        siteRef: SITE_REF,
        defaultRef: SITE_DEFAULT_REF,
        inventoryPaths,
        inventoryStatus,
        checked: !NO_PROVENANCE,
      });
      if (attest.blocked) {
        // Non sbloccabile con `--force`: nessuno puo' CONFERMARE che un hash e'
        // quello vero del sito guardando il terminale. L'uscita e'
        // `--no-provenance`, che dichiara di non verificare.
        initBlocked.push({ path: rel, why: attest.why, forceable: false });
        continue;
      }

      entry.baseline = initBaseline({
        site: siteBaseline,
        corpus: now.corpus,
        // L'allineamento di QUESTA voce e' di OGGI: e' oggi che ne stiamo
        // scrivendo l'hash. Ereditare `manifest.alignedAt` le darebbe la data
        // dell'ultimo `--init` INTEGRALE, che con `--only` per questa voce non
        // e' mai avvenuto e che in una passata parziale (issue #978) non viene
        // nemmeno bumpato: la baseline sarebbe di oggi con la data di ieri.
        alignedAt: new Date().toISOString().slice(0, 10),
        forcedAt,
      });
      initWritten.push(rel);
      continue;
    }

    let verdict = classify(entry, now, base);
    if (entry.scalarFingerprint && (verdict.state === 'stable' || verdict.state === 'site-ahead')) {
      let fingerprint;
      try {
        fingerprint = scalarFingerprintVerdict(entry, {
          site: await siteFile(entry.scalarFingerprint.sitePath),
          corpus: fs.existsSync(path.join(ROOT, entry.scalarFingerprint.corpusPath))
            ? fs.readFileSync(path.join(ROOT, entry.scalarFingerprint.corpusPath))
            : null,
        });
      } catch (e) {
        fingerprint = { checked: true, valid: false, matches: false, detail: `lettura fingerprint fallita: ${String(e.message || e).slice(0, 120)}` };
      }
      if (!fingerprint.valid) {
        verdict = { state: 'check-failed', actionable: true, headline: 'confronto fingerprint scalare non verificabile', detail: fingerprint.detail };
      } else if (fingerprint.matches) {
        verdict = { state: 'stable', actionable: false, headline: 'allineato sul contratto scalare', detail: entry.reason || '' };
      } else {
        // Il `detail` e' costruito da zero, quindi la coda dell'avviso va
        // riappesa a mano: senza, un `identical` con dipendenze implicite
        // perde l'avviso proprio dove la copia sta per essere fatta.
        verdict = {
          state: 'site-ahead',
          actionable: true,
          headline: 'il contratto scalare del sito e andato avanti, qui no',
          detail: fingerprint.detail + implicitPinnersTail(entry),
        };
      }
    }

    // Issue #148: un file assente da un lato non produce un confronto in
    // `classify()`, quindi una baseline fabbricata (presa da un ramo mai
    // mergiato, o da uno stato mai committato) può restare verde per sempre —
    // è successo davvero con `scripts/lib/control-char-publish-gate.mjs`,
    // registrato `not-ported` (quindi già `actionable: false` per
    // costruzione) con un hash che non ha mai corrisposto a niente su `main`
    // del sito. Questo controllo è ORTOGONALE al verdetto sopra: anche una
    // entry che `classify()` giudica innocua puo' nascondere una baseline
    // fantasma, e qui la si scopre a prescindere dal `mode`.
    let provenance = { ghosts: [], detail: '', rateLimited: false, rateLimitDetail: '', siteBaselineLastSeenAt: null };
    if (!NO_PROVENANCE) {
      if (provenancePass.rateLimited) {
        provenance = { ...provenance, rateLimited: true, rateLimitDetail: provenancePass.detail };
      } else {
        try {
          provenance = await checkBaselineProvenance(entry, now, provenancePass);
        } catch (e) {
          // PROCEED-SAFE: un controllo di provenienza rotto non deve inghiottire
          // il resto del report.
          provenance = { ...provenance, detail: `verifica di provenienza fallita: ${String(e.message || e).slice(0, 120)}` };
        }
      }
    }

    if (provenance.ghosts.length) {
      results.push({
        path: rel,
        mode: entry.mode,
        state: 'ghost-baseline',
        actionable: true,
        headline: `baseline.${provenance.ghosts.join(' e baseline.')} non corrisponde a nessun blob mai esistito`,
        detail: [provenance.detail, provenance.rateLimitDetail].filter(Boolean).join(' '),
        hashes: { ...now, baseline: base },
      });
    } else if (provenance.rateLimited) {
      // Il verdetto locale resta valido: il rate limit impedisce solo la prova
      // storica, non cancella drift o convergenza già calcolati in memoria.
      results.push(provenanceRateLimitVerdict(
        entry,
        now,
        [provenance.detail, provenance.rateLimitDetail].filter(Boolean).join(' '),
        verdict,
      ));
    } else {
      // Issue #303: un `identical` in `site-ahead` da oltre la soglia non è
      // latenza, è un gemello che nessun trasporto porta. Escalation del solo
      // `state` (headline/detail compresi): il verdetto sottostante resta
      // vero — il sito è andato avanti — e questo ne aggiunge l'età, che è
      // l'unica cosa che distingue "arriverà" da "non arriverà mai".
      const stranded = strandedVerdict({
        mode: entry.mode,
        state: verdict.state,
        baselineLastSeenAt: provenance.siteBaselineLastSeenAt,
      });
      if (stranded.stranded) {
        const days = stranded.ageDays.toFixed(1);
        results.push({
          path: rel,
          mode: entry.mode,
          state: 'stranded-twin',
          actionable: true,
          headline: `dichiarato identico al sito, ma fermo indietro da ${days} giorni`,
          detail:
            `Il sito ha lasciato la baseline il ${provenance.siteBaselineLastSeenAt} e qui non e' mai sceso niente ` +
            `(soglia: ${STRANDED_AFTER_DAYS} giorni, \`STRANDED_AFTER_DAYS\`). Nessun workflow porta questo path: ` +
            `\`mirror-articles-engine.yml\` si ferma a \`engine/\`, che il manifest tiene \`outOfScope\` proprio perche' ` +
            "quello un trasporto ce l'ha. Copia la versione del sito (`sitePath`) e aggiorna a mano la baseline di QUESTA voce." +
            // `stranded-twin` e' un `site-ahead` con l'eta' misurata, e il
            // report lo mette in cima con 🚨: e' la riga che qualcuno copiera'
            // a mano, quindi e' quella che ha PIU' bisogno dell'avviso.
            implicitPinnersTail(entry),
          hashes: { ...now, baseline: base },
          ageDays: stranded.ageDays,
        });
      } else {
        results.push({ path: rel, mode: entry.mode, ...verdict, hashes: { ...now, baseline: base } });
      }
    }
  }

  if (INIT) {
    for (const { path: rel, why } of initBlocked) console.error(`  ⚠ ${rel}: ${why}`);
    // Con `--force` le bloccate sono state riscritte lo stesso: non restano
    // «intatte», quindi non contano come rifiuto (ma il blocco resta stampato).
    // `--force` copre i blocchi FORCEABILI (il drift che chi lancia dichiara di
    // star chiudendo), non l'attestazione della baseline: quella resta un
    // rifiuto anche con `--force`, quindi continua a contare come non scritta.
    const forced = FORCE ? initBlocked.filter((b) => b.forceable).length : 0;
    const skipped = initBlocked.length - forced;
    const outcome = initPassOutcome({
      written: initWritten.length,
      blocked: skipped,
      failed: initFailed.length,
      targeted: Boolean(initTargets),
    });
    if (forced) {
      console.error(`--init --force: ${forced} voce/i riscritte NONOSTANTE il blocco qui sopra.`);
    }
    if (outcome.bumpAlignedAt) manifest.alignedAt = new Date().toISOString().slice(0, 10);
    if (initTargets) {
      const invariant = initOnlyManifestUnchanged(manifestBefore, manifest, initTargets);
      if (!invariant.ok) {
        console.error(`--init --only: sono cambiate entry fuori filtro (${invariant.changed.join(', ')}): manifest non scritto.`);
        return 1;
      }
    }
    if (outcome.write) {
      fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(`Baseline registrate per ${initWritten.length} file: ${initWritten.join(', ')}.`);
    }
    if (skipped) {
      // Le voci bloccate restano com'erano — nessun `alignedAt` bumpato,
      // nessun verdetto sepolto — ma la passata non e' pulita e non deve
      // sembrarlo: exit 1, cosi' un wrapper che guarda solo l'exit code lo
      // vede. Il resto del manifest e' scritto, altrimenti UNA voce
      // parcheggiata in `both-moved` renderebbe `--init` globale impossibile
      // per sempre e l'unica via d'uscita sarebbe la sepoltura di massa.
      console.error(
        `--init: ${skipped} voce/i NON riscritte (baseline lasciata intatta); ` +
          `${initWritten.length} registrate, \`manifest.alignedAt\` non bumpato. ` +
          'Riconcilia i due lati, oppure rilancia `--init --only <path> --force` sulle SOLE voci di cui stai chiudendo tu il drift. ' +
          "I rifiuti di ATTESTAZIONE (baseline non confermata dall'albero del sito) `--force` non li copre: si risolvono con `GH_TOKEN`/un ritentativo, oppure si dichiarano con `--no-provenance`.",
      );
    }
    if (initFailed.length) {
      console.error(
        `--init: ${initFailed.length} voce/i non verificate per errore di lettura: ` +
          initFailed.map(({ path: rel, reason }) => `${rel} (${reason})`).join('; '),
      );
      if (!initWritten.length && !skipped) {
        console.error(`--init: nessuna voce registrata: ${initFailed.length} non verificate.`);
      }
    }
    return outcome.exitCode;
  }

  // Passata a parte, DOPO il ciclo principale: le voci `corpus-only` escono da
  // `classify()` senza mai toccare il sito, quindi la loro classificazione non
  // è verificata da niente. Qui si verifica per CONTENUTO — l'unica chiave che
  // regge quando il gemello vive a un path diverso sui due lati, che è proprio
  // il caso in cui la dichiarazione sbagliata sopravvive. Costo: UNA richiesta
  // per l'intero albero del sito, non una per file.
  const corpusOnly = manifest.files.filter((e) => e.mode === 'corpus-only');
  const pending = manifest.files.filter((e) => e.mode === 'corpus-only-pending');
  if (!INIT && (corpusOnly.length || pending.length)) {
    const closedPending = new Set();
    for (const entry of pending) {
      if (await trackingIssueClosed(entry.trackingIssue)) closedPending.add(entry.path);
    }
    const candidates = [...corpusOnly, ...pending.filter((entry) => closedPending.has(entry.path))];
    let index = null;
    try {
      const inventory = await siteBlobIndex();
      index = inventory?.status === 'ok' ? inventory.index : null;
    } catch {
      index = null; // PROCEED-SAFE: senza inventario nessun verdetto, mai un falso rosso.
    }
    for (const entry of candidates) {
      // Il normale fetch su `sitePath || path` ha già prodotto questo stato:
      // non duplicare la stessa riga nel backstop per inventario.
      if (entry.mode === 'corpus-only-pending' && results.some((r) => r.path === entry.path && r.state === 'corpus-only-pending-landed')) continue;
      let blobSha = null;
      try {
        const abs = path.join(ROOT, entry.path);
        if (fs.existsSync(abs)) blobSha = gitBlobSha(fs.readFileSync(abs));
      } catch {
        blobSha = null;
      }
      const twin = corpusOnlyTwinVerdict({
        mode: entry.mode,
        path: entry.path,
        sitePath: entry.sitePath,
        trackingIssueClosed: closedPending.has(entry.path),
        blobSha,
        siteBlobIndex: index,
      });
      if (!twin.misclassified) continue;
      // Il ciclo principale può avere già registrato lo stesso pending come
      // assente sul path dichiarato. Il backstop per contenuto/path lo
      // sostituisce con un solo verdetto, non aggiunge una riga contraddittoria.
      const pendingIndex = results.findIndex(
        (r) => r.path === entry.path && (r.state === 'corpus-only' || r.state === 'corpus-only-pending'),
      );
      if (pendingIndex >= 0) results.splice(pendingIndex, 1);
      results.push({
        path: entry.path,
        mode: entry.mode,
        state: entry.mode === 'corpus-only-pending' ? 'corpus-only-pending-landed' : 'corpus-only-twin',
        actionable: true,
        headline: `dichiarato \`${entry.mode}\`, ma il sito ha una copia non dichiarata in ${twin.sitePaths.map((p) => `\`${p}\``).join(', ')}`,
        detail:
          "`classify()` esce sul ramo `corpus-only` senza mai interrogare il sito: finche' la voce " +
          "dice 'non esiste la\'', il file resta fuori da ogni sorveglianza. " +
          (twin.contentPaths.length
            ? 'L\'inventario ha trovato anche lo stesso blob, eventualmente a un path DIVERSO: un fetch su `path` non lo avrebbe visto.'
            : 'L\'inventario ha trovato il path dichiarato, ma il contenuto puo\' essere ADATTATO: il confronto per hash da solo non lo avrebbe visto.') +
          ' Riclassifica a `identical` (o `adapted` se la divergenza e\' voluta) con `sitePath` e la baseline dei due lati.',
        hashes: { blobSha, sitePaths: twin.sitePaths },
      });
    }
  }

  const actionable = results.filter((r) => r.actionable);

  if (AS_JSON) {
    console.log(JSON.stringify({ siteRepo: SITE_REPO, siteRef: SITE_REF, alignedAt: manifest.alignedAt, results, actionable: actionable.length }, null, 2));
  } else {
    const byState = results.reduce((acc, r) => ((acc[r.state] = (acc[r.state] || 0) + 1), acc), {});
    console.log(`Ciclo autonomo — divergenza vs ${SITE_REPO}@${SITE_REF}`);
    console.log(`Baseline dell'ultimo allineamento: ${manifest.alignedAt || '(mai registrata)'}\n`);
    console.log(`${results.length} file sorvegliati — ${Object.entries(byState).map(([k, v]) => `${k}:${v}`).join('  ')}\n`);

    if (!actionable.length) {
      console.log('Niente che richieda una decisione: i due cicli sono allineati, o divergono solo dove dichiarato.');
    } else {
      // Ordine per urgenza decisionale, non alfabetico.
      const ORDER = ['ghost-baseline', 'corpus-only-twin', 'identical-unmirrorable', 'stranded-twin', 'undeclared-drift', 'both-moved', 'both-moved-converged', 'site-ahead', 'corpus-only-pending-landed', 'missing-here', 'removed-on-site', 'corpus-ahead', 'corpus-only-pending'];
      actionable.sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state));
      for (const r of actionable) {
        console.log(`  [${r.state}] ${r.path}`);
        console.log(`      ${r.headline}`);
        if (r.detail) console.log(`      → ${r.detail}`);
        console.log('');
      }
    }
  }

  // Report su issue. Solo quando c'è qualcosa da decidere: una issue aperta a
  // ogni giro per dire "tutto a posto" smette di essere letta, ed è il modo
  // più sicuro per non accorgersi di quella che conta. La deduplica del
  // creator (prefisso del titolo) fa sì che le passate successive commentino
  // sulla stessa issue invece di aprirne una nuova.
  if (AS_ISSUE && actionable.length) {
    const section = (state, title) => {
      const rows = state === 'provenance-rate-limited'
        ? actionable.filter((r) => r.provenanceState === state)
        : actionable.filter((r) => r.state === state && r.provenanceState !== 'provenance-rate-limited');
      if (!rows.length) return '';
      return [`### ${title}`, '', ...rows.map((r) => `- \`${r.path}\` — ${r.headline}\n  ${r.detail}`), ''].join('\n');
    };
    const description = [
      `Confronto con \`${SITE_REPO}@${SITE_REF}\`, baseline dell'ultimo allineamento: **${manifest.alignedAt || '(mai registrata)'}**.`,
      '',
      `${results.length} file sorvegliati, **${actionable.length}** richiedono una decisione.`,
      '',
      section('provenance-rate-limited', '⚠️ Provenienza non verificata — verdetto locale conservato'),
      section('ghost-baseline', '💀 Baseline fantasma — mai esistita nella storia esaminata'),
      section('stranded-twin', `🚨 Gemello \`identical\` fermo indietro da oltre ${STRANDED_AFTER_DAYS} giorni — nessun trasporto lo porta`),
      section('corpus-only-twin', '🔴 Dichiarato `corpus-only`, ma il gemello esiste sul sito'),
      section('identical-unmirrorable', '🔴 Dichiarato `identical`, ma importa un modulo che il sito non ha'),
      section('undeclared-drift', '🔴 Divergenza non dichiarata'),
      section('both-moved', '🔴 Modificato su entrambi i lati'),
      section('both-moved-converged', '🟢 Modificato su entrambi i lati, ma gia\' convergente — solo da ri-baselinare'),
      section('site-ahead', '⬇️ Il sito è andato avanti — da portare qui'),
      section('corpus-only-pending-landed', '🟢 Il gemello atteso è arrivato sul sito — pronta la promozione'),
      section('missing-here', '⚠️ Dichiarato nel manifest ma assente'),
      section('removed-on-site', '⚠️ Non più sul sito'),
      section('corpus-ahead', '⬆️ Modificato qui — candidato a risalire al sito'),
      section('corpus-only-pending', '⏳ In attesa del gemello sul sito (lavoro tracciato)'),
      '---',
      '',
      'Le classi `site-ahead` e `corpus-ahead` non sono errori: sono le due direzioni in cui il ciclo evolve. La prima è lavoro da portare, la seconda è un miglioramento locale che probabilmente serve a entrambi i cicli.',
      '',
      `\`stranded-twin\` (issue #303) è un \`site-ahead\` a cui è stata misurata l'ETÀ: un gemello dichiarato \`identical\` che il sito ha lasciato indietro da più di ${STRANDED_AFTER_DAYS} giorni. La distinzione è la sola cosa che separa "qualcuno lo porterà" da "non lo porterà nessuno", perché **nessuna** voce \`identical\` di questo manifest ha un trasporto automatico: \`mirror-articles-engine.yml\` copre \`engine/\`, e \`engine/\` è \`outOfScope\` qui proprio per quel motivo. I due insiemi sono disgiunti per costruzione, quindi per ogni file di questo manifest il trasporto è una copia a mano — e finché non la si fa, la riga qui sopra è l'unica cosa che lo dice.`,
      '',
      '`ghost-baseline` (issue #148) è diverso da tutte le altre classi: non descrive dove si è mosso il codice, dice che il DATO della baseline non è mai stato reale — verificato contro l\'intera storia disponibile del path su quel lato (o, se la storia supera il cap di ricerca, la entry non compare qui: un mancato match parziale resta silenzioso per non produrre falsi rossi). La correzione è ricalcolare la baseline dal contenuto REALE — l\'hash del blob a cui quel lato era davvero allineato alla data di `alignedAt` — e non semplicemente rilanciare `--init`, perché `--init` scrive `now`, che per una entry già rotta potrebbe anch\'esso non essere il valore che ci si aspetta. Se `now` è invece il valore giusto (la voce è nuova e non si è più mossa), `--init --only <path>` la registra da sola, senza dichiarare allineate le altre trecento (issue #653).',
      '',
      '`corpus-only-pending` non è un errore neanche lei: è un promemoria che punta a un lavoro già tracciato altrove (vedi `trackingIssue` in ogni riga). Non richiede un\'azione qui finché non diventa `-landed` — a quel punto la voce va promossa a mano.',
      '',
      'Dopo un allineamento voluto: `node scripts/ci/loop-drift-check.mjs --init` e committa il manifest.',
      '',
      '_Aperta da `scripts/ci/loop-drift-check.mjs`._',
    ].filter(Boolean).join('\n');

    await createGithubIssue({
      title: 'Loop drift: il ciclo autonomo diverge dal sito',
      description,
      priority: 3,
      labels: ['Bug'],
      workflow: 'loop-drift-check',
    });
  }

  return STRICT && actionable.length ? 1 : 0;
}

// Solo in modalita' CLI: senza guardia, importare questo modulo da un test
// eseguirebbe main() — che fa fetch di rete e, con --issue, apre/commenta
// issue sul repo. `classify` resta importabile per testare la classificazione
// senza pagare nessuno dei due.
if (process.argv[1] && process.argv[1].endsWith('loop-drift-check.mjs')) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      // PROCEED-SAFE: un checker rotto non deve rompere la CI di nessuno.
      console.error(`loop-drift-check fallito: ${e && e.stack ? e.stack : e}`);
      process.exit(STRICT ? 1 : 0);
    },
  );
}

// `siteFile` e' esportata per `transport-identical-twins.mjs` (issue #331): il
// trasporto deve leggere il sito con la STESSA sorgente di URL, ref e token del
// checker, altrimenti i due potrebbero guardare due `main` diversi.
// `sha256` e `repoHistoryMatch` sono esportate per
// `loop-baseline-pr-gate.mjs` (issue #956): il gate in PR deve pesare una
// baseline con LA STESSA regola con cui la pesa il cron, altrimenti una voce
// accettata in PR verrebbe dichiarata fantasma il mattino dopo — o peggio, il
// contrario. Una seconda copia della regola lo renderebbe inevitabile.
export { classify, parseOnly, onlyArgError, forceArgError, resolveInitTargets, initWriteVerdict, initAttestVerdict, initPassOutcome, initBaseline, initOnlyManifestUnchanged, localHash, ghostVerdict, strandedVerdict, provenanceRateLimitVerdict, corpusOnlyTwinVerdict, unmirrorableDepsVerdict, implicitPinnersVerdict, declaredAbsentCiters, crawlerContractIsActive, resetPinnerIndex, DECLARED_ABSENT_REGISTRY_REL, CRAWLER_CONTRACT_REL, DORMANT_WITH_CRAWLER_CONTRACT, resolvedLocalImports, gitBlobSha, scalarFingerprintVerdict, siteFile, sha256, repoHistoryMatch };
