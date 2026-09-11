/**
 * auto-merge-orphan-push.test.mjs — un push sul branch di una PR già MERGED
 * non deve restare orfano in silenzio (issue #532).
 *
 * Il difetto vive nel blocco `on:` del workflow. GitHub accetta il push, il
 * commit resta fuori da main, e nessuno lo dice. Non è un errore, è un'ASSENZA
 * — la stessa classe di `loop-workflow-triggers.test.mjs`.
 *
 * Il rilevatore era il primo job del workflow dell'auto-merge su LGTM finché
 * quello è esistito; dal 2026-09-03 vive in `orphan-push-warn.yml`, perché il
 * merge è passato all'auto-merge nativo e `tests.yml` — l'unico altro posto
 * dove avrebbe potuto stare — ha il `push:` scopato a `main`, cioè il trigger
 * OPPOSTO a quello che serve qui.
 *
 * Il test legge lo YAML shipped, controlla le invarianti strutturali ed esegue
 * lo script con un `gh` simulato per osservare i verdetti che, se sparissero,
 * riaprirebbero il silenzio:
 *   (a) il blocco `on` prima di `jobs` contiene `push`;
 *   (b) esiste uno step/job che parla di MERGED o orphan push;
 *   (c) un push già contenuto e un secondo giro sulla stessa head non
 *       commentano la PR vecchia;
 *   (d) una PR chiusa senza merge e un push senza PR hanno verdetti distinti.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/orphan-push-warn.yml');
const src = fs.readFileSync(WORKFLOW, 'utf8');

/** Solo le righe eseguibili: i commenti CITANO il difetto, e un match sul
 *  testo grezzo li leggerebbe come ancora presenti. */
const active = (text) =>
  text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

const ATTIVE = active(src);

const runAt = src.indexOf('        run: |\n');
assert.notEqual(runAt, -1, 'orphan-push-warn.yml non contiene lo script del job');
const RUN = src.slice(runAt)
  .split('\n')
  .slice(1)
  .map((line) => line.startsWith('          ') ? line.slice(10) : line)
  .join('\n');

function runWorkflow(scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-push-warn-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const commentFile = path.join(dir, 'comment');
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
set -eu
args="$*"
if printf '%s' "$args" | grep -Fq -- '--state open'; then
  printf '%s' "$ORPHAN_TEST_OPEN"
  exit 0
fi
if printf '%s' "$args" | grep -Fq -- '--state all' && printf '%s' "$args" | grep -Fq -- '--jq'; then
  printf '%s' "$ORPHAN_TEST_TARGET"
  exit 0
fi
if printf '%s' "$args" | grep -Fq -- '--state all'; then
  printf '%s' "$ORPHAN_TEST_AFTER_ROUND"
  exit 0
fi
if printf '%s' "$args" | grep -Fq -- '/comments'; then
  printf '%s' "$ORPHAN_TEST_COMMENTS"
  exit 0
fi
if printf '%s' "$args" | grep -Fq -- '/compare/'; then
  if printf '%s' "$args" | grep -Fq -- "...$ORPHAN_TEST_DEFAULT_BRANCH"; then
    printf '%s' "$ORPHAN_TEST_MAIN_STATUS"
  elif printf '%s' "$args" | grep -Fq -- "...$ORPHAN_TEST_MERGE_OID"; then
    printf '%s' "$ORPHAN_TEST_MERGE_STATUS"
  else
    printf '%s' "$ORPHAN_TEST_HEAD_STATUS"
  fi
  exit 0
fi
if [ "\${1:-}" = pr ] && [ "\${2:-}" = comment ]; then
  printf '%s' "$*" > "$ORPHAN_TEST_COMMENT_FILE"
  exit 0
fi
exit 1
`, { mode: 0o755 });

  const env = {
    ...process.env,
    GH_TOKEN: 'test-token',
    REPO: 'owner/repo',
    DEFAULT_BRANCH: 'main',
    HEAD_REF: 'feature/reused',
    SHA: 'push-sha',
    RUN_STARTED_AT: '2026-09-11T06:00:00Z',
    ORPHAN_TEST_COMMENT_FILE: commentFile,
    ORPHAN_TEST_DEFAULT_BRANCH: 'main',
    ORPHAN_TEST_MERGE_OID: scenario.mergeOid || 'merge-oid',
    ORPHAN_TEST_OPEN: '',
    ORPHAN_TEST_TARGET: '{}',
    ORPHAN_TEST_AFTER_ROUND: '[]',
    ORPHAN_TEST_MAIN_STATUS: 'diverged',
    ORPHAN_TEST_MERGE_STATUS: 'diverged',
    ORPHAN_TEST_HEAD_STATUS: 'diverged',
    ORPHAN_TEST_COMMENTS: '[]',
    ...scenario,
    PATH: `${bin}:${process.env.PATH}`,
  };
  try {
    const result = spawnSync('bash', ['-c', RUN], { env, encoding: 'utf8' });
    return {
      ...result,
      comment: fs.existsSync(commentFile) ? fs.readFileSync(commentFile, 'utf8') : '',
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Testa del file: tutto ciò che precede `jobs:`. È lo stesso taglio della
 *  metrica della scheda; qui si asserisce sul testo attivo, non sui commenti. */
function onBlock(text) {
  const jobsAt = text.search(/\njobs:\s*\n/);
  assert.notEqual(jobsAt, -1, 'orphan-push-warn.yml non ha una sezione `jobs:`');
  const head = text.slice(0, jobsAt);
  const onAt = head.search(/\non:\s*\n/);
  assert.notEqual(onAt, -1, 'auto-merge-on-lgtm.yml non ha un blocco `on:`');
  return head.slice(onAt + 1);
}

/** Blocco di un job: da `\n  <nome>:` al job successivo allo stesso livello. */
function jobBlock(text, name) {
  const start = text.search(new RegExp(`\\n  ${name}:\\s*\\n`));
  if (start === -1) return null;
  const rest = text.slice(start + 1);
  const next = rest.search(/\n {2}[a-z][\w-]*:\s*\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

test('(a) il blocco on prima di jobs contiene push (e ignora main)', () => {
  const on = onBlock(ATTIVE);
  assert.match(
    on,
    /^on:\n(?:.*\n)*[ \t]+push:/m,
    'Senza trigger `push` un git push sul branch di una PR già MERGED non fa ' +
      'partire nessun job: il commit resta orfano e il silenzio di #532 torna identico.',
  );
  assert.match(
    on,
    /push:\n[ \t]+branches-ignore:\s*\[main\]/,
    'Il trigger `push` deve ignorare `main`: spararlo lì costerebbe una run ' +
      'per ogni articolo generato (~90/giorno) senza nessuna PR da avvisare.',
  );
});

test('(b) esiste uno step/job che parla di MERGED o orphan push', () => {
  const jobsAt = ATTIVE.search(/\njobs:\s*\n/);
  assert.notEqual(jobsAt, -1, 'auto-merge-on-lgtm.yml non ha una sezione `jobs:`');
  const jobs = ATTIVE.slice(jobsAt);
  const parlaOrphan = /orphan push|orfano/i.test(jobs);
  const parlaMerged = /MERGED/.test(jobs);
  assert.ok(
    parlaOrphan || parlaMerged,
    'Nessuno step/job parla di MERGED o orphan push: il trigger `push` ' +
      'partirebbe e non segnalerebbe nulla, che è lo stesso silenzio con un run in più.',
  );
  assert.match(
    jobs,
    /gh pr comment/,
    'Lo step di avviso non commenta sulla PR: un ::warning nel log della run ' +
      'non arriva a chi ha pushato, e il commit resta orfano senza traccia sulla PR.',
  );
});

test('(d) il job warn-orphan-push ignora il push di cancellazione branch del proprio squash-merge', () => {
  const job = jobBlock(ATTIVE, 'warn-orphan-push');
  assert.ok(job, 'job `warn-orphan-push` non trovato');
  assert.match(
    job,
    /github\.event\.deleted\s*!=\s*true/,
    'Il job non esclude `github.event.deleted == true`: ogni squash-merge fatto ' +
      'da questo stesso workflow (`gh pr merge --delete-branch`) genera un push di ' +
      'cancellazione branch che il job leggerebbe come push orfano, postando un ' +
      'falso avviso su OGNI PR auto-mergiata.',
  );
});

test('(e) seleziona anche una PR chiusa senza merge e controlla le containment proof', () => {
  const job = jobBlock(ATTIVE, 'warn-orphan-push');
  assert.ok(job, 'job `warn-orphan-push` non trovato');
  assert.match(job, /--state all/);
  assert.match(job, /mergedAt/);
  assert.match(job, /closedAt/);
  assert.match(job, /headRefOid/);
  assert.match(job, /mergeCommit/);
  assert.match(job, /select\(\.state != "OPEN"\)/);
  assert.match(job, /DEFAULT_BRANCH/);
  assert.match(job, /repos\/\$\{REPO\}\/compare\/\$\{SHA\}\.\.\.\$\{DEFAULT_BRANCH\}/);
  assert.match(job, /MERGE_COMMIT_OID/);
  assert.match(job, /repos\/\$\{REPO\}\/compare\/\$\{SHA\}\.\.\.\$\{MERGE_COMMIT_OID\}/);
  assert.match(job, /AFTER_ROUND/);
  assert.match(job, /NEW_ROUND/);
  assert.match(job, /createdAt/);
  assert.match(job, /for attempt in 1 2 3/);
  assert.match(
    job,
    /repos\/\$\{REPO\}\/compare\/\$\{SHA\}\.\.\.\$\{HEAD_OID\}/,
    'il confronto deve usare la head della PR: il merge commit di uno squash non contiene '
      + 'l\'OID del commit originale come antenato',
  );
  assert.match(job, /CONTAINMENT.*\n[\s\S]*\[ \"\$CONTAINMENT\" = "ahead" \]/);
  assert.match(job, /TARGET='\{\}'/);
  assert.doesNotMatch(job, /\$\{TARGET:-\{\}\}/);
  assert.match(job, /RUN_STARTED_AT/);
  assert.match(job, /github\.run_started_at/);
  assert.doesNotMatch(job, /github\.event\.head_commit\.timestamp/);
  assert.match(job, /REALLY ORPHAN/);
  assert.match(job, /CLOSED WITHOUT MERGE/);
  assert.match(job, /classificazione sospesa/);
});

test('(f) il warning orfano e\' deduplicato con un marker sulla PR', () => {
  const job = jobBlock(ATTIVE, 'warn-orphan-push');
  assert.ok(job, 'job `warn-orphan-push` non trovato');
  assert.match(job, /MARKER='<!-- orphan-push-warn -->'/);
  assert.match(job, /gh api --paginate "repos\/\$\{REPO\}\/issues\/\$\{PR_NUMBER\}\/comments"/);
  assert.match(job, /grep -Fq "\$MARKER"/);
  assert.match(job, /\$\{MARKER\}/);
  assert.ok(
    job.indexOf('echo "::warning::Push orfano:') < job.indexOf("MARKER='"),
    'l annotation per-SHA deve precedere il gate di dedup per-PR',
  );
});

test('(g) il verdetto osservabile distingue merged contenuto, closed-unmerged, secondo giro e really orphan', () => {
  const merged = runWorkflow({
    ORPHAN_TEST_TARGET: JSON.stringify({
      number: 41,
      createdAt: '2026-09-11T04:00:00Z',
      closedAt: '2026-09-11T06:05:00Z',
      mergedAt: '2026-09-11T06:05:00Z',
      headRefOid: 'head-oid',
      mergeCommit: { oid: 'merge-oid' },
    }),
    ORPHAN_TEST_MAIN_STATUS: 'diverged',
    ORPHAN_TEST_MERGE_STATUS: 'ahead',
  });
  assert.equal(merged.status, 0);
  assert.match(merged.stdout, /merge commit merge-oid/);
  assert.equal(merged.comment, '', 'un push gia\' antenato del merge commit non deve commentare');

  const closed = runWorkflow({
    ORPHAN_TEST_TARGET: JSON.stringify({
      number: 42,
      createdAt: '2026-09-11T04:00:00Z',
      closedAt: '2026-09-11T06:05:00Z',
      headRefOid: 'head-oid',
      mergeCommit: { oid: null },
    }),
    ORPHAN_TEST_COMMENTS: '[]',
  });
  assert.equal(closed.status, 0);
  assert.match(closed.stdout, /CLOSED WITHOUT MERGE/);
  assert.match(closed.comment, /orphan-push-warn/);

  const secondRound = runWorkflow({
    ORPHAN_TEST_TARGET: JSON.stringify({
      number: 43,
      createdAt: '2026-09-11T04:00:00Z',
      closedAt: '2026-09-11T06:05:00Z',
      mergedAt: '2026-09-11T06:05:00Z',
      headRefOid: 'head-oid',
      mergeCommit: { oid: 'merge-oid' },
    }),
    ORPHAN_TEST_AFTER_ROUND: '[{"number":44,"createdAt":"2026-09-11T06:06:00Z"}]',
  });
  assert.equal(secondRound.status, 0);
  assert.match(secondRound.stdout, /Secondo giro: PR #44/);
  assert.equal(secondRound.comment, '', 'il secondo giro sulla stessa head non deve commentare la PR precedente');

  const preMergeSquash = runWorkflow({
    ORPHAN_TEST_TARGET: JSON.stringify({
      number: 45,
      createdAt: '2026-09-11T04:00:00Z',
      closedAt: '2026-09-11T06:05:00Z',
      mergedAt: '2026-09-11T06:05:00Z',
      headRefOid: 'head-oid',
      mergeCommit: { oid: 'merge-oid' },
    }),
    RUN_STARTED_AT: '2026-09-11T06:04:00Z',
    ORPHAN_TEST_MERGE_STATUS: 'diverged',
    ORPHAN_TEST_HEAD_STATUS: 'ahead',
  });
  assert.equal(preMergeSquash.status, 0);
  assert.match(preMergeSquash.stdout, /head storica head-oid/);
  assert.equal(preMergeSquash.comment, '', 'un push pre-merge contenuto nella head storica non deve commentare');

  // Il commit e' stato creato prima del merge, ma il push/run e' arrivato
  // dopo: il timestamp del commit non deve piu' sopprimere l'unico warning.
  const dedup = runWorkflow({
    ORPHAN_TEST_TARGET: JSON.stringify({
      number: 46,
      createdAt: '2026-09-11T04:00:00Z',
      closedAt: '2026-09-11T06:05:00Z',
      mergedAt: '2026-09-11T06:05:00Z',
      headRefOid: 'head-oid',
      mergeCommit: { oid: 'merge-oid' },
    }),
    ORPHAN_TEST_COMMIT_TIMESTAMP: '2026-09-11T06:00:00Z',
    RUN_STARTED_AT: '2026-09-11T06:06:00Z',
    ORPHAN_TEST_HEAD_STATUS: 'ahead',
    ORPHAN_TEST_COMMENTS: '<!-- orphan-push-warn -->',
  });
  assert.equal(dedup.status, 0);
  assert.match(dedup.stdout, /Push orfano: commit push-sha/);
  assert.match(dedup.stdout, /nessun commento duplicato/);
  assert.equal(dedup.comment, '', 'il secondo passaggio dello stesso push non deve duplicare il commento');

  const reallyOrphan = runWorkflow({
    ORPHAN_TEST_TARGET: '{}',
  });
  assert.equal(reallyOrphan.status, 0);
  assert.match(reallyOrphan.stdout, /REALLY ORPHAN/);
  assert.equal(reallyOrphan.comment, '', 'un push senza PR non ha una destinazione per il commento');
});

// Il test (c) — «il job `auto-merge` e' gateato su `event_name != 'push'`» —
// e' stato rimosso il 2026-09-03 insieme al suo oggetto: il merge e' passato
// all'auto-merge nativo di GitHub e non esiste piu' un job di merge che
// condivida il trigger `push` con questo. La proprieta' che il test difendeva
// (il push non deve far partire una valutazione di merge) ora vale
// by construction: questo workflow ha SOLO il trigger `push` e SOLO questo job.
