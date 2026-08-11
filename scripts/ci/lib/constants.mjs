/**
 * constants.mjs — costanti CI condivise tra gli script di auto-merge/rebase.
 *
 * `VITEST_CHECK_NAME` è il nome del check-run su cui gattano sia
 * `auto-merge-eval.mjs` (gate 3: HEAD vitest == success) sia `pr-autorebase.mjs`
 * (rilevamento head "orfani" a 0 check-run vitest da heal-dispatchare). DEVE
 * matchare byte-per-byte il `name:` del job in `.github/workflows/tests.yml`
 * (source of truth: lo YAML non può importare una const JS). Se i tre punti
 * divergono, `headHasVitestCheck` / il gate vitest leggono length 0 / conclusion
 * "" in silenzio → heal ri-dispatcha all'infinito e nessuna PR mergia. Tenendo
 * i due script `.mjs` su questa singola const, l'unico drift residuo possibile è
 * rinominare il job in tests.yml senza aggiornare qui — coperto dal guard test
 * `generator/tests/ci-check-name.test.mjs`.
 *
 * ── ADATTAMENTO DICHIARATO (voce `constants` in loop-sync-manifest.json) ──
 *
 * Questo repo non usa vitest: le gate girano con `node --test` e il job si
 * chiama `tests (node --test)`. Il valore quindi differisce dal sito, ma il
 * NOME DELL'EXPORT no.
 *
 * È deliberato, ed è il perno di tutta la sincronizzazione: i tre consumer
 * (`auto-merge-eval.mjs`, `pr-autorebase.mjs`, `vitestCheck.mjs`) importano
 * `VITEST_CHECK_NAME`, e rinominarlo qui li farebbe divergere tutti e tre dal
 * sito — 5.000 righe che vanno riallineate a mano ogni volta che il sito le
 * tocca. Tenendo il nome, l'intera differenza fra i due repo si concentra in
 * QUESTA RIGA, e ogni altro file resta byte-identico e copiabile.
 *
 * Il nome è storico e sul corpus è una bugia; il commento è il posto giusto per
 * dirlo, un rename no.
 *
 * L'override via `CI_CHECK_NAME` esiste perché il giorno in cui il sito adotta
 * la stessa riga i due file diventano identici e il drift scende a zero.
 */
export const VITEST_CHECK_NAME = process.env.CI_CHECK_NAME || 'tests (node --test)';

/**
 * Matcha il nome dei check-run dei singoli SHARD vitest in `tests.yml`
 * (`name: vitest shard ${{ matrix.shard }}/4` → `vitest shard 1/4`, …). Distinto
 * da `VITEST_CHECK_NAME`, che è il job AGGREGATORE: l'aggregatore collassa
 * QUALSIASI shard non-`success` (incluso `cancelled`) in un unico `failure`
 * (`needs.vitest-shard.result != success → exit 1`), perdendo l'informazione su
 * SE la failure è un test rotto o una cancellazione transient (concurrency
 * `cancel-in-progress` durante un'ondata di push su main). `vitestCheck.mjs` usa
 * questo regex per ri-aprire gli shard sottostanti e distinguere i due casi
 * (vedi `vitestVerdictIsTransientCancellation`). `\d+\/\d+` resta valido se il
 * numero di shard cambia. Drift dal `name:` del job → guard in
 * `tests/ci-vitest-check-name.test.ts`.
 *
 * NB (2026-08-05): dal de-sharding #2882 `tests.yml` ha un JOB SOLO e questo
 * regex non matcha nulla sugli head odierni — il ramo shard di
 * `vitestVerdictIsTransientCancellation` è quindi inerte, non morto: resta per
 * rendere il ri-shardaggio reversibile senza toccare il percorso di recupero.
 * Nella topologia a job singolo la cancellazione NON viene collassata in
 * `failure`: atterra come `cancelled` sul check aggregatore, caso gestito
 * direttamente lì senza passare da questo regex. */
export const VITEST_SHARD_NAME_RE = /^vitest shard \d+\/\d+$/;

/**
 * Detects a `🔴 Important` finding in a reviewer body, TOLERANT to the reviewer's
 * markdown: `🔴 Important:`, `🔴 **Important —**`, `🔴**Important**:` all match. The
 * plain literal `'🔴 Important'` (used historically) misses the bold form, which
 * the reviewer emitted on PR #2211 round-2 ("🔴 **Important —**") → the
 * redflag-fixer skipped and the PR stalled with an unaddressed 🔴, and the
 * auto-merge 🔴-guard could likewise miss it. Single source for the JS-side gates
 * (auto-merge-eval.mjs).
 *
 * Requires a delimiter (`:`, em-dash `—`, or `-`) right after `Important` (+
 * optional closing bold). Without it, PR #3330 false-positived: the reviewer's
 * own negation prose "zero 🔴 Important findings (both nits are non-blocking...)"
 * matched the bare `🔴\s*\*{0,2}\s*Important` regex — "Important" there is an
 * adjective inside a sentence saying there are NONE, not the marker — so the
 * auto-merge 🔴-guard skipped a PR that actually had `## LGTM` and zero real
 * findings, and the same text would also have mis-tripped stale-pr-rescuer.yml's
 * Class B rescue. Every real marker observed (colon-delimited, or the PR #2211
 * bold/dash form) has punctuation immediately after "Important"; plain
 * continuation prose does not.
 *
 * NB: `pr-redflag-fixer.yml`'s preflight greps the SAME shape in bash
 * (`grep -qP '🔴\s*\*{0,2}\s*Important\s*\*{0,2}\s*[:—-]'`) — a YAML `if:` cannot
 * import this regex, so keep the two equivalent. `stale-pr-rescuer.yml`'s Class B
 * check now mirrors it too (previously an even broader bare `🔴`, with the same
 * false-positive exposure).
 */
export const REDFLAG_IMPORTANT_RE = /🔴\s*\*{0,2}\s*Important\s*\*{0,2}\s*[:—-]/;

/**
 * File la cui modifica impedisce STRUTTURALMENTE al reviewer Claude di girare
 * sulla PR → niente `## LGTM` → l'auto-merge normale non scatta → senza fallback
 * la PR resta ferma in attesa di un merge manuale.
 *
 * È SOLO `pr-review-loop.yml`: la GitHub App del reviewer esige che il workflow
 * file in esecuzione sia byte-identico alla versione su `main` (`Workflow
 * validation failed. 401`). Una PR che lo MODIFICA ha per definizione un
 * contenuto diverso da main → 401 → review job rosso, nessun `## LGTM` postato.
 * Verificato che gli altri file storicamente citati come "merge manuale"
 * (`auto-merge-on-lgtm.yml`, `post-merge-followup.yml`, `REVIEW.md`,
 * `FOLLOWUP.md`) NON driftano: il reviewer (che esegue `pr-review-loop.yml`,
 * invariato) gira e posta `## LGTM` normalmente (`post-merge-followup` per giunta
 * gira su `pull_request: closed`, post-merge → non gatekeepa il merge). Tenere
 * la lista MINIMA limita la superficie "merge senza review Claude" del fallback.
 *
 * Usato da `auto-merge-eval.mjs` (drift-fallback: gate deterministici al posto
 * dell'`## LGTM` mancante). Se in futuro un altro workflow su `pull_request`
 * inizia a invocare il claude-code-action, aggiungilo qui.
 */
export const REVIEW_WORKFLOW_DRIFT_FILES = ['.github/workflows/pr-review-loop.yml'];

/**
 * Nome del check-run del job `test` di `.github/workflows/generator-ci.yml`
 * (nessun `name:` esplicito sul job → il check-run prende l'id `test`,
 * verificato via `gh api .../check-runs` su un run reale). Quel job include i
 * due gate del `SiteShellContract` (`host/tests/shell-contract-{fingerprint,
 * functions}.test.mjs`) insieme agli altri `node --test`/`tsx --test` del
 * generatore — è il check che #242 vuole richiesto dall'auto-merge quando la
 * PR tocca i path che lo attivano (sotto), altrimenti un `generator-ci` rosso
 * non ferma il merge (il gate era acceso ma non bloccante, perché
 * `auto-merge-eval.mjs` esigeva `success` solo su `VITEST_CHECK_NAME` e
 * `main` non ha required status checks configurati — `branches/main/protection`
 * risponde 404).
 */
export const GENERATOR_CI_JOB_NAME = 'test';

/**
 * Path che fanno scattare `generator-ci.yml` su una PR — MIRROR dei
 * `pull_request.paths` in `.github/workflows/generator-ci.yml` (lo YAML non
 * può importare una const JS). Le voci che finiscono per `/` sono prefissi di
 * cartella (`generator/**` → `generator/`); le altre sono match esatti di
 * file. Usati da `auto-merge-eval.mjs` (`touchesGeneratorCiPaths`) per capire
 * se una PR deve attendere anche `GENERATOR_CI_JOB_NAME`, non solo
 * `VITEST_CHECK_NAME`, prima di mergiare — condizionato ai path così una PR di
 * solo contenuto non paga mai il costo extra (nessun check-run "test" da
 * attendere, perché `generator-ci.yml` non parte nemmeno). Drift dai path
 * reali del workflow → guard in
 * `generator/tests/generator-ci-required-gate.test.mjs`.
 */
export const GENERATOR_CI_TRIGGER_PATHS = [
  'generator/',
  'engine/',
  'host/',
  '.github/workflows/generator-ci.yml',
  'package.json',
  'package-lock.json',
];
