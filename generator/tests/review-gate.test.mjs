/**
 * review-gate.test.mjs — il gate che decide se il check richiesto e' verde.
 *
 * ## Perche' questo file merita un test suo
 *
 * Dal 2026-09-03 il merge non lo decide piu' uno script nostro: lo decide
 * l'auto-merge NATIVO di GitHub, che aspetta il check-run `tests (node --test)`
 * e non sa niente di `## LGTM`. L'unico punto in cui il verdetto della Claude
 * review entra in quella decisione e' l'exit code di `review-gate.mjs`.
 *
 * Un difetto qui non e' rumoroso: un `exit 0` di troppo mergia una PR con un
 * `🔴 Important` aperto e nessuno se ne accorge, perche' il check e' verde e la
 * review resta un commento in fondo alla pagina. Le asserzioni qui sotto
 * coprono le cinque forme in cui quel difetto puo' presentarsi.
 *
 * Come `stale-pr-rescuer-classify.test.mjs`, il test ESEGUE lo script vero con
 * `gh` stubbato: un test a regex sul sorgente («c'e' un `includes('## LGTM')`»)
 * passerebbe anche su un ramo irraggiungibile.
 */
import { formatCodexFallbackEvidence } from '../../scripts/ci/claude-codex-fallback.mjs';
import { codeContributionFingerprint } from '../../scripts/ci/auto-merge-eval.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/ci/review-gate.mjs');

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const OLD_BODY_REVISION = `body:${'e'.repeat(64)}`;

const GOOD_BODY = '## Implementato\n- una cosa vera\n\n## Non implementato (ancora)\n- Nessuno';
const bodyRevision = body => `body:${createHash('sha256').update(`${body}\n`).digest('hex')}`;
const BODY_REVISION = bodyRevision(GOOD_BODY);

/**
 * Esegue il gate vero con `gh` sostituito da uno stub che legge le sue
 * risposte da file. Ritorna `{ status, stdout, comments }`.
 *
 * Lo stub scarta i flag PRIMA di leggere il path, per la stessa ragione
 * documentata nello stub del rescuer: `gh api --paginate <path>` con un match
 * cieco su `$1` leggerebbe `--paginate` come path e cadrebbe nel default,
 * cioe' un test verde su un gate che non vede piu' niente.
 */
function runGate({ reviews = [], files = [], meta = null, compare = null,
  checkRuns = [], checkRunPages = null, codexEvidence = null,
  reviewRevision: requestedReviewRevision = null, currentBody: requestedCurrentBody = null,
  metaSequence = null }) {
  const currentBody = requestedCurrentBody ?? meta?.body ?? GOOD_BODY;
  const reviewRevision = requestedReviewRevision ?? bodyRevision(currentBody);
  const dir = mkdtempSync(path.join(tmpdir(), 'review-gate-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const calls = path.join(dir, 'calls');
    const gateOutput = path.join(dir, 'gate-output');
    const fixReviews = path.join(dir, 'reviews.json');
    const fixFiles = path.join(dir, 'files.txt');
    const fixMeta = path.join(dir, 'meta.json');
    writeFileSync(calls, '');
    writeFileSync(gateOutput, '');
    writeFileSync(fixReviews, JSON.stringify(reviews));
    writeFileSync(fixFiles, files.join('\n') + (files.length ? '\n' : ''));
    writeFileSync(fixMeta, JSON.stringify({
      head: { sha: HEAD },
      ...(meta ?? {}),
      body: meta?.body ?? currentBody,
    }));
    const fixMetaSequence = path.join(dir, 'meta-sequence.json');
    const metaSequenceIndex = path.join(dir, 'meta-sequence-index');
    if (metaSequence) {
      writeFileSync(fixMetaSequence, JSON.stringify(metaSequence));
      writeFileSync(metaSequenceIndex, '0');
    }

    // `compare` mappa sha → payload della compare API. Un `null` significa
    // «endpoint non stubbato»: il gate deve cadere sul ramo conservativo.
    const fixCompare = path.join(dir, 'compare.json');
    writeFileSync(fixCompare, JSON.stringify(compare ?? {}));
    const fixCheckRuns = path.join(dir, 'check-runs.json');
    writeFileSync(fixCheckRuns, JSON.stringify(checkRunPages ?? { check_runs: checkRuns }));

    writeFileSync(
      path.join(bin, 'gh'),
      `#!/usr/bin/env bash
sub="$1"; shift
case "$sub" in
  api)
    p=""
    jq=""
    paginate=0
    slurp=0
    while [ $# -gt 0 ]; do
      case "$1" in
        --paginate) paginate=1; shift ;;
        --slurp) slurp=1; shift ;;
        --jq) jq="$2"; shift 2 ;;
        -H|-f|-F|-X) shift 2 ;;
        *) if [ -z "$p" ]; then p="$1"; fi; shift ;;
      esac
    done
    case "$p" in
      */reviews*)  cat ${JSON.stringify(fixReviews)} ;;
      */pulls/*/files*) cat ${JSON.stringify(fixFiles)} ;;
      */compare/main...*)
        node -e 'const c=require(process.argv[1]); process.stdout.write((c.mergeBase||"")+"\\n")' ${JSON.stringify(fixCompare)} ;;
      */compare/*)
        node -e 'const c=require(process.argv[1]); const k=process.argv[2].split("/compare/")[1]; process.stdout.write(JSON.stringify((c.byRange||{})[k]||{files:[]}))' ${JSON.stringify(fixCompare)} "$p" ;;
      */commits/*/check-runs*)
        if [[ "$p" == *'filter=all' && "$paginate" = 1 && "$slurp" = 1 ]]; then
          cat ${JSON.stringify(fixCheckRuns)}
        else
          echo '{"check_runs":[]}'
        fi ;;
      */issues/*/comments*) echo '[]' ;;
      */issues?*) echo '[]' ;;
      */git/trees/*)
        node -e 'const fs=require("fs"); const files=fs.readFileSync(process.argv[1],"utf8").split(/\\r?\\n/).filter(Boolean); files.push("generator/scripts/outside.mjs"); process.stdout.write(JSON.stringify({truncated:false,tree:files.map(path=>({type:"blob",path}))}))' ${JSON.stringify(fixFiles)} ;;
      */pulls/*)
        if [ -n ${metaSequence ? JSON.stringify(fixMetaSequence) : "''"} ] && [ -z "$jq" ]; then
          index=$(cat ${JSON.stringify(metaSequenceIndex)} 2>/dev/null || echo 0)
          node -e 'const fs=require("fs"); const payload=require(process.argv[1]); const i=Number(process.argv[2]); const item=payload[Math.min(i, payload.length - 1)] || {}; process.stdout.write(JSON.stringify(item)); fs.writeFileSync(process.argv[3], String(i + 1));' ${JSON.stringify(fixMetaSequence)} "$index" ${JSON.stringify(metaSequenceIndex)}
        elif [ "$jq" = ".base.sha" ]; then
          node -e 'const m=require(process.argv[1]); process.stdout.write((m.base?.sha||"")+"\\n")' ${JSON.stringify(fixMeta)}
        elif [ "$jq" = ".head.sha" ]; then
          node -e 'const m=require(process.argv[1]); process.stdout.write((m.head?.sha||"")+"\\n")' ${JSON.stringify(fixMeta)}
        elif [ "$jq" = '.body // ""' ] || [[ "$jq" == "if type != "* ]]; then
          node -e 'const m=require(process.argv[1]); process.stdout.write(String(m.body||"")+"\\n")' ${JSON.stringify(fixMeta)}
        else
          cat ${JSON.stringify(fixMeta)}
        fi ;;
      *) echo '{}' ;;
    esac
    ;;
  pr)
    action="$1"; shift
    if [ "$action" = "view" ]; then
      node -e 'const fs=require("fs"); const files=fs.readFileSync(process.argv[1],"utf8").split(/\\r?\\n/).filter(Boolean); process.stdout.write(JSON.stringify({changedFiles:files.length,files}))' ${JSON.stringify(fixFiles)}
    elif [ "$action" = "comment" ]; then
      printf 'COMMENT %s\\n' "$*" >> ${JSON.stringify(calls)}
    fi
    ;;
  issue)
    action="$1"; shift
    if [ "$action" = "list" ]; then
      echo '[]'
    elif [ "$action" = "create" ]; then
      echo 'https://github.com/nanakokyobashi-rgb/frontaliere-articles/issues/123'
    fi
    ;;
  *) exit 0 ;;
esac
exit 0
`,
    );
    chmodSync(path.join(bin, 'gh'), 0o755);

    const evidenceFile = path.join(dir, 'codex-evidence.txt');
    if (codexEvidence !== null) writeFileSync(evidenceFile, codexEvidence);
    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'nanakokyobashi-rgb/frontaliere-articles',
        PR_NUMBER: '901',
        HEAD_SHA: HEAD,
        GH_TOKEN: 'stub',
        REVIEW_REVISION: reviewRevision,
        GITHUB_OUTPUT: gateOutput,
        CODEX_FALLBACK_EVIDENCE_FILE: codexEvidence === null ? '' : evidenceFile,
      },
    });
    return { status: r.status, stdout: `${r.stdout}${r.stderr}`, gateOutput: readFileSync(gateOutput, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const botReview = (commit, body, { reviewRevision = BODY_REVISION, ...overrides } = {}) => ({
  user: { type: 'Bot', login: 'claude[bot]' },
  state: 'COMMENTED',
  commit_id: commit,
  body: `${body}${reviewRevision ? `\n<!-- REVIEW_INPUT_REVISION: ${reviewRevision} -->` : ''}`,
  ...overrides,
});

test('LGTM sulla head senza 🔴 → il check e\' verde', () => {
  const r = runGate({ reviews: [botReview(HEAD, 'tutto bene\n\n## LGTM')] });
  assert.equal(r.status, 0, r.stdout);
});

test('un edit del body dopo la selezione del verdetto resta bloccante', () => {
  const changedBody = `${GOOD_BODY}\n- modifica concorrente`;
  const r = runGate({
    reviews: [botReview(HEAD, 'tutto bene\n\n## LGTM')],
    reviewRevision: BODY_REVISION,
    metaSequence: [
      { head: { sha: HEAD }, body: GOOD_BODY },
      { head: { sha: HEAD }, body: changedBody },
    ],
  });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /HEAD o body PR sono cambiati durante la valutazione/i, r.stdout);
});

test('un push dopo la selezione del verdetto resta bloccante', () => {
  const r = runGate({
    reviews: [botReview(HEAD, 'tutto bene\n\n## LGTM')],
    reviewRevision: BODY_REVISION,
    metaSequence: [
      { head: { sha: HEAD }, body: GOOD_BODY },
      { head: { sha: OLD }, body: GOOD_BODY },
    ],
  });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /HEAD o body PR sono cambiati durante la valutazione/i, r.stdout);
});

test('un LGTM della revisione body precedente viene portato avanti sulla stessa HEAD', () => {
  const stale = runGate({
    reviews: [botReview(HEAD, 'tutto bene\n\n## LGTM', { reviewRevision: OLD_BODY_REVISION })],
    files: ['generator/scripts/create-article.mjs'],
  });
  assert.equal(stale.status, 0, stale.stdout);
  assert.match(stale.stdout, /review approvante sulla head/i, stale.stdout);

  const fresh = runGate({
    reviews: [botReview(HEAD, 'tutto bene\n\n## LGTM', { reviewRevision: BODY_REVISION })],
    files: ['generator/scripts/create-article.mjs'],
  });
  assert.equal(fresh.status, 0, fresh.stdout);
});

test('un body cambiato sulla stessa HEAD porta avanti una review che conserva il codice', () => {
  const changedBody = `${GOOD_BODY}\n- altra cosa`;
  const r = runGate({
    reviews: [botReview(HEAD, 'tutto bene\n\n## LGTM', { reviewRevision: OLD_BODY_REVISION })],
    currentBody: changedBody,
    reviewRevision: bodyRevision(changedBody),
  });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /review approvante sulla head/i, r.stdout);
});

test('una review sulla HEAD senza marker non diventa carry-forward', () => {
  const r = runGate({
    reviews: [botReview(HEAD, 'tutto bene\n\n## LGTM', { reviewRevision: '' })],
  });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /manca.*marker|nessuna review/i, r.stdout);
});

test('marker di body conflittuali sulla HEAD non diventano carry-forward', () => {
  const r = runGate({
    reviews: [botReview(
      HEAD,
      `tutto bene\n\n## LGTM\n<!-- REVIEW_INPUT_REVISION: ${OLD_BODY_REVISION} -->`,
    )],
  });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /manca.*marker|nessuna review/i, r.stdout);
});

test('il review-gate sceglie l ultimo verdetto terminale per timestamp e id', () => {
  const clean = botReview(HEAD, 'tutto bene\n\n## LGTM', {
    submitted_at: '2026-09-18T09:00:00Z',
    id: 10,
  });
  const finding = botReview(HEAD, '🔴 Important: controllo mancante\n\n## LGTM', {
    submitted_at: '2026-09-18T09:01:00Z',
    id: 11,
  });
  assert.equal(runGate({ reviews: [clean, finding] }).status, 1);
  assert.equal(runGate({ reviews: [finding, clean] }).status, 1);
  assert.equal(runGate({
    reviews: [
      finding,
      { ...clean, submitted_at: '2026-09-18T09:02:00Z', id: 12 },
    ],
  }).status, 0);
});

test('PENDING, DISMISSED e CHANGES_REQUESTED non approvano un LGTM carry-forward', () => {
  for (const state of ['PENDING', 'DISMISSED', 'CHANGES_REQUESTED']) {
    const r = runGate({
      reviews: [botReview(HEAD, 'tutto bene\n\n## LGTM', { state })],
    });
    assert.equal(r.status, 1, `${state}: ${r.stdout}`);
  }
});

test('un verdetto negativo del body precedente sulla stessa HEAD resta bloccante', () => {
  const changedBody = `${GOOD_BODY}\n- altra cosa`;
  const r = runGate({
    reviews: [botReview(HEAD, '🔴 Important: il controllo manca\n\n## LGTM', { reviewRevision: OLD_BODY_REVISION })],
    currentBody: changedBody,
    reviewRevision: bodyRevision(changedBody),
  });
  assert.equal(r.status, 1, r.stdout);
  assert.doesNotMatch(r.stdout, /drift-fallback: APPROVATO/i, r.stdout);
});

test('LGTM accanto a un 🔴 Important → il check e\' ROSSO', () => {
  // Il caso che l'auto-merge nativo non puo' vedere da solo: la review c'e',
  // dice anche `## LGTM`, ma porta un finding bloccante. Se questo esce 0 la PR
  // mergia con il 🔴 aperto.
  const r = runGate({
    reviews: [botReview(HEAD, '🔴 Important: manca il guard\n\n## LGTM')],
  });
  assert.equal(r.status, 1, `Un 🔴 Important accanto al LGTM deve bloccare.\n${r.stdout}`);
});

test('Important fuori dal diff → il gate e\' verde e il finding diventa follow-up', () => {
  const r = runGate({
    reviews: [botReview(HEAD, [
      '## Findings (1 Important, 0 Nit)',
      '`generator/scripts/outside.mjs:10`: 🔴 Important: il controllo condiviso manca.',
    ].join('\n'))],
    files: ['generator/scripts/in-scope.mjs'],
    meta: { base: { sha: 'c'.repeat(40) }, head: { sha: HEAD } },
  });
  assert.equal(r.status, 0, `Un finding solo fuori dal diff non deve bloccare.\n${r.stdout}`);
  assert.match(r.stdout, /follow-up|fuori dal diff/i, r.stdout);
});

test('Important che inizia con nessuno resta rosso se cita un file nel diff', () => {
  const r = runGate({
    reviews: [botReview(HEAD, [
      '## Findings (Important: 1, 0 Nit)',
      '`generator/scripts/in-scope.mjs:10`: 🔴 Important: nessuno dei feed viene rigenerato.',
      '',
      '## LGTM',
    ].join('\n'))],
    files: ['generator/scripts/in-scope.mjs'],
    meta: { base: { sha: 'c'.repeat(40) }, head: { sha: HEAD } },
  });
  assert.equal(r.status, 1, `Un finding in-diff che inizia con nessuno deve bloccare.\n${r.stdout}`);
});

test('nessuna review del bot e PR che non tocca il workflow di review → ROSSO', () => {
  const r = runGate({ reviews: [], files: ['generator/scripts/create-article.mjs'] });
  assert.equal(r.status, 1, `Senza review il merge non deve poter avvenire.\n${r.stdout}`);
  assert.match(r.stdout, /no fallback/, r.stdout);
});

test('review di un umano non vale come verdetto', () => {
  // Il gate deve leggere SOLO il bot reviewer: un `## LGTM` scritto a mano in
  // una review umana non e' il contratto che questo cancello sorveglia.
  const r = runGate({
    reviews: [{ user: { type: 'User', login: 'valerielinc-ops' }, commit_id: HEAD, body: '## LGTM' }],
  });
  assert.equal(r.status, 1, `Una review umana non deve soddisfare il gate.\n${r.stdout}`);
});

test('drift-fallback: PR sul workflow che ospita la review, autore fidato, body conforme → verde', () => {
  // `claude-code-action` risponde 401 quando il workflow del branch non e'
  // byte-identico a `main`, quindi una PR su `tests.yml` non PUO' avere una
  // review. Senza questa uscita resterebbe ferma per sempre.
  const r = runGate({
    reviews: [],
    files: ['.github/workflows/tests.yml'],
    meta: { assoc: 'OWNER', login: 'valerielinc-ops', type: 'User', body: GOOD_BODY },
  });
  assert.equal(r.status, 0, `Il drift-fallback non ha approvato.\n${r.stdout}`);
  assert.match(r.stdout, /drift-fallback: APPROVATO/, r.stdout);
  assert.match(r.gateOutput, /^fallback_approved=true$/m, r.gateOutput);
});

test('drift-fallback: body non conforme → resta ROSSO', () => {
  const r = runGate({
    reviews: [],
    files: ['.github/workflows/tests.yml'],
    meta: { assoc: 'OWNER', login: 'valerielinc-ops', type: 'User', body: 'niente sezioni' },
  });
  assert.equal(r.status, 1, `Il fallback e\' l'unica strada senza review: non puo' essere gratis.\n${r.stdout}`);
});

test('drift-fallback: NON si apre se una review negativa esiste gia\'', () => {
  // Il fallback vale solo quando il reviewer non ha POTUTO parlare DELLA HEAD.
  // Se ha parlato sulla head e ha detto 🔴, toccare `tests.yml` non cancella
  // quel verdetto.
  const r = runGate({
    reviews: [botReview(HEAD, '🔴 Important: il gate non copre il caso X')],
    files: ['.github/workflows/tests.yml'],
    meta: { assoc: 'OWNER', login: 'valerielinc-ops', type: 'User', body: GOOD_BODY },
  });
  assert.equal(r.status, 1, `Una review negativa gia' postata deve battere il fallback.\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, /drift-fallback/, r.stdout);
});

const COMPARE_CHANGED = {
  mergeBase: 'c'.repeat(40),
  byRange: {
    [`${'c'.repeat(40)}...${HEAD}`]: { files: [{ filename: 'engine/x.ts', status: 'modified', patch: '@@\n+due' }] },
    [`${'c'.repeat(40)}...${OLD}`]: { files: [{ filename: 'engine/x.ts', status: 'modified', patch: '@@\n+uno' }] },
  },
};

const COMPARE_SAME = {
  mergeBase: 'c'.repeat(40),
  byRange: {
    [`${'c'.repeat(40)}...${HEAD}`]: { files: [{ filename: 'engine/x.ts', status: 'modified', patch: '@@\n+uno' }] },
    [`${'c'.repeat(40)}...${OLD}`]: { files: [{ filename: 'engine/x.ts', status: 'modified', patch: '@@\n+uno' }] },
  },
};

const DRIFT_META = {
  assoc: 'OWNER',
  login: 'valerielinc-ops',
  type: 'User',
  body: GOOD_BODY,
};

test('drift-fallback: 🔴 stantio senza revisione corrente + tests.yml → ROSSO', () => {
  // Anche se il contributo è cambiato, un finding precedente non può essere
  // cancellato dal solo fallback: serve un verdetto per il body revisionato.
  const r = runGate({
    reviews: [botReview(OLD, '🔴 Important: collect jq ancora claude-only\n\n## LGTM', { reviewRevision: OLD_BODY_REVISION })],
    files: ['.github/workflows/tests.yml', 'scripts/ci/review-gate.mjs'],
    meta: DRIFT_META,
    compare: COMPARE_CHANGED,
  });
  assert.equal(r.status, 1, `Un 🔴 storico non può essere scavalcato senza un verdetto sulla revisione corrente.\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, /drift-fallback: APPROVATO/, r.stdout);
});

test('drift-fallback: 🔴 con revisione corrente ma SHA vecchia → ROSSO', () => {
  // Un marker body aggiornato non dimostra che il finding sia stato
  // rivalutato dopo una modifica del codice. Senza una review sulla HEAD,
  // il fallback non può far sparire un Important storico.
  const r = runGate({
    reviews: [botReview(OLD, '🔴 Important: il controllo non copre il caso X')],
    files: ['.github/workflows/tests.yml'],
    meta: DRIFT_META,
    compare: COMPARE_CHANGED,
  });
  assert.equal(r.status, 1, `Un 🔴 sulla SHA vecchia deve restare bloccante anche col marker body corrente.\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, /drift-fallback: APPROVATO/, r.stdout);
});

test('drift-fallback: 🔴 sulla SHA corrente ma revisione body vecchia → ROSSO', () => {
  // Il carry-forward sulla stessa HEAD conserva il finding anche quando la
  // revisione body è vecchia: il passaggio di body edit non lo può cancellare.
  const r = runGate({
    reviews: [botReview(HEAD, '🔴 Important: il controllo non copre il caso X', { reviewRevision: OLD_BODY_REVISION })],
    files: ['.github/workflows/tests.yml'],
    meta: DRIFT_META,
    compare: COMPARE_CHANGED,
  });
  assert.equal(r.status, 1, `Un 🔴 sulla SHA corrente ma su body vecchio deve restare bloccante.\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, /drift-fallback: APPROVATO/, r.stdout);
});

test('drift-fallback: review storica senza LGTM → ROSSO', () => {
  // Una review storica non approvante senza 🔴 Important non deve diventare un
  // insieme vuoto che il fallback può scavalcare.
  const r = runGate({
    reviews: [botReview(OLD, '❓ q: verificare il percorso di recovery')],
    files: ['.github/workflows/tests.yml'],
    meta: DRIFT_META,
    compare: COMPARE_CHANGED,
  });
  assert.equal(r.status, 1, `Una review storica senza LGTM deve restare bloccante.\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, /drift-fallback: APPROVATO/, r.stdout);
});

test('drift-fallback: 🔴 su SHA vecchio ma contributo INVARIATO + tests.yml → ROSSO', () => {
  // Il codice e' lo stesso: il 🔴 e' ancora il verdetto vivo. tests.yml nel
  // diff della PR (file list) non basta a cancellarlo.
  const r = runGate({
    reviews: [botReview(OLD, '🔴 Important: il gate non copre il caso X')],
    files: ['.github/workflows/tests.yml'],
    meta: DRIFT_META,
    compare: COMPARE_SAME,
  });
  assert.equal(r.status, 1, `Un 🔴 sul contributo invariato deve restare bloccante.\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, /drift-fallback: APPROVATO/, r.stdout);
});

test('drift-fallback: LGTM stantia (contributo cambiato) + tests.yml → ROSSO', () => {
  // Stesso 401: Claude non può ri-revieware il delta. Una LGTM sulla HEAD
  // vecchia non è però una prova sul contributo corrente: il fallback non deve
  // cancellare nemmeno un verdetto positivo stantio.
  const r = runGate({
    reviews: [botReview(OLD, '## LGTM')],
    files: ['.github/workflows/tests.yml'],
    meta: DRIFT_META,
    compare: COMPARE_CHANGED,
  });
  assert.equal(r.status, 1, `Una LGTM sulla HEAD vecchia non deve autorizzare il fallback.\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, /drift-fallback: APPROVATO/, r.stdout);
});

test('carry-forward: LGTM su un commit precedente con contributo invariato → verde', () => {
  // Il caso frequente su questo repo: la PR viene rebasata su main, oppure un
  // workflow di generazione le riscrive `content/`. Il codice approvato non e'
  // cambiato, quindi l'approvazione regge senza rispendere Claude.
  const r = runGate({
    reviews: [botReview(OLD, '## LGTM')],
    compare: {
      mergeBase: 'c'.repeat(40),
      byRange: {
        [`${'c'.repeat(40)}...${HEAD}`]: { files: [{ filename: 'engine/x.ts', status: 'modified', patch: '@@\n+uno' }] },
        [`${'c'.repeat(40)}...${OLD}`]: { files: [{ filename: 'engine/x.ts', status: 'modified', patch: '@@\n+uno' }] },
      },
    },
  });
  assert.equal(r.status, 0, `Il carry-forward non ha retto.\n${r.stdout}`);
  assert.match(r.stdout, /carry-forward/, r.stdout);
});

test('carry-forward: contributo CAMBIATO dall\'ultima LGTM → ROSSO', () => {
  const r = runGate({
    reviews: [botReview(OLD, '## LGTM')],
    compare: {
      mergeBase: 'c'.repeat(40),
      byRange: {
        [`${'c'.repeat(40)}...${HEAD}`]: { files: [{ filename: 'engine/x.ts', status: 'modified', patch: '@@\n+due' }] },
        [`${'c'.repeat(40)}...${OLD}`]: { files: [{ filename: 'engine/x.ts', status: 'modified', patch: '@@\n+uno' }] },
      },
    },
  });
  assert.equal(r.status, 1, `Il codice e' cambiato dopo la LGTM: serve una review nuova.\n${r.stdout}`);
});

test('carry-forward: solo `content/` cambiato → verde (e\' la churn del corpus)', () => {
  // La ragione per cui `NON_REVIEWABLE_FINGERPRINT_RE` nomina l'albero di
  // QUESTO repo: fino al 2026-09-03 la lista arrivava dal sito e non conteneva
  // `content/`, quindi ogni rigenerazione del corpus invalidava una LGTM buona.
  const r = runGate({
    reviews: [botReview(OLD, '## LGTM')],
    compare: {
      mergeBase: 'c'.repeat(40),
      byRange: {
        [`${'c'.repeat(40)}...${HEAD}`]: {
          files: [
            { filename: 'engine/x.ts', status: 'modified', patch: '@@\n+uno' },
            { filename: 'content/blog-body/it/nuovo.ts', status: 'added', patch: '@@\n+articolo' },
          ],
        },
        [`${'c'.repeat(40)}...${OLD}`]: { files: [{ filename: 'engine/x.ts', status: 'modified', patch: '@@\n+uno' }] },
      },
    },
  });
  assert.equal(r.status, 0, `La churn di content/ non deve invalidare una LGTM.\n${r.stdout}`);
});

test('fingerprint: crawler generati senza `.patch` non rendono il contributo UNKNOWN', () => {
  const generated = {
    filename: '.github/workflows/crawler-group-07.yml',
    status: 'modified',
  };
  const code = {
    filename: 'scripts/ci/auto-merge-eval.mjs',
    status: 'modified',
    patch: '@@\n+una riga di codice',
  };

  assert.equal(codeContributionFingerprint([generated]), '');
  assert.equal(
    codeContributionFingerprint([generated, code]),
    'scripts/ci/auto-merge-eval.mjs\tmodified\t+una riga di codice',
  );
  assert.equal(
    codeContributionFingerprint([{ filename: '.github/workflows/tests.yml', status: 'modified' }]),
    null,
    'un workflow non generato resta conservativo se GitHub omette la patch',
  );
});

const codexEvidence = formatCodexFallbackEvidence({ trigger: 'runtime-429', status: 'success' });
const codexReview = (overrides = {}) => ({
  user: { type: 'Bot', login: 'github-actions[bot]' },
  state: 'COMMENTED',
  commit_id: HEAD,
  body: `<!-- CODEX_FALLBACK_REVIEW -->\n## LGTM\n<!-- REVIEW_INPUT_REVISION: ${BODY_REVISION} -->`,
  ...overrides,
});

test('Codex LGTM requires valid run evidence and exact HEAD', () => {
  assert.equal(runGate({ reviews: [codexReview()], codexEvidence }).status, 0);
  assert.equal(runGate({ reviews: [codexReview()] }).status, 1);
  for (const review of [
    codexReview({ commit_id: OLD }),
    codexReview({ body: '## LGTM' }),
    codexReview({ user: { type: 'User', login: 'github-actions[bot]' } }),
    codexReview({ user: { type: 'Bot', login: 'other[bot]' } }),
    codexReview({ body: '<!-- CODEX_FALLBACK_REVIEW -->\n🔴 Important: fix required' }),
  ]) {
    const result = runGate({ reviews: [review], codexEvidence,
      files: ['.github/workflows/tests.yml'], meta: { assoc: 'OWNER', login: 'valerielinc-ops', body: GOOD_BODY } });
    assert.equal(result.status, 1, result.stdout);
  }
});

test('Codex LGTM sulla stessa HEAD porta avanti il verdetto dopo un body edit', () => {
  const changedBody = `${GOOD_BODY}\n- modifica editoriale`;
  const staleCodex = codexReview({
    body: `<!-- CODEX_FALLBACK_REVIEW -->\n## LGTM\n<!-- REVIEW_INPUT_REVISION: ${OLD_BODY_REVISION} -->`,
  });
  const result = runGate({
    reviews: [staleCodex],
    currentBody: changedBody,
    reviewRevision: bodyRevision(changedBody),
    checkRuns: [{ name: 'tests (node --test)', status: 'completed', conclusion: 'success' }],
  });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /review approvante sulla head/i, result.stdout);
});

test('Codex LGTM carry-forward usa il check richiesto verde come prova persistente', () => {
  const checkRuns = [{ name: 'tests (node --test)', status: 'completed', conclusion: 'success' }];
  const compare = {
    mergeBase: 'c'.repeat(40),
    byRange: {
      [`${'c'.repeat(40)}...${HEAD}`]: { files: [{ filename: 'engine/x.ts', status: 'modified', patch: '@@\n+uno' }] },
      [`${'c'.repeat(40)}...${OLD}`]: { files: [{ filename: 'engine/x.ts', status: 'modified', patch: '@@\n+uno' }] },
    },
  };
  const result = runGate({
    reviews: [codexReview({ commit_id: OLD })],
    compare,
    checkRuns,
  });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /carry-forward/, result.stdout);
});

test('Codex LGTM carry-forward aggrega tutte le pagine della cronologia check-run', () => {
  const checkRunPages = [
    { check_runs: [{ name: 'tests (node --test)', status: 'completed', conclusion: 'failure' }] },
    { check_runs: [{ name: 'tests (node --test)', status: 'completed', conclusion: 'success' }] },
  ];
  const compare = {
    mergeBase: 'c'.repeat(40),
    byRange: {
      [`${'c'.repeat(40)}...${HEAD}`]: { files: [{ filename: 'engine/x.ts', status: 'modified', patch: '@@\n+uno' }] },
      [`${'c'.repeat(40)}...${OLD}`]: { files: [{ filename: 'engine/x.ts', status: 'modified', patch: '@@\n+uno' }] },
    },
  };
  const result = runGate({
    reviews: [codexReview({ commit_id: OLD })],
    compare,
    checkRunPages,
  });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /carry-forward/, result.stdout);
});

test('un marker Codex senza evidenza e senza check precedente non sblocca il gate', () => {
  const result = runGate({ reviews: [codexReview({ commit_id: OLD })], compare: {
    mergeBase: 'c'.repeat(40),
    byRange: {
      [`${'c'.repeat(40)}...${HEAD}`]: { files: [{ filename: 'engine/x.ts', status: 'modified', patch: '@@\n+uno' }] },
      [`${'c'.repeat(40)}...${OLD}`]: { files: [{ filename: 'engine/x.ts', status: 'modified', patch: '@@\n+uno' }] },
    },
  } });
  assert.equal(result.status, 1, result.stdout);
});

test('invalid or failed Codex evidence cannot reuse an approving Claude review', () => {
  for (const evidence of ['invalid',
    formatCodexFallbackEvidence({ trigger: 'runtime-429', status: 'failure' }),
    codexEvidence.replace('gpt-5.6-luna', 'wrong-model')]) {
    const result = runGate({ reviews: [botReview(HEAD, '## LGTM'), codexReview()], codexEvidence: evidence });
    assert.equal(result.status, 1, result.stdout);
  }
});
