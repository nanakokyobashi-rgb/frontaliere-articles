/**
 * loop-references-exist.test.mjs — i file che il ciclo NOMINA senza importarli
 * devono esistere, oppure la loro assenza va DICHIARATA.
 *
 * ## Il buco che chiude, che è una classe e non un caso
 *
 * `loop-scripts-closure.test.mjs` risolve gli **import** relativi, ed è per
 * questo che il porting del ciclo sembrava chiuso. Ma un riferimento che non ha
 * forma di import non è coperto da niente:
 *
 *   `alert-pat-down.mjs` è arrivato qui `identical` dichiarando in un commento —
 *   con tanto di ⚠ — che `gh-pat-expiry-monitor.yml` è «l'unico punto di
 *   chiusura» del suo alert. Quel workflow qui non esisteva. L'alerter apre una
 *   issue `priority:urgent`, e col dedup sul titolo canonico ogni 429 successivo
 *   ci avrebbe aggiunto solo un commento di recurrence: il segnale «il loop è
 *   giù» sarebbe restato acceso per sempre, senza distinguere più l'allarme vero
 *   da quello stantio. È successo davvero (#45), e le voci `not-ported` del
 *   manifest erano **0**: il porting si dichiarava completo avendo portato
 *   l'allarme senza il suo chiuditore.
 *
 * È la stessa forma del `SiteShellContract` in `CLAUDE.md`:
 * `packages-articles-confinement.test.ts` dimostra via AST che nulla sotto
 * `packages/articles` importa fuori, ma il contratto **non ha forma di import**,
 * quindi spedire l'engine senza la sua metà `host/` dava `TypeError` a render
 * time dietro una CI verde. Un guard che segue gli import non vede i contratti
 * che import non sono.
 *
 * ## Cosa fa
 *
 * Estrae dal TESTO dei file del ciclo (commenti, stringhe, `run:` dei workflow —
 * senza distinguere: un path citato in un commento è una promessa al lettore
 * esattamente come uno in un `run:` è una promessa al runner) i token che hanno
 * forma di path sotto `.github/`, `scripts/`, `generator/`, `bin/`, e verifica
 * che risolvano a un file esistente.
 *
 * ## Il problema vero: i falsi positivi, e perché NON si indovinano dalla prosa
 *
 * Un path citato e assente non è di per sé un difetto. Su questo repo, al primo
 * giro, 17 citazioni su 197 non risolvevano, e quasi tutte erano legittime — il
 * repo cita di continuo file che vivono solo sul sito. Peggio: la forma più
 * insidiosa è la citazione **contrastiva**, dove il path è nominato proprio per
 * dire che NON è quello giusto qui:
 *
 *     #  - Il ponte Remote Config è `generator/scripts/load-rc-env.mjs`, non
 *     #    `scripts/load-rc-env.mjs`.
 *
 * Leggere l'intento dalla prosa è precisamente l'errore che
 * `scripts/ci/lib/false-positive-declaration.mjs` documenta: il matching naive
 * legge una dichiarazione NEGATA come affermativa, e quel modulo ha dovuto
 * crescere un lookbehind di negazione (in due lingue) per un bug trovato in
 * review. Non ripetiamo quella strada: qui la prosa non viene interpretata.
 *
 * **La regola è invece: ogni citazione non risolta va dichiarata**, con una fra
 * tre `kind` chiuse e una ragione scritta. Il valore non sta nel classificare le
 * 17 di oggi — sta nel rendere impossibile aggiungere la 18ª in silenzio. Un
 * porting che cita un file mai portato non passa più con la CI verde: chi lo fa
 * deve scegliere un `kind`, e **la scelta è il momento in cui ci si chiede se la
 * citazione sia portante**. Quella domanda, sulla #45, non se l'è posta nessuno.
 *
 * Non esiste un `kind` per «assente ma portante»: quello è il difetto, e le
 * uniche uscite sono portare il referente o riscrivere l'affermazione.
 *
 * ## Perché il registro non è un timbro
 *
 * Tre assert lo tengono vivo invece che gonfio:
 *   1. una dichiarazione il cui path ORA esiste è stale → va rimossa;
 *   2. una dichiarazione che nessuno cita più è peso morto → va rimossa;
 *   3. `renamed-here` deve dire dove sta davvero il file QUI, e quel path viene
 *      verificato: se il corrispettivo locale si sposta, la dichiarazione rompe.
 *
 * L'assert 3 è ciò che dà denti alla classe più ambigua, e l'assert 2 è ciò che
 * impedisce al registro di diventare l'elenco delle scuse di ieri.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT_DIRS = ['scripts/ci', 'scripts/ci/lib', 'scripts/lib'];
const WORKFLOW_DIR = '.github/workflows';

/**
 * Estensioni ordinate dalla PIÙ LUNGA alla più corta.
 *
 * Non è cosmetica: l'alternanza regex è ordinata, quindi con `js` prima di
 * `json` il token `scripts/ci/loop-sync-manifest.json` viene troncato a
 * `...manifest.js` e segnalato come mancante. È successo al primo giro di
 * questo guard, su un file che esiste — un falso positivo prodotto dal
 * DETECTOR, che è il modo più veloce per far disattivare un check.
 */
const EXT = '(?:mjs|cjs|jsonc|json|js|ts|sh|yaml|yml)';
const REF_RE = new RegExp(
  `(?:\\.github|scripts|generator|bin)\\/[A-Za-z0-9._\\/*-]+\\.${EXT}(?![A-Za-z0-9])`,
  'g',
);

/**
 * Nome NUDO di workflow — `gh-pat-expiry-monitor.yml` senza cartella davanti.
 *
 * Non è un di più: è la forma in cui il caso della #45 era scritto. In
 * `alert-pat-down.mjs` il monitor è nominato tre volte, e **due su tre sono
 * nude**; solo una porta il path completo. Un guard che vedesse solo i path
 * completi avrebbe preso quel difetto per fortuna, non per costruzione — e la
 * fortuna è esattamente ciò che è mancato la prima volta. Su questo repo 97
 * citazioni nude risolvono: lasciarle fuori renderebbe il guard decorativo
 * proprio sulla classe di referente che si è rotta.
 *
 * Il lookbehind esclude ciò che ha già una cartella davanti (`.github/workflows/x.yml`
 * → preso da REF_RE, non due volte da qui) e i dotfile (`.prettierrc.yml`).
 */
const BARE_WORKFLOW_RE = /(?<![/A-Za-z0-9._-])([a-z0-9][a-z0-9-]*\.ya?ml)(?![A-Za-z0-9])/g;

/** Un token nudo si risolve nella cartella dei workflow; un path sta già dov'è. */
const resolveToken = (token) => (token.includes('/') ? token : `${WORKFLOW_DIR}/${token}`);

/**
 * Il registro delle assenze dichiarate. Chiave: `<file citante> :: <path citato>`.
 *
 * `kind`:
 *   `site-only`    — esiste sul sito, qui non ha corrispettivo, e la citazione è
 *                    DESCRITTIVA: niente di ciò che sta qui dipende dalla sua
 *                    esistenza. È la classe più affollata e la più pericolosa da
 *                    scegliere a cuor leggero: se qualcosa qui *dipende* dal
 *                    referente, non è questa.
 *   `renamed-here` — il file esiste anche qui, sotto un ALTRO path. `insteadOf`
 *                    lo indica ed è verificato.
 *   `example`      — placeholder di documentazione, non è un path reale da
 *                    nessuna parte.
 *   `data`         — il token NON è un riferimento: è un nome di file usato come
 *                    DATO (voce di una allow/deny-list). Non deve risolvere a
 *                    niente, qui o altrove.
 */
const DECLARED_ABSENT = {
  '.github/workflows/auto-merge-on-lgtm.yml :: scripts/load-rc-env.mjs': {
    kind: 'renamed-here',
    insteadOf: 'generator/scripts/load-rc-env.mjs',
    reason:
      'Citazione CONTRASTIVA: la riga nomina il path del sito per dire che qui il ponte RC ' +
      'non e\' quello. Il testo e\' corretto cosi\' com\'e\'; e\' il grep a non poterlo sapere.',
  },
  'scripts/ci/alert-pat-down.mjs :: scripts/load-rc-env.mjs': {
    kind: 'renamed-here',
    insteadOf: 'generator/scripts/load-rc-env.mjs',
    reason:
      'Il file e\' `identical` al sito e il path e\' giusto LA\'. Nel body della issue che ' +
      'apre, qui manda il lettore su un file inesistente: e\' un wart, non un guasto, e la ' +
      'correzione andrebbe fatta sul sito per non creare un corpus-ahead su un file ' +
      'dichiarato uguale.',
  },
  'scripts/ci/pr-autorebase.mjs :: .github/workflows/worktree-branch-janitor.yml': {
    kind: 'site-only',
    reason:
      'QUI IL LETTORE DELLA LABEL E\' UN ALTRO, ed e\' il punto da non perdere. Lo script ' +
      'applica `autorebase-reopen-failed` e dice che a risparmiare l\'head ref e\' il ' +
      'janitor, che su questo repo non esiste. La label NON e\' pero\' inerte: il suo ' +
      'lettore qui e\' il Gate 0 di `.github/workflows/recycle-stale-prs.yml`, l\'unico ' +
      'workflow che cancella branch su questo repo. Era una sostituzione taciuta, trovata a ' +
      'mano una volta e mai scritta da nessuna parte: e\' esattamente la classe di difetto ' +
      'che questo guard esiste per non far ripetere.',
  },
  'scripts/ci/followup-resolution-match.mjs :: scripts/ci/reconcile-followups.mjs': {
    kind: 'site-only',
    reason:
      'Il docstring dice «used by BOTH» elencando due consumatori: qui ne esiste solo uno ' +
      '(`check-issue-already-resolved.mjs`), quindi la frase e\' vera sul sito e imprecisa ' +
      'qui. Descrittiva: il matcher e\' puro e funziona identico con un solo chiamante — ' +
      'l\'assenza del passaggio advisory schedulato non rompe niente, toglie uno strato.',
  },
  '.github/workflows/publish-api.yml :: scripts/lib/deploy-it-pages-prep.sh': {
    kind: 'site-only',
    reason:
      'La riga dice esplicitamente «The site\'s own deploy»: cita il deploy del sito per ' +
      'motivare il `max-age=600` che questo job deve EGUAGLIARE. Il referente e\' altrove ' +
      'per costruzione.',
  },
  'scripts/ci/check-workflows-scope.mjs :: .github/workflows/foo.yml': {
    kind: 'example',
    reason: 'Placeholder in un docstring che mostra la forma della bullet-list «File di partenza».',
  },
  'scripts/lib/workflow-scope-detect.mjs :: scripts/create-article.mjs': {
    kind: 'renamed-here',
    insteadOf: 'generator/scripts/create-article.mjs',
    reason:
      'Citazione CONTRASTIVA, ed e\' il difetto stesso che il commento descrive: la vecchia ' +
      '`CODE_PATH_RE` ancorava con `\\b` sulla directory, quindi su un body che cita ' +
      '`generator/scripts/create-article.mjs` estraeva il SUFFISSO `scripts/create-article.mjs` — ' +
      'che qui non esiste, ed e\' esattamente il motivo per cui la pre-flight overlap del ' +
      'drainer (confronto `Set.has` esatto) non trovava mai un match su questo repo. Il path e\' ' +
      'nominato per dire che e\' SBAGLIATO: niente dipende dalla sua esistenza.',
  },
  'scripts/lib/workflow-scope-detect.mjs :: scripts/x.mjs': {
    kind: 'example',
    reason:
      'Placeholder: «la forma del sito `scripts/x.mjs` continua a matchare con zero segmenti ' +
      'di prefisso». Serve a dire che la meta\' che funziona non deve regredire.',
  },
  'scripts/lib/workflow-scope-detect.mjs :: scripts/foo.mjs': {
    kind: 'example',
    reason:
      'Placeholder, e per di piu\' estratto da una NON-citazione: il commento parla di ' +
      '`descripts/foo.mjs`, la stringa che il lookbehind `(?<![\\w.-])` esiste per NON far ' +
      'matchare. E\' lo scanner di questo guard a ritagliarne la coda, non il commento a citarla.',
  },
  'scripts/ci/check-workflows-scope.mjs :: .github/workflows/send-job-alerts.yml': {
    kind: 'site-only',
    reason: 'Cronaca dell\'incidente #4437 del sito, che motiva l\'euristica. Descrittiva.',
  },
  'scripts/ci/check-workflows-scope.mjs :: scripts/send-job-alerts.mjs': {
    kind: 'site-only',
    reason: 'Stessa cronaca #4437: dove viveva davvero la fix richiesta. Descrittiva.',
  },
  'scripts/ci/close-recovered-failure-issues.mjs :: scripts/generate-crawler-group-workflows.mjs': {
    kind: 'site-only',
    reason:
      'La consolidazione dei crawler-group e\' del sito; qui non esistono crawler group. ' +
      'Citata per spiegare perche\' i nomi dei workflow cambiano sotto i piedi.',
  },
  'scripts/ci/scan-failed-runs.mjs :: scripts/ci/report-validate-dist-failure.mjs': {
    kind: 'site-only',
    reason:
      'Citato come MODELLO: e\' il reporter di issue diagnostica ricca del sito, e i tre ' +
      'contratti che il rilevatore «articolo generato e perso» onora (dedup sul titolo, ' +
      'esclusione dal closer, path dei workflow nel body per il capability guard) sono ' +
      'documentati la\'. Descrittiva: qui non lo chiama nessuno e niente dipende dalla sua ' +
      'esistenza — il rilevatore e\' autonomo e testato da ' +
      '`generator/tests/scan-failed-runs-filter.test.mjs`.',
  },
  'scripts/lib/cf-analytics.mjs :: scripts/cf-status-report.mjs': {
    kind: 'site-only',
    reason: 'Elenco «chi consuma questo modulo»: consumatori del sito. Nessuna dipendenza qui.',
  },
  'scripts/lib/cf-analytics.mjs :: scripts/discover-404s-via-cloudflare.mjs': {
    kind: 'site-only',
    reason: 'Elenco «chi consuma questo modulo»: consumatori del sito. Nessuna dipendenza qui.',
  },
  'scripts/lib/cf-analytics.mjs :: scripts/build-cf-hot-404s.mjs': {
    kind: 'site-only',
    reason: 'Elenco «chi consuma questo modulo»: consumatori del sito. Nessuna dipendenza qui.',
  },
  'scripts/lib/secrets-scope-detect.mjs :: scripts/load-rc-env.mjs': {
    kind: 'renamed-here',
    insteadOf: 'generator/scripts/load-rc-env.mjs',
    reason:
      'File `identical`: la frase spiega quale loader richiede GOOGLE_APPLICATION_CREDENTIALS. ' +
      'Il meccanismo esiste anche qui, sotto `generator/scripts/`.',
  },
  'scripts/lib/secrets-scope-detect.mjs :: scripts/cf-status-report.mjs': {
    kind: 'site-only',
    reason:
      'Mappa categoria-issue → script che una fix vera dovrebbe toccare. Le categorie ' +
      'elencate (cloudflare-5xx, campaign-goal, posthog, generazione articoli) sono del ' +
      'sito: il modulo qui serve a RICONOSCERLE, non a eseguirle.',
  },
  'scripts/lib/secrets-scope-detect.mjs :: scripts/campaign-goal-check.mjs': {
    kind: 'site-only',
    reason: 'Stessa mappa categoria → script del sito. Descrittiva.',
  },
  'scripts/lib/secrets-scope-detect.mjs :: scripts/lib/posthog-client.mjs': {
    kind: 'site-only',
    reason: 'Stessa mappa categoria → script del sito. Descrittiva.',
  },
  'scripts/lib/secrets-scope-detect.mjs :: scripts/create-article.mjs': {
    kind: 'site-only',
    reason: 'Stessa mappa categoria → script del sito. Descrittiva.',
  },
  'scripts/ci/loop-drift-check.mjs :: scripts/lib/control-char-publish-gate.mjs': {
    kind: 'site-only',
    reason:
      'Citato nel docstring dell\'invariante di provenienza (issue #148) come l\'esempio ' +
      'canonico di baseline fantasma: e\' la meta\' SITO della coppia, registrata `not-ported` ' +
      'nel manifest apposta perche\' qui sarebbe la politica sbagliata (vedi la `reason` della ' +
      'voce nel manifest). Descrittiva: niente qui dipende dalla sua esistenza.',
  },

  // ── Nomi NUDI di workflow (risolti in .github/workflows/) ────────────────
  'scripts/lib/workflow-scope-detect.mjs :: lighthouserc.yml': {
    kind: 'data',
    reason:
      'Voce di una allow-list di file YAML che NON sono workflow, usata per non ' +
      'classificare come workflow-scope una modifica a un config qualsiasi. E\' un dato, ' +
      'non un riferimento: non deve esistere qui ne\' altrove.',
  },
  'scripts/lib/workflow-scope-detect.mjs :: pnpm-workspace.yml': {
    kind: 'data',
    reason: 'Stessa allow-list di YAML non-workflow in workflow-scope-detect.mjs. E\' un dato.',
  },
  'scripts/lib/workflow-scope-detect.mjs :: docker-compose.yml': {
    kind: 'data',
    reason: 'Stessa allow-list di YAML non-workflow in workflow-scope-detect.mjs. E\' un dato.',
  },
  'scripts/lib/workflow-scope-detect.mjs :: vitest.yml': {
    kind: 'data',
    reason: 'Stessa allow-list di YAML non-workflow in workflow-scope-detect.mjs. E\' un dato.',
  },
  'scripts/ci/check-workflows-scope.mjs :: refresh-thin-promotions.yml': {
    kind: 'site-only',
    reason: 'Cronaca di un caso del sito che motiva l\'euristica di questo modulo. Descrittiva.',
  },
  // NB: la voce `persist-job-stats.yml` di questo stesso file e' stata rimossa nel
  // riallineamento del 2026-08-14 (issue #234): il sito ha riscritto quel docstring
  // (#5437 — i tre workflow costruiscono ora il titolo da `${{ github.workflow }}`),
  // e la citazione non esiste piu'. Il test «nessuna dichiarazione morta» l'ha vista.
  'scripts/ci/close-recovered-failure-issues.mjs :: scripts/ci/failure-issue-inventory.mjs': {
    kind: 'site-only',
    reason:
      'Sostituisce la citazione di `persist-job-stats.yml` che il sito ha riscritto con #5437. ' +
      'Il docstring dice che il conteggio dei workflow dal titolo non risolvibile e\' ora ' +
      'MISURATO da `node scripts/ci/failure-issue-inventory.mjs --json` e fissato come ' +
      'baseline shrink-only in `tests/failure-issue-closers.test.ts`: due strumenti del SITO, ' +
      'entrambi assenti qui. La citazione e\' descrittiva — questo reconciler non invoca ' +
      'l\'inventario, ne\' legge quella baseline: racconta come il sito ha chiuso la stessa ' +
      'domanda. Nota per chi porta: il baseline citato e\' EMPTY, quindi non c\'e\' un dato ' +
      'da replicare qui, solo una misura da rifare se un giorno servisse.',
  },
  'scripts/ci/followup-drainer.mjs :: compress-contract-docs.yml': {
    kind: 'site-only',
    reason:
      'L\'UNICA delle sei arrivate col riallineamento #234 che non sia prosa: qui sotto c\'e\' ' +
      'codice vivo, `detectCompressContractDocsRatchet(title)`, che confronta il titolo con la ' +
      'costante letterale `COMPRESS_CONTRACT_DOCS_TITLE` per esentare quella issue dal ' +
      'promote/age-out. Il workflow che quel titolo lo EMETTE sta solo sul sito, quindi qui il ' +
      'detector non matcha mai e resta inerte. Dichiarato `site-only` e non lasciato scoperto ' +
      'perche\' la domanda del guard («qualcosa qui DIPENDE della sua esistenza?») ha risposta ' +
      'NO in senso stretto: un filtro che non matcha lascia la issue al trattamento normale, ' +
      'che e\' esattamente il comportamento del corpus prima di questa copia — non si perde ' +
      'nessuna protezione, perche\' non c\'e\' niente da proteggere. Se un giorno questo repo ' +
      'adottasse il ratchet sui propri contract doc (AGENTS.md/REVIEW.md/ISSUES.md/FOLLOWUP.md ' +
      'ci sono tutti), il workflow va portato E questa voce va tolta.',
  },
  'scripts/ci/mint-app-token.mjs :: .github/workflows/hydrated-article-parity.yml': {
    kind: 'site-only',
    reason:
      'Citazione dentro un messaggio di errore riportato VERBATIM: il `remote rejected` della ' +
      'issue #5280 del sito, che nomina il workflow che il push dell\'App non poteva scrivere. ' +
      'E\' cronaca dell\'incidente che motiva `APP_TOKEN_WORKFLOWS`, non un referente. Su questo ' +
      'repo l\'intero meccanismo e\' inerte per un\'altra ragione ancora: non c\'e\' GitHub App, ' +
      'lo script warn-exit, e i workflow qui spingono con GITHUB_PAT_NANAKO.',
  },
  'scripts/ci/scan-job-timeouts.mjs :: deploy-publish.yml': {
    kind: 'site-only',
    reason:
      'Cronaca della run 31672320271 del sito (#5773/#5772/#5771), che motiva la firma B ' +
      '(host-kill) di questo scanner: la riga spiega perche\' il leg morto era invisibile, ' +
      'visto che `deploy-publish.yml` e\' gated su `workflow_run.conclusion == success`. ' +
      'Descrittiva: la firma B e\' generica e non conosce nessun workflow per nome. La catena ' +
      'di pubblicazione di questo repo e\' `publish-api.yml`, che non c\'entra con quella.',
  },
  'scripts/lib/workflow-scope-detect.mjs :: .github/workflows/content-grounding-audit.yml': {
    kind: 'example',
    reason:
      'NON e\' `site-only`: verificato, quel path non esiste nemmeno sul sito (404 su main). ' +
      'E\' una bullet copiata verbatim dal CORPO della issue #5595 come fixture del difetto ' +
      '— un workflow soltanto PIANIFICATO, e la bullet stessa dice «SE il processo risiede ' +
      'nel repository». Un path immaginato in un piano, citato per mostrare la forma di testo ' +
      'su cui `CODE_PATH_RE` sbagliava: non deve risolvere da nessuna parte.',
  },
  'scripts/lib/workflow-scope-detect.mjs :: .github/workflows/post-deploy-validate-dist.yml': {
    kind: 'site-only',
    reason:
      'Fixture citata per delimitare cio\' che #5595 NON ha cambiato: la issue #1607 del sito ' +
      '(«in `.github/workflows/post-deploy-validate-dist.yml`, allargare il guard») resta il ' +
      'caso che deve continuare a bloccare. Il workflow esiste sul sito e li\' e\' coperto da ' +
      'un test; qui la citazione e\' descrittiva e il rilevatore resta repo-agnostico.',
  },
  'scripts/lib/github-issue-creator.mjs :: orchestrate-crawlers.yml': {
    kind: 'site-only',
    reason: 'L\'orchestratore dei crawler e\' del sito; qui non esistono crawler. Descrittiva.',
  },
  'scripts/lib/secrets-scope-detect.mjs :: evergreen-refresh-audit.yml': {
    kind: 'site-only',
    reason: 'Stessa mappa categoria-issue → workflow del sito. Descrittiva.',
  },
  '.github/workflows/auto-merge-engine-lockstep.yml :: mirror-articles-engine.yml': {
    kind: 'site-only',
    reason:
      'E\' il workflow del SITO che apre qui la PR `engine-lockstep-auto` — la riga lo dice ' +
      'esplicitamente («nel repo del sito»). Il verso della discesa e\' quello: il mirror sta ' +
      'di la\', l\'auto-merge di qua.',
  },
  '.github/workflows/batch-faq-articles.yml :: mirror-articles-corpus.yml': {
    kind: 'site-only',
    reason:
      'Il mirror del corpus vive sul sito ed e\' dispatch-only, in via di cancellazione. ' +
      'Citato come precedente di un modo di fallire, non come dipendenza.',
  },
  '.github/workflows/generate-article.yml :: sync-articles-sitemaps.yml': {
    kind: 'site-only',
    reason:
      'Il consumatore a valle, sul SITO: e\' il workflow che riceve il ' +
      '`repository_dispatch: articles-published` e che, in piu\', ha un cron 2x/giorno come ' +
      'rete di sicurezza. La riga lo cita per argomentare perche\' la guardia in ' +
      '`publish-api.yml` da sola non basta — quella ferma l\'annuncio, ma NON il commit, e ' +
      'quel cron potrebbe portare un articolo gia\' su main al sito comunque, in ritardo. ' +
      'E\' una citazione descrittiva: niente qui lo invoca ne\' dipende dalla sua esistenza, ' +
      'e il guard nel percorso di scrittura funziona identico se di la\' quel workflow ' +
      'venisse rinominato o rimosso — nel qual caso l\'argomento diventerebbe piu\' debole, ' +
      'non sbagliato.',
  },
  // Gli altri tre produttori del corpus citano lo stesso consumatore a valle,
  // per lo stesso argomento e nella stessa forma: la guardia sul percorso di
  // scrittura serve PERCHE' quel cron del sito puo' portare al sito un articolo
  // gia' su main senza aspettare il `repository_dispatch`. Vedi la voce di
  // `generate-article.yml` sopra — nessuno di questi lo invoca.
  '.github/workflows/publish-journalist-articles.yml :: sync-articles-sitemaps.yml': {
    kind: 'site-only',
    reason:
      'Citazione descrittiva, gemella di quella in generate-article.yml: argomenta perche\' il ' +
      'preflight di publish-api.yml (che ferma l\'ANNUNCIO) non sostituisce la guardia prima del ' +
      'commit (che ferma la SCRITTURA). Niente qui lo invoca, e la guardia funziona identica se ' +
      'di la\' venisse rinominato.',
  },
  '.github/workflows/generate-daily-brief.yml :: sync-articles-sitemaps.yml': {
    kind: 'site-only',
    reason:
      'Idem: la riga spiega perche\' un\'edizione committata sopra un corpus sporco arriverebbe al ' +
      'sito col cron 2x/giorno anche senza dispatch. Descrittiva, non una dipendenza.',
  },
  '.github/workflows/generate-border-wait-ranking-weekly.yml :: sync-articles-sitemaps.yml': {
    kind: 'site-only',
    reason:
      'Idem: stessa argomentazione sul digest evergreen, che dopo la prima registrazione scrive ' +
      'sempre fuori da registerArticleFiles(). Descrittiva, non una dipendenza.',
  },
  '.github/workflows/post-merge-followup.yml :: followup-reconcile.yml': {
    kind: 'site-only',
    reason:
      'Citato come PATTERN da imitare («Pattern = followup-reconcile.yml»), non come ' +
      'workflow da invocare: e\' un riferimento di progetto, e il workflow vive sul sito.',
  },
  '.github/workflows/refresh-events-digest.yml :: crawl-events.yml': {
    kind: 'site-only',
    reason:
      'La riga dice «the site repo\'s crawl-events.yml»: nomina la sorgente da cui UNO step ' +
      'e\' migrato qui (issue #4974). Il referente resta di la\' per costruzione.',
  },
  '.github/workflows/fast-publish-article.yml :: scripts/wait-for-live-article-shards.mjs': {
    kind: 'site-only',
    reason:
      'La meta\' sul sito della stessa pipeline: e\' la sonda di liveness che questo gate ' +
      'reimplementa in shell per gli shard che pusha questo repo. La riga la cita come ' +
      'PRECEDENTE del cache-bust `_fpcb` (issue #114) — «non e\' un nome nuovo, e\' quello ' +
      'che usa gia\' di la\'» — non come qualcosa che questo workflow invoca. Nulla qui ' +
      'dipende dalla sua esistenza: il gate gira per intero con curl e jq.',
  },
  '.github/workflows/fast-publish-article.yml :: scripts/lib/live-link-check.mjs': {
    kind: 'site-only',
    reason:
      'Il modulo del sito sotto wait-for-live-article-shards.mjs, citato nella stessa frase ' +
      'e per la stessa ragione: e\' li\' che vive `checkLink` col suo `_=<epoch>`. ' +
      'Descrittiva — nominare dove sta l\'altra meta\' e\' cio\' che rende ricontrollabile ' +
      'l\'affermazione «il porting ha perso il bust», non una dipendenza.',
  },
};

const KINDS = new Set(['site-only', 'renamed-here', 'example', 'data']);
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

function sourceFiles() {
  const out = [];
  for (const d of SCRIPT_DIRS) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) if (f.endsWith('.mjs')) out.push(path.join(d, f));
  }
  const wf = path.join(ROOT, WORKFLOW_DIR);
  if (fs.existsSync(wf)) {
    for (const f of fs.readdirSync(wf)) if (/\.ya?ml$/.test(f)) out.push(path.join(WORKFLOW_DIR, f));
  }
  return out.sort();
}

/**
 * Tutte le citazioni, risolte e no. Deduplicate per coppia (citante, citato):
 * lo stesso path nominato tre volte nello stesso file è UNA cosa da decidere,
 * non tre.
 */
function collectCitations() {
  const cited = new Map(); // key -> {from, token, resolved, line}
  for (const rel of sourceFiles()) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    src.split('\n').forEach((line, i) => {
      const tokens = [
        ...[...line.matchAll(REF_RE)].map((m) => m[0]),
        ...[...line.matchAll(BARE_WORKFLOW_RE)].map((m) => m[1]),
      ];
      for (const token of tokens) {
        // Glob e placeholder non sono path: `scripts/lib/**`, `<nome>.yml`,
        // `${{ github.workflow }}.yml` non si risolvono e non devono.
        if (token.includes('*') || token.includes('<') || token.includes('$')) continue;
        const key = `${rel} :: ${token}`;
        if (!cited.has(key)) cited.set(key, { from: rel, token, resolved: resolveToken(token), line: i + 1 });
      }
    });
  }
  return cited;
}

test('ogni path citato dagli script del ciclo esiste, o la sua assenza è dichiarata', () => {
  const cited = collectCitations();
  assert.ok(cited.size > 0, 'nessuna citazione trovata: SCRIPT_DIRS/REF_RE sono sbagliati?');

  const undeclared = [];
  for (const [key, c] of cited) {
    if (exists(c.resolved)) continue;
    if (DECLARED_ABSENT[key]) continue;
    undeclared.push(`${c.from}:${c.line} → ${c.token}${c.token === c.resolved ? '' : ` (cercato in ${c.resolved})`}`);
  }

  assert.deepEqual(
    undeclared,
    [],
    'Path CITATI ma inesistenti, e non dichiarati.\n\n' +
      'Un riferimento che non è un import non è coperto da nessun altro guard: è così che\n' +
      '`alert-pat-down.mjs` è arrivato qui promettendo che `gh-pat-expiry-monitor.yml`\n' +
      'avrebbe chiuso il suo alert, con quel workflow assente e la CI verde (#45).\n\n' +
      'La domanda da farsi NON è «esiste?» ma «qualcosa qui DIPENDE dalla sua esistenza?».\n' +
      '  - Sì  → è la classe della #45. Porta il referente, o riscrivi l\'affermazione.\n' +
      '          Non esiste un `kind` per dichiararlo: sarebbe scrivere che va bene.\n' +
      '  - No  → dichiaralo in DECLARED_ABSENT con `kind` + `reason`.\n\n' +
      `  ${undeclared.join('\n  ')}`,
  );
});

test('il registro delle assenze dichiarate è ben formato', () => {
  const bad = [];
  for (const [key, d] of Object.entries(DECLARED_ABSENT)) {
    if (!key.includes(' :: ')) bad.push(`${key}: chiave senza separatore ' :: '`);
    if (!KINDS.has(d.kind)) bad.push(`${key}: kind '${d.kind}' non è uno di ${[...KINDS].join('|')}`);
    // Una ragione di due parole non è una decisione, è un timbro.
    if (!d.reason || d.reason.length < 40) bad.push(`${key}: manca una ragione scritta (>=40 caratteri)`);
    if (d.kind === 'renamed-here' && !d.insteadOf) bad.push(`${key}: 'renamed-here' richiede insteadOf`);
    if (d.kind !== 'renamed-here' && d.insteadOf) bad.push(`${key}: insteadOf ha senso solo per 'renamed-here'`);
  }
  assert.deepEqual(bad, [], `Voci malformate in DECLARED_ABSENT:\n  ${bad.join('\n  ')}`);
});

test("una dichiarazione 'renamed-here' deve indicare un file che esiste davvero qui", () => {
  // È l'assert che dà denti alla classe più ambigua: dire «esiste, ma altrove»
  // è una promessa verificabile, e se il corrispettivo locale si sposta questa
  // rompe invece di restare una frase vera solo il giorno in cui fu scritta.
  const broken = [];
  for (const [key, d] of Object.entries(DECLARED_ABSENT)) {
    if (d.kind !== 'renamed-here') continue;
    if (!exists(d.insteadOf)) broken.push(`${key}: insteadOf '${d.insteadOf}' non esiste`);
  }
  assert.deepEqual(broken, [], `insteadOf non risolti:\n  ${broken.join('\n  ')}`);
});

test('nessuna dichiarazione stale: se il file dichiarato assente ora esiste, la voce va rimossa', () => {
  const stale = [];
  for (const key of Object.keys(DECLARED_ABSENT)) {
    const token = key.split(' :: ')[1];
    if (!token) continue;
    const target = resolveToken(token);
    if (exists(target)) stale.push(`${key} — '${target}' ORA esiste`);
  }
  assert.deepEqual(
    stale,
    [],
    'Il file è stato portato ma la dichiarazione di assenza è rimasta. Rimuovila: una\n' +
      'dichiarazione che sopravvive al suo motivo è un buco silenzioso per il prossimo\n' +
      `porting, che vedrà il path già «giustificato».\n  ${stale.join('\n  ')}`,
  );
});

test('nessuna dichiarazione morta: ogni voce deve corrispondere a una citazione reale', () => {
  // Senza questo, il registro diventa l'elenco delle scuse di ieri: voci che non
  // proteggono più niente ma continuano a coprire il path se qualcuno lo ricita.
  const cited = collectCitations();
  const dead = Object.keys(DECLARED_ABSENT).filter((k) => !cited.has(k));
  assert.deepEqual(
    dead,
    [],
    `Voci di DECLARED_ABSENT che nessun file cita più — vanno rimosse:\n  ${dead.join('\n  ')}`,
  );
});
