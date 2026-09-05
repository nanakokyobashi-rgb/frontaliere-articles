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
 * @returns {{handoff: boolean, paths: string[], residual: string[], reason: string}}
 */
export function handoffDecision({ verdict, body, lockedPaths } = {}) {
  if (!verdict || !HANDOFF_VERDICTS.has(verdict)) {
    return { handoff: false, paths: [], residual: [], reason: `verdetto non instradabile: ${verdict ?? 'nessuno'}` };
  }
  const paths = extractSitePaths(body);
  if (!paths.length) {
    return { handoff: false, paths: [], residual: [], reason: 'nessun path citato: la diagnosi non è azionabile così com\'è' };
  }
  if (verdict === 'no-root-cause') {
    const locked = lockedPaths ?? mirrorLockedPaths();
    // Il manifest e' una mappa corpus→sito; una `Set` iniettata resta accettata e
    // vale come identita' (il path del sito e' lo stesso del corpus).
    const siteOf = (p) => (typeof locked.get === 'function' ? locked.get(p) : null) || p;
    const blocked = paths.filter((p) => locked.has(p));
    if (!blocked.length) {
      return {
        handoff: false,
        paths: [],
        residual: [],
        reason: 'no-root-cause senza path `identical` nel manifest: vicolo cieco, non lato sbagliato del mirror',
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
      residual: paths.filter((p) => !locked.has(p)),
      reason: `diagnosi bloccata dal mirror su ${sitePaths.join(', ')}`,
    };
  }
  const siteName = SITE_REPO.split('/')[1];
  if (!String(body || '').includes(siteName)) {
    return { handoff: false, paths: [], residual: [], reason: 'la diagnosi non nomina il repo del sito' };
  }
  // I `blocked-*` scrivono gia' i path COME LI VEDE IL SITO (il fixer li ha letti
  // di la'): niente traduzione, e niente residuo — la forma misurata 4 su 4 e'
  // «un solo file, e vive sul sito».
  return { handoff: true, paths, residual: [], reason: `diagnosi con ${paths.length} path del sito` };
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
  const tail = residual.length
    ? `**Non la chiudo**: la diagnosi cita anche ${residual.map((p) => `\`${p}\``).join(', ')}, che il manifest NON dichiara \`identical\` — è lavoro di questo repo, il mirror non lo porterà, e questa issue ne resta l'unico portatore. La parcheggio in \`needs-human\` togliendo le label di routing, così non ri-paga run mentre aspetta.`
    : 'Chiudo qui: quando la fix scenderà col mirror, la condizione che ha aperto questa issue non ci sarà più.';
  try {
    gh(['issue', 'comment', ISSUE, '--repo', REPO, '--body',
      `📤 **Consegnata al sito**: ${url}\n\nIl fix vive in \`${SITE_REPO}\` e il ciclo di là ora ce l'ha, con la diagnosi di questo run riportata integralmente. ${tail}`], { json: false });
    if (residual.length) {
      gh(['issue', 'edit', ISSUE, '--repo', REPO,
        '--add-label', 'needs-human', '--remove-label', 'agent:fix', '--remove-label', 'agent:fix-queued'], { json: false });
    } else {
      gh(['issue', 'close', ISSUE, '--repo', REPO, '--reason', 'completed'], { json: false });
    }
  } catch (e) {
    const what = residual.length ? 'non parcheggiata' : 'non chiusa';
    console.log(`::warning::handoff-to-site: #${ISSUE} consegnata ma ${what} (${String(e).slice(0, 100)}). La issue del sito esiste: nessun lavoro perso.`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('handoff-to-site.mjs')) main();
