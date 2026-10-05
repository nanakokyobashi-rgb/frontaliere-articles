#!/usr/bin/env node
/**
 * adapted-drift-register.mjs — il registro dei gemelli `adapted` in drift da
 * riconciliare a mano, con l'esito del merge a 3 vie di ciascuno (issue #339).
 *
 * ## Perche' esiste
 *
 * Il report di `loop-drift-check.mjs` dice CHI si e' mosso, non QUANTO costa
 * riportare la modifica. Questo script lo misura con `git merge-file`:
 * ours = file del corpus, base = file del sito alla baseline del manifest
 * (ritrovato nella storia del sito), theirs = file del sito di oggi. Il numero
 * di conflitti separa i trasporti meccanici (0) dal lavoro a mano, e il
 * registro e' la lista di quel lavoro. Decisione del proprietario del
 * 2026-10-05: in automatico solo i merge puliti; nessuna PR con i marcatori di
 * conflitto, nessuna riconciliazione automatica degli altri.
 *
 * ## Dove gira
 *
 * Serve la STORIA del sito (la base del merge e' un blob vecchio), quindi un
 * clone del sito con la storia: `--site-dir`. Nessuna chiamata REST: tutto da
 * `git`. La issue si crea con `scripts/lib/github-issue-creator.mjs` (che usa
 * `gh`) e si aggiorna riscrivendone il body con `gh issue edit`.
 *
 * Uso:
 *   node scripts/ci/adapted-drift-register.mjs --site-dir <clone del sito> [opzioni]
 *     --site-ref <ref>      default origin/main
 *     --corpus-ref <ref>    default origin/main (manifest e file del corpus)
 *     --history-cap <n>     commit del sito esaminati per file, default 200
 *     --json                il registro come JSON su stdout
 *     --issue               crea o aggiorna la issue-registro
 *     --write-ratchet       pota scripts/ci/adapted-drift-ratchet.json ai path
 *                           ancora in drift (lo crea se manca; non aggiunge mai)
 *
 * Exit: 0 registro prodotto; 1 errore (clone del sito mancante, issue non scritta).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256, identicalSectionsVerdict } from './loop-drift-check.mjs';
import {
  ADAPTED_DRIFT_RATCHET_PATH,
  adaptedTwinState,
  isAdaptedDrift,
  pruneRatchetPaths,
  readRatchetFile,
  serializeRatchet,
} from './lib/adapted-drift.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_REL = 'scripts/ci/loop-sync-manifest.json';
const TOOL = 'adapted-drift-register';

export const ADAPTED_DRIFT_REGISTER_TITLE = 'Loop drift: gemelli adapted da riconciliare a mano';
export const REGISTER_MARKER = '<!-- adapted-drift-register -->';

const MAX_BUFFER = 256 * 1024 * 1024;

function gitBytes(cwd, args) {
  const res = spawnSync('git', args, { cwd, maxBuffer: MAX_BUFFER });
  return res.status === 0 ? res.stdout : null;
}

function gitText(cwd, args) {
  const out = gitBytes(cwd, args);
  return out === null ? null : out.toString('utf8');
}

/**
 * La revisione del sito a cui la baseline era allineata: il commit piu' recente
 * (entro `cap`) in cui il file ha l'hash `baselineSite`. `--follow` con
 * `--name-only` da' anche il path a ogni commit, cosi' un rinomina non perde la base.
 */
export function findSiteBase({ siteDir, siteRef, sitePath, baselineSite, cap }) {
  const log = gitText(siteDir, ['log', '--follow', `-n${cap}`, '--format=__C__%H', '--name-only', siteRef, '--', sitePath]);
  if (log === null) return null;
  let commit = null;
  for (const line of log.split('\n')) {
    if (line.startsWith('__C__')) {
      commit = line.slice(5);
      continue;
    }
    if (!line.trim() || !commit) continue;
    const bytes = gitBytes(siteDir, ['show', `${commit}:${line.trim()}`]);
    if (bytes !== null && sha256(bytes) === baselineSite) return { commit, path: line.trim(), bytes };
    commit = null;
  }
  return null;
}

/** Numero di conflitti di `git merge-file` (0 = pulito), o null se il merge non gira. */
export function mergeConflicts({ ours, base, theirs }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapted-3way-'));
  try {
    const files = { ours, base, theirs };
    for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), bytes);
    const res = spawnSync('git', ['merge-file', '-p', '--quiet', 'ours', 'base', 'theirs'], { cwd: dir, maxBuffer: MAX_BUFFER });
    if (res.error || res.status === null || res.status < 0 || res.status > 127) return null;
    return res.status;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Le PR del sito (dai titoli squash `… (#N)`) che hanno toccato il file dopo la base. */
export function sitePrsFromSubjects(subjects) {
  const prs = new Set();
  for (const subject of subjects) {
    const all = [...String(subject).matchAll(/\(#(\d+)\)/g)];
    if (all.length) prs.add(Number(all[all.length - 1][1]));
  }
  return [...prs].sort((a, b) => a - b);
}

/** Ancora del file nella pagina compare di GitHub: `#diff-<sha256 hex del path>`. */
export function compareUrl({ siteRepo, baseCommit, headCommit, sitePath }) {
  const anchor = crypto.createHash('sha256').update(sitePath).digest('hex');
  return `https://github.com/${siteRepo}/compare/${baseCommit}...${headCommit}#diff-${anchor}`;
}

/** Calcola il registro: una riga per ogni gemello `adapted` in drift. */
export function buildRegister({ corpusDir, corpusRef, siteDir, siteRef, cap }) {
  const manifestText = gitText(corpusDir, ['show', `${corpusRef}:${MANIFEST_REL}`]);
  if (manifestText === null) throw new Error(`${MANIFEST_REL} non leggibile a ${corpusRef}`);
  const manifest = JSON.parse(manifestText);
  const siteRepo = manifest.siteRepo || 'valerielinc-ops/frontaliere-si-o-no';
  const siteHead = gitText(siteDir, ['rev-parse', siteRef])?.trim();
  const corpusHead = gitText(corpusDir, ['rev-parse', corpusRef])?.trim();
  if (!siteHead) throw new Error(`ref del sito non risolvibile: ${siteRef} in ${siteDir}`);
  const adapted = manifest.files.filter((entry) => entry.mode === 'adapted');
  const counts = {};
  const rows = [];
  for (const entry of adapted) {
    const sitePath = entry.sitePath || entry.path;
    const site = gitBytes(siteDir, ['show', `${siteRef}:${sitePath}`]);
    const corpus = gitBytes(corpusDir, ['show', `${corpusRef}:${entry.path}`]);
    const state = adaptedTwinState({
      site: site === null ? null : sha256(site),
      corpus: corpus === null ? null : sha256(corpus),
      baseline: entry.baseline || null,
    });
    counts[state] = (counts[state] || 0) + 1;
    if (!isAdaptedDrift(state)) continue;
    const row = { path: entry.path, sitePath, state, conflicts: null, baseCommit: null, sitePrs: [], diffUrl: null, sections: null };
    const base = findSiteBase({ siteDir, siteRef, sitePath, baselineSite: entry.baseline.site, cap });
    if (base) {
      row.baseCommit = base.commit;
      row.conflicts = mergeConflicts({ ours: corpus, base: base.bytes, theirs: site });
      const subjects = gitText(siteDir, ['log', '--follow', '--format=%s', `${base.commit}..${siteRef}`, '--', sitePath]);
      row.sitePrs = sitePrsFromSubjects((subjects || '').split('\n').filter(Boolean));
      row.diffUrl = compareUrl({ siteRepo, baseCommit: base.commit, headCommit: siteHead, sitePath });
    }
    if (entry.identicalSections !== undefined) {
      const sections = identicalSectionsVerdict(entry, { site, corpus });
      row.sections = sections.drift ? `sezione byte-identica divergente: ${sections.detail}` : 'sezione byte-identica allineata';
    }
    rows.push(row);
  }
  rows.sort((a, b) => (a.conflicts ?? Infinity) - (b.conflicts ?? Infinity) || a.path.localeCompare(b.path));
  return { siteRepo, siteRef, siteHead, corpusRef, corpusHead, adapted: adapted.length, counts, rows };
}

export function bucketOf(conflicts) {
  if (conflicts === null || conflicts === undefined) return 'nobase';
  if (conflicts === 0) return 'clean';
  return conflicts <= 2 ? 'few' : 'many';
}

/** Il body della issue-registro. */
export function registerMarkdown(register) {
  const { rows } = register;
  const buckets = { clean: 0, few: 0, many: 0, nobase: 0 };
  for (const row of rows) buckets[bucketOf(row.conflicts)] += 1;
  const byState = (s) => rows.filter((r) => r.state === s).length;
  const cell = (s) => String(s).replace(/\|/g, '\\|');
  const fileCell = (r) => (r.sitePath === r.path ? `\`${cell(r.path)}\`` : `\`${cell(r.path)}\` ← sito \`${cell(r.sitePath)}\``);
  const conflictCell = (r) => (r.conflicts === null ? 'base non trovata' : r.conflicts === 0 ? '0 (pulito)' : String(r.conflicts));
  const lines = [
    REGISTER_MARKER,
    '',
    `Registro generato da \`scripts/ci/adapted-drift-register.mjs\`: non si modifica a mano, si rigenera. Corpus \`${register.corpusHead?.slice(0, 9)}\` (\`${register.corpusRef}\`), sito \`${register.siteHead.slice(0, 11)}\` (\`${register.siteRef}\`).`,
    '',
    `Gemelli \`adapted\`: ${register.adapted}. **In drift: ${rows.length}** (${byState('both-moved')} \`both-moved\`, ${byState('site-ahead')} \`site-ahead\`).`,
    '',
    `Merge a 3 vie con \`git merge-file\` (ours = corpus, base = sito alla baseline del manifest, theirs = sito di oggi): ${buckets.clean} puliti, ${buckets.few} con 1-2 conflitti, ${buckets.many} con 3 o piu', ${buckets.nobase} senza base ritrovata.`,
    '',
    '**Come si chiude una riga.** Porta a mano nel file del corpus la diff del sito linkata, rispettando l\'adattamento scritto nella `reason` del manifest, e apri una PR del corpus con nel body `Realign-adapted: <path> site-prs=#N[,#M]` (le PR del sito elencate qui). Al merge il job `realign-adapted` di `transport-identical-twins-realign.yml` riattesta la baseline e toglie il path da `scripts/ci/adapted-drift-ratchet.json`. Un merge pulito (0 conflitti) va comunque riletto: pulito non vuol dire semanticamente giusto.',
    '',
    `Il gate \`adapted-drift-budget\` (\`scripts/ci/adapted-drift-ratchet.mjs\`, nel workflow \`loop-drift-check.yml\`) va rosso se un gemello \`adapted\` entra in drift fuori da quell'elenco.`,
    '',
    '| File | Stato | Conflitti | PR del sito dalla baseline | Diff del sito dalla baseline |',
    '|---|---|---|---|---|',
    ...rows.map((r) => [
      fileCell(r) + (r.sections ? ` (${cell(r.sections)})` : ''),
      `\`${r.state}\``,
      conflictCell(r),
      r.sitePrs.length ? r.sitePrs.map((n) => `#${n}`).join(', ') : '—',
      r.diffUrl ? `[diff](${r.diffUrl})` : '—',
    ].join(' | ')).map((line) => `| ${line} |`),
    '',
    'Le PR del sito sono lette dai titoli dei commit squash (`… (#N)`) del sito fra la base e la punta: verificale prima di dichiararle in `Realign-adapted:`.',
    '',
    'Rigenera: `node scripts/ci/adapted-drift-register.mjs --site-dir <clone del sito con la storia> --issue`',
  ];
  return lines.join('\n');
}

function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER });
}

/** Crea la issue-registro col creator del repo, o ne riscrive il body se e' gia' aperta. */
async function upsertRegisterIssue(body) {
  const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || 'nanakokyobashi-rgb/frontaliere-articles';
  const open = JSON.parse(gh(['issue', 'list', '--repo', repo, '--state', 'open', '--search', `in:title "${ADAPTED_DRIFT_REGISTER_TITLE}"`, '--json', 'number,title,url', '--limit', '20']));
  const existing = open.find((issue) => issue.title === ADAPTED_DRIFT_REGISTER_TITLE);
  if (existing) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `${TOOL}-`)), 'body.md');
    fs.writeFileSync(file, body);
    gh(['issue', 'edit', String(existing.number), '--repo', repo, '--body-file', file]);
    return { number: existing.number, url: existing.url, action: 'updated' };
  }
  process.env.GH_REPO = repo;
  const { createGithubIssue } = await import('../lib/github-issue-creator.mjs');
  const created = await createGithubIssue({
    title: ADAPTED_DRIFT_REGISTER_TITLE,
    description: body,
    priority: 4,
    // `backlog` tiene la issue fuori dal ciclo automatico (classify-issue:
    // route none): le righe sono lavoro a mano per decisione del proprietario.
    labels: ['backlog'],
    workflow: TOOL,
    exactTitle: true,
  });
  if (!created || created.persisted === false) throw new Error('issue-registro non scritta dal creator');
  return { number: created.number, url: created.url, action: 'created' };
}

function argValue(argv, name) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function main(argv) {
  const siteDir = argValue(argv, 'site-dir') || process.env.SITE_GIT_DIR;
  if (!siteDir || gitText(siteDir, ['rev-parse', '--git-dir']) === null) {
    console.error(`${TOOL}: serve --site-dir <clone git del sito con la storia> (o SITE_GIT_DIR).`);
    return 1;
  }
  const cap = Number(argValue(argv, 'history-cap') || 200);
  const register = buildRegister({
    corpusDir: ROOT,
    corpusRef: argValue(argv, 'corpus-ref') || 'origin/main',
    siteDir,
    siteRef: argValue(argv, 'site-ref') || 'origin/main',
    cap: Number.isInteger(cap) && cap > 0 ? cap : 200,
  });
  const body = registerMarkdown(register);
  if (argv.includes('--json')) console.log(JSON.stringify(register, null, 2));
  else console.log(body);

  if (argv.includes('--write-ratchet')) {
    const drift = register.rows.map((r) => r.path);
    const current = readRatchetFile(ROOT);
    const next = current
      ? pruneRatchetPaths(current, current.paths.filter((p) => !drift.includes(p)))
      : {
          _doc: [
            'Gemelli `adapted` in drift accettati come debito (issue #339). Il gate `adapted-drift-budget`',
            '(scripts/ci/adapted-drift-ratchet.mjs) fallisce se un path in drift non e\' qui. L\'elenco si',
            'accorcia soltanto: il job realign-adapted toglie i path che riattesta, e',
            '`adapted-drift-register.mjs --write-ratchet` pota quelli non piu\' in drift. Non aggiungere path a mano.',
          ],
          paths: drift,
        };
    fs.writeFileSync(path.join(ROOT, ADAPTED_DRIFT_RATCHET_PATH), serializeRatchet(next));
    console.error(`${TOOL}: ${ADAPTED_DRIFT_RATCHET_PATH} → ${next.paths.length} path.`);
  }

  if (argv.includes('--issue')) {
    const issue = await upsertRegisterIssue(body);
    console.error(`${TOOL}: issue-registro #${issue.number} ${issue.action} (${issue.url}).`);
  }
  return 0;
}

const isDirectRun = (() => {
  try {
    return path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`${TOOL} fallito: ${error && error.stack ? error.stack : error}`);
      process.exit(1);
    },
  );
}
