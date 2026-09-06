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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/ci/review-gate.mjs');

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

const GOOD_BODY = '## Implementato\n- una cosa vera\n\n## Non implementato (ancora)\n- Nessuno';

/**
 * Esegue il gate vero con `gh` sostituito da uno stub che legge le sue
 * risposte da file. Ritorna `{ status, stdout, comments }`.
 *
 * Lo stub scarta i flag PRIMA di leggere il path, per la stessa ragione
 * documentata nello stub del rescuer: `gh api --paginate <path>` con un match
 * cieco su `$1` leggerebbe `--paginate` come path e cadrebbe nel default,
 * cioe' un test verde su un gate che non vede piu' niente.
 */
function runGate({ reviews = [], files = [], meta = null, compare = null }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'review-gate-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const calls = path.join(dir, 'calls');
    const fixReviews = path.join(dir, 'reviews.json');
    const fixFiles = path.join(dir, 'files.txt');
    const fixMeta = path.join(dir, 'meta.json');
    writeFileSync(calls, '');
    writeFileSync(fixReviews, JSON.stringify(reviews));
    writeFileSync(fixFiles, files.join('\n') + (files.length ? '\n' : ''));
    writeFileSync(fixMeta, JSON.stringify(meta ?? {}));

    // `compare` mappa sha → payload della compare API. Un `null` significa
    // «endpoint non stubbato»: il gate deve cadere sul ramo conservativo.
    const fixCompare = path.join(dir, 'compare.json');
    writeFileSync(fixCompare, JSON.stringify(compare ?? {}));

    writeFileSync(
      path.join(bin, 'gh'),
      `#!/usr/bin/env bash
sub="$1"; shift
case "$sub" in
  api)
    p=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --paginate|--slurp) shift ;;
        --jq|-H|-f|-F|-X) shift 2 ;;
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
      */issues/*/comments*) echo '[]' ;;
      */pulls/*)   cat ${JSON.stringify(fixMeta)} ;;
      *) echo '{}' ;;
    esac
    ;;
  pr)
    action="$1"; shift
    if [ "$action" = "comment" ]; then
      printf 'COMMENT %s\\n' "$*" >> ${JSON.stringify(calls)}
    fi
    ;;
  *) exit 0 ;;
esac
exit 0
`,
    );
    chmodSync(path.join(bin, 'gh'), 0o755);

    const r = spawnSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_REPOSITORY: 'nanakokyobashi-rgb/frontaliere-articles',
        PR_NUMBER: '901',
        HEAD_SHA: HEAD,
        GH_TOKEN: 'stub',
      },
    });
    return { status: r.status, stdout: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const botReview = (commit, body) => ({
  user: { type: 'Bot', login: 'claude[bot]' },
  commit_id: commit,
  body,
});

test('LGTM sulla head senza 🔴 → il check e\' verde', () => {
  const r = runGate({ reviews: [botReview(HEAD, 'tutto bene\n\n## LGTM')] });
  assert.equal(r.status, 0, r.stdout);
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

test('drift-fallback: 🔴 stantio (SHA vecchio, contributo cambiato) + tests.yml → verde', () => {
  // #970: Claude posta 🔴 sulla prima HEAD, i commit dopo sistemano e toccano
  // tests.yml, claude-code-action skippa 401 senza postare. Senza questo ramo
  // il 🔴 vecchio tiene il check rosso per sempre.
  const r = runGate({
    reviews: [botReview(OLD, '🔴 Important: collect jq ancora claude-only\n\n## LGTM')],
    files: ['.github/workflows/tests.yml', 'scripts/ci/review-gate.mjs'],
    meta: DRIFT_META,
    compare: COMPARE_CHANGED,
  });
  assert.equal(r.status, 0, `Un 🔴 che non si applica piu' alla head non deve bloccare il fallback.\n${r.stdout}`);
  assert.match(r.stdout, /drift-fallback: APPROVATO/, r.stdout);
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

test('drift-fallback: LGTM stantia (contributo cambiato) + tests.yml → verde', () => {
  // Stesso 401: Claude non puo' ri-revieware il delta. Senza fallback la LGTM
  // vecchia non carry-forwarda e il check resta rosso.
  const r = runGate({
    reviews: [botReview(OLD, '## LGTM')],
    files: ['.github/workflows/tests.yml'],
    meta: DRIFT_META,
    compare: COMPARE_CHANGED,
  });
  assert.equal(r.status, 0, `Una LGTM che non si applica piu' deve cedere al fallback, non al rosso.\n${r.stdout}`);
  assert.match(r.stdout, /drift-fallback: APPROVATO/, r.stdout);
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
