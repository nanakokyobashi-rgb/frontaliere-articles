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

export const SITE_REPO = process.env.SITE_REPO || 'valerielinc-ops/frontaliere-si-o-no';
const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
const ISSUE = process.env.ISSUE_NUMBER || '';
const DRY = process.argv.includes('--dry-run');

/** I verdetti che possono nascondere un «lato sbagliato del mirror». */
export const HANDOFF_VERDICTS = new Set(['blocked-admin-settings', 'blocked-workflows-scope']);

const FIX_OUTCOME_RE = /<!--\s*FIX_OUTCOME:\s*([a-z0-9-]+)\s*-->/i;

/** Ultimo verdetto + il corpo che lo porta. Pura. */
export function lastVerdictComment(comments) {
  let best = null;
  let at = -Infinity;
  for (const c of comments || []) {
    const body = String(c?.body || '');
    const m = FIX_OUTCOME_RE.exec(body);
    if (!m) continue;
    const t = Date.parse(c?.created_at ?? c?.createdAt);
    if (!Number.isNaN(t) && t >= at) { at = t; best = { verdict: m[1].toLowerCase(), body }; }
  }
  return best;
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
 * e spedirla al sito sarebbe rumore. Servono TUTTE E TRE le condizioni — il
 * verdetto giusto, il nome del repo del sito, e almeno un path — perché è la
 * congiunzione che ha selezionato 4 casi su 4 senza falsi.
 *
 * @returns {{handoff: boolean, paths: string[], reason: string}}
 */
export function handoffDecision({ verdict, body } = {}) {
  if (!verdict || !HANDOFF_VERDICTS.has(verdict)) {
    return { handoff: false, paths: [], reason: `verdetto non instradabile: ${verdict ?? 'nessuno'}` };
  }
  const siteName = SITE_REPO.split('/')[1];
  if (!String(body || '').includes(siteName)) {
    return { handoff: false, paths: [], reason: 'la diagnosi non nomina il repo del sito' };
  }
  const paths = extractSitePaths(body);
  if (!paths.length) {
    return { handoff: false, paths: [], reason: 'nessun path citato: la diagnosi non è azionabile così com\'è' };
  }
  return { handoff: true, paths, reason: `diagnosi con ${paths.length} path del sito` };
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
    `Il fixer di là ha diagnosticato al turno 1 che il file da cambiare vive **in questo repo**, e si è fermato — non ha i permessi per pushare qui. La diagnosi è completa e già pagata: è riportata sotto integralmente, così non va rifatta.`,
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
  try {
    gh(['issue', 'comment', ISSUE, '--repo', REPO, '--body',
      `📤 **Consegnata al sito**: ${url}\n\nIl fix vive in \`${SITE_REPO}\` e il ciclo di là ora ce l'ha, con la diagnosi di questo run riportata integralmente. Chiudo qui: quando la fix scenderà col mirror, la condizione che ha aperto questa issue non ci sarà più.`], { json: false });
    gh(['issue', 'close', ISSUE, '--repo', REPO, '--reason', 'completed'], { json: false });
  } catch (e) {
    console.log(`::warning::handoff-to-site: #${ISSUE} consegnata ma non chiusa (${String(e).slice(0, 100)}). La issue del sito esiste: nessun lavoro perso.`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('handoff-to-site.mjs')) main();
