#!/usr/bin/env node
/**
 * handoff-to-site.mjs — porta al SITO la diagnosi che il fixer di questo repo ha
 * già pagato e non può applicare.
 *
 * ## Il difetto, misurato
 *
 * `blocked-admin-settings` su questo repo non descrive impostazioni di repo.
 * Misurato il 2026-08-24 su tutte e 4 le issue aperte che lo portano — #548,
 * #531, #513, #472 — la forma è sempre la stessa: il fixer verifica al turno 1
 * che il file da cambiare vive in `valerielinc-ops/frontaliere-si-o-no`, lo
 * scrive, e si ferma. È il caso «lato sbagliato del mirror».
 *
 * La diagnosi è quindi CORRETTA, COMPLETA e già pagata — e nessuno la porta di
 * là. Il verdetto la trasforma in un parcheggio, che è il modo più costoso di
 * avere ragione: l'informazione che serve al sito esiste, in un commento che il
 * sito non legge.
 *
 * ## La stessa forma sotto un altro verdetto (#316)
 *
 * `blocked-admin-settings` non è l'unico travestimento. Su #316 il fixer ha
 * emesso `no-root-cause` DIECI volte fra il 2026-08-14 e il 2026-09-03 con la
 * causa trovata e riconfermata ogni volta (`isQueueManaged` in
 * `scripts/ci/followup-drainer.mjs`): non era un vicolo cieco, era il mirror —
 * quel file è `mode: identical` nel manifest, quindi scriverlo da qui verrebbe
 * sovrascritto. Stessa forma, stesso parcheggio, dieci run ri-pagati.
 *
 * `no-root-cause` è però ambiguo dove i `blocked-*` non lo sono, perché copre
 * ANCHE il vicolo cieco vero. Il discriminante non può quindi essere il
 * verdetto: è il manifest (`MIRROR_LOCKED_MODES`), che dice per costruzione
 * quali path una fix scritta qui non sopravviverebbe.
 *
 * ## Perché si può fare, e non si faceva
 *
 * Il canale esisteva già e non era usato: `GITHUB_PAT` è di `valerielinc-ops`
 * (admin sul sito, verificato) ed è nella mappa `RC_TO_ENV` di
 * `load-rc-env.mjs`, quindi i workflow di questo repo che caricano Remote Config
 * lo hanno in `process.env`. Mancava solo qualcuno che lo usasse per aprire la
 * issue.
 *
 * ## Deterministico, non affidato al prompt
 *
 * Gira come post-step di `issue-fix.yml`, dopo Claude: l'agente ha già scritto
 * la diagnosi, e questo script la legge. Un'istruzione nel prompt sarebbe la
 * stessa forma del checkpoint WIP dei `max-turns` — un passo che l'agente esegue
 * solo se gli restano turni, e che quindi non esegue proprio nei casi che
 * contano.
 *
 * Uso:
 *   ISSUE_NUMBER=548 node scripts/ci/handoff-to-site.mjs [--dry-run]
 *
 * Env: `GH_REPO` (questo repo), `SITE_TOKEN` (il PAT con accesso al sito),
 *      `GH_TOKEN` (per leggere e commentare qui).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Il marker di verdetto ha UNA definizione condivisa: era scritto identico qui e
// in `close-recovered-failure-issues.mjs`, che gia' lo esporta. Due copie della
// stessa regex sono due posti dove il contratto puo' divergere in silenzio.
import { FIX_OUTCOME_RE } from './close-recovered-failure-issues.mjs';

export const SITE_REPO = process.env.SITE_REPO || 'valerielinc-ops/frontaliere-si-o-no';
const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
const ISSUE = process.env.ISSUE_NUMBER || '';
const DRY = process.argv.includes('--dry-run');

/** I verdetti che possono nascondere un «lato sbagliato del mirror». */
export const HANDOFF_VERDICTS = new Set([
  'blocked-admin-settings',
  'blocked-workflows-scope',
  // `no-root-cause` NON significa sempre «non ho trovato la causa». Misurato su
  // #316 (10 run fra il 2026-08-14 e il 2026-09-03): la causa era trovata,
  // scritta e riconfermata ogni volta — `isQueueManaged` in
  // `scripts/ci/followup-drainer.mjs` — e il fixer si fermava perche' quel file
  // e' `mode: identical` nel manifest, quindi scriverlo da qui verrebbe
  // sovrascritto al mirror successivo (AGENTS.md non-negoziabile #6). E'
  // esattamente il «lato sbagliato del mirror» che questo script esiste per
  // consegnare, ma il verdetto emesso non era instradabile: la diagnosi restava
  // in un commento che il sito non legge, e la issue ha ri-pagato 10 run
  // identici. Il verdetto da solo NON basta a distinguerlo da un vicolo cieco
  // vero: vedi `MIRROR_LOCKED_MODES` per la condizione che lo fa.
  'no-root-cause',
]);

/**
 * I `mode` del manifest per cui una fix scritta QUI viene sovrascritta al mirror
 * successivo — cioe' la definizione operativa di «lato sbagliato del mirror».
 *
 * Solo `identical`: un file `adapted` e' dichiarato diverso per costruzione ed e'
 * **nostro** da modificare, quindi un `no-root-cause` che lo cita non e' un caso
 * di mirror. `corpus-only` non esiste nemmeno la'.
 */
export const MIRROR_LOCKED_MODES = new Set(['identical']);

const MANIFEST_PATH = fileURLToPath(new URL('./loop-sync-manifest.json', import.meta.url));

/**
 * I `mode` che dichiarano «questo file sul sito NON esiste». Un path citato con
 * uno di questi non e' mai spedibile e non e' mai residuo: e' evidenza.
 *
 * `corpus-only-pending` sta qui con `corpus-only` perche' la domanda a cui questa
 * lista risponde e' «esiste di la' OGGI», e per entrambi la risposta e' no; il
 * grado dice se DOVREBBE esistere, che e' un'altra domanda (vedi l'intestazione
 * del manifest, issue #125).
 *
 * `not-ported` NON sta qui: il manifest lo definisce all'opposto — «il sito ce
 * l'ha, qui deliberatamente no». Metterlo fra gli assenti filtrava via proprio il
 * caso canonico di hand-off, e in silenzio: il solo entry `not-ported` e'
 * `scripts/lib/control-char-publish-gate.mjs`, il gate dei control character che
 * di la' esiste ed e' l'unico posto dove quella diagnosi si puo' applicare.
 * Stessa lista, stessa ragione, di `ABSENT_ON_SITE_MODES` in
 * `loop-drift-check.mjs`.
 */
export const SITE_ABSENT_MODES = new Set(['corpus-only', 'corpus-only-pending']);

/**
 * I path che il manifest dichiara inesistenti sul sito. Sorgente unica, come
 * `mirrorLockedPaths()`.
 *
 * Serve a togliere dai path CITATI quelli che la diagnosi porta come EVIDENZA e
 * non come lavoro. Il caso tipico e' `scripts/ci/loop-sync-manifest.json`, cioe'
 * il manifest stesso: ogni diagnosi di mirror lo cita per provare il `mode`, e
 * misurato il 2026-09-06 sulle 280 issue con un verdetto compariva fra i «path
 * del sito» spediti in 4 delle 9 consegne — un file che di la' non c'e'.
 *
 * Manifest illeggibile → insieme vuoto, cioe' nessun filtro: qui il fallimento
 * sicuro e' il comportamento di prima, non una consegna vuota.
 */
export function siteAbsentPaths(manifestPath = MANIFEST_PATH) {
  try {
    const man = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const out = new Set();
    for (const f of man?.files || []) {
      if (SITE_ABSENT_MODES.has(f?.mode) && f?.path) out.add(f.path);
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * I path che il manifest dichiara bloccati dal mirror, come mappa
 * **path del corpus → path del sito**. Letti dalla SORGENTE UNICA
 * (`scripts/ci/loop-sync-manifest.json`), non da un elenco ricopiato qui: se un
 * file cambia `mode`, questa decisione cambia con lui, gratis.
 *
 * I due lati NON hanno lo stesso path: 112 dei 157 entry `identical` portano un
 * `sitePath` diverso (`host/shared/clauseTail.mjs` →
 * `build-plugins/shared/clauseTail.mjs`). La chiave resta il path del corpus,
 * perche' e' la forma in cui il fixer scrive la diagnosi; il valore e' quello da
 * spedire, perche' e' l'unico che di la' esiste. Stessa risoluzione
 * (`sitePath || path`) di `transport-identical-twins.mjs` e `loop-drift-check.mjs`,
 * gli altri due lettori del manifest che parlano al repo del sito.
 */
export function mirrorLockedPaths(manifestPath = MANIFEST_PATH) {
  try {
    const man = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const out = new Map();
    for (const f of man?.files || []) {
      if (!MIRROR_LOCKED_MODES.has(f?.mode) || !f?.path) continue;
      out.set(f.path, f.sitePath || f.path);
    }
    return out;
  } catch {
    // Manifest illeggibile → mappa vuota: nessun `no-root-cause` viene
    // spedito. Il fallimento sicuro e' non consegnare, non consegnare a caso.
    return new Map();
  }
}

/**
 * Come si chiama di la' un path citato in forma corpus: mappa
 * **path del corpus → path del sito** per TUTTI gli entry che il manifest non
 * dichiara assenti dal sito (`identical`, `adapted`, `not-ported`).
 *
 * E' una domanda DIVERSA da quella di `mirrorLockedPaths()`, che risponde a «il
 * mirror sovrascriverebbe una fix scritta qui» e per costruzione conosce i soli
 * `identical`. Usarla anche per tradurre i nomi perdeva i 69 gemelli `adapted`,
 * 36 dei quali hanno un `sitePath` diverso: un path `adapted` citato in forma
 * corpus veniva spedito cosi' com'e' — un file che di la' non c'e' — e sul ramo
 * `blocked-*`, che chiude, la issue di origine spariva sopra una consegna che
 * punta al vuoto. E' la stessa perdita di #472.
 *
 * Stessa risoluzione (`sitePath || path`) di `transport-identical-twins.mjs` e
 * `loop-drift-check.mjs`. Manifest illeggibile → mappa vuota, cioe' nessuna
 * traduzione: si spedisce la forma citata, che e' il comportamento di prima.
 */
export function sitePathMap(manifestPath = MANIFEST_PATH) {
  try {
    const man = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const out = new Map();
    for (const f of man?.files || []) {
      if (!f?.path || SITE_ABSENT_MODES.has(f?.mode)) continue;
      out.set(f.path, f.sitePath || f.path);
    }
    return out;
  } catch {
    return new Map();
  }
}

/**
 * Ultimo verdetto + il corpo che lo porta. Pura.
 *
 * Un verdetto SENZA data parsabile non viene scartato (#815, item 1: stessa
 * classe, gemello `corpus-only` di `needs-human-prepass.mjs`). Le due forme
 * accettate qui hanno chiavi diverse (`created_at` REST, `createdAt` GraphQL) e
 * nessuna delle due e' garantita da un tipo: se la data manca, scartare il
 * commento fa tornare `null`, cioe' «nessun verdetto» — indistinguibile dal caso
 * in cui nessun fixer e' mai passato. Qui il costo e' preciso: un
 * `blocked-workflows-scope` che nomina un file del sito non verrebbe MAI
 * spedito, e l'unico segnale sarebbe una diagnosi che non arriva mai di la'.
 *
 * Un verdetto datato batte sempre uno senza data; fra due senza data vince
 * l'ultimo in ordine di lista, che e' l'ordine cronologico dell'API.
 */
export function lastVerdictComment(comments) {
  let best = null;
  let at = -Infinity;
  let undated = null;
  for (const c of comments || []) {
    const body = String(c?.body || '');
    const m = FIX_OUTCOME_RE.exec(body);
    if (!m) continue;
    const t = Date.parse(c?.created_at ?? c?.createdAt);
    if (Number.isNaN(t)) { undated = { verdict: m[1].toLowerCase(), body }; continue; }
    if (t >= at) { at = t; best = { verdict: m[1].toLowerCase(), body }; }
  }
  return best ?? undated;
}

/**
 * I path del SITO citati in una diagnosi. Pura.
 *
 * Serve a due cose insieme: è il discriminante del hand-off — una diagnosi che
 * non nomina un file non è azionabile e non va spedita — ed è il contenuto utile
 * della issue che si apre. Estrarre i path e non solo il nome del repo evita di
 * spedire un «guarda là» che il sito dovrebbe ri-diagnosticare da zero.
 */
export function extractSitePaths(body) {
  const text = String(body || '');
  const out = new Set();
  // Path in backtick: la forma in cui il fixer li scrive (AGENTS.md lo prescrive).
  for (const m of text.matchAll(/`([\w.-]+(?:\/[\w.-]+)+\.[a-z]{2,4})`/g)) out.add(m[1]);
  return [...out];
}

/**
 * Il vocabolario con cui una diagnosi AFFERMA il blocco del mirror. Sono i
 * termini del manifest stesso (`mode: identical`, `sitePath`, il verdetto
 * `site-ahead` di `loop-drift-check.mjs`) piu' il modo in cui il fixer scrive la
 * conseguenza («verrebbe sovrascritto al mirror successivo») e lo slug del sito.
 *
 * Non e' il nome del repo in prosa che il commento di `handoffDecision` scarta
 * come terno al lotto: quello era il discriminante DA SOLO. Qui e' il secondo
 * termine di una congiunzione col manifest, e serve a separare la menzione dal
 * soggetto — non a stabilire che il file e' condiviso, cosa che il manifest dice
 * gia' meglio.
 */
export const MIRROR_CLAIM_RE = /identical|site[- ]ahead|mirror|sovrascritt|sitePath|frontaliere-si-o-no/i;

/** Quanto testo intorno alla citazione vale come «stessa frase». */
const CLAIM_WINDOW = 240;

/**
 * Il path e' citato COME blocco del mirror, non solo nominato. Pura.
 *
 * Il difetto misurato (#972 item 1, marcato «funnel-critical» dal reviewer di
 * #914): il discriminante era «un qualunque path in backtick e' `identical` nel
 * manifest». Dei 157 entry `identical`, 47 stanno sotto `scripts/` e sono i file
 * del ciclo agentico stesso — `triage-sweep.mjs`, `pr-autorebase.mjs`,
 * `harvest-agent-lessons.mjs` — cioe' esattamente quelli che OGNI diagnosi sul
 * loop nomina di passaggio, spesso solo per escluderli. Una menzione incidentale
 * bastava a instradare e, senza residuo, a CHIUDERE la issue di origine: il
 * portatore della diagnosi spariva per effetto della consegna.
 *
 * La corroborazione richiesta e' la stessa idea di `isDistinctiveToken()` in
 * `followup-resolution-match.mjs`: un token nudo non e' evidenza, deve portare
 * la struttura che lo qualifica. Qui la struttura e' l'affermazione di mirror
 * nella stessa frase — ed e' un termine in CONGIUNZIONE col manifest, che resta
 * l'ancora. Se sbaglia, sbaglia verso il non-instradare, cioe' verso lo status
 * quo; l'altro verso e' quello che perde la issue.
 */
export function citedAsMirrorBlocked(body, path) {
  const text = String(body || '');
  const needle = '`' + path;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    const window = text.slice(Math.max(0, i - CLAIM_WINDOW), i + needle.length + CLAIM_WINDOW);
    if (MIRROR_CLAIM_RE.test(window)) return true;
  }
  return false;
}

/**
 * La decisione, dal solo verdetto + corpo. Pura → testabile senza rete.
 *
 * `handoff: false` è il default e non un errore: la maggior parte dei
 * `blocked-admin-settings` di un repo normale è davvero un'impostazione di repo,
 * e spedirla al sito sarebbe rumore. Servono TUTTE E TRE le condizioni base — il
 * verdetto giusto, il nome del repo del sito, e almeno un path — perché è la
 * congiunzione che ha selezionato 4 casi su 4 senza falsi.
 *
 * `no-root-cause` usa invece verdetto + path + **manifest**, e SOSTITUISCE la
 * condizione sul nome del repo invece di aggiungersi ad essa. Due misure del
 * 2026-09-04 sulle 26 issue aperte con un verdetto:
 *
 * - La congiunzione a tre non basta a disambiguare questo verdetto, che copre
 *   sia il vicolo cieco vero sia il mirror: avrebbe spedito anche #694, i cui
 *   path sono `adapted` e corpus-only — lavoro NOSTRO — chiudendo qui una issue
 *   legittima. Peggio del parcheggio che il hand-off esiste per togliere.
 * - Il nome del repo in prosa e' un falso negativo: dei 14 verdetti di #316,
 *   4 non scrivono lo slug `frontaliere-si-o-no` pur diagnosticando lo stesso
 *   file `identical`. Legare la consegna alla prosa dell'agente la rende un
 *   terno al lotto, mentre `mode: identical` nel manifest **e'** l'affermazione
 *   che quel file e' condiviso col sito: e' evidenza piu' forte, non piu' debole.
 *
 * Con questa regola la selezione e' 1 su 26, ed e' #316 — l'unica che il mirror
 * blocca davvero.
 *
 * `paths` sono i path **come esistono sul sito** (`sitePath` del manifest quando
 * differisce): il match resta sul path del corpus, che e' la forma in cui il
 * fixer scrive la diagnosi, ma spedire quella forma manderebbe il fixer di la' a
 * cercare un file che nel suo repo non c'e'.
 *
 * `residual` sono i path citati che il mirror NON porta — lavoro che resta qui.
 * Non e' un dettaglio di reporting: e' cio' che decide se la issue di origine si
 * puo' chiudere `completed` (vedi `main`), perche' una issue aggregata come #316
 * porta anche item su file `adapted` che nessun mirror consegnera'.
 *
 * `close` dice se la consegna AUTORIZZA a chiudere qui. Solo i `blocked-*` lo
 * fanno: la loro forma misurata 4 su 4 e' esplicita («il file da cambiare vive
 * di la'»), quindi «consegnata» e «risolta» coincidono. `no-root-cause` non lo
 * autorizza MAI — e' il verdetto ambiguo per costruzione, quello che copre anche
 * il vicolo cieco vero, e chiudere su una sua inferenza fa evaporare l'unico
 * portatore della diagnosi (#972 item 1). Si consegna e si parcheggia: il
 * parcheggio non ri-paga run e `needs-human-sweep.yml` e' la porta di rientro,
 * mentre la chiusura sbagliata non ha porta di rientro affatto.
 *
 * @returns {{handoff: boolean, paths: string[], residual: string[], close: boolean, reason: string}}
 */
export function handoffDecision({ verdict, body, lockedPaths, siteAbsent, siteNames } = {}) {
  if (!verdict || !HANDOFF_VERDICTS.has(verdict)) {
    return { handoff: false, paths: [], residual: [], close: false, reason: `verdetto non instradabile: ${verdict ?? 'nessuno'}` };
  }
  const paths = extractSitePaths(body);
  if (!paths.length) {
    return { handoff: false, paths: [], residual: [], close: false, reason: 'nessun path citato: la diagnosi non è azionabile così com\'è' };
  }
  const absent = siteAbsent ?? siteAbsentPaths();
  const locked = lockedPaths ?? mirrorLockedPaths();
  const names = siteNames ?? sitePathMap();
  // UN solo idioma di traduzione per i due rami: «come si chiama di la'» e' una
  // domanda sola, e la risposta viene dal manifest INTERO (`sitePathMap`), non
  // dai soli `identical`. `locked` resta consultata per prima perche' i test
  // possono iniettarla; una `Set` iniettata non ha `get` e vale come identita'.
  const siteOf = (p) => (typeof locked?.get === 'function' ? locked.get(p) : null) || names.get(p) || p;
  if (verdict === 'no-root-cause') {
    // CONGIUNZIONE, non sola appartenenza: il manifest dice che il file e'
    // condiviso, la citazione dice che la diagnosi PARLA di quel file. Vedi
    // `citedAsMirrorBlocked` per il caso misurato.
    const inManifest = paths.filter((p) => locked.has(p));
    const blocked = inManifest.filter((p) => citedAsMirrorBlocked(body, p));
    if (!blocked.length) {
      return {
        handoff: false,
        paths: [],
        residual: [],
        close: false,
        reason: inManifest.length
          ? `no-root-cause: ${inManifest.join(', ')} è \`identical\` nel manifest ma citato senza affermazione di mirror — menzione incidentale, non lato sbagliato del mirror`
          : 'no-root-cause senza path `identical` nel manifest: vicolo cieco, non lato sbagliato del mirror',
      };
    }
    // Si spediscono i SOLI path bloccati, non tutti quelli citati. Una diagnosi
    // di questa forma nomina anche i file NOSTRI che ha esaminato per escluderli
    // (`classify-issue.mjs` e' `adapted`, `loop-sync-manifest.json` e' la prova):
    // elencarli di la' sotto «path del sito» direbbe al ciclo del sito di
    // cambiare file che il mirror non condivide. Il corpo integrale della
    // diagnosi viaggia comunque sotto, quindi il contesto non si perde.
    const sitePaths = [...new Set(blocked.map(siteOf))];
    return {
      handoff: true,
      paths: sitePaths,
      // Il residuo e' LAVORO che resta qui, quindi ne escono sia i path che il
      // mirror porta sia quelli che il manifest dichiara inesistenti sul sito:
      // questi ultimi sono evidenza (#972 item 2), e contarli parcheggiava la
      // issue per una citazione invece che per lavoro aperto.
      residual: paths.filter((p) => !locked.has(p) && !absent.has(p)),
      // Consegna sì, chiusura no: vedi il blocco su `close` sopra.
      close: false,
      reason: `diagnosi bloccata dal mirror su ${sitePaths.join(', ')}`,
    };
  }
  const siteName = SITE_REPO.split('/')[1];
  if (!String(body || '').includes(siteName)) {
    return { handoff: false, paths: [], residual: [], close: false, reason: 'la diagnosi non nomina il repo del sito' };
  }
  // STESSA CLASSE del ramo sopra, e la misura del 2026-09-06 sulle 280 issue con
  // un verdetto la smentisce nei fatti: delle 9 consegne `blocked-*` reali solo
  // 2 citano un path solo, e 4 spedivano `scripts/ci/loop-sync-manifest.json`
  // — evidenza, `corpus-only`, di la' inesistente — mentre altre scrivevano la
  // forma CORPUS (`generator/scripts/create-article.mjs`) di un gemello che sul
  // sito vive altrove. La chiusura resta (qui la diagnosi e' esplicita: il file
  // da cambiare vive di la'), ma l'elenco spedito passa dal manifest come
  // nell'altro ramo: via l'evidenza, e forma del sito per i gemelli.
  const shippable = paths.filter((p) => !absent.has(p));
  const sitePaths = [...new Set(shippable.map(siteOf))];
  if (!sitePaths.length) {
    return {
      handoff: false,
      paths: [],
      residual: [],
      close: false,
      reason: 'i soli path citati sono dichiarati inesistenti sul sito dal manifest: evidenza, non lavoro instradabile',
    };
  }
  return { handoff: true, paths: sitePaths, residual: [], close: true, reason: `diagnosi con ${sitePaths.length} path del sito` };
}

/** Titolo della issue sul sito. Pura — e il discriminante sta PRIMO. */
export function handoffTitle(issueNumber, corpusTitle) {
  // Il numero della issue di origine apre il titolo, perché il dedup di chi
  // legge i titoli taglia a 60 caratteri: un discriminante in coda si perde.
  return `corpus#${issueNumber}: ${String(corpusTitle || '').slice(0, 90)}`;
}

function gh(args, { token, json = true } = {}) {
  const env = { ...process.env };
  if (token) { env.GH_TOKEN = token; env.GITHUB_TOKEN = token; }
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
  return json ? JSON.parse(out) : out;
}

function main() {
  if (!REPO || !ISSUE) { console.log('handoff-to-site: REPO o ISSUE_NUMBER assenti → niente da fare.'); return; }
  const token = process.env.SITE_TOKEN || '';

  let data;
  try {
    data = gh(['issue', 'view', ISSUE, '--repo', REPO, '--json', 'title,comments']);
  } catch (e) {
    console.log(`handoff-to-site: issue #${ISSUE} non leggibile (${String(e).slice(0, 100)}) → niente da fare.`);
    return;
  }
  const last = lastVerdictComment(data?.comments || []);
  const d = handoffDecision({ verdict: last?.verdict, body: last?.body });
  if (!d.handoff) { console.log(`handoff-to-site: #${ISSUE} non instradata — ${d.reason}.`); return; }

  const origin = `https://github.com/${REPO}/issues/${ISSUE}`;
  // Dedup PRIMA di aprire: la ricerca è sul link di origine nel body, non sul
  // titolo. Un titolo può essere riscritto; il link no, ed è l'unica cosa che
  // lega le due issue in modo verificabile.
  if (token) {
    try {
      const existing = gh(['issue', 'list', '--repo', SITE_REPO, '--state', 'all',
        '--search', `"${origin}" in:body`, '--json', 'number,url', '--limit', '5'], { token });
      if (Array.isArray(existing) && existing.length) {
        console.log(`handoff-to-site: #${ISSUE} già consegnata → ${existing[0].url}. Niente doppioni.`);
        return;
      }
    } catch { /* ricerca non disponibile → si prosegue: il rischio è un doppione, non una perdita */ }
  }

  const body = [
    `Consegnata dal ciclo di \`${REPO}\` (post-step deterministico di \`issue-fix\`, zero-Claude).`,
    '',
    `Il fixer di là ha diagnosticato che il file da cambiare vive **in questo repo**, e si è fermato — o non ha i permessi per pushare qui, o il file è \`mode: identical\` nel manifest e una fix scritta di là verrebbe sovrascritta al mirror successivo. La diagnosi è completa e già pagata: è riportata sotto integralmente, così non va rifatta.`,
    '',
    `**Motivo dell'instradamento:** ${d.reason}`,
    '',
    `**Path del sito citati:** ${d.paths.map((p) => `\`${p}\``).join(', ')}`,
    '',
    `**Origine:** ${origin}`,
    '',
    '---',
    '',
    last.body,
  ].join('\n');

  if (DRY || !token) {
    const why = DRY ? 'DRY-RUN' : 'SITE_TOKEN assente';
    console.log(`[${why}] aprirei su ${SITE_REPO}: "${handoffTitle(ISSUE, data.title)}"`);
    console.log(`[${why}] path: ${d.paths.join(', ')}`);
    if (!token) console.log('::warning::handoff-to-site: SITE_TOKEN assente → la diagnosi resta qui e nessuno la porta di là.');
    return;
  }

  let url = '';
  try {
    const created = gh(['issue', 'create', '--repo', SITE_REPO,
      '--title', handoffTitle(ISSUE, data.title), '--body', body], { token, json: false });
    url = String(created).trim().split('\n').pop() || '';
    console.log(`HANDOFF #${ISSUE} → ${url}`);
  } catch (e) {
    console.log(`::warning::handoff-to-site: apertura sul sito fallita (${String(e).slice(0, 120)}) → la issue resta qui, si ritenta al prossimo giro.`);
    return;
  }

  // Solo DOPO che la issue esiste di là si tocca questa: se l'apertura fallisce,
  // qui non resta traccia da ripulire e il prossimo giro riprova da zero.
  //
  // La chiusura NON è automatica. «Consegnata» e «risolta» coincidono solo
  // quando TUTTO ciò che la diagnosi nomina scende col mirror. Una issue
  // aggregata non è così: #316 porta anche un item su `scripts/lib/classify-issue.mjs`,
  // che è `adapted` — lavoro NOSTRO — e vive nel body della issue, mentre di là
  // viaggiano titolo + ultimo commento di verdetto. Chiuderla `completed`
  // dichiarerebbe risolto anche quell'item e ne farebbe evaporare l'unico
  // portatore, in silenzio e per effetto della consegna stessa.
  //
  // Quando resta un path citato che il mirror non porta si consegna e si
  // PARCHEGGIA: `needs-human` + via le label di routing è l'esclusione che il
  // drainer già usa (`followup-drainer.mjs`, i filtri di promozione), quindi la
  // issue non ri-paga le run che questo script esiste per togliere, e
  // `needs-human-sweep.yml` è la porta di rientro nel ciclo.
  const residual = d.residual || [];
  const tail = d.close
    ? 'Chiudo qui: quando la fix scenderà col mirror, la condizione che ha aperto questa issue non ci sarà più.'
    : residual.length
      ? `**Non la chiudo**: la diagnosi cita anche ${residual.map((p) => `\`${p}\``).join(', ')}, che il manifest NON dichiara \`identical\` — è lavoro di questo repo, il mirror non lo porterà, e questa issue ne resta l'unico portatore. La parcheggio in \`needs-human\` togliendo le label di routing, così non ri-paga run mentre aspetta.`
      : `**Non la chiudo**: il verdetto è \`no-root-cause\`, che copre anche il vicolo cieco vero — «consegnata» non implica «risolta», e una chiusura sbagliata farebbe evaporare l'unico portatore della diagnosi. La parcheggio in \`needs-human\` togliendo le label di routing: non ri-paga run, e \`needs-human-sweep.yml\` è la porta di rientro.`;
  try {
    gh(['issue', 'comment', ISSUE, '--repo', REPO, '--body',
      `📤 **Consegnata al sito**: ${url}\n\nIl fix vive in \`${SITE_REPO}\` e il ciclo di là ora ce l'ha, con la diagnosi di questo run riportata integralmente. ${tail}`], { json: false });
    if (!d.close) {
      gh(['issue', 'edit', ISSUE, '--repo', REPO,
        '--add-label', 'needs-human', '--remove-label', 'agent:fix', '--remove-label', 'agent:fix-queued'], { json: false });
    } else {
      gh(['issue', 'close', ISSUE, '--repo', REPO, '--reason', 'completed'], { json: false });
    }
  } catch (e) {
    const what = d.close ? 'non chiusa' : 'non parcheggiata';
    console.log(`::warning::handoff-to-site: #${ISSUE} consegnata ma ${what} (${String(e).slice(0, 100)}). La issue del sito esiste: nessun lavoro perso.`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('handoff-to-site.mjs')) main();
