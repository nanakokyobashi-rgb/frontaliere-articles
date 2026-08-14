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
    runs.push({ id: 1000, name: CHECK_NAME, status: 'completed', completed_at: isoAgo(3), conclusion: concl });
  }
  for (let i = 0; i < pending; i++) runs.push({ id: 2000 + i, name: CHECK_NAME, status: 'in_progress', completed_at: null });
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
function runScan({ prs, checks, reviews: revs, comments: posted = [], dryRun = false }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'stale-pr-rescuer-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const calls = path.join(dir, 'calls');
    const fixPrs = path.join(dir, 'prs.json');
    const fixChecks = path.join(dir, 'checks.json');
    const fixReviews = path.join(dir, 'reviews.json');
    const fixComments = path.join(dir, 'comments.json');
    writeFileSync(calls, '');
    writeFileSync(fixPrs, JSON.stringify(prs));
    writeFileSync(fixChecks, JSON.stringify(checks));
    writeFileSync(fixReviews, JSON.stringify(revs));
    writeFileSync(fixComments, JSON.stringify(posted));

    // `gh`: serve le QUATTRO letture del rescuer e registra le tre scritture
    // (add-label, remove-label, comment). Ogni scrittura finisce in `calls` in
    // una forma greppabile dal test.
    //
    // Il ramo `api` scarta i flag PRIMA di leggere il path: dal fix della #314
    // ogni chiamata è `gh api --paginate <path>`, e uno stub che prendesse
    // ciecamente `$1` leggerebbe `--paginate` come path e cadrebbe nel default
    // `{}` — cioè un test verde su un rescuer che non vede più niente.
    writeFileSync(
      path.join(bin, 'gh'),
      `#!/usr/bin/env bash
sub="$1"; shift
case "$sub" in
  pr)
    action="$1"; shift
    case "$action" in
      edit)
        n="$1"; shift
        act="LABEL"
        while [ $# -gt 0 ]; do
          if [ "$1" = "--remove-label" ]; then act="UNLABEL"; fi
          shift
        done
        printf '%s %s\\n' "$act" "$n" >> ${JSON.stringify(calls)}
        ;;
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
    p=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --paginate|--slurp) shift ;;
        --jq|-H|-f|-F|-X) shift 2 ;;
        *) if [ -z "$p" ]; then p="$1"; fi; shift ;;
      esac
    done
    # L'ordine dei pattern conta: \`.../pulls/N/reviews\` matcha anche
    # \`*/pulls*\`, quindi le foglie vanno prima della lista.
    case "$p" in
      */check-runs*) cat ${JSON.stringify(fixChecks)} ;;
      */reviews*)    cat ${JSON.stringify(fixReviews)} ;;
      */comments*)   cat ${JSON.stringify(fixComments)} ;;
      */pulls*)      cat ${JSON.stringify(fixPrs)} ;;
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
    const unlabeled = [...raw.matchAll(/^UNLABEL (\d+)$/gm)].map((m) => Number(m[1]));
    const comments = [...raw.matchAll(/^COMMENT (\d+)\n([\s\S]*?)\n<<<END>>>$/gm)].map((m) => ({
      pr: Number(m[1]),
      body: m[2],
    }));
    return { labeled, unlabeled, comments, stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Una PR aperta, non draft, ferma da 5h (oltre la soglia di 2h del rescuer).
 *
 * Forma REST (`head.ref`, `head.sha`, `updated_at`, `draft`) e non quella di
 * `gh pr list --json`: dal fix della #314 il rescuer legge
 * `gh api --paginate repos/:r/pulls` e rimappa i campi in jq. La fixture DEVE
 * parlare la lingua dell'API vera, altrimenti pinnerebbe una forma che nessuno
 * riceve più.
 */
const openPr = (over = {}) => [
  {
    number: 901,
    head: { ref: 'fix/qualcosa', sha: HEAD_SHA },
    updated_at: isoAgo(5),
    user: { login: 'claude' },
    labels: [],
    draft: false,
    ...over,
  },
];

/** La stessa PR, ma già etichettata `stale-review`. */
const staleLabelled = (over = {}) => openPr({ labels: [{ name: 'stale-review' }], ...over });

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
    prs: openPr({ updated_at: isoAgo(0.5) }),
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

// ── 5. IL CASO #314: la label non deve spegnere la valutazione ─────────────
//
// Il rescuer saltava in cima al ciclo ogni PR che avesse già `stale-review`.
// Il corto circuito è che quella label è ANCHE ciò che fa saltare la PR a
// `pr-review-loop.yml`: una PR entrata in classe C con i test rossi, riparata
// dopo, diventa una classe D — verde, con una review più vecchia dell'head —
// che nessuno poteva più vedere. Verde per ogni gate, senza review, per
// sempre. Esattamente lo stallo permanente che questo workflow esiste per
// rompere, prodotto dal workflow stesso.

test('IL CASO #314: una PR già `stale-review` viene RI-VALUTATA, non saltata', opts, () => {
  const r = runScan({
    prs: staleLabelled(),
    checks: checkRuns({ concl: 'success' }),
    reviews: reviews({ commit: OLD_SHA, body: '🔴 **Important**: manca il guard' }),
  });
  assert.equal(
    r.comments.length,
    1,
    'La PR ha già `stale-review` e il rescuer non l\'ha classificata: è il corto circuito della ' +
      `#314. La label che dovrebbe segnalare lo stallo lo rende invisibile.\n${r.stdout}`,
  );
  assert.match(
    r.comments[0].body,
    /review più vecchia dell'head/,
    `Ri-valutata, ma non come classe D: è lo stato in cui una classe C riparata finisce.\n${r.comments[0].body}`,
  );
});

test('#314 — idempotenza: stessa classe sullo stesso head non ri-commenta', opts, () => {
  // Il loop che il vecchio salto voleva evitare. Si chiude sulla coppia
  // (CLASSE, HEAD) invece che sulla sola esistenza della label: più stretto,
  // e senza spegnere la valutazione.
  const first = runScan({
    prs: staleLabelled(),
    checks: checkRuns({ concl: 'success' }),
    reviews: reviews({ commit: OLD_SHA, body: 'un finding' }),
  });
  assert.equal(first.comments.length, 1, first.stdout);

  const again = runScan({
    prs: staleLabelled(),
    checks: checkRuns({ concl: 'success' }),
    reviews: reviews({ commit: OLD_SHA, body: 'un finding' }),
    comments: [{ body: first.comments[0].body }],
  });
  assert.deepEqual(
    again.comments,
    [],
    'Stessa classe e stesso head, e il rescuer ha commentato di nuovo: a un cron orario ' +
      `sarebbero 24 commenti al giorno sulla stessa PR.\n${again.stdout}`,
  );
  assert.deepEqual(again.labeled, [], 'nessuna azione attesa quando il verdetto è già stato consegnato');
});

test('#314 — classe DIVERSA sullo stesso head: il fatto nuovo viene detto', opts, () => {
  // È la transizione che il vecchio salto rendeva invisibile: C (test rossi)
  // → D (riparata, verde, review vecchia). Il marker della classe C non deve
  // sopprimere il verdetto della classe D.
  const cComment = `🔧 **stale-review** (automatico)\n<!-- stale-pr-rescuer class=C head=${HEAD_SHA.slice(0, 7)} -->`;
  const r = runScan({
    prs: staleLabelled(),
    checks: checkRuns({ concl: 'success' }),
    reviews: reviews({ commit: OLD_SHA, body: 'un finding' }),
    comments: [{ body: cComment }],
  });
  assert.equal(
    r.comments.length,
    1,
    'Il marker di una classe PRECEDENTE ha soppresso il verdetto della classe nuova: ' +
      `l\'idempotenza sarebbe di nuovo un corto circuito, solo più difficile da vedere.\n${r.stdout}`,
  );
  assert.match(r.comments[0].body, /review più vecchia dell'head/, r.comments[0].body);
});

test('#314 — stallo rientrato: `stale-review` viene TOLTA, non lasciata lì', opts, () => {
  // L'altra metà. Finché la label resta, `pr-review-loop.yml` salta la PR e
  // `recycle-stale-prs` la conta fra le chiudibili a 24h: un segnale scaduto
  // può far chiudere una PR sana. Qui la review è SULL'head, i test sono verdi
  // e non c'è nessun 🔴 → nessuna classe scatta.
  const r = runScan({
    prs: staleLabelled(),
    checks: checkRuns({ concl: 'success' }),
    reviews: reviews({ commit: HEAD_SHA, body: 'tutto a posto\n\n## LGTM' }),
  });
  assert.deepEqual(r.comments, [], `Nessuno stallo: nessun commento atteso.\n${r.stdout}`);
  assert.deepEqual(
    r.unlabeled,
    [901],
    'La label `stale-review` non è stata rimossa a stallo rientrato. Nessun altro workflow la ' +
      `toglie: resta finché la PR non viene chiusa.\n${r.stdout}`,
  );
});

test('#314 — con un run in volo la label NON viene tolta: lo stato non è noto', opts, () => {
  // Fail-safe: `TESTS_PENDING > 0` significa "non lo sappiamo ancora", e
  // togliere la label lì cancellerebbe un segnale valido per un run che deve
  // ancora rispondere.
  const r = runScan({
    prs: staleLabelled(),
    checks: checkRuns({ concl: null, pending: 1 }),
    reviews: reviews({ commit: HEAD_SHA, body: 'ok' }),
  });
  assert.deepEqual(r.unlabeled, [], `Label tolta mentre un check è ancora in volo.\n${r.stdout}`);
});

// ── 6. Troncamento e ordinamento: i due difetti silenziosi della #314 ───────

test('#314 — nessuna lettura `gh` senza `--paginate`', opts, () => {
  // Metrica della scheda. Una risposta troncata non produce nessun errore: le
  // PR oltre il taglio semplicemente non esistono per il rescuer, e sono le
  // più vecchie — cioè quelle che ha il compito di trovare.
  const offenders = readFileSync(WF_PATH, 'utf8')
    .split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /\bgh (api|pr list)\b/.test(l) && !l.includes('--paginate'));
  assert.deepEqual(
    offenders.map(([n, l]) => `${n}: ${l.trim()}`),
    [],
    'Letture `gh` senza `--paginate`: troncano in silenzio.',
  );
});

test('#314 — due check completati nello STESSO secondo: vince il più recente per `id`', opts, () => {
  // `completed_at` è ISO8601 risolto al secondo, e due run sullo stesso SHA
  // che chiudono nello stesso secondo sono ordinari (un rerun parte quando il
  // primo sta finendo). A parità di chiave `sort_by` è STABILE, quindi senza
  // tie-break `last` è "l'ultimo che l'API ha elencato" — un ordine che non è
  // il tempo. Qui il `failure` è elencato per ultimo ma ha l'`id` più BASSO:
  // è il `success` (id maggiore) il verdetto vero.
  const sameSecond = isoAgo(3);
  const r = runScan({
    prs: openPr(),
    checks: {
      check_runs: [
        { id: 5002, name: CHECK_NAME, status: 'completed', completed_at: sameSecond, conclusion: 'success' },
        { id: 5001, name: CHECK_NAME, status: 'completed', completed_at: sameSecond, conclusion: 'failure' },
      ],
    },
    reviews: reviews({ commit: OLD_SHA, body: 'un finding, niente LGTM' }),
  });
  const body = only(r);
  assert.match(
    body,
    /review più vecchia dell'head/,
    'Con `sort_by(.completed_at)` senza tie-break vince il `failure` stantio elencato per ultimo ' +
      `e un success reale viene mascherato: la PR cade in classe C invece che in D.\n${body}`,
  );
});

// ── 7. D è un sottoinsieme stretto di A: nessuna PR etichettata in più ──────

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
