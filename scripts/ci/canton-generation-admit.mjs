#!/usr/bin/env node
/**
 * canton-generation-admit.mjs — l'ammissione di UNA sezione cantonale alla
 * generazione (P8 del piano «sezioni articoli per cantone», D15/D16/D19).
 *
 * Lo esegue il job `section_gate` di `.github/workflows/generate-article-core.yml`
 * per i chiamanti `generate-article-<cantone>.yml`, DOPO `load-rc-env.mjs` e
 * PRIMA che il job `generate` esista: una sezione non ammessa non fa checkout
 * del corpus, non installa dipendenze e non chiama nessun modello.
 *
 * Quattro domande, dalla meno costosa alla piu' costosa. La prima che risponde
 * «no» chiude la run con successo e con un marcatore nel log:
 *
 *   1. LA SEZIONE PUO' GENERARE? (D16)
 *      - Remote Config e' stato caricato davvero? `load-rc-env.mjs` esce 0 anche
 *        quando non carica niente (fail-open, per scelta), quindi il controllo
 *        e' esplicito: una variabile che arriva SOLO da Remote Config
 *        (`GITHUB_PAT_NANAKO`) deve essere nell'ambiente. Senza, la lista dei
 *        cantoni accesi non e' leggibile e la risposta e' «no», non «forse».
 *      - la sezione e' accesa? Stessa funzione che usa `create-article.mjs`
 *        (`resolveCantonSectionGate`: `enabled` nel profilo oppure
 *        `CANTON_ARTICLE_SECTIONS_ENABLED` da Remote Config). Assente o vuoto =
 *        nessun cantone.
 *      - la sezione e' ATTIVA nel profilo corpus (`enabled`)? Il bootstrap
 *        inietta lo stesso insieme nel core; il rebase
 *        (`--section-surfaces`), il ricontrollo di unicita' dopo il rebase e la
 *        pubblicazione leggono le sezioni attive: generare per una sezione
 *        spenta nel core vorrebbe dire scrivere file che il rebase non sa
 *        risolvere e che nessuno pubblica.
 *   2. C'E' ANCORA BUDGET? (D19) I commit `Generate blog article (<sezione>)`
 *      delle ultime 24 ore sul ramo di destinazione, contro `dailyBudget` del
 *      profilo (`generator/data/canton-sections.json`), eventualmente abbassato
 *      da `vars.CANTON_DAILY_BUDGET_CAP` (il pilota a <=2/giorno).
 *   3. QUANTI CANTONI STANNO GIA' GENERANDO? Una sola lettura delle run
 *      `in_progress` del repo: quelle dei workflow `generate-article-<cantone>.yml`
 *      PIU' VECCHIE di questa non devono raggiungere
 *      `vars.CANTON_GENERATION_MAX_PARALLEL` (default 3). Il confronto e'
 *      asimmetrico come in `admit`: fra due arrivi simultanei esattamente uno si
 *      vede davanti, quindi non si fermano a vicenda.
 *   4. LA QUOTA CONDIVISA E' SOTTO PRESSIONE? I cantoni hanno precedenza
 *      INFERIORE a frontaliere/svizzera e al ciclo delle PR: se
 *      `check-quota-backoff.mjs` trova un beacon di rate limit attivo (qui o sul
 *      repo del sito) il cantone cede il turno.
 *
 * Un dispatch manuale salta 2-4 (una richiesta esplicita non e' un arrivo
 * ridondante, come in `admit`), mai la 1: una sezione spenta non genera.
 *
 * FAIL-CLOSED su 2 e 3: se GitHub non risponde, il cantone salta lo slot. Costa
 * un turno a una sezione a bassa precedenza; il contrario costerebbe quota a
 * frontaliere/svizzera. La 4 eredita il contratto proceed-safe di
 * `check-quota-backoff.mjs` (un beacon illeggibile non e' un beacon attivo).
 *
 * Output (`GITHUB_OUTPUT`): `proceed=true|false`, `reason=<motivo>`.
 * Log: `GENERATION_OUTCOME kind=skipped reason=<motivo> section=<id>` quando
 * salta (stessa forma di `admit`), piu' `CANTON_SECTION_DISABLED section=<id>`
 * per una sezione spenta (stesso marcatore di `create-article.mjs`).
 * Exit 0 sempre, salvo un uso sbagliato (sezione non cantonale: exit 2).
 *
 * Solo builtin Node e moduli puri del corpus, come ogni script di `scripts/ci/`.
 */
import '../../host/cantonSectionsBootstrap.mjs';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCantonSection } from '../../engine/shared/articleSectionCore.mjs';
import { activeCorpusCoreMap } from '../lib/corpus-sections.mjs';
import {
  CANTON_SECTION_DISABLED_MARKER,
  CANTON_SECTIONS_ENABLED_ENV,
  cantonSectionProfile,
  resolveCantonSectionGate,
} from '../../generator/scripts/lib/canton-section-profile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Variabile che arriva SOLO da Remote Config: la sua presenza prova il caricamento. */
export const RC_SENTINEL_ENV = 'GITHUB_PAT_NANAKO';

/** Tetto globale di cantoni che generano insieme, se `vars` non lo imposta. */
export const DEFAULT_MAX_PARALLEL = 3;

/** Finestra del budget giornaliero. */
export const BUDGET_WINDOW_HOURS = 24;

/** Il workflow riusabile: non ha run proprie, ma il suo nome ha la stessa forma dei chiamanti. */
export const CORE_WORKFLOW_PATH = '.github/workflows/generate-article-core.yml';

/** I chiamanti cantonali: `generate-article-<codice-minuscolo>.yml`. */
export const CANTON_WORKFLOW_PATH_RE = /^\.github\/workflows\/generate-article-[a-z0-9]+\.yml$/;

/** Remote Config e' stato caricato in questo job? */
export function remoteConfigLoaded(env = process.env) {
  return typeof env?.[RC_SENTINEL_ENV] === 'string' && env[RC_SENTINEL_ENV].trim() !== '';
}

/** Un intero positivo scritto come stringa, oppure `fallback`. */
export function positiveInt(raw, fallback) {
  const s = String(raw ?? '').trim();
  if (!/^[0-9]+$/.test(s)) return fallback;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** `dailyBudget` del profilo, abbassato (mai alzato) da un tetto globale opzionale. */
export function effectiveDailyBudget(profile, capRaw) {
  const budget = Number(profile?.dailyBudget);
  if (!Number.isInteger(budget) || budget < 0) {
    throw new Error(`dailyBudget non valido per ${profile?.section}: ${profile?.dailyBudget}`);
  }
  const cap = positiveInt(capRaw, null);
  return cap === null ? budget : Math.min(budget, cap);
}

/** Il subject che `generate-article-core.yml` scrive per un articolo della sezione. */
export function articleCommitSubject(section) {
  return `Generate blog article (${section})`;
}

/** Quanti dei subject sono articoli della sezione (confronto esatto, non per prefisso). */
export function countSectionArticles(subjects, section) {
  const wanted = articleCommitSubject(section);
  return (subjects || []).filter((s) => String(s).trim() === wanted).length;
}

/**
 * Le run dei workflow cantonali in volo e PIU' VECCHIE di questa.
 *
 * @param {Array<{ id: number, path: string, created_at: string }>} runs run `in_progress` del repo
 * @param {number|string} selfId
 * @returns {{ older: number, total: number, selfSeen: boolean }}
 */
export function olderCantonRuns(runs, selfId) {
  const me = Number(selfId);
  const canton = (runs || []).filter((r) => r && typeof r.path === 'string'
    && r.path !== CORE_WORKFLOW_PATH && CANTON_WORKFLOW_PATH_RE.test(r.path));
  const self = canton.find((r) => Number(r.id) === me);
  const others = canton.filter((r) => Number(r.id) !== me);
  if (!self) {
    // Questa run non e' nell'elenco (pagina piena, o stato non ancora
    // `in_progress`): non c'e' un istante con cui confrontare, quindi ogni
    // altra run conta. E' il verso prudente.
    return { older: others.length, total: others.length, selfSeen: false };
  }
  const older = others.filter((r) => r.created_at < self.created_at
    || (r.created_at === self.created_at && Number(r.id) < me)).length;
  return { older, total: others.length, selfSeen: true };
}

/**
 * La decisione, pura rispetto alla rete: le letture arrivano come funzioni.
 *
 * @param {{
 *   section: string,
 *   env?: Record<string, string | undefined>,
 *   eventName?: string,
 *   activeSections?: Record<string, unknown>,
 *   profiles?: any,
 *   readArticleSubjects: () => string[] | null,
 *   readInProgressRuns: () => Array<{ id: number, path: string, created_at: string }> | null,
 *   readQuotaBeacon: () => { active: boolean, resetsAt?: number | null },
 *   selfId?: number | string,
 * }} input
 * @returns {{ proceed: boolean, reason: string, detail: string, unknown?: string[] }}
 */
export function decideCantonAdmission({
  section,
  env = process.env,
  eventName = '',
  activeSections = activeCorpusCoreMap(),
  profiles,
  readArticleSubjects,
  readInProgressRuns,
  readQuotaBeacon,
  selfId = 0,
}) {
  if (!isCantonSection(section)) {
    throw new Error(`"${section}" non e' una sezione cantonale del core`);
  }
  if (!remoteConfigLoaded(env)) {
    return {
      proceed: false,
      reason: 'rc-unavailable',
      detail: `Remote Config non caricato (${RC_SENTINEL_ENV} assente dall'ambiente): `
        + `${CANTON_SECTIONS_ENABLED_ENV} non e' leggibile, la sezione resta spenta`,
    };
  }
  const gate = resolveCantonSectionGate(section, { env, profiles });
  if (!gate.enabled) {
    return {
      proceed: false,
      reason: 'canton-disabled',
      detail: `sezione non accesa: ne' enabled nel profilo ne' in ${CANTON_SECTIONS_ENABLED_ENV}`,
      unknown: gate.unknown,
    };
  }
  if (!Object.prototype.hasOwnProperty.call(activeSections, section)) {
    return {
      proceed: false,
      reason: 'canton-inactive',
      detail: `sezione accesa (${gate.via}) ma non attiva nel profilo corpus (enabled): `
        + 'bootstrap, rebase, unicita\' e pubblicazione non la coprono',
      unknown: gate.unknown,
    };
  }
  if (eventName === 'workflow_dispatch') {
    return {
      proceed: true,
      reason: 'manual-dispatch',
      detail: 'dispatch manuale: budget, tetto globale e beacon non si applicano',
      unknown: gate.unknown,
    };
  }

  const budget = effectiveDailyBudget(cantonSectionProfile(section, profiles), env?.CANTON_DAILY_BUDGET_CAP);
  const subjects = readArticleSubjects();
  if (!Array.isArray(subjects)) {
    return {
      proceed: false,
      reason: 'budget-unreadable',
      detail: `commit delle ultime ${BUDGET_WINDOW_HOURS}h non leggibili: il budget non e' verificabile, si salta lo slot`,
    };
  }
  const produced = countSectionArticles(subjects, section);
  if (produced >= budget) {
    return {
      proceed: false,
      reason: 'daily-budget',
      detail: `${produced} articoli nelle ultime ${BUDGET_WINDOW_HOURS}h su un budget di ${budget}`,
    };
  }

  const cap = positiveInt(env?.CANTON_GENERATION_MAX_PARALLEL, DEFAULT_MAX_PARALLEL);
  const runs = readInProgressRuns();
  if (!Array.isArray(runs)) {
    return {
      proceed: false,
      reason: 'parallel-unreadable',
      detail: 'run in_progress non leggibili: il tetto globale non e\' verificabile, si salta lo slot',
    };
  }
  const { older, total, selfSeen } = olderCantonRuns(runs, selfId);
  if (older >= cap) {
    return {
      proceed: false,
      reason: 'parallel-cap',
      detail: `${older} run cantonali piu' vecchie gia' in volo (in tutto ${total}, tetto ${cap}`
        + `${selfSeen ? '' : '; questa run non e\' nell\'elenco, contate tutte'})`,
    };
  }

  const beacon = readQuotaBeacon();
  if (beacon?.active) {
    return {
      proceed: false,
      reason: 'quota-beacon',
      detail: `beacon di rate limit attivo${beacon.resetsAt ? ` fino a ${new Date(beacon.resetsAt * 1000).toISOString()}` : ''}: `
        + 'i cantoni cedono a frontaliere/svizzera e al ciclo delle PR',
    };
  }

  return {
    proceed: true,
    reason: 'admitted',
    detail: `budget ${produced}/${budget} nelle ultime ${BUDGET_WINDOW_HOURS}h, ${older} run cantonali piu' vecchie in volo (tetto ${cap}), nessun beacon`,
    unknown: gate.unknown,
  };
}

/** `resets_at=<epoch>` dall'output di `check-quota-backoff.mjs`: attivo se nel futuro. */
export function parseQuotaBeaconOutput(text, nowSec = Math.floor(Date.now() / 1000)) {
  let resetsAt = null;
  for (const line of String(text || '').split('\n')) {
    const m = /^resets_at=(\d+)\s*$/.exec(line);
    if (m) resetsAt = Number(m[1]);
  }
  return { active: resetsAt !== null && resetsAt > nowSec, resetsAt };
}

// ── Letture (solo in modalita' CLI) ──────────────────────────────────────────

function gh(args, env = process.env) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      env,
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    console.warn(`::warning::canton-admit: gh ${args.slice(0, 2).join(' ')} fallito: ${String(error?.stderr || error?.message || error).trim().slice(0, 200)}`);
    return null;
  }
}

function readArticleSubjectsFromGitHub(repo, ref) {
  const since = new Date(Date.now() - BUDGET_WINDOW_HOURS * 3_600_000).toISOString();
  const raw = gh(['api', '--paginate',
    `repos/${repo}/commits?sha=${encodeURIComponent(ref)}&since=${encodeURIComponent(since)}&per_page=100`,
    '--jq', '.[] | .commit.message | split("\n")[0]']);
  return raw === null ? null : raw.split('\n').filter(Boolean);
}

function readInProgressRunsFromGitHub(repo) {
  const raw = gh(['api', `repos/${repo}/actions/runs?status=in_progress&per_page=100`,
    '--jq', '[.workflow_runs[] | {id: .id, path: .path, created_at: .created_at}]']);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readQuotaBeaconFromScript() {
  const dir = mkdtempSync(path.join(tmpdir(), 'canton-admit-beacon-'));
  const out = path.join(dir, 'output');
  try {
    appendFileSync(out, '');
    const env = { ...process.env, GITHUB_OUTPUT: out, DRY_RUN: '1', CODEX_FALLBACK_MODE: '1' };
    // Sola lettura: niente issue da ri-accodare, nessun lease.
    for (const k of ['ISSUE_NUMBER', 'PR_NUMBER', 'QUOTA_LEASE_ACTION']) delete env[k];
    execFileSync(process.execPath, [path.join(HERE, 'check-quota-backoff.mjs')], {
      env, encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'inherit', 'inherit'],
    });
    return parseQuotaBeaconOutput(readFileSync(out, 'utf8'));
  } catch (error) {
    console.warn(`::warning::canton-admit: beacon di quota non leggibile (${String(error?.message || error).slice(0, 160)}) → trattato come assente (contratto proceed-safe di check-quota-backoff.mjs)`);
    return { active: false, resetsAt: null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const section = String(process.env.SECTION || '').trim();
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
  const ref = process.env.TARGET_REF || 'main';
  let verdict;
  try {
    verdict = decideCantonAdmission({
      section,
      eventName: process.env.EVENT_NAME || '',
      selfId: process.env.SELF_ID || 0,
      readArticleSubjects: () => (repo ? readArticleSubjectsFromGitHub(repo, ref) : null),
      readInProgressRuns: () => (repo ? readInProgressRunsFromGitHub(repo) : null),
      readQuotaBeacon: readQuotaBeaconFromScript,
    });
  } catch (error) {
    console.error(`::error::canton-admit: ${error?.message ?? error}`);
    process.exit(2);
  }
  if (verdict.unknown?.length) {
    console.warn(`::warning::canton-admit: ${CANTON_SECTIONS_ENABLED_ENV} nomina cantoni sconosciuti al core: ${verdict.unknown.join(', ')}`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `proceed=${verdict.proceed}\nreason=${verdict.reason}\n`);
  }
  if (verdict.proceed) {
    console.log(`canton-admit: ${section} ammessa (${verdict.reason}) — ${verdict.detail}`);
  } else {
    if (verdict.reason === 'canton-disabled') console.log(`${CANTON_SECTION_DISABLED_MARKER} section=${section}`);
    console.log(`canton-admit: ${section} non ammessa — ${verdict.detail}`);
    console.log(`GENERATION_OUTCOME kind=skipped reason=${verdict.reason} section=${section}`);
  }
}
