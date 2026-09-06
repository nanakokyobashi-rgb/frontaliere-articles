#!/usr/bin/env node
/**
 * transport-identical-twins.mjs — il trasporto che ai gemelli `identical` del
 * manifest mancava (issue #331, follow-up di #326 e #303).
 *
 * ## Il buco che chiude
 *
 * `loop-drift-check.mjs` sa dire che un gemello `identical` è fermo indietro, e
 * da quanto (`stranded-twin`, issue #303). Non lo porta: «non mergia, non apre
 * PR, non riscrive niente». Per ognuna delle voci `identical` del manifest la
 * discesa era quindi **una copia a mano**, e il 2026-08-14 cinque gemelli erano
 * fermi fino a 15,75 giorni — fra questi `host/shared/localeEmitFilter.ts`, che
 * sul sito aveva già prodotto `/en.html` `/de.html` `/fr.html` a 404 (#5327) e
 * qui girava ancora col difetto. Il verdetto rende il ritardo visibile e datato;
 * non lo elimina.
 *
 * ## Perché QUI, e non allargando l'allowlist del mirror
 *
 * L'altra strada — estendere l'allowlist di `mirror-articles-engine.yml` (che
 * gira sul SITO) oltre `engine/` — è bloccata, e per una ragione che non scade:
 * quell'allowlist copia **directory intere**, e sotto `scripts/**`/`host/**`
 * vivono decine di file `adapted`, diversi apposta (es.
 * `scripts/ci/auto-merge-eval.mjs`, che qui ha un gate in più e sul sito
 * un'osservazione che qui non esiste). Sovrascriverli sarebbe la metà
 * distruttiva del vecchio mirror, spostata da `content/` a `generator/`. Da qui
 * la richiesta di una «prova di confinamento» equivalente a
 * `packages-articles-confinement.test.ts` prima di allargare.
 *
 * Questo script prende la direzione opposta e non ha bisogno di quella prova:
 *
 *   - **è tirato, non spinto**: gira in questo repo, che è il lato che RICEVE;
 *   - **è guidato dal manifest, file per file**: copia solo i path dichiarati
 *     `mode: "identical"`, dal loro `sitePath`. Un file `adapted` non è
 *     "protetto da un'eccezione" — non è proprio nell'insieme di partenza, e
 *     nessuna directory viene mai copiata in blocco. Il confinamento che la
 *     prova AST dimostrerebbe per un albero, qui è l'enumerazione stessa;
 *   - **copia solo `site-ahead`**: il verdetto arriva da `classify()` di
 *     `loop-drift-check.mjs`, importata, non reimplementata. Se questo lato si
 *     è mosso (`corpus-ahead`, `both-moved`, `undeclared-drift`) non si tocca
 *     niente: una divergenza a due direzioni è una decisione, e questo script
 *     non ha il contesto per prenderla — esattamente come il drift check.
 *
 * `engine/` resta fuori: è `outOfScope` nel manifest PROPRIO perché un
 * trasporto ce l'ha già (il mirror), e due canali sullo stesso path sono un
 * conflitto, non una ridondanza.
 *
 * ## L'insieme deve essere CHIUSO, non solo enumerato
 *
 * Enumerare i path `identical` confina la SCRITTURA, ma non basta a rendere
 * coerente una passata: un fixture può essere byte-identico al sito e pinnare
 * codice che qui è `adapted`/`corpus-only`. È il caso di
 * `host/tests/shell-contract-functions.golden.json`, che pinna le funzioni di
 * `host/siteShellBootstrap.ts` (composto sopra `host/htmlTemplate.ts`,
 * `host/constants.ts`, `host/shared/seoContentTokens.ts` — tutti fuori
 * dall'insieme di partenza per costruzione). Copiarlo DA SOLO fa fallire
 * `host/tests/shell-contract-functions.test.mjs`, e la PR di trasporto resta
 * aperta e non mergiabile: da lì il guard «una PR alla volta» del workflow
 * spegne ogni passata successiva e il canale si ferma SENZA che nulla
 * fallisca. Lo stesso taglio arriva dal tetto per passata, che può separare
 * un fixture dai suoi soggetti in due giri diversi.
 *
 * Per questo un fixture (golden/snapshot, o un file sotto un albero di test) si
 * copia solo se i suoi ACCOPPIAMENTI locali — i file che lo citano e i file che
 * cita — sono a loro volta `identical`. Un accoppiamento non registrato nel
 * manifest è locale per definizione, quindi vale come un no.
 *
 * E «nessun accoppiamento» vale solo se ho davvero guardato: chi cita si cerca
 * in tutto il pacchetto, non nella sola directory del fixture, e un file del
 * sottoalbero che non sono riuscito a leggere entra fra gli accoppiamenti come
 * `illeggibile` invece di sparire in un `null` indistinguibile da «non lo
 * cita» (issue #853).
 *
 * ## Cosa NON fa
 *
 * Non mergia e non decide: scrive i file e aggiorna la baseline delle sole voci
 * copiate. La PR la apre il workflow, e passa dalla review come ogni altra.
 * Senza `--apply` non scrive niente: la modalità di default è il dry-run.
 *
 * La baseline che `--apply` registra è però quella dei byte SCARICATI, scritta
 * prima che il commit esista (issue #852). A chiuderla è `--realign=<lista>`,
 * un passaggio distinto che gira sul commit appena creato e confronta la
 * baseline con i byte che ci sono finiti davvero: la riallinea dove questo
 * ricostruisce l'invariante di `classify()`, ed esce ROSSO — prima del push —
 * dove i byte committati non sono quelli del sito, perché lì la voce non è un
 * gemello byte-identico e nessuna baseline la renderebbe tale.
 *
 * ## Uso
 *
 *   node scripts/ci/transport-identical-twins.mjs            # dry-run, report
 *   node scripts/ci/transport-identical-twins.mjs --json     # dry-run, JSON
 *   node scripts/ci/transport-identical-twins.mjs --apply    # scrive + baseline
 *   node scripts/ci/transport-identical-twins.mjs --realign=<lista>
 *                                                           # dopo il commit:
 *                                                           # riallinea la
 *                                                           # baseline dai byte
 *                                                           # COMMITTATI
 *
 * Env:
 *   SITE_REPO / SITE_REF   letti da `loop-drift-check.mjs` (stessa sorgente).
 *   GH_TOKEN               opzionale; il repo del sito è pubblico.
 *   TRANSPORT_MAX_FILES    default 25; tetto di file copiati in una passata.
 *   TRANSPORT_MAX_FAILURE_RATIO  default 0.25; oltre questa frazione di fetch
 *                          fallite la passata esce ROSSA invece che verde.
 *
 * ## Uscita
 *
 * `0` anche quando non c'e' niente da portare: e' il caso normale. L'unica
 * uscita rossa e' il BUIO sul canale — troppe fetch fallite perche' il report
 * («0 da portare, N non verificati») significhi ancora qualcosa.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classify, siteFile } from './loop-drift-check.mjs';
// Dalla libreria e non da `scan-failed-runs.mjs`: quello e' una CLI che apre
// issue, e importarla per leggere un numero tira dentro
// `github-issue-creator.mjs` e le sue costanti di argv.
import { parsePositiveNum } from '../lib/parse-positive-num.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_PATH = path.join(ROOT, 'scripts/ci/loop-sync-manifest.json');

const RAW_ARGS = process.argv.slice(2);
const ARGS = new Set(RAW_ARGS);
const APPLY = ARGS.has('--apply');
const AS_JSON = ARGS.has('--json');
// `--realign=<file>` e' un PASSAGGIO A PARTE, non un'opzione della copia: gira
// sul commit gia' creato, quando i byte committati esistono. Vedi
// `realignFromCommitted`.
const REALIGN_FILE = (RAW_ARGS.find((a) => a.startsWith('--realign=')) || '').slice('--realign='.length) || null;

/**
 * Tetto per passata. Non è una difesa dai file: è una difesa dal GIORNO in cui
 * il sito rinomina mezzo albero e questo script aprirebbe una PR da 100 file
 * che nessuno rivede davvero. Oltre il tetto la passata si ferma e lo dice,
 * così la copia resta un atto leggibile.
 *
 * Validato, non solo letto: `Number('venticinque')` è `NaN`, e
 * `transported.length >= NaN` è sempre falso — il tetto SPARIREBBE invece di
 * fallire, che è il contrario di quello che una difesa deve fare quando la si
 * configura male (stessa classe degli override malformati di #797/#811).
 * `parsePositiveNum` è la sorgente unica di quella validazione.
 */
const MAX_FILES = parsePositiveNum(process.env.TRANSPORT_MAX_FILES, 25, {
  label: 'TRANSPORT_MAX_FILES',
  tool: 'transport-identical-twins',
  // Un tetto FRAZIONARIO passa il test "positivo" e poi viene troncato:
  // `TRANSPORT_MAX_FILES=0.5` da' `slice(0, 0)`, zero copie e un «niente da
  // portare» verde. E' lo stesso spegnimento silenzioso del `NaN`, per un
  // valore che `> 0` non intercetta (issue #871).
  integer: true,
});

/**
 * Codice d'uscita per «copiato quello che si poteva, ma resta un no permanente
 * con divergenza reale».
 *
 * Distinto da 1 — che vuol dire «NON copiare», il buio delle fetch che invalida
 * la passata intera — perche' qui gli altri gemelli si copiano benissimo e uno
 * solo di loro ha bisogno di una mano. Riusare 1 avrebbe fermato il trasporto
 * di TUTTI finche' una persona non interviene: un canale che wedgia il canale.
 * Con 2 lo step di apply porta il resto, apre la PR, e alza il rosso DOPO —
 * vedi `.github/workflows/transport-identical-twins.yml` (issue #871 item 4).
 */
export const EXIT_MANUAL_NEEDED = 2;

/**
 * Una FRAZIONE, non una percentuale. `parsePositiveNum` valida solo `> 0`,
 * quindi `TRANSPORT_MAX_FAILURE_RATIO=25` (chi pensa in percentuale) passerebbe
 * e renderebbe `ratio > maxRatio` sempre falso: la difesa dal buio SPARIREBBE
 * invece di fallire — la stessa classe del tetto qui sopra, e per questo va
 * chiusa nello stesso modo, non lasciata a un follow-up.
 */
export function parseRatio(raw, fallback, { label, warn = console.warn, tool = 'transport-identical-twins' } = {}) {
  const n = parsePositiveNum(raw, fallback, { label, warn, tool });
  if (n > 1) {
    warn(
      `::warning::[${tool}] ${label}=${String(raw)} e' una FRAZIONE fra 0 e 1, non una percentuale — `
        + `override IGNORATO, si prosegue col default ${fallback}. `
        + 'Attenzione: il comportamento che stavi comprando NON e\' attivo.',
    );
    return fallback;
  }
  return n;
}

/**
 * Frazione di fetch fallite oltre la quale la passata è BUIO, non silenzio.
 * Sotto la soglia restano transienti: un 429 isolato su 159 path non deve
 * rendere rossa una passata che ha comunque verificato tutto il resto.
 */
const MAX_FAILURE_RATIO = parseRatio(process.env.TRANSPORT_MAX_FAILURE_RATIO, 0.25, {
  label: 'TRANSPORT_MAX_FAILURE_RATIO',
  tool: 'transport-identical-twins',
});

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

/**
 * Un path del manifest è un dato, e un dato che diventa una destinazione di
 * scrittura va trattato come non fidato: `..`, path assoluto o separatore
 * Windows farebbero uscire la copia dal checkout. È l'unico punto dello script
 * che scrive, quindi è l'unico punto dove serve.
 *
 * `.github/workflows/` è escluso a parte, e non per la sicurezza del path: il
 * token del ciclo non ha lo scope `workflows`, quindi una copia lì produrrebbe
 * un push RIFIUTATO dopo aver scritto il file — cioè una passata che fallisce
 * in fondo invece che all'inizio. Quei 20 gemelli restano una copia a mano.
 */
export function unsafeTarget(rel) {
  if (typeof rel !== 'string' || rel.trim() === '') return 'path vuoto';
  if (rel.includes('\\')) return 'separatore non POSIX';
  if (path.posix.isAbsolute(rel) || path.isAbsolute(rel)) return 'path assoluto';
  if (rel.split('/').includes('..')) return 'path risalente';
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return 'destinazione fuori dal checkout';
  if (rel.startsWith('.github/workflows/')) return 'workflow: il token del ciclo non ha lo scope `workflows`';
  return null;
}

/**
 * Un fixture è un file il cui contenuto È l'aspettativa di un test: un
 * golden/snapshot, o qualunque file che vive dentro un albero di test. Sono i
 * soli path per cui «byte-identico al sito» non implica «coerente qui»: il loro
 * significato sta nel codice che li legge, non in loro.
 *
 * Il predicato è volutamente stretto. Ogni sorgente e' accoppiata a qualcosa,
 * e allargarlo a tutto l'albero trasformerebbe il trasporto in un no
 * permanente; un fixture invece fallisce in modo DIVERSO — non a render time,
 * ma come test rosso su una PR che nessuno può mergiare, e che spegne il
 * canale (il guard «una PR di trasporto alla volta»).
 */
export function isFixture(rel) {
  const segs = String(rel || '').split('/');
  const base = segs.pop() || '';
  if (/\.(golden|snapshot|fixture)\./.test(base)) return true;
  return segs.some((seg) => seg === 'test' || seg === 'tests' || seg === 'fixtures' || seg === '__fixtures__' || seg === 'snapshots');
}

/**
 * Gli accoppiamenti che impediscono una copia isolata: i path locali legati al
 * fixture che NON sono `identical`. Un path non registrato nel manifest è
 * locale per definizione — non ha un gemello dichiarato sul sito — quindi conta
 * come bloccante, non come sconosciuto.
 *
 *   couplings   [{ path, mode }] i file che citano il fixture e quelli che cita.
 */
export function couplingBlockers(couplings = []) {
  return couplings.filter((c) => c.mode !== 'identical').map((c) => c.path).sort();
}

/**
 * Gli accoppiamenti che non ho POTUTO valutare: il file esiste nel sottoalbero
 * del fixture ma non è stato letto (I/O, o oltre il tetto di lettura), quindi
 * «non lo cita» non è una risposta che ho.
 *
 * Sono già bloccanti via `couplingBlockers` — il loro `mode` non è `identical`
 * — ma vanno separati nel REPORT: «accoppiato a un path non identical» manda a
 * cercare una dipendenza che magari non esiste, mentre la ragione vera è che il
 * rilevamento è cieco su quel file. Una ragione sbagliata è peggio di una
 * generica: fa fare il lavoro sbagliato (issue #853).
 */
export function unreadableCouplings(couplings = []) {
  return couplings.filter((c) => c.unreadable).map((c) => ({ path: c.path, reason: c.unreadable })).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Decide se UNA voce va copiata giù dal sito. Pura: prende gli hash già
 * calcolati, come `classify()` — è questo a renderla testabile offline, senza
 * rete e senza scrivere niente.
 *
 *   entry            la voce di manifest (`path`, `mode`, `sitePath`, `baseline`).
 *   now              { site, corpus } gli hash di ORA, `null` se assente.
 *   base             la baseline registrata ({ site, corpus }).
 *   outOfScopePrefixes  i prefissi `scope.outOfScope` del manifest.
 *   couplings        [{ path, mode }] gli accoppiamenti locali della voce
 *                    (rilevanti solo per un fixture: vedi `isFixture`).
 *
 * Ritorna `{ transport, permanent, state, reason }`. `transport: true` SOLO per
 * un `identical` in `site-ahead` con una destinazione scrivibile: ogni altro
 * verdetto è un no con la sua ragione, mai un silenzio. `permanent` dice se
 * quel no scade (vedi `permanentBlock`).
 */
/**
 * Le ragioni per cui una voce non è copiabile in NESSUN giro, separate da
 * quelle che scadono. È la distinzione su cui poggia il tetto: un vicino
 * escluso perché `site-ahead` non lo è ancora (o perché la sua fetch è
 * fallita) torna candidato domani, e rinviare l'altra metà è corretto; un
 * vicino bloccato da `couplingBlockers`, da `unsafeTarget` o da `outOfScope`
 * non tornerà MAI, e rinviare l'altra metà è un no permanente travestito da
 * «aspetta il prossimo giro».
 *
 * Ritorna la ragione (stringa) o `null`. È la sorgente unica: `transportVerdict`
 * la usa per il proprio verdetto e `main()` per costruire l'insieme dei path
 * bloccati per sempre che il tetto deve saper riconoscere.
 */
export function permanentBlock(entry, { outOfScopePrefixes = [], couplings = [] } = {}) {
  if (entry.mode !== 'identical') {
    return `mode \`${entry.mode}\`: solo \`identical\` è copiabile così com'è`;
  }
  // Difesa in profondità: una voce `identical` sotto un prefisso `outOfScope`
  // non dovrebbe esistere (i due insiemi sono disgiunti per costruzione), ma se
  // ci finisse avrebbe DUE trasporti sullo stesso path — il mirror e questo.
  const covered = outOfScopePrefixes.find((p) => entry.path.startsWith(p));
  if (covered) {
    return `\`${covered}\` è outOfScope: ha già un trasporto suo, due canali sullo stesso path sono un conflitto`;
  }
  const unsafe = unsafeTarget(entry.path);
  if (unsafe) return `destinazione non scrivibile (${unsafe})`;
  // L'insieme trasportabile dev'essere CHIUSO, non solo enumerato: un fixture
  // copiato da solo mette rossa la PR di trasporto, che resta aperta e spegne
  // il canale. Vale a prescindere dallo stato, così la ragione è leggibile
  // anche quando il fixture e' ancora `stable`.
  if (isFixture(entry.path)) {
    // Il buio PRIMA dell'accoppiamento: se non ho letto un file del sottoalbero
    // non so se cita il fixture, e «non lo so» non è «non lo cita».
    const blind = unreadableCouplings(couplings);
    if (blind.length) {
      const detail = blind.slice(0, 3).map((b) => `${b.path}: ${b.reason}`).join('; ');
      return `${blind.length} file del sottoalbero non leggibili (${detail}): non so se citano il fixture, e «non ho potuto leggere» non è «non lo cita»`;
    }
    const blockers = couplingBlockers(couplings);
    if (blockers.length) {
      return `fixture accoppiato a ${blockers.length} path non \`identical\` (${blockers.slice(0, 3).join(', ')}): una copia isolata mette rossa la PR di trasporto`;
    }
  }
  return null;
}

export function transportVerdict(entry, now, base, { outOfScopePrefixes = [], couplings = [] } = {}) {
  const state = classify(entry, now, base).state;
  const forever = permanentBlock(entry, { outOfScopePrefixes, couplings });
  if (forever) return { transport: false, permanent: true, state, reason: forever };
  if (state !== 'site-ahead') {
    return { transport: false, permanent: false, state, reason: `stato \`${state}\`: copiabile solo \`site-ahead\` (il sito avanti, questo lato fermo sulla baseline)` };
  }
  return { transport: true, permanent: false, state, reason: 'il sito è andato avanti e qui nessuno ha toccato il file: la copia è esatta' };
}

/**
 * Il tetto per passata applicato in modo CHIUSO: taglia i candidati oltre
 * `maxFiles`, poi scarta anche quelli che il taglio avrebbe separato dal loro
 * accoppiamento. La relazione è trattata come SIMMETRICA, ed è questo il punto:
 *
 *   - se il fixture resta e il file che pinna cade oltre il tetto, il golden
 *     descrive codice che qui non c'è ancora;
 *   - se cade il FIXTURE e resta il file che pinna, il golden locale descrive
 *     codice che qui è appena cambiato.
 *
 * Sono la stessa incoerenza, non due casi: PR rossa, non mergiabile, e da lì il
 * guard «una PR di trasporto alla volta» spegne il canale in silenzio. Il verso
 * fixture→codice era coperto; questo copre entrambi con la stessa mappa.
 *
 * Un accoppiamento fuori dai candidati non è automaticamente benigno: se è
 * `identical` ma è stato escluso PRIMA (fetch fallita, `unsafeTarget`, i gemelli
 * sotto `.github/workflows/`, o uno stato che non è `site-ahead`) allora qui
 * resta indietro mentre l'altra metà avanza — di nuovo la stessa incoerenza.
 * Solo un accoppiamento VERIFICATO allineato (`alignedPaths`, cioè `stable`)
 * non blocca.
 *
 *   candidates    [{ path, couplings }] in ordine, già filtrati da `transportVerdict`.
 *   maxFiles      il tetto per passata.
 *   alignedPaths  Set dei path verificati allineati su entrambi i lati.
 *   couplingGraph [{ path, couplings }] raccolto per OGNI fixture, anche per
 *                 quelli che non sono diventati candidati: è da lì che arriva
 *                 il verso inverso (un candidato non fixture ha `couplings: []`
 *                 e da solo non saprebbe di essere pinnato da nessuno).
 *   blockedForever Set dei path che `permanentBlock` esclude in OGNI giro.
 *
 * E qui sta la differenza che il rinvio da solo non fa. Un vicino che tornerà
 * candidato domani rende il taglio un RINVIO; un vicino bloccato per sempre —
 * `generator/tests/crawler-cross-repo-artifacts.test.mjs` è accoppiato a
 * `scripts/ci/loop-sync-manifest.json`, `corpus-only`, che non sarà mai
 * `identical` — lo rende un NO PERMANENTE: appena quel fixture esce da
 * `stable`, i file che pinna (`scripts/ci/close-recovered-failure-issues.mjs`,
 * `generator/data/crawler-cross-repo-contract.json`) verrebbero scartati a ogni
 * giro, con «aspetta il giro in cui ci stanno insieme» per un giro che non
 * arriva mai: una fix del sito che non scende più, in silenzio, con la passata
 * verde. Il taglio resta — copiare una metà sola mette comunque rossa la PR —
 * ma la ragione dice «copia a mano», che è l'unica azione che lo sblocca, e il
 * flag `permanent` la porta fino al report.
 *
 * La permanenza si PROPAGA: se A cade per un vicino bloccato per sempre, anche
 * B che cade per colpa di A cade per sempre.
 *
 * Ritorna `{ chosen, dropped, capped }`. `capped` è UN conteggio solo — i
 * candidati non copiati in questa passata — e `dropped` ne porta le ragioni.
 */
export function closeTransportSet(candidates, { maxFiles = 25, alignedPaths = new Set(), couplingGraph = [], blockedForever = new Set() } = {}) {
  const permanent = new Set(blockedForever);
  const candidatePaths = new Set(candidates.map((c) => c.path));
  const neighbours = new Map();
  const link = (a, b) => {
    if (a === b) return;
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a).add(b);
  };
  for (const node of [...couplingGraph, ...candidates]) {
    for (const k of node.couplings || []) {
      // Un accoppiamento non `identical` non è trasportabile in nessun giro:
      // blocca già in `transportVerdict`, e come arco renderebbe il suo
      // fixture non copiabile per sempre — un no permanente travestito da tetto.
      if (k.mode !== 'identical') continue;
      link(node.path, k.path);
      link(k.path, node.path);
    }
  }

  const kept = new Map(candidates.slice(0, maxFiles).map((c) => [c.path, c]));
  const dropped = [];
  // Punto fisso: scartare A può separare B da A, quindi una passata sola non
  // basta. L'insieme si restringe a ogni giro, quindi termina.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [rel, c] of [...kept]) {
      const split = [...(neighbours.get(rel) || [])].filter((q) => !kept.has(q) && !alignedPaths.has(q)).sort();
      if (!split.length) continue;
      const forever = split.filter((q) => permanent.has(q));
      kept.delete(rel);
      if (forever.length) permanent.add(rel);
      dropped.push({
        path: rel,
        candidate: candidatePaths.has(rel),
        split,
        permanent: forever.length > 0,
        reason: forever.length
          ? `accoppiato a ${forever.join(', ')}, che nessun giro potra\u2019 copiare: il rinvio non scade, serve una copia a mano delle due meta\u2019 insieme`
          : `separato dai suoi accoppiamenti (${split.join(', ')}): una metà copiata senza l\u2019altra mette rossa la PR di trasporto — aspetta il giro in cui ci stanno insieme`,
      });
      changed = true;
    }
  }

  const chosen = candidates.filter((c) => kept.has(c.path));
  return { chosen, dropped, capped: candidates.length - chosen.length };
}

/**
 * Il canale è al BUIO, non in silenzio? Se `raw.githubusercontent` risponde
 * 429/5xx su tutti i path, ogni voce finisce in `failed`, la passata stampa
 * «0 da portare, N non verificati» e esce VERDE: nessuna PR, nessun allarme, e
 * il trasporto si spegne esattamente come il mirror disabilitato per tre
 * settimane, con il log giornaliero come unica traccia.
 *
 * La soglia è una frazione e non un numero fisso perché l'insieme cresce, e ha
 * un minimo assoluto perché su pochi path una frazione è rumore. Il caso
 * «tutte fallite» è rosso comunque: lì non c'è niente di verificato di cui il
 * report possa parlare.
 *
 * `missing` conta l'altra metà del buio, e non era guardata: **un 404 non
 * lancia**. `siteFile()` ritorna `null` (è un segnale: il file non esiste più
 * là), quindi se `SITE_REPO`/`SITE_REF` non risolvono più — branch rinominato,
 * repo reso privato, che su `raw.githubusercontent` dà 404 e non 403 — TUTTE le
 * voci prendono `site: null`, finiscono in `skipped` come
 * `removed-on-site`/`missing-here`, `failed` resta 0 e la passata esce verde
 * con «0 da portare, 0 non verificati». È il modo più probabile di perdere
 * l'intero canale, ed è esattamente il buio che questo verdetto esiste per
 * chiudere. Un'assenza di massa è un ref sbagliato, non N rimozioni simultanee;
 * una o due assenze restano un dato normale e non fanno rosso.
 */
export function fetchFailureVerdict(attempted, failed, { maxRatio = 0.25, minFailures = 3, missing = 0 } = {}) {
  const unverified = failed + missing;
  if (attempted <= 0 || unverified <= 0) return { red: false, reason: null };
  const detail = missing > 0 ? ` (${failed} fetch fallite, ${missing} assenti sul sito: il ref e\u2019 sbagliato, non ${missing} rimozioni simultanee)` : '';
  if (unverified >= attempted) {
    return { red: true, reason: `nessuna delle ${attempted} voci e\u2019 stata verificata${detail || ': tutte le fetch dal sito sono fallite'}: la passata non ha verificato NIENTE` };
  }
  const ratio = unverified / attempted;
  if (unverified >= minFailures && ratio > maxRatio) {
    return {
      red: true,
      reason: `${unverified}/${attempted} voci non verificate${detail} (${(ratio * 100).toFixed(0)}%, soglia ${(maxRatio * 100).toFixed(0)}%): il report «0 da portare» non significa piu\u2019 niente`,
    };
  }
  return { red: false, reason: null };
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/**
 * Il manifest ENUMERA ogni path registrato: un match lì non dice che quel file
 * legge il fixture, dice solo che il fixture è nel set. Vale per il manifest e
 * per chiunque parli DEL set citandolo (questo script, il suo test, il drift
 * check): sono descrittori dell'insieme, non consumatori. È la stessa
 * degenerazione che teneva la scansione confinata alla directory — riconosciuta
 * per quello che è, invece di essere evitata rinunciando a guardare altrove.
 *
 * L'insieme è ENUMERATO, non dedotto dal testo. «Nomina il path del manifest»
 * era il criterio precedente, ed è un sovrainsieme che inghiotte consumer veri:
 * un test che importa davvero il fixture e cita il manifest solo di passaggio
 * sparisce dalla scansione, e il fixture torna a risultare «senza
 * accoppiamenti» — esattamente il falso silenzio che l'issue #853 chiude. I
 * descrittori sono quattro e cambiano quando cambia il ciclo, non quando
 * cambia il testo di un file terzo: elencarli costa una riga e non ha
 * sovrainsieme.
 */
const SET_MANIFEST_REL = 'scripts/ci/loop-sync-manifest.json';
export const SET_DESCRIPTORS = new Set([
  SET_MANIFEST_REL,
  'scripts/ci/transport-identical-twins.mjs',
  'generator/tests/transport-identical-twins.test.mjs',
  'scripts/ci/loop-drift-check.mjs',
]);

/**
 * Le forme in cui un path fra gli argomenti di una chiamata resta una
 * CITAZIONE: asserzioni (il path è il valore ATTESO, non un input),
 * appartenenza a una collezione, composizione di path, domande sull'esistenza,
 * diagnostica, sintassi.
 *
 * L'elenco è quello dei NON-lettori, ed è la correzione del verso (issue #930).
 * Finché il criterio era l'elenco delle letture riconosciute, ogni forma non
 * prevista — `new URL(rel, import.meta.url)` passato a una lettura, un helper
 * condiviso di `generator/tests/`, un `loadJson('…')` — rispondeva «non
 * legge», il manifest usciva dall'insieme, e l'insieme veniva dichiarato
 * CHIUSO quando non lo era. Enumerare invece i nominatori fa cadere l'ignoto
 * dalla parte conservativa: un accoppiamento di troppo costa una copia a mano
 * nominata nel report, un accoppiamento mancato costa la PR di trasporto rossa
 * che resta aperta e spegne il canale.
 */
const NAMING_CALLS = new Set([
  // asserzioni e harness
  'ok', 'equal', 'notEqual', 'strictEqual', 'notStrictEqual', 'deepEqual', 'deepStrictEqual',
  'notDeepEqual', 'match', 'doesNotMatch', 'throws', 'rejects', 'fail', 'expect',
  'test', 'describe', 'it', 'todo', 'skip',
  // appartenenza e manipolazione di stringhe/collezioni
  'includes', 'indexOf', 'lastIndexOf', 'has', 'add', 'set', 'get', 'push', 'unshift',
  'concat', 'startsWith', 'endsWith', 'split', 'replace', 'replaceAll', 'trim',
  'filter', 'find', 'findIndex', 'some', 'every', 'map', 'sort', 'delete',
  // composizione di path e domande sull'ESISTENZA: non toccano il contenuto
  'join', 'resolve', 'relative', 'dirname', 'basename', 'extname', 'normalize',
  'existsSync', 'exists', 'statSync', 'lstatSync', 'stat',
  // costruzione di pattern, diagnostica, sintassi
  'RegExp', 'String', 'Set', 'Array', 'Error', 'log', 'warn', 'error', 'info', 'debug',
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof',
]);

/** Indice appena dopo il literal aperto a `i`, escape inclusi. */
function endOfStringLiteral(src, i) {
  const quote = src[i];
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === quote) return j + 1;
    // Un apice non chiuso a fine riga è un apostrofo di prosa, non un literal:
    // trascinare il resto del file dentro una stringa nasconderebbe il codice
    // che viene dopo — di nuovo il verso sbagliato.
    if (quote !== '`' && c === '\n') return j;
  }
  return src.length;
}

/**
 * Il sorgente col testo dei commenti sostituito da spazi (gli indici non si
 * spostano, i newline restano).
 *
 * Serve perché il criterio precedente leggeva anche i commenti, e nei due
 * versi sbagliava entrambe le volte: `[^)]*` si ferma alla prima `)` ma
 * ATTRAVERSA i newline, quindi un commento dentro la lista argomenti di una
 * lettura — `readFileSync(\n  // cfr. \`scripts/ci/loop-sync-manifest.json\`\n
 * P, 'utf8')` — contava come lettura, e il delimitatore accettato includeva il
 * backtick, cioè proprio quello con cui la prosa di questo repo cita i path.
 * Il risultato non era un errore ma un fixture `identical` bloccato PER SEMPRE
 * su una dipendenza che non esiste (issue #930).
 */
function stripComments(src) {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') { i = endOfStringLiteral(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') out[j++] = ' ';
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = i;
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) {
        if (src[j] !== '\n') out[j] = ' ';
        j++;
      }
      for (let k = j; k < Math.min(j + 2, src.length); k++) out[k] = ' ';
      i = j + 2;
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * I literal e gli identificatori del sorgente, ognuno con la catena delle
 * chiamate che lo racchiude (`['join', 'readFileSync']` per un literal dentro
 * `readFileSync(path.join(ROOT, '…'))`).
 *
 * È una scansione a token, non una regex: la domanda «dentro quale chiamata
 * sta questo literal» ha una risposta esatta contando le parentesi, e le
 * regex che la approssimavano sbagliavano in entrambi i versi.
 */
function callSites(src) {
  const strings = [];
  const idents = [];
  const stack = [];
  let callee = null;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const end = endOfStringLiteral(src, i);
      strings.push({ value: src.slice(i + 1, Math.max(i + 1, end - 1)), index: i, calls: stack.filter(Boolean) });
      callee = null;
      i = end;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      const name = src.slice(i, j);
      idents.push({ name, index: i, calls: stack.filter(Boolean) });
      // La catena `a.b.c(` lascia `c`: il segmento finale è ciò che chiama.
      callee = name;
      i = j;
      continue;
    }
    if (c === '(') { stack.push(callee); callee = null; i++; continue; }
    if (c === ')') { stack.pop(); callee = null; i++; continue; }
    if (c === '.' || c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    callee = null;
    i++;
  }
  return { strings, idents };
}

const isNamingChain = (calls) => calls.every((c) => NAMING_CALLS.has(c));

/**
 * Il fixture LEGGE quel path, o si limita a nominarlo?
 *
 * La risposta è «legge» per difetto, e diventa «nomina» solo per le forme che
 * si sanno riconoscere come citazioni:
 *
 *   - il path che compare SOLO nei commenti — la prosa di questo repo cita i
 *     path fra backtick, e un commento non apre niente;
 *   - il literal fra gli argomenti di chiamate tutte in `NAMING_CALLS`
 *     (`assert.ok(list.includes('…'))`, `path.join(ROOT, '…')` di cui nessuno
 *     poi legge il risultato);
 *   - il literal legato a una costante (`const P = path.join(ROOT, '…')`) di
 *     cui ogni uso è a sua volta una forma che nomina.
 *
 * Tutto il resto — una lettura diretta, una indiretta, un wrapper, una forma
 * che non avevamo previsto — è «legge». È l'inverso del criterio precedente, e
 * il verso è quello: un match di troppo tiene un accoppiamento che forse non
 * c'è e costa una copia a mano nominata nel report, mentre un match mancato
 * dichiara chiuso un insieme che non lo è, cioè la PR di trasporto rossa che
 * spegne il canale.
 *
 * Il literal ammette il prefisso relativo (`'../../scripts/ci/…'`): i due
 * call-site di `cite()` passano lo stesso path normalizzato da ROOT, ma nel
 * testo del fixture uno dei due compare come specificatore relativo, e la
 * stessa domanda deve avere la stessa risposta (issue #930).
 */
export function readsContentOf(rel, text) {
  const src = stripComments(typeof text === 'string' ? text : '');
  const esc = String(rel).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exact = new RegExp(`^(?:\\.{1,2}/)*${esc}$`);
  const lit = `['"\`](?:\\.{1,2}/)*${esc}['"\`]`;

  // L'`import`/`export … from` statico non è una chiamata e non ha parentesi
  // da guardare; un modulo importato è contenuto quanto un JSON parsato.
  if (new RegExp(`(?:^|[\\n;])\\s*(?:import|export)\\b[^;]*${lit}`).test(src)) return true;

  const { strings, idents } = callSites(src);
  const mentions = strings.filter((s) => exact.test(s.value));
  if (!mentions.length) return false;

  const decls = [];
  for (const m of src.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=[^;]*${lit}`, 'g'))) {
    decls.push({ name: m[1], start: m.index, end: m.index + m[0].length });
  }
  for (const m of mentions) {
    if (m.calls.length) {
      if (!isNamingChain(m.calls)) return true;
      continue;
    }
    // Fuori da ogni chiamata il literal è un valore: lo si sa nominare solo se
    // finisce in una costante, e allora la domanda si sposta sulla costante.
    if (!decls.some((d) => m.index >= d.start && m.index < d.end)) return true;
  }

  const aliases = new Set(decls.map((d) => d.name));
  for (const id of idents) {
    if (!aliases.has(id.name) || !id.calls.length) continue;
    if (!isNamingChain(id.calls)) return true;
  }
  return false;
}

/**
 * L'altro verso: un path che il fixture NOMINA è un accoppiamento vero — quello
 * è codice che il fixture legge — tranne il manifest solo NOMINATO (issue #889).
 *
 * `SET_DESCRIPTORS` filtra i CITER, e lì i quattro descrittori si equivalgono:
 * enumerano ogni path del set, quindi il loro match non dice niente sul
 * fixture. Nel verso «chi cita il fixture» l'insieme NON è lo stesso, e
 * riusarlo tale e quale rimetterebbe il falso silenzio di #853: un fixture che
 * importa davvero `transport-identical-twins.mjs` o `loop-drift-check.mjs`
 * dipende da quel codice, e copiarlo senza la sua metà è la classe «engine
 * senza `host/`».
 *
 * Il manifest è l'unico candidato all'eccezione perché non è un input che il
 * trasporto possa rompere: è il LIBRO MASTRO del trasporto stesso, riscritto da
 * `--apply` nella stessa passata che copia la voce
 * (`baseline.site`/`baseline.corpus`). E poiché è `corpus-only` per costruzione
 * («Questo file.»), contarlo come bloccante non è un rinvio: è un NO
 * PERMANENTE.
 *
 * **Ma l'eccezione vale solo per chi lo NOMINA, non per chi lo LEGGE**, e la
 * differenza è misurabile su
 * `generator/tests/crawler-cross-repo-artifacts.test.mjs`: quel fixture non
 * verifica che il manifest esista, asserisce sul suo CONTENUTO contro un altro
 * file — per ogni `artifacts[]` del contract pretende l'entry
 * `.github/workflows/<file>` con `mode`, `sitePath` e `baseline` uguali a
 * `artifactSha256`. Quelle entry non entrano nell'insieme chiuso: il fixture le
 * nomina via template, e i loro path sono `unsafeTarget` («il token del ciclo
 * non ha lo scope `workflows`»), quindi nessuna passata potrà mai riscriverle.
 * Portare giù il fixture e il contract lasciando il manifest fermo fa fallire
 * il test su `mapping loop-sync assente` o su una `baseline` diversa — cioè
 * esattamente la PR di trasporto rossa che `permanentBlock` esiste per evitare.
 * Il libro mastro è neutro finché lo si nomina; sul suo contenuto è un
 * accoppiamento come gli altri.
 */
export function namedIsCoupling(rel, ownText) {
  if (rel !== SET_MANIFEST_REL) return true;
  // Senza il testo del fixture non so se lo legge, e «non lo so» non e' «non lo
  // legge»: il verso conservativo tiene l'accoppiamento, come per il buio di
  // `readLocal()`.
  if (typeof ownText !== 'string') return true;
  return readsContentOf(rel, ownText);
}

/**
 * Un file locale letto come TESTO, con lo stato esplicito.
 *
 * `null` non basta: «non esiste», «non è testo» e «non ho potuto leggerlo»
 * sono tre risposte diverse, e collassarle fa dire a chi chiama «non ti cita»
 * anche quando la verità è «non lo so». Sul rilevamento degli accoppiamenti
 * quel «non lo so» diventa via libera a una copia isolata (issue #853).
 *
 *   `absent`     non c'è (o non è un file): non può citare nessuno.
 *   `binary`     contiene byte NUL: non è sorgente, non cita per basename.
 *   `unreadable` esiste, ma non l'ho letto — errore di I/O o oltre il tetto.
 *   `text`       letto.
 */
function readLocal(rel) {
  const abs = path.join(ROOT, rel);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { state: 'absent', text: null, reason: null };
    return { state: 'unreadable', text: null, reason: `stat fallita (${e && e.code ? e.code : e})` };
  }
  if (!stat.isFile()) return { state: 'absent', text: null, reason: null };
  if (stat.size > MAX_TEXT_BYTES) {
    return { state: 'unreadable', text: null, reason: `${stat.size} byte, oltre il tetto di lettura di ${MAX_TEXT_BYTES}` };
  }
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch (e) {
    return { state: 'unreadable', text: null, reason: `lettura fallita (${e && e.code ? e.code : e})` };
  }
  // Un NUL è la firma del binario, e un binario non cita un basename come
  // sorgente: è un `absent` di fatto, non un buio. Deciderlo dai byte e non
  // dall'estensione evita sia il falso blocco su un .webp sia il falso via
  // libera su un'estensione fuori da un'allowlist.
  if (buf.includes(0)) return { state: 'binary', text: null, reason: null };
  return { state: 'text', text: buf.toString('utf8'), reason: null };
}

/**
 * Il sottoalbero in cui cercare chi cita il fixture: il PACCHETTO, cioè il
 * primo segmento del path (`host/`, `generator/`, `scripts/`, `.github/`).
 *
 * La directory del fixture da sola non basta — un consumer in una directory
 * sorella non produceva match e il fixture risultava senza accoppiamenti,
 * quindi copiabile da solo (issue #853). Tutto l'albero sarebbe l'altro
 * eccesso: il pacchetto è il confine entro cui un test e il suo golden vivono
 * per convenzione, e fuori dal quale un riferimento è quasi sempre prosa.
 */
export function couplingScanRoot(rel) {
  return String(rel || '').split('/')[0] || '';
}

const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'content', 'public']);

/**
 * I file del sottoalbero, più le directory che non ho potuto ELENCARE.
 *
 * Una `readdirSync` fallita è la stessa ambiguità di una lettura fallita, un
 * livello più su: i file lì dentro non sono «assenti», sono invisibili. Inghiottirla
 * ridarebbe un «nessun accoppiamento» che significa «non ho guardato».
 */
function walkSubtree(root, acc = [], blind = new Map()) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(ROOT, root), { withFileTypes: true });
  } catch (e) {
    // La directory che non c'è non nasconde niente; ogni altro errore sì.
    if (!e || e.code !== 'ENOENT') blind.set(root, `readdir fallita (${e && e.code ? e.code : e})`);
    return { files: acc, blind };
  }
  for (const e of entries) {
    if (SCAN_SKIP_DIRS.has(e.name)) continue;
    const rel = path.posix.join(root, e.name);
    if (e.isDirectory()) walkSubtree(rel, acc, blind);
    else if (e.isFile()) acc.push(rel);
  }
  return { files: acc, blind };
}

/**
 * Gli accoppiamenti LOCALI di un fixture, in due direzioni:
 *
 *   - chi lo cita — il test che lo legge (`shell-contract-functions.test.mjs`
 *     per il golden delle funzioni del contratto);
 *   - chi cita — i path che il fixture stesso nomina, quando e' codice.
 *
 * Chi lo cita si cerca in tutto il PACCHETTO (vedi `couplingScanRoot`), non
 * nella sola directory del fixture, saltando i descrittori del set (vedi
 * `SET_DESCRIPTORS`) che citerebbero ogni path per costruzione. L'elenco è
 * chiuso: «nomina il manifest» escludeva anche i consumer veri che lo citano
 * di passaggio.
 *
 * Un file del sottoalbero che ESISTE ma non è stato letto non è «non ti cita»:
 * entra fra gli accoppiamenti con `mode: 'illeggibile'`, quindi blocca. Il
 * verso conservativo è voluto — un accoppiamento mancato manda rossa la PR di
 * trasporto e SPEGNE il canale, un blocco di troppo costa una copia a mano
 * nominata nel report.
 *
 * Legge solo l'albero LOCALE: niente rete, quindi un test la può chiamare.
 */
/**
 * Il consumatore che cita il file SENZA nominarlo.
 *
 * Il match sui citer e' `text.includes(base)` col basename INTERO, estensione
 * compresa. Un import TypeScript non scrive mai l'estensione:
 * `host/siteShellBootstrap.ts:63` fa
 *
 *     import { truncateCodeUnits } from './shared/safeTruncate';
 *
 * e quella riga non contiene la stringa `safeTruncate.ts` da nessuna parte. Il
 * consumatore c'e', il match no, e `localCouplings()` torna `[]` — «nessun
 * accoppiamento», cioe' copiabile da solo. E' lo STESSO falso silenzio che
 * questa funzione esiste per chiudere, sulla meta' `host/` del contratto col
 * sito: spedire una di queste voci senza la sua meta' e' la classe «engine
 * senza `host/`, TypeError a render time dietro una CI verde».
 *
 * Misurato su `main` prima della correzione: 9 voci `identical` con importer
 * reali verificati uscivano a zero accoppiamenti — `host/shared/safeTruncate.ts`,
 * `host/authors.ts`, `host/contentHash.ts`, `host/seo/organizationLd.ts`,
 * `host/seo/imageObjectLd.ts`, `host/shared/buildDayStamp.ts`,
 * `host/shared/inlineJsonScript.ts`, `host/shared/railGutters.ts`,
 * `host/shared/stripLiteralMarkdown.ts`.
 *
 * ## Perche' uno specificatore e non `includes(stem)` nudo
 *
 * Senza estensione, un basename e' una parola comune: `authors`, `constants`,
 * `index` compaiono in prosa, in JSON e nei commenti di mezzo albero, e un
 * `includes()` su di loro accoppierebbe ogni file a ogni altro — il verso
 * conservativo di questa funzione diventerebbe un no permanente su tutto, cioe'
 * il canale spento dall'altra parte. La forma cercata e' quindi lo stem come
 * CODA di un path fra apici: `'./shared/safeTruncate'`,
 * `'../../host/authors'`, `"@/seo/organizationLd"`. Un `import x from
 * 'safeTruncate'` senza separatore non matcha, ed e' giusto: quello e' un
 * pacchetto, non questo file.
 *
 * Ritorna `null` per un basename senza estensione di codice: li' il match
 * intero e' gia' esatto e non c'e' niente da allargare.
 */
export function importSpecifierRe(base) {
  const stem = base.replace(/\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/, '');
  if (stem === base) return null;
  const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`['"\`][^'"\`]*[./]${esc}['"\`]`);
}

export function localCouplings(rel, modeOf) {
  const base = rel.split('/').pop();
  const specifier = importSpecifierRe(base);
  const dir = path.dirname(rel);
  const found = new Set();
  const unreadable = new Map();

  const scan = walkSubtree(couplingScanRoot(rel));
  for (const [d, reason] of scan.blind) unreadable.set(d, reason);
  for (const other of scan.files) {
    if (other === rel) continue;
    // Un descrittore del set non è un consumatore, quindi non è nemmeno un
    // buio: che sia leggibile o no non cambia se il fixture ha accoppiamenti.
    if (SET_DESCRIPTORS.has(other)) continue;
    const read = readLocal(other);
    if (read.state === 'unreadable') {
      unreadable.set(other, read.reason);
      continue;
    }
    if (read.state !== 'text') continue;
    if (read.text.includes(base) || (specifier && specifier.test(read.text))) found.add(other);
  }

  const own = readLocal(rel);
  // Il fixture illeggibile è il caso peggiore dei due: non so nemmeno cosa
  // cita, quindi non posso dichiararlo chiuso.
  if (own.state === 'unreadable') unreadable.set(rel, own.reason);
  if (own.state === 'text') {
    const ownText = own.text;
    // Specificatori relativi (`../../scripts/ci/close-recovered-failure-issues.mjs`) e path repo-relative
    // citati come stringa (`'scripts/ci/loop-sync-manifest.json'`). Solo quelli
    // che esistono davvero qui diventano un accoppiamento: il resto è prosa.
    const cite = (relPath) => {
      if (namedIsCoupling(relPath, ownText)) found.add(relPath);
    };
    for (const m of ownText.matchAll(/\.{1,2}\/[\w./-]+/g)) {
      const abs = path.resolve(ROOT, dir, m[0]);
      if (abs.startsWith(ROOT + path.sep) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        cite(path.relative(ROOT, abs).split(path.sep).join('/'));
      }
    }
    for (const m of ownText.matchAll(/['"`]([\w.-]+(?:\/[\w.-]+)+)['"`]/g)) {
      const cand = m[1];
      if (cand.startsWith('.') && !cand.startsWith('.github')) continue;
      const abs = path.join(ROOT, cand);
      if (abs.startsWith(ROOT + path.sep) && fs.existsSync(abs) && fs.statSync(abs).isFile()) cite(cand);
    }
  }
  found.delete(rel);
  const couplings = [...found].sort().map((c) => ({ path: c, mode: modeOf.get(c) || 'non registrato' }));
  for (const p of [...unreadable.keys()].sort()) {
    couplings.push({ path: p, mode: 'illeggibile', unreadable: unreadable.get(p) });
  }
  return couplings;
}


/** Hash del file locale, o null se non esiste. */
function localHash(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? sha256(fs.readFileSync(p)) : null;
}

/**
 * Riallineamento della baseline dai byte COMMITTATI (issue #852).
 *
 * `--apply` scrive `baseline.corpus` con l'hash dei byte SCARICATI, calcolato
 * prima che il commit esista. Nei casi in cui i byte committati non sono quelli
 * scaricati — una normalizzazione di line-ending al commit, un filtro
 * `clean`, o un path che per un errore di staging non entra nel commit — il
 * manifest atterra su `main` con una baseline che non descrive nessuno dei due
 * lati. Il giorno dopo `loop-drift-check.mjs` legge `corpus-ahead` su un file
 * che nessuno ha toccato: una riga actionable permanente, cioe' il modo in cui
 * un report smette di essere letto.
 *
 * Per questo il riallineamento e' un PASSAGGIO DISTINTO dalla copia e non una
 * riga dentro di lei: ricalcolare l'hash subito dopo `writeFileSync` leggerebbe
 * gli stessi byte appena scritti, e sarebbe un no-op per costruzione. L'unica
 * sorgente che puo' smentire `now.site` e' il commit.
 *
 * **Si corregge SOLO `baseline.corpus`.** `baseline.site` resta l'hash dei byte
 * realmente scaricati dal sito: e' un blob che su quel lato ESISTE, e
 * sovrascriverlo con un hash locale fabbricherebbe esattamente la
 * `ghost-baseline` che `checkBaselineProvenance()` esiste per intercettare
 * (issue #148).
 *
 * ## Perche' su un `identical` la correzione da sola NON basta
 *
 * Per un gemello `mode: identical` scrivere `baseline.corpus = committed`
 * quando `committed !== baseline.site` non produce `stable`: al giro dopo
 * nessuno dei due lati si e' mosso dalla propria baseline, ma
 * `now.site !== now.corpus`, e `classify()` entra nel ramo `undeclared-drift`
 * — actionable, in cima al report, con la remediation sbagliata («riallinea il
 * file, oppure marcalo `adapted`») per una differenza di soli byte. Peggio:
 * `transportVerdict()` non copia un `undeclared-drift`, quindi quel gemello
 * smette di aggiornarsi tutti i giorni senza che niente fallisca — la forma di
 * guasto che questo repo riconosce come la peggiore. La riga actionable
 * permanente di #852 non sparirebbe: cambierebbe solo nome.
 *
 * Il fatto sotto e' che se i byte committati non sono quelli scaricati, quel
 * gemello **non e' byte-identico** e non e' un `identical` trasportabile.
 * Quindi il disallineamento esce ROSSO — prima del push, cioe' prima che il
 * manifest atterri su `main` — e la decisione (correggere la copia, o degradare
 * la voce ad `adapted` con la sua `reason`) resta a chi ha il contesto per
 * prenderla. La correzione silenziosa e' ammessa solo dove ricostruisce
 * davvero l'invariante di `classify()`: `committed === baseline.site` su un
 * `identical`, o una voce di modo diverso, dove i due lati POSSONO differire.
 *
 *   manifest        il manifest parsato (mutato in place).
 *   paths           i path trasportati in questa passata: le sole voci su cui
 *                   un disallineamento e' un errore di REGISTRAZIONE e non una
 *                   divergenza locale legittima da leggere a mano.
 *   readCommitted   (rel) => Buffer dei byte committati; lancia se il path non
 *                   e' nel commit.
 *
 * Ritorna `{ corrections, mismatched, unreadable }`.
 */
export function realignFromCommitted(manifest, paths, readCommitted) {
  const wanted = new Set(paths);
  const corrections = [];
  const mismatched = [];
  const unreadable = [];

  for (const entry of manifest.files || []) {
    if (!wanted.has(entry.path)) continue;
    let bytes;
    try {
      bytes = readCommitted(entry.path);
    } catch (e) {
      unreadable.push({ path: entry.path, reason: String(e.message || e).slice(0, 120) });
      continue;
    }
    if (bytes == null) {
      unreadable.push({ path: entry.path, reason: 'nessun contenuto committato per questo path' });
      continue;
    }
    const committed = sha256(bytes);
    const base = entry.baseline || {};
    if (base.corpus === committed) continue;
    // Un `identical` i cui byte committati non sono quelli serviti dal sito non
    // e' un gemello: scrivere qui la baseline lo consegnerebbe al drift check
    // come `undeclared-drift` permanente, e al trasporto come voce che non si
    // copia piu'. Si lascia la baseline com'e' e si esce rossi.
    if ((entry.mode || 'identical') === 'identical' && committed !== (base.site ?? null)) {
      mismatched.push({ path: entry.path, site: base.site ?? null, committed });
      continue;
    }
    corrections.push({ path: entry.path, from: base.corpus ?? null, to: committed });
    entry.baseline = { ...base, corpus: committed };
  }

  // Un path trasportato che non e' leggibile dal commit e' la meta' PEGGIORE
  // del buco: la baseline lo dichiara allineato e il file non c'e'. Non e' un
  // rinvio, quindi non puo' uscire verde.
  const missingWanted = [...wanted].filter((rel) => !(manifest.files || []).some((e) => e.path === rel));
  for (const rel of missingWanted) unreadable.push({ path: rel, reason: 'path trasportato assente dal manifest' });

  return { corrections, mismatched, unreadable };
}

/** I byte committati di un path, letti da `HEAD` invece che dal working tree. */
function committedBytes(rel) {
  return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
}

function realignMain(listFile) {
  const paths = fs
    .readFileSync(listFile, 'utf8')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const { corrections, mismatched, unreadable } = realignFromCommitted(manifest, paths, committedBytes);

  if (corrections.length) fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

  if (AS_JSON) {
    console.log(JSON.stringify({ realign: true, paths: paths.length, corrections, mismatched, unreadable }, null, 2));
  } else {
    console.log(`transport-identical-twins (realign): ${paths.length} voci verificate sul commit, ${corrections.length} baseline corrette`);
    for (const c of corrections) console.log(`  ✎ ${c.path}: baseline.corpus ${c.from} → ${c.to} (byte committati)`);
    for (const m of mismatched) console.error(`  ✖ ${m.path}: i byte COMMITTATI (${m.committed}) non sono quelli serviti dal sito (${m.site}) — non e’ un gemello byte-identico`);
    for (const u of unreadable) console.error(`  ⚠ ${u.path}: ${u.reason}`);
  }

  if (mismatched.length) {
    console.error(`transport-identical-twins: ${mismatched.length} path trasportati sono stati committati con byte diversi da quelli del sito. Registrarli come baseline darebbe ‘undeclared-drift’ permanente al drift check e li escluderebbe dal trasporto: correggi la copia (normalizzazione, filtro ‘clean’, staging), oppure degrada la voce a ‘adapted’ con la sua ‘reason’.`);
    return 1;
  }

  if (unreadable.length) {
    console.error(`transport-identical-twins: ${unreadable.length} path trasportati non verificabili sul commit — la baseline resterebbe registrata su byte che nessuno ha committato`);
    return 1;
  }
  return 0;
}

async function main() {
  // `--realign lista.txt` (con lo spazio) e `--realign=` vuoto lascerebbero
  // `REALIGN_FILE` a `null`: si cadrebbe qui sotto nel dry-run di rete — exit
  // 0, baseline mai verificata, step VERDE. Un no-op silenzioso su questo
  // passaggio e' indistinguibile dal successo, quindi e' un errore.
  if (RAW_ARGS.some((a) => a === '--realign' || a === '--realign=')) {
    console.error('transport-identical-twins: --realign vuole la forma --realign=<file> (un path per riga)');
    return 1;
  }
  if (REALIGN_FILE) return realignMain(REALIGN_FILE);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const outOfScopePrefixes = (manifest.scope?.outOfScope || []).map((x) => x.prefix);
  const modeOf = new Map(manifest.files.map((e) => [e.path, e.mode]));
  const today = new Date().toISOString().slice(0, 10);

  const candidates = [];
  const skipped = [];
  const failed = [];
  const manual = [];
  const couplingGraph = [];
  const alignedPaths = new Set();
  const blockedForever = new Set();
  let attempted = 0;
  let missingOnSite = 0;

  for (const entry of manifest.files) {
    if (entry.mode !== 'identical') continue;
    const rel = entry.path;
    const sitePath = entry.sitePath || rel;
    const base = entry.baseline || { site: null, corpus: null };

    const couplings = isFixture(rel) ? localCouplings(rel, modeOf) : [];
    // Raccolto per OGNI fixture, non solo per i candidati: e' la mappa inversa
    // di cui il tetto ha bisogno per non copiare un file lasciando indietro il
    // golden che lo pinna (il fixture puo' essere stato escluso prima).
    if (couplings.length) couplingGraph.push({ path: rel, couplings });
    // Non dipende dagli hash, quindi si sa PRIMA della fetch — ed e' cio' che
    // permette al tetto di distinguere un rinvio da un no che non scade.
    if (permanentBlock(entry, { outOfScopePrefixes, couplings })) blockedForever.add(rel);

    let content;
    let now;
    attempted += 1;
    try {
      content = await siteFile(sitePath);
      // Un 404 non lancia: qui non c'e' un errore da mettere in `failed`, ma
      // nemmeno una verifica. Contato a parte, e' la meta' del buio che
      // `fetchFailureVerdict` non poteva vedere.
      if (content === null) missingOnSite += 1;
      now = { site: content === null ? null : sha256(content), corpus: localHash(rel) };
    } catch (e) {
      // PROCEED-SAFE come il drift check: una fetch fallita non deve far
      // saltare le altre copie, e soprattutto non deve MAI valere come "il
      // file non c'è più sul sito" (che sarebbe una rimozione inventata).
      failed.push({ path: rel, reason: String(e.message || e).slice(0, 120) });
      continue;
    }

    const verdict = transportVerdict(entry, now, base, { outOfScopePrefixes, couplings });
    if (!verdict.transport) {
      skipped.push({ path: rel, state: verdict.state, reason: verdict.reason });
      // Un no PERMANENTE su un file che il sito ha gia' portato avanti non e'
      // uno skip: e' una copia a mano che nessuno fara' se il report non la
      // nomina, e che nessun giro futuro di questo canale ripeschera'. Un
      // blocco permanente su un file `stable` invece non deve niente a
      // nessuno — i 25 gemelli sotto `.github/workflows/` sono in quello stato
      // per costruzione — e tenerli qui renderebbe la passata rossa ogni
      // giorno, cioe' un canale che si smette di leggere (issue #871 item 4).
      if (verdict.permanent && verdict.state === 'site-ahead') {
        manual.push({ path: rel, state: verdict.state, reason: verdict.reason });
      }
      // Solo un accoppiamento VERIFICATO allineato non blocca l'altra meta'.
      // Ogni altro skip (e ogni fetch fallita) lascia questo lato indietro.
      if (verdict.state === 'stable') alignedPaths.add(rel);
      continue;
    }
    candidates.push({ entry, path: rel, sitePath, content, now, base, couplings });
  }

  // Il tetto si applica DOPO aver raccolto tutti i candidati, non durante: e'
  // l'unico modo di sapere se tagliarlo separerebbe un fixture dai suoi
  // accoppiamenti. Una passata che copia il golden e lascia indietro il file
  // che pinna è incoerente per costruzione — la stessa rottura del fixture
  // copiato da solo, prodotta dal tetto invece che dal manifest.
  const { chosen, dropped, capped } = closeTransportSet(candidates, {
    maxFiles: MAX_FILES,
    alignedPaths,
    couplingGraph,
    blockedForever,
  });
  for (const d of dropped) skipped.push({ path: d.path, state: 'site-ahead', reason: d.reason });
  // I rinvii che non scadono non sono «al prossimo giro»: sono una copia a mano
  // che nessuno farà se il report non la nomina. I candidati che il tetto ha
  // separato da una metà bloccata per sempre si uniscono ai no permanenti già
  // raccolti sopra: la stessa cosa arrivata da due porte.
  for (const d of dropped.filter((x) => x.permanent)) {
    manual.push({ path: d.path, state: 'site-ahead', reason: d.reason });
  }

  const transported = [];
  for (const { entry, path: rel, sitePath, content, now, base } of chosen) {
    if (APPLY) {
      const abs = path.join(ROOT, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      // Dopo la copia i due lati sono lo STESSO byte: la baseline è quell'hash
      // su entrambi i lati. Scriverla qui è ciò che impedisce al prossimo giro
      // di drift check di rileggere la copia appena fatta come una divergenza.
      //
      // `now.site` sono però i byte SCARICATI, e questo è un istante in cui il
      // commit non esiste ancora: se i byte committati differiranno (line
      // ending normalizzati, filtro `clean`, staging incompleto) questa riga
      // registra una baseline che non descrive nessuno dei due lati. È per
      // quello che `--realign=<lista>` gira DOPO il commit — vedi
      // `realignFromCommitted`, che è l'unico posto in cui i byte committati
      // sono leggibili.
      entry.baseline = { site: now.site, corpus: now.site, alignedAt: today };
    }
    transported.push({ path: rel, sitePath, from: base.site, to: now.site });
  }

  if (APPLY && transported.length) {
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  // «Niente da portare» non è un fallimento, ed è il caso NORMALE: chi chiama
  // guarda il diff. «Non ho potuto guardare» invece sì — è indistinguibile dal
  // primo nel report, quindi deve distinguersi nell'EXIT CODE, o il canale si
  // spegne restando verde.
  const dark = fetchFailureVerdict(attempted, failed.length, { maxRatio: MAX_FAILURE_RATIO, missing: missingOnSite });

  if (AS_JSON) {
    console.log(JSON.stringify({ apply: APPLY, transported, capped, failed, missingOnSite, manual, skipped, dark }, null, 2));
  } else {
    const mode = APPLY ? 'APPLY' : 'dry-run';
    console.log(`transport-identical-twins (${mode}): ${transported.length} da portare, ${skipped.length} fermi, ${failed.length} non verificati`);
    for (const t of transported) console.log(`  ⬇ ${t.path}  ←  ${t.sitePath}  (${t.from} → ${t.to})`);
    if (capped) console.log(`  ⏸ altri ${capped} candidati non copiati oggi (tetto di ${MAX_FILES} file, più le metà che il taglio avrebbe separato): restano al prossimo giro`);
    for (const f of failed) console.log(`  ⚠ ${f.path}: ${f.reason}`);
    for (const m of manual) console.log(`  ⛔ ${m.path}: ${m.reason}`);
    // Gli skip attivi — quelli che una persona deve guardare — sono i soli
    // stampati: elencare 150 `stable` ogni giorno è la riga che nessuno legge.
    for (const s of skipped.filter((x) => x.state !== 'stable')) console.log(`  · ${s.path}: ${s.reason}`);
  }

  if (dark.red) {
    console.error(`transport-identical-twins: ${dark.reason}`);
    return 1;
  }
  // Prima, la riga `⛔` e il campo `manual` vivevano nel log di una passata
  // VERDE, e nessuno step leggeva quel campo: il gemello restava indietro per
  // sempre e il solo ripescaggio ipotizzato (`stranded-twin` dopo 3 giorni) era
  // a sua volta spegnibile in silenzio dal difetto dell'item 1. Ora il
  // fallimento del workflow apre la sua issue via `scan-failed-runs.mjs`.
  //
  // Misurato il 2026-09-05 su `main`: 26 blocchi permanenti, TUTTI `stable`,
  // quindi questo insieme e' vuoto e la passata resta verde.
  if (manual.length) {
    console.error(
      `transport-identical-twins: ${manual.length} gemelli \`identical\` sono \`site-ahead\` e bloccati per SEMPRE `
      + `(${manual.map((m) => m.path).join(', ')}): nessun giro di questo canale li portera\u2019, serve una copia a mano.`,
    );
    return EXIT_MANUAL_NEEDED;
  }
  return 0;
}

// Solo in modalita' CLI: senza guardia, importare questo modulo da un test
// farebbe rete e, con --apply, scriverebbe sull'albero.
if (process.argv[1] && process.argv[1].endsWith('transport-identical-twins.mjs')) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`transport-identical-twins fallito: ${e && e.stack ? e.stack : e}`);
      process.exit(1);
    },
  );
}
