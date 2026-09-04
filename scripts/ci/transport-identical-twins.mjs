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
 * ## Cosa NON fa
 *
 * Non mergia e non decide: scrive i file e aggiorna la baseline delle sole voci
 * copiate. La PR la apre il workflow, e passa dalla review come ogni altra.
 * Senza `--apply` non scrive niente: la modalità di default è il dry-run.
 *
 * ## Uso
 *
 *   node scripts/ci/transport-identical-twins.mjs            # dry-run, report
 *   node scripts/ci/transport-identical-twins.mjs --json     # dry-run, JSON
 *   node scripts/ci/transport-identical-twins.mjs --apply    # scrive + baseline
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
import { fileURLToPath } from 'node:url';
import { classify, siteFile } from './loop-drift-check.mjs';
import { parsePositiveNum } from './scan-failed-runs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_PATH = path.join(ROOT, 'scripts/ci/loop-sync-manifest.json');

const ARGS = new Set(process.argv.slice(2));
const APPLY = ARGS.has('--apply');
const AS_JSON = ARGS.has('--json');

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
});

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

/** Il testo di un file locale, o `null` se assente o non leggibile come testo. */
function localText(rel) {
  const abs = path.join(ROOT, rel);
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Gli accoppiamenti LOCALI di un fixture, in due direzioni:
 *
 *   - chi lo cita — il test che lo legge (`shell-contract-functions.test.mjs`
 *     per il golden delle funzioni del contratto);
 *   - chi cita — i path che il fixture stesso nomina, quando e' codice.
 *
 * Chi lo cita si cerca nella sola directory del fixture: un golden e il test
 * che lo legge stanno accanto, e il test lo nomina per basename. Allargare la
 * scansione a tutto il manifest sarebbe degenere — il manifest ELENCA ogni
 * path, quindi ogni fixture risulterebbe accoppiato al manifest e bloccato per
 * la ragione sbagliata.
 *
 * Legge solo l'albero LOCALE: niente rete, quindi un test la può chiamare.
 */
export function localCouplings(rel, modeOf) {
  const base = rel.split('/').pop();
  const dir = path.dirname(rel);
  const neighbours = fs.existsSync(path.join(ROOT, dir))
    ? fs.readdirSync(path.join(ROOT, dir)).map((n) => path.posix.join(dir, n))
    : [];
  const found = new Set();

  for (const other of neighbours) {
    if (other === rel) continue;
    const text = localText(other);
    if (text && text.includes(base)) found.add(other);
  }

  const own = localText(rel);
  if (own) {
    // Specificatori relativi (`../../scripts/ci/close-recovered-failure-issues.mjs`) e path repo-relative
    // citati come stringa (`'scripts/ci/loop-sync-manifest.json'`). Solo quelli
    // che esistono davvero qui diventano un accoppiamento: il resto è prosa.
    for (const m of own.matchAll(/\.{1,2}\/[\w./-]+/g)) {
      const abs = path.resolve(ROOT, dir, m[0]);
      if (abs.startsWith(ROOT + path.sep) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        found.add(path.relative(ROOT, abs).split(path.sep).join('/'));
      }
    }
    for (const m of own.matchAll(/['"`]([\w.-]+(?:\/[\w.-]+)+)['"`]/g)) {
      const cand = m[1];
      if (cand.startsWith('.') && !cand.startsWith('.github')) continue;
      const abs = path.join(ROOT, cand);
      if (abs.startsWith(ROOT + path.sep) && fs.existsSync(abs) && fs.statSync(abs).isFile()) found.add(cand);
    }
  }
  found.delete(rel);
  return [...found].sort().map((c) => ({ path: c, mode: modeOf.get(c) || 'non registrato' }));
}

/** Hash del file locale, o null se non esiste. */
function localHash(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? sha256(fs.readFileSync(p)) : null;
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const outOfScopePrefixes = (manifest.scope?.outOfScope || []).map((x) => x.prefix);
  const modeOf = new Map(manifest.files.map((e) => [e.path, e.mode]));
  const today = new Date().toISOString().slice(0, 10);

  const candidates = [];
  const skipped = [];
  const failed = [];
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
  // che nessuno farà se il report non la nomina.
  const manual = dropped.filter((d) => d.permanent);

  const transported = [];
  for (const { entry, path: rel, sitePath, content, now, base } of chosen) {
    if (APPLY) {
      const abs = path.join(ROOT, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      // Dopo la copia i due lati sono lo STESSO byte: la baseline è quell'hash
      // su entrambi i lati. Scriverla qui è ciò che impedisce al prossimo giro
      // di drift check di rileggere la copia appena fatta come una divergenza.
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
