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
 * POSIZIONE, non solo forma (2026-09-05). Il delimitatore da solo non basta, e la
 * terza variante della classe e' stata misurata proprio qui: sulla PR #909 una
 * review con `## Findings (Important: 0, Nit: 3)` e `## LGTM` regolari CITAVA un
 * marker dentro il testo di un proprio nit — «... 🟡 Nit: ... Verificato:
 * «🔴 Important: il path non gestito raggiunge `parsePath` e il router.» →
 * stripped ...» — e il review gate rendeva ROSSA una PR approvata. Il marker
 * citato porta i due punti come quello vero, quindi il rimedio di #3330
 * (pretendere la punteggiatura dopo "Important") non lo vede.
 *
 * Cio' che distingue un marker da una citazione non e' il vocabolario ma la
 * POSIZIONE NELLA STRUTTURA: il marker APRE la riga del proprio finding (al piu'
 * preceduto da una location label — `- `, `` `path.mjs:L12`: ``), mentre una
 * citazione sta DENTRO una riga che ha gia' aperto un ALTRO finding, oppure dentro
 * un code span. Da qui le due clausole, entrambe strutturali e non lessicali:
 *
 *   1. `^[^\n🟡🟢❓]*` — sulla stessa riga, prima del marker, nessun glifo di
 *      severita' PIU' BASSA: se la riga ha gia' aperto un 🟡/🟢/❓, il 🔴 che segue
 *      e' testo riportato, non il verdetto della riga. `🔴` NON e' escluso, di
 *      proposito: un 🔴 decorativo prima del marker non deve poterlo nascondere —
 *      dove la regola e' incerta si sbaglia in direzione ROSSA.
 *   1-bis. `|(?:[^\n`«]|`[^\n`]*`)*[🟡🟢❓](?:[^\n`«]|`[^\n`]*`)*` — la clausola 1 da
 *      sola era l'UNICA
 *      direzione in cui questa regex poteva SPEGNERE il gate, contro il principio
 *      appena dichiarato (#977): `… 🟡 Nit: x. 🔴 Important: y` — due finding sulla
 *      STESSA riga — diventava verde, e con un `## LGTM` la PR si mergiava con un
 *      🔴 aperto. Il reviewer viola «una riga per finding» (REVIEW.md → Output
 *      format), ma un marker vero non puo' sparire per una violazione di FORMA. Il
 *      ramo lo riammette quando fra il glifo precedente e il 🔴 non c'e' nessun
 *      apri-citazione: ne' un `«` ne' un code span APERTO (uno CHIUSO — `` `x` `` —
 *      e' prosa normale e viene attraversato). Nel caso #909 la citazione ha
 *      entrambi, quindi resta verde. Sotto quel ramo la citazione non marcata come
 *      tale (`🟡 Nit: la review diceva 🔴 Important: x`, senza «» ne' backtick)
 *      torna ROSSA: e' il verso giusto in cui sbagliare, ed e' la forma che
 *      REVIEW.md non produce.
 *
 *      Il prefisso PRIMA del glifo e' lo stesso attraversamento di quello dopo, e
 *      non un `.*` (#1106). Con `.*` il glifo-ancora poteva stare DENTRO una
 *      citazione, e da li' il controllo di apri-citazione non vedeva piu' il
 *      backtick (o l'`«`) che l'aveva aperta: una riga come
 *      `🟡 Nit: verificato che ``Due 🟡 nit, nessun 🔴 Important — merge libero.`` era
 *      false` tornava ROSSA pur non avendo nessun marker. Misurato sulla review di
 *      questa stessa PR, che portava `## Findings (Important: 0, Nit: 3)` e
 *      `## LGTM` e veniva comunque respinta da `review-gate.mjs`. Il prefisso
 *      attraversa come UNITA' cio' che e' gia' chiuso — code span `` `x` `` e
 *      citazioni `«x»` — e si ferma solo su una citazione APERTA, quindi un glifo
 *      citato non puo' piu' fare da ancora, in entrambe le forme di citazione.
 *
 *      Le due eccezioni sono cio' che tiene il ramo dalla parte del rosso (#1106,
 *      round 2). (a) Una citazione CHIUSA si attraversa invece di fermare
 *      l'attraversamento: fermarsi li' perdeva il glifo-ancora e un marker VERO
 *      dopo la citazione tornava verde — `- 🟢 ok. Il body dice «x». 🟡 Nit: a.
 *      🔴 Important: b`. (b) Un backtick che sulla riga non ha un compagno
 *      (`` `(?![^\n`]*`) ``) non apre nulla: e' la location label idiomatica di
 *      REVIEW.md, `` `a.mjs:L1: `` mai chiusa, e fermarcisi spegneva il gate su
 *      `` - `a.mjs:L1: 🟡 Nit: a. 🔴 Important: b ``. Un backtick che il compagno
 *      ce l'ha resta un apri-span e continua a bloccare: e' quello che tiene
 *      verde il falso rosso di #1106 (`` `Due 🟡 nit, nessun 🔴 Important` ``).
 *      Il ramo resta cio' che intendeva ammettere: un secondo finding VERO sulla
 *      stessa riga. L'alternanza resta senza punti di scelta — le alternative
 *      sono disgiunte sul primo carattere, e le due che aprono con un backtick si
 *      escludono a vicenda sul lookahead — quindi il lead non backtracka come
 *      faceva `.*[🟡🟢❓]`.
 *   2. `(?<!\s\`)(?<!^\`)` — il marker incollato a un backtick sta dentro un code
 *      span solo se quel backtick APRE lo span, cioe' e' a inizio riga o preceduto
 *      da spazio: `` `🔴 Important: x` `` e' una fixture citata. Il backtick che
 *      CHIUDE una location label — `` `a.mjs:L1`🔴 Important: y ``, label incollata
 *      al glifo — e' preceduto da un non-spazio, ed e' un marker VERO: il
 *      `(?<!\`)` di prima, che guardava un solo carattere senza distinguere apri
 *      da chiudi, lo spegneva in silenzio (#977). Il finding interamente dentro un
 *      code span (`` `file:L1: 🔴 Important: …` ``, la forma degli esempi di
 *      REVIEW.md) resta rosso: li' il backtick non e' incollato al glifo.
 *
 * Il conteggio dichiarato `## Findings (Important: N)` NON e' un ingresso del gate,
 * di proposito: su 172 review bot reali dei due repo c'e' su 170/172, e soprattutto
 * potrebbe spostare il verdetto solo da rosso a VERDE — un reviewer che scrive
 * `Important: 0` e poi un 🔴 vero spegnerebbe il gate. Resta l'oracolo indipendente
 * del test (`generator/tests/redflag-important-marker.test.mjs`).
 *
 * Misura: sulle stesse 172 review il verdetto cambia su UNA sola, la #909; gli
 * altri 54 corpi con un marker vero restano rossi e nessuno passa da verde a rosso.
 * Le due aggiunte del 2026-09-06 non toccano quella misura per costruzione: la 2
 * si applica solo a un marker INCOLLATO a un backtick e la 1-bis solo a una riga
 * che ha gia' aperto un altro finding — due forme che in quel campione non
 * compaiono — ed entrambe muovono il verdetto da verde a ROSSO, mai al contrario.
 * Gemello del sito: `scripts/ci/lib/constants.mjs` in valerielinc-ops/frontaliere-si-o-no
 * (`mode: adapted` nel manifest, quindi la modifica si fa qui e non scende dal mirror).
 *
 * NB: il preflight di `pr-redflag-fixer.yml` e la Classe B di
 * `stale-pr-rescuer.yml` grepano la STESSA forma in bash — un `if:`/`run:` YAML non
 * puo' importare questa regex. `grep` e' gia' orientato alla riga, quindi il pattern
 * bash e' questa `.source` senza i `\n` delle classi negate:
 * `grep -qP '^(?:[^🟡🟢❓]*|(?:[^`«]|`[^`]*`|«[^»]*»|`(?![^`]*`))*[🟡🟢❓](?:[^`«]|`[^`]*`|«[^»]*»|`(?![^`]*`))*)(?<!\s\`)(?<!^\`)🔴\s*\*{0,2}\s*Important\s*\*{0,2}\s*[:—-]'`.
 * I due lookbehind sono a lunghezza fissa, quindi PCRE1 (`grep -P`) li accetta —
 * uno solo, `(?<!(?:^|\s)\`)`, sarebbe a lunghezza variabile e li' non compila.
 * Le tre copie non possono piu' divergere in silenzio: il guard `mirror bash` di
 * `generator/tests/redflag-important-marker.test.mjs` deriva il pattern atteso da
 * questa `.source` e lo pretende, verbatim, in entrambi i workflow.
 */
export const REDFLAG_IMPORTANT_RE = /^(?:[^\n🟡🟢❓]*|(?:[^\n`«]|`[^\n`]*`|«[^\n»]*»|`(?![^\n`]*`))*[🟡🟢❓](?:[^\n`«]|`[^\n`]*`|«[^\n»]*»|`(?![^\n`]*`))*)(?<!\s`)(?<!^`)🔴\s*\*{0,2}\s*Important\s*\*{0,2}\s*[:—-]/mu;

/**
 * File la cui modifica impedisce STRUTTURALMENTE al reviewer Claude di girare
 * sulla PR → niente `## LGTM` → l'auto-merge normale non scatta → senza fallback
 * la PR resta ferma in attesa di un merge manuale.
 *
 * È SOLO `tests.yml`, perché dal 2026-09-03 è LÌ che vive la Claude review: la
 * GitHub App del reviewer esige che il workflow file in esecuzione sia
 * byte-identico alla versione su `main` (`Workflow validation failed. 401`). Una
 * PR che lo MODIFICA ha per definizione un contenuto diverso da main → 401 →
 * nessun `## LGTM` postato.
 *
 * ── ATTENZIONE, questa costante ha cambiato REFERENTE, non solo nome ────────
 * Prima puntava al workflow di review dedicato, che girava su `workflow_run` e
 * quindi eseguiva SEMPRE la versione di `main`: una PR che lo modificava non
 * mandava in 401 la propria review, e il drift-fallback serviva solo al caso
 * limite. Ora il reviewer gira su `pull_request`, cioè sulla versione DEL
 * BRANCH: la 401 su una PR che tocca `tests.yml` non è più un caso limite, è la
 * norma. Se questa lista non segue il file che ospita la review, ogni PR sul CI
 * resta ferma per sempre senza che niente diventi rosso.
 *
 * Gli altri file storicamente citati come "merge manuale"
 * (`post-merge-followup.yml`, `REVIEW.md`, `FOLLOWUP.md`) NON driftano: il
 * reviewer gira e posta `## LGTM` normalmente (`post-merge-followup` per giunta
 * gira su `pull_request: closed`, post-merge → non gatekeepa il merge). Tenere
 * la lista MINIMA limita la superficie "merge senza review Claude" del fallback.
 *
 * Usato da `review-gate.mjs` e `auto-merge-eval.mjs` (drift-fallback: gate
 * deterministici al posto dell'`## LGTM` mancante). Se in futuro un altro
 * workflow su `pull_request` inizia a invocare il claude-code-action,
 * aggiungilo qui.
 */
export const REVIEW_WORKFLOW_DRIFT_FILES = ['.github/workflows/tests.yml'];

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

/**
 * Login dei bot le cui review valgono come VERDETTO del reviewer.
 *
 * Prefisso, non uguaglianza: la stessa App si presenta come
 * `frontaliere-automation[bot]` sui webhook/REST e come
 * `frontaliere-automation` in GraphQL (vedi `followup-drainer.mjs`,
 * `BOT_COMMENT_LOGINS`), e `claude` arriva sia nudo sia come `claude[bot]`.
 * Un match ancorato in coda leggerebbe zero review su uno dei due canali —
 * cioè un gate che decide su un insieme VUOTO senza dirlo.
 *
 * Perché due login e non uno: dal momento in cui il trigger di
 * `pr-redflag-fixer.yml` accetta una review dell'App bot, ogni CONSUMER della
 * stessa review deve accettarla, o le due direzioni sbagliano in silenzio:
 * un `🔴 Important` dell'App bot invisibile ad `auto-merge-eval.mjs` →
 * merge con un 🔴 aperto; il suo `## LGTM` invisibile a `review-gate.mjs` →
 * check richiesto mai verde, PR ferma per sempre senza errore. Stessa classe
 * per `pr-autorebase.mjs` (nessuna review vista → close+reopen a vuoto) e per
 * il bundle del 🔴-fixer (findings di un round già chiuso).
 *
 * Sorgente UNICA anche per il lato bash: uno `run:` YAML non può importare
 * questa regex, quindi i `--jq` dei workflow usano `REVIEWER_BOT_LOGIN_JQ`,
 * derivato da questa `.source`, e il guard
 * `generator/tests/reviewer-bot-login.test.mjs` lo pretende verbatim nei
 * workflow che filtrano le review.
 */
export const REVIEWER_BOT_LOGIN_RE = /^(claude|frontaliere-automation)/i;

/** Il filtro sopra come predicato jq, per i `--jq` dei workflow. */
export const REVIEWER_BOT_LOGIN_JQ = `test("${REVIEWER_BOT_LOGIN_RE.source}";"i")`;
