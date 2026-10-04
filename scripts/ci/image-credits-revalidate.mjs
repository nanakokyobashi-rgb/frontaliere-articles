#!/usr/bin/env node
/**
 * image-credits-revalidate.mjs — the monthly revalidation of the Wikimedia
 * Commons cover credits (P14, `.github/workflows/image-credits-revalidate.yml`).
 *
 * A credit record (`content/image-credits/blog/<cover>.json`) says what Commons
 * said about the photo when it was read: author, licence, restrictions. Commons
 * keeps changing: a file is deleted (often for a copyright problem),
 * relicensed, re-attributed, tagged with a personality or trademark
 * restriction, re-uploaded. Nothing in the corpus notices: a record is read
 * again only when someone reruns the backfill.
 *
 * The workflow re-reads the metadata (`scripts/backfill-image-credits.mjs
 * --fetch`, about 11 read-only requests), runs `--check` against it (which names
 * each changed field and ignores `fetchedAt`) and hands the `--check` log to
 * this script:
 *
 *   - a clean log: says so, and does nothing else;
 *   - problems: opens ONE issue, or comments on it if it is already open
 *     (`github-issue-creator.mjs` dedups on the first 60 characters of a title
 *     that never changes), listing the problems by kind and the remedy. It
 *     carries `needs-human`: the remedy is curation from the Commons file page
 *     and, for restrictions and deleted files, the owner's decision — not a
 *     fixer's;
 *   - a log that did not complete (no `--check: N problem(s)` line, or a count
 *     that disagrees with the lines): exit 1 and no issue. The run goes red and
 *     `workflow-failure-issues.yml` reports a failure, which is what it is.
 *
 * Read-only on the repository: nothing here writes a tracked file, and the
 * snapshot `--fetch` writes stays in the runner.
 *
 * Usage:
 *   node scripts/ci/image-credits-revalidate.mjs --check-log <file> [--dry-run]
 *   node scripts/ci/image-credits-revalidate.mjs --cover-patterns
 *     (prints the sparse-checkout patterns of the cover files --check reads)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_FILE, liveCommonsCovers } from '../backfill-image-credits.mjs';
import { IMAGE_CREDIT_RECORDS_DIR } from '../lib/image-credit-records.mjs';
import { createGithubIssue } from '../lib/github-issue-creator.mjs';
import { coverKey } from '../../engine/shared/imageCredits.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * STABLE: no date, no count. It is the dedup key of `createGithubIssue` (first
 * 60 characters), so every month lands on the same issue; no `/` or `*`, which
 * the phrase search behind the dedup does not survive.
 */
export const ISSUE_TITLE = 'Crediti copertine Commons: cambiamenti da rivedere';
export const ISSUE_LABELS = Object.freeze(['bug', 'automation', 'needs-human']);
const WORKFLOW = 'image-credits-revalidate';

/** How `scripts/backfill-image-credits.mjs` prints each line of `--check`. */
const LINE_PREFIX = '[backfill] ';
const SUMMARY_RX = /^--check: (\d+) problem\(s\)$/;
const NEEDS_HUMAN_RX = /^needs a human: «(.*?)» \(([^()]*)\): (.*)$/;
const DIFFERS_RX = new RegExp(
  `^${IMAGE_CREDIT_RECORDS_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/]+)\\.json: differs from a rebuild — run --build \\((.*)\\)$`,
);

/** At most this many files per kind in the body; the full list is in the run log. */
const MAX_PER_KIND = 100;
const MAX_RAW_LINES = 200;

/** The kinds of problem, in the order the body lists them. */
export const PROBLEM_KINDS = Object.freeze([
  ['deleted', 'File cancellati su Commons (urgente)'],
  ['licence', 'Licenza cambiata o non più riconoscibile'],
  ['author', 'Autore o attribuzione cambiati'],
  ['restriction', "Restrizioni d'uso nuove o cambiate"],
  ['revision', 'Nuova versione del file su Commons'],
  ['renamed', 'File rinominato su Commons'],
  ['other', 'Altri problemi segnalati da --check'],
]);

/**
 * The problem lines of a `--check` log. Throws when the log did not complete:
 * a crash has no summary line, and a count that disagrees with the lines means
 * the format moved — either way nothing here may pass for «no problem».
 *
 * @param {string} text stdout and stderr of `--check`, together
 * @returns {string[]}
 */
export function parseCheckLog(text) {
  const problems = [];
  let reported = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (!raw.startsWith(LINE_PREFIX)) continue;
    const line = raw.slice(LINE_PREFIX.length);
    const summary = line.match(SUMMARY_RX);
    if (summary) reported = Number(summary[1]);
    else problems.push(line);
  }
  if (reported === null) throw new Error('--check did not complete: the log has no "--check: N problem(s)" line');
  if (reported !== problems.length) throw new Error(`--check reported ${reported} problem(s), but the log holds ${problems.length} problem line(s)`);
  return problems;
}

/** The kind of one reason of a «needs a human» line (`assessCommonsFile` and `planBackfill` vocabulary). */
function reasonKind(reason) {
  if (reason === 'deleted-on-commons') return 'deleted';
  if (reason.startsWith('licence:') || reason === 'non-free') return 'licence';
  if (reason.startsWith('restriction:')) return 'restriction';
  if (reason.startsWith('author:') || reason === 'email-in-artist') return 'author';
  if (reason.startsWith('cannot be credited:')) return null; // the remedy of a replace verdict, not a reason
  return 'other';
}

/** The kind of a record field that differs from its rebuild (`changedRecordFields` paths). */
function fieldKind(field) {
  if (field.startsWith('licence.')) return 'licence';
  if (field.startsWith('author.') || field === 'attribution') return 'author';
  if (field === 'restrictions') return 'restriction';
  if (['commons.revision', 'commons.width', 'commons.height', 'modified'].includes(field)) return 'revision';
  if (['commons.title', 'commons.pageUrl', 'commons.pageId', 'commons.aliases'].includes(field)) return 'renamed';
  return 'other';
}

/**
 * The problems by kind and Commons file. A file can be in more than one kind
 * (a new licence AND a new author); a line nothing here recognises is kept,
 * verbatim, under `other` — never dropped.
 *
 * @param {string[]} problems lines from `parseCheckLog`
 * @param {{ titleOfCover?: (key: string) => string | null }} [options] the Commons title of a record on disk
 * @returns {Map<string, Map<string, { title: string | null, covers: Set<string>, details: Set<string> }>>} kind → key → finding
 */
export function classifyProblems(problems, { titleOfCover = () => null } = {}) {
  /** @type {Map<string, Map<string, { title: string | null, covers: Set<string>, details: Set<string> }>>} */
  const byKind = new Map(PROBLEM_KINDS.map(([kind]) => [kind, new Map()]));
  const add = (kind, key, title, covers, details) => {
    const kindMap = byKind.get(kind);
    if (!kindMap.has(key)) kindMap.set(key, { title, covers: new Set(), details: new Set() });
    const finding = kindMap.get(key);
    for (const cover of covers) finding.covers.add(cover);
    for (const detail of details) finding.details.add(detail);
  };
  for (const line of problems) {
    const human = line.match(NEEDS_HUMAN_RX);
    if (human) {
      const [, title, coverList, reasonList] = human;
      const covers = coverList.split(',').map((c) => c.trim()).filter(Boolean);
      /** @type {Map<string, string[]>} */
      const reasonsByKind = new Map();
      for (const reason of reasonList.split('; ')) {
        const kind = reasonKind(reason);
        if (!kind) continue;
        if (!reasonsByKind.has(kind)) reasonsByKind.set(kind, []);
        reasonsByKind.get(kind).push(reason);
      }
      if (reasonsByKind.size === 0) reasonsByKind.set('other', [reasonList]);
      for (const [kind, reasons] of reasonsByKind) add(kind, `title:${title}`, title, covers, reasons);
      continue;
    }
    const differs = line.match(DIFFERS_RX);
    if (differs) {
      const [, cover, fieldList] = differs;
      const title = titleOfCover(cover);
      /** @type {Map<string, string[]>} */
      const fieldsByKind = new Map();
      for (const field of fieldList.split(',').map((f) => f.trim()).filter(Boolean)) {
        const kind = fieldKind(field);
        if (!fieldsByKind.has(kind)) fieldsByKind.set(kind, []);
        fieldsByKind.get(kind).push(field);
      }
      if (fieldsByKind.size === 0) fieldsByKind.set('other', [line]);
      for (const [kind, fields] of fieldsByKind) add(kind, title ? `title:${title}` : `cover:${cover}`, title, [cover], fields);
      continue;
    }
    add('other', `line:${line}`, null, [], [line]);
  }
  return byKind;
}

const code = (value) => `\`${String(value).replace(/`/g, "'")}\``;
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The issue body: what the revalidation read, the problems by kind, the
 * remedy, and the `--check` lines themselves.
 *
 * @param {{ problems: string[], byKind: ReturnType<typeof classifyProblems>, fetchedAt?: string | null, runUrl?: string | null }} input
 */
export function buildIssueBody({ problems, byKind, fetchedAt = null, runUrl = null }) {
  const titles = new Set();
  const covers = new Set();
  for (const findings of byKind.values()) {
    for (const finding of findings.values()) {
      if (finding.title) titles.add(finding.title);
      for (const cover of finding.covers) covers.add(cover);
    }
  }
  const lines = [
    `${fetchedAt ? `Il ${fetchedAt} la` : 'La'} rivalidazione mensile ha riletto su Wikimedia Commons i metadati delle copertine accreditate`
      + ' con `node scripts/backfill-image-credits.mjs --fetch`, poi `--check`.',
    `\`--check\` segnala **${count(problems.length, 'problema', 'problemi')}** (${titles.size} file Commons, ${count(covers.size, 'copertina', 'copertine')}):`
      + ' finché restano aperti, il credito pubblicato di questi file può non dire più quello che Commons dice oggi.',
  ];
  if (runUrl) lines.push('', `Run: ${runUrl}`);
  for (const [kind, heading] of PROBLEM_KINDS) {
    const findings = [...byKind.get(kind).values()];
    if (findings.length === 0) continue;
    lines.push('', `### ${heading} — ${findings.length}`, '');
    for (const finding of findings.slice(0, MAX_PER_KIND)) {
      const what = finding.title ? `«${finding.title}»` : null;
      const where = finding.covers.size > 0
        ? `${finding.covers.size === 1 ? 'copertina' : 'copertine'} ${[...finding.covers].sort().map(code).join(', ')}` : null;
      lines.push(`- ${[what, where, [...finding.details].map(code).join(', ')].filter(Boolean).join(' — ')}`);
    }
    if (findings.length > MAX_PER_KIND) lines.push(`- … e altri ${findings.length - MAX_PER_KIND}: l'elenco intero è nel log della run.`);
  }
  lines.push(
    '',
    '### Rimedio',
    '',
    '1. `node scripts/backfill-image-credits.mjs --fetch` aggiorna `data/commons-credit-snapshot.json` (sola lettura, circa 11 richieste a Commons). Senza, `--build` ricostruisce dallo snapshot vecchio e non vede niente.',
    '2. Per ogni file elencato, cura `data/image-credit-overrides.json` leggendo la sua pagina su Commons:',
    '   - file cancellato: `decision: "replace"` con una `replacement` per ogni copertina, subito: senza licenza la foto non si può mostrare;',
    '   - restrizione: decide il proprietario, `accept-restriction` oppure `replace`;',
    '   - licenza, autore o attribuzione: `licence`, `author`, `attribution` come li dice la pagina del file (mai l\'uploader, mai un indirizzo e-mail), sempre con `curation: { by, at, note }`;',
    '   - nuova versione o rinomina: controlla che la foto sia ancora quella della copertina, altrimenti `replace`.',
    '3. `node scripts/backfill-image-credits.mjs --build`, poi `--check` deve uscire pulito.',
    '4. Apri una PR con snapshot, overrides, record e letterali SEO cambiati.',
    '',
    `<details><summary>Righe di <code>--check</code> (${problems.length})</summary>`,
    '',
    '```text',
    ...problems.slice(0, MAX_RAW_LINES).map((line) => line.replace(/```/g, "'''")),
    ...(problems.length > MAX_RAW_LINES ? [`… e altre ${problems.length - MAX_RAW_LINES} righe nel log della run`] : []),
    '```',
    '',
    '</details>',
  );
  return lines.join('\n');
}

/** The Commons title a record on disk names, or null when it cannot be read. */
function recordTitleReader(root) {
  return (key) => {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(root, IMAGE_CREDIT_RECORDS_DIR, `${key}.json`), 'utf-8'));
      return typeof record?.commons?.title === 'string' ? record.commons.title : null;
    } catch {
      return null;
    }
  };
}

/**
 * The sparse-checkout patterns of the covers `--check` reads to tell a crop
 * from a resize: every live Commons cover, the same list `planBackfill` walks.
 * Measured on 2026-10-04: 684 webp files and 73 MB in the checkout, against
 * 6,094 files and 362 MB for the whole folder.
 */
export function coverSparsePatterns(root = ROOT) {
  const keys = new Set();
  for (const { id } of liveCommonsCovers(root)) {
    const key = coverKey(`/images/blog/${id}.webp`);
    if (key) keys.add(key);
  }
  return [...keys].sort().map((key) => `/public/images/blog/${key}.webp`);
}

/**
 * The decision, with GitHub injected. Returns the exit code.
 *
 * @param {{ root?: string, checkLog: string, dryRun?: boolean, runUrl?: string | null,
 *   createIssue?: typeof createGithubIssue, log?: (line: string) => void }} input
 */
export async function runRevalidation({
  root = ROOT, checkLog, dryRun = false, runUrl = null,
  createIssue = createGithubIssue, log = console.log,
}) {
  let problems;
  try {
    problems = parseCheckLog(checkLog);
  } catch (error) {
    log(`::error::[image-credits-revalidate] ${error instanceof Error ? error.message : String(error)} — nessuna issue.`);
    return 1;
  }
  if (problems.length === 0) {
    log('[image-credits-revalidate] --check pulito: ogni credito corrisponde ancora a quello che Commons dice oggi. Niente da fare.');
    return 0;
  }
  let fetchedAt = null;
  try {
    fetchedAt = JSON.parse(fs.readFileSync(path.join(root, SNAPSHOT_FILE), 'utf-8')).fetchedAt ?? null;
  } catch { /* the date is a courtesy in the body, not a condition */ }
  const byKind = classifyProblems(problems, { titleOfCover: recordTitleReader(root) });
  const body = buildIssueBody({ problems, byKind, fetchedAt, runUrl });
  const counts = PROBLEM_KINDS.map(([kind]) => `${kind} ${byKind.get(kind).size}`).join(', ');
  log(`[image-credits-revalidate] ${count(problems.length, 'problema', 'problemi')} (${counts}).`);
  if (dryRun) {
    log(`[image-credits-revalidate] dry-run: aprirei o commenterei «${ISSUE_TITLE}»:\n\n${body}`);
    return 0;
  }
  const result = await createIssue({
    title: ISSUE_TITLE,
    description: body,
    priority: 2,
    labels: [...ISSUE_LABELS],
    workflow: WORKFLOW,
  });
  if (!result || result.persisted === false) {
    log(`::error::[image-credits-revalidate] la issue non è stata registrata: la run fallisce, e il corpo resta qui.\n\n${body}`);
    return 1;
  }
  log(`[image-credits-revalidate] issue #${result.number ?? '?'} ${result.url ?? ''}`.trimEnd());
  return 0;
}

async function main(argv) {
  if (argv.includes('--cover-patterns')) {
    for (const pattern of coverSparsePatterns(ROOT)) console.log(pattern);
    return 0;
  }
  const at = argv.indexOf('--check-log');
  const file = at >= 0 ? argv[at + 1] : null;
  if (!file) {
    console.error('usage: node scripts/ci/image-credits-revalidate.mjs --check-log <file> [--dry-run] | --cover-patterns');
    return 2;
  }
  const env = process.env;
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  return runRevalidation({ checkLog: fs.readFileSync(file, 'utf-8'), dryRun: argv.includes('--dry-run'), runUrl });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((exitCode) => { process.exitCode = exitCode; }, (error) => {
    console.error(`[image-credits-revalidate] ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  });
}
