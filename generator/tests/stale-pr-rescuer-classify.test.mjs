/**
 * stale-pr-rescuer-classify.test.mjs — la catena di classificazione di
 * `.github/workflows/stale-pr-rescuer.yml`, ESEGUITA.
 * Run with `node --test generator/tests/stale-pr-rescuer-classify.test.mjs`.
 *
 * ## Perché eseguire e non greppare
 *
 * Il rescuer decide con un `if/elif/elif/elif/else` dentro un blocco `run:`. Un
 * test a regex su «esiste un ramo per la direzione 3» passerebbe anche se quel
 * ramo fosse IRRAGGIUNGIBILE — messo dopo la classe A, che lo contiene, non
 * scatterebbe mai e nessuna asserzione testuale se ne accorgerebbe. È la stessa
 * ragione per cui `generate-article-chain.test.mjs` estrae ed esegue il proprio
 * blocco invece di asserire che «c'è un break».
 *
 * Qui il blocco viene estratto dallo YAML vero ed eseguito con `gh` e `date`
 * stubbati su PATH. `jq` è quello di sistema: è parte della logica sotto test.
 *
 * ## Le due proprietà che contano
 *
 * 1. **La classe D esiste e scatta** sullo stato della #201: una review Claude
 *    su un commit che non è più l'head, senza `## LGTM`, con i test verdi. Il
 *    commento deve consegnare il rimedio giusto — il `workflow_dispatch` di
 *    `pr-review-loop.yml` aggiunto dalla #286 — e non «mergia main e pusha».
 *
 * 2. **Nessuna cella muta.** Con `LAST_CID != HEAD` e nessun run in volo, una
 *    classe deve SEMPRE scattare: è questa la proprietà che rende la
 *    condizione «review più vecchia dell'ultimo commit» coperta, e nessun
 *    commento in prosa la dimostra. Il grid test qui sotto la esegue su tutte
 *    le conclusioni possibili del check.
 *
 *    Va detto per intero: questa metà è già soddisfatta da `main` PRIMA della
 *    classe D — `success` cadeva in A e tutto il resto in C. È una guardia di
 *    regressione, non la prova di un lavoro nuovo, e mettere le due cose sullo
 *    stesso piano renderebbe il file una dimostrazione di comodo. La metà che
 *    DISCRIMINA è la 1: rimettendo lo YAML di `main` restano verdi 5 test su 9
 *    e cadono i 4 che parlano di D.
 *
 * E i tre guard sui falsi positivi, ognuno con il suo caso:
 *   - una review con `## LGTM` su un commit precedente NON è uno stallo (è il
 *     carry-forward progettato dal `Re-review guard` di `pr-review-loop.yml`);
 *   - una PR mai revisionata non è «revisionata e poi superata»;
 *   - con i test rossi il rimedio giusto resta quello della classe C.
 *
 * ## Portabilità
 *
 * `date` è stubbato perché la BSD `date` di macOS non ha `-d <iso>`: senza stub
 * il fallback `|| echo "$NOW"` renderebbe ogni PR «fresca» e il test sarebbe
 * verde a vuoto in locale e rosso solo in CI. Il caso «PR fresca» qui sotto è
 * anche la prova che lo stub discrimina davvero.
 *
 * La classe B (🔴 Important sull'head) non è esercitata: usa `grep -qP`, che
 * BSD grep non ha. Nessun caso di questo file la attraversa — B pretende
 * `LAST_CID == HEAD`, cioè l'opposto di ciò che qui si misura.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WF_PATH = path.resolve(HERE, '../../.github/workflows/stale-pr-rescuer.yml');
const WF = readFileSync(WF_PATH, 'utf8');

const HAS_JQ = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0;

/**
 * Estrae il corpo di uno step `run: |`. Volutamente senza parser YAML: il repo
 * non ha node_modules e le gate girano col solo `node --test`.
 */
function extractRun(stepName) {
  const lines = WF.split('\n');
  const start = lines.findIndex((l) => l === `      - name: ${stepName}`);
  assert.notEqual(start, -1, `step non trovato: ${stepName}`);
  const runAt = lines.findIndex((l, i) => i > start && l === '        run: |');
  assert.notEqual(runAt, -1, `blocco run non trovato per: ${stepName}`);
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') {
      body.push('');
      continue;
    }
    if (!l.startsWith('          ')) break;
    body.push(l.slice(10));
  }
  return body.join('\n');
}

const SCAN_RUN = extractRun('Scan open PRs and flag stalled ones');
const CHECK_NAME = 'tests (node --test)';
const HEAD_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const isoAgo = (hours) => new Date(Date.now() - hours * 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');

/** check-runs con UNA conclusione completata (o niente, con `concl: null`). */
function checkRuns({ concl = 'success', pending = 0 } = {}) {
  const runs = [];
  if (concl !== null) {
    runs.push({ name: CHECK_NAME, status: 'completed', completed_at: isoAgo(3), conclusion: concl });
  }
  for (let i = 0; i < pending; i++) runs.push({ name: CHECK_NAME, status: 'in_progress', completed_at: null });
  return { check_runs: runs };
}

/** Una review Claude, o nessuna. */
function reviews({ commit = OLD_SHA, body = 'nessun blocco' } = {}) {
  return [{ user: { login: 'claude[bot]', type: 'Bot' }, commit_id: commit, body }];
}

/**
 * Esegue il blocco `run:` con `gh` e `date` stubbati e restituisce
 * `{ labeled, comments, stdout }`.
 */
function runScan({ prs, checks, reviews: revs, dryRun = false }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'stale-pr-rescuer-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const calls = path.join(dir, 'calls');
    const fixPrs = path.join(dir, 'prs.json');
    const fixChecks = path.join(dir, 'checks.json');
    const fixReviews = path.join(dir, 'reviews.json');
    writeFileSync(calls, '');
    writeFileSync(fixPrs, JSON.stringify(prs));
    writeFileSync(fixChecks, JSON.stringify(checks));
    writeFileSync(fixReviews, JSON.stringify(revs));

    // `gh`: serve le tre letture del rescuer e registra le due scritture.
    // Ogni scrittura finisce in `calls` in una forma greppabile dal test.
    writeFileSync(
      path.join(bin, 'gh'),
      `#!/usr/bin/env bash
sub="$1"; shift
case "$sub" in
  pr)
    action="$1"; shift
    case "$action" in
      list) cat ${JSON.stringify(fixPrs)} ;;
      edit) printf 'LABEL %s\\n' "$1" >> ${JSON.stringify(calls)} ;;
      comment)
        n="$1"; shift
        body=""
        while [ $# -gt 0 ]; do
          if [ "$1" = "--body" ]; then body="$2"; shift 2; else shift; fi
        done
        printf 'COMMENT %s\\n%s\\n<<<END>>>\\n' "$n" "$body" >> ${JSON.stringify(calls)}
        ;;
      *) exit 0 ;;
    esac
    ;;
  api)
    p="$1"
    case "$p" in
      */check-runs) cat ${JSON.stringify(fixChecks)} ;;
      */reviews) cat ${JSON.stringify(fixReviews)} ;;
      *) echo '{}' ;;
    esac
    ;;
  *) exit 0 ;;
esac
exit 0
`,
    );

    // `date`: emula le DUE sole forme usate dal blocco — `-u +%s` e
    // `-u -d <iso> +%s`. La BSD date non ha `-d`, e il fallback del workflow
    // (`|| echo "$NOW"`) renderebbe ogni PR fresca: il test si spegnerebbe da
    // solo in locale senza dirlo.
    writeFileSync(
      path.join(bin, 'date'),
      `#!/usr/bin/env bash
iso=""
while [ $# -gt 0 ]; do
  case "$1" in
    -u) shift ;;
    -d) iso="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$iso" ]; then
  node -e 'const t=Date.parse(process.argv[1]); if(Number.isNaN(t)){process.exit(1)}; console.log(Math.floor(t/1000))' "$iso"
else
  node -e 'console.log(Math.floor(Date.now()/1000))'
fi
`,
    );
    chmodSync(path.join(bin, 'gh'), 0o755);
    chmodSync(path.join(bin, 'date'), 0o755);

    const script = path.join(dir, 'scan.sh');
    writeFileSync(script, SCAN_RUN);

    const stdout = execFileSync('bash', ['-e', script], {
      encoding: 'utf8',
      // stderr catturato e non ereditato: su macOS il ramo della classe B usa
      // `grep -qP`, che BSD grep non ha, e la sua usage line inquinerebbe
      // l'output di ogni run senza essere un fallimento.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        REPO: 'nanakokyobashi-rgb/frontaliere-articles',
        CI_CHECK_NAME: CHECK_NAME,
        GH_TOKEN: 'x',
        DRY_RUN: dryRun ? 'true' : 'false',
      },
    });

    const raw = readFileSync(calls, 'utf8');
    const labeled = [...raw.matchAll(/^LABEL (\d+)$/gm)].map((m) => Number(m[1]));
    const comments = [...raw.matchAll(/^COMMENT (\d+)\n([\s\S]*?)\n<<<END>>>$/gm)].map((m) => ({
      pr: Number(m[1]),
      body: m[2],
    }));
    return { labeled, comments, stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Una PR aperta, non draft, ferma da 5h (oltre la soglia di 2h del rescuer). */
const openPr = (over = {}) => [
  {
    number: 901,
    headRefName: 'fix/qualcosa',
    headRefOid: HEAD_SHA,
    updatedAt: isoAgo(5),
    author: { login: 'claude' },
    labels: [],
    isDraft: false,
    ...over,
  },
];

const only = (r) => {
  assert.equal(r.comments.length, 1, `atteso UN commento, ricevuti ${r.comments.length}:\n${r.stdout}`);
  return r.comments[0].body;
};

const opts = { skip: HAS_JQ ? false : 'jq non disponibile: la catena del rescuer lo usa per leggere le tre risposte gh' };

// ── 1. La classe D esiste, scatta, e consegna il rimedio giusto ─────────────
//
// Lo stato è quello della #181 raccontato dalla #201: review con 🔴 Important
// sul commit X, il redflag-fixer committa Y, i test tornano verdi su Y, e
// nessuna review nuova arriva mai perché un rerun di `tests` non produce
// l'evento `workflow_run` del reviewer.

test('D — review più vecchia dell\'head con test verdi: la classe scatta', opts, () => {
  const body = only(
    runScan({
      prs: openPr(),
      checks: checkRuns({ concl: 'success' }),
      reviews: reviews({ commit: OLD_SHA, body: '🔴 **Important**: manca il guard\n\ndettagli' }),
    }),
  );
  assert.match(
    body,
    /review più vecchia dell'head/,
    `La classe D non ha classificato lo stato della direzione 3 (#201). Commento:\n${body}`,
  );
});

test('D — il rimedio è il dispatch della review, non «mergia main e pusha»', opts, () => {
  const body = only(
    runScan({
      prs: openPr(),
      checks: checkRuns({ concl: 'success' }),
      reviews: reviews({ commit: OLD_SHA, body: '🔴 **Important**: manca il guard' }),
    }),
  );
  assert.match(
    body,
    /pr-review-loop\.yml/,
    'Il commento non nomina `pr-review-loop.yml`: la maniglia della #286 (direzione 1 della #201) è ' +
      `l'unica cura in un comando per questo stato, e senza il suo nome il segnale non è azionabile.\n${body}`,
  );
  assert.match(body, /-f pr=901/, `Il dispatch va consegnato con il numero della PR già dentro.\n${body}`);
  assert.doesNotMatch(
    body,
    /git merge origin\/main/,
    `Rimedio della classe A su uno stato di classe D: il merge di main non fa ripartire nessuna review.\n${body}`,
  );
});

// ── 2. I tre guard sui falsi positivi ──────────────────────────────────────

test('guard 1 — una LGTM su un commit precedente NON è uno stallo (carry-forward)', opts, () => {
  // `pr-review-loop.yml` salta Claude di proposito quando il delta dall'ultima
  // LGTM è di soli content/data, e porta la LGTM avanti. È lo stato SANO più
  // frequente su questo repo, dove quasi ogni PR è corpus.
  const body = only(
    runScan({
      prs: openPr(),
      checks: checkRuns({ concl: 'success' }),
      reviews: reviews({ commit: OLD_SHA, body: 'tutto a posto\n\n## LGTM' }),
    }),
  );
  assert.doesNotMatch(
    body,
    /review più vecchia dell'head/,
    'La classe D ha rivendicato il carry-forward della LGTM: è lo stato progettato del ' +
      `\`Re-review guard\` di pr-review-loop.yml, e chiamarlo stallo insegna a ignorare l'etichetta.\n${body}`,
  );
  assert.match(body, /nessuna review li ha coperti/, `Atteso il fallback alla classe A.\n${body}`);
});

test('guard 2 — una PR mai revisionata resta in classe A', opts, () => {
  const body = only(
    runScan({ prs: openPr(), checks: checkRuns({ concl: 'success' }), reviews: [] }),
  );
  assert.doesNotMatch(
    body,
    /review più vecchia dell'head/,
    `«mai revisionata» non è «revisionata e poi superata»: il rimedio è diverso.\n${body}`,
  );
  assert.match(body, /nessuna review li ha coperti/, body);
});

test('guard 3 — con i test rossi il rimedio resta quello della classe C', opts, () => {
  const body = only(
    runScan({
      prs: openPr(),
      checks: checkRuns({ concl: 'failure' }),
      reviews: reviews({ commit: OLD_SHA, body: '🔴 **Important**: rotto' }),
    }),
  );
  assert.doesNotMatch(
    body,
    /review più vecchia dell'head/,
    'Con i test rossi la causa dello stallo è il rosso: dirottare su un dispatch della review ' +
      `sostituirebbe una cura corretta (rebase + re-dispatch dei test) con una inefficace.\n${body}`,
  );
  assert.match(body, /stallo silenzioso/, body);
});

// ── 3. Le due celle che devono restare MUTE ────────────────────────────────

test('un run in volo sull\'head non è uno stallo: nessuna azione', opts, () => {
  const r = runScan({
    prs: openPr(),
    checks: checkRuns({ concl: null, pending: 1 }),
    reviews: reviews({ commit: OLD_SHA }),
  });
  assert.deepEqual(r.comments, [], `Con i test in volo la PR sta lavorando.\n${r.stdout}`);
  assert.deepEqual(r.labeled, []);
});

test('una PR toccata da meno di 2h non viene mai etichettata', opts, () => {
  // Vale anche come prova che lo stub di `date` discrimina: se non parsasse
  // `updatedAt`, il fallback del workflow renderebbe fresca OGNI PR e tutti i
  // casi sopra sarebbero verdi a vuoto.
  const r = runScan({
    prs: openPr({ updatedAt: isoAgo(0.5) }),
    checks: checkRuns({ concl: 'success' }),
    reviews: reviews({ commit: OLD_SHA }),
  });
  assert.deepEqual(r.comments, [], `Il gate delle 2h non ha trattenuto una PR fresca.\n${r.stdout}`);
});

// ── 4. Nessuna cella muta: la proprietà che rende la condizione «coperta» ───

test('nessuna cella muta con review più vecchia dell\'head e nessun run in volo', opts, () => {
  // È questa la forma esatta della direzione 3 della #201. Non serve un ramo
  // per ogni conclusione: serve che NESSUNA conclusione cada nell'`else` muto.
  const mute = [];
  const claimedByD = [];
  for (const concl of ['success', 'failure', 'cancelled', 'timed_out', 'neutral', null]) {
    const r = runScan({
      prs: openPr(),
      checks: checkRuns({ concl }),
      reviews: reviews({ commit: OLD_SHA, body: 'un finding, niente LGTM' }),
    });
    if (r.comments.length === 0) mute.push(String(concl));
    else if (/review più vecchia dell'head/.test(r.comments[0].body)) claimedByD.push(String(concl));
  }
  assert.deepEqual(
    mute,
    [],
    `Queste conclusioni del check cadono nell'else MUTO con una review più vecchia dell'head: ` +
      `${mute.join(', ')}. È lo stallo permanente della #201 — la PR è verde per ogni gate e ` +
      `nessuno la guarda più.`,
  );
  assert.deepEqual(
    claimedByD,
    ['success'],
    `La classe D deve rivendicare SOLO lo stato coi test verdi (guard 3), ma rivendica: ${claimedByD.join(', ')}.`,
  );
});

// ── 5. D è un sottoinsieme stretto di A: nessuna PR etichettata in più ──────

test('D non allarga l\'insieme delle PR etichettate', opts, () => {
  // Il predicato di D aggiunge tre congiunzioni al predicato di A e non ne
  // toglie nessuna. La conseguenza operativa — `recycle-stale-prs` chiude le
  // `stale-review` ferme >24h — è che questa PR non può far chiudere niente
  // che prima restasse aperto.
  const src = readFileSync(WF_PATH, 'utf8');
  const chain = src.slice(src.indexOf('REASON=""; RESCUE=""'));
  const dBranch = chain.slice(0, chain.indexOf('\n            elif '));
  for (const required of ['-n "$LAST_CID"', '"$LAST_CID" != "$HEAD"', '"$TESTS_CONCL" = "success"']) {
    assert.ok(
      dBranch.includes(required),
      `Il ramo D non congiunge più \`${required}\`: senza, smette di essere un sottoinsieme del ` +
        `ramo A e comincia a etichettare PR che oggi nessuno etichetta.`,
    );
  }
});
