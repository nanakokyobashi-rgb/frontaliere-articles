#!/usr/bin/env node
/**
 * scan-generation-health.mjs — apre (e richiude) una issue quando la pipeline
 * di generazione articoli è ROTTA MA VERDE.
 *
 * ## Il difetto che copre, che non è un fallimento
 *
 * `scan-failed-runs.mjs` — il fratello di questo script, da leggere per primo —
 * filtra su `conclusion == failure`. È il filtro giusto per ciò che sorveglia, e
 * per costruzione non può vedere la classe di guasti diagnosticata il
 * 2026-08-10: cinque difetti indipendenti della generazione, TUTTI su run uscite
 * `success`, con lo step Summary che diceva `Generated: true` mentre il log
 * diceva «Push prosegue senza nuovo articolo». Il proprietario se n'è accorto
 * guardando il SITO e notando che uscivano solo articoli evergreen, a coppie,
 * sulla stessa città. Nessun canale automatico lo diceva.
 *
 * `generate-article.yml` esce 0 di proposito quando non produce nulla, ed è
 * corretto: un run senza articolo è un esito normale (`set +e` esplicito nello
 * step, con un commento che spiega perché). Il difetto non è nel singolo run —
 * è nella SERIE. Da qui la forma di questo scanner: nessuna condizione guarda un
 * run, tutte guardano una finestra.
 *
 * ## Perché centrale, e non uno step dentro generate-article.yml
 *
 * Lo stesso ragionamento di `scan-failed-runs.mjs`, che vale identico qui e per
 * una ragione in più. Le due dello scanner dei fallimenti: (a) i workflow di
 * generazione sono il core operativo di questo repo e non vanno modificati per
 * ospitare una preoccupazione che non è la loro; (b) un workflow nuovo
 * nascerebbe scoperto. La terza, specifica: **un run non può diagnosticare se
 * stesso**. Ogni condizione qui è un rapporto fra run diversi — «tutte le run
 * della sezione X per N ore», «la quota di run che svuotano il pool» — e nessuno
 * step dentro un run ha quel denominatore.
 *
 * ## Le sorgenti, tutte già emesse (nessun file della pipeline è stato toccato)
 *
 *  1. **I titoli dei commit su `main`.** `generate-article.yml` distingue già
 *     onestamente ciò che ha prodotto: `Generate blog article (<sezione>)` vs
 *     `Record rejected topic candidates (<sezione> — no article generated)`.
 *     Una sola chiamata API per 100 commit, e dà sezione + istante.
 *  2. **I marker nei log delle run**, machine-readable e già in produzione:
 *       `event=<e> chain=<c> → section=<s> dry_run=<d>`  (generate-article.yml)
 *       `PRESPEND_GATE_OUTCOME emptied=… recovered=… status=… section=…`
 *       `PRESPEND_GATE_TOTAL_REJECTION before=… anchor_candidates=… section=…`
 *       `⏭️  [<modello>] Skipped — request would exceed <N>-token limit (estimated <M>)`
 *       `⚠️  Tutte le keyword evergreen risultano già coperte dal pre-flight.`
 *  3. **Il corpus del checkout** (`content/*-articles-data.ts` +
 *     `content/blog-meta*-it.ts`), per le coppie di articoli sullo stesso
 *     argomento. Zero rete.
 *
 * ## Il criterio di taratura: anomalo, non normale
 *
 * Ogni soglia qui sotto è MISURATA sullo storico reale, e la misura è scritta
 * accanto alla costante. Il criterio è duplice e va letto insieme:
 *  - la condizione deve essere FALSA nella normalità osservata (altrimenti è
 *    rumore quotidiano, che si impara a ignorare — e allora tanto vale non
 *    averla);
 *  - deve essere VERA sui guasti realmente accaduti (altrimenti è silenzio,
 *    che è dove eravamo).
 * Dove le due cose non erano separabili con una soglia sola, la condizione NON
 * è stata aperta — vedi la sezione qui sotto.
 *
 * ## Cosa NON viene sorvegliato, e perché
 *
 *  · **La morte della catena self-trigger.** È il terzo dei cinque guasti
 *    diagnosticati, e non ha una condizione propria di proposito. La catena si
 *    innesca su un push che tocca `content/**`, e un anello che non produce
 *    nulla non lo tocca: fermarsi è il suo STOP DESIGNATO, non un difetto
 *    (`generate-article.yml` lo argomenta per esteso — è la differenza voluta
 *    dalla versione del sito, che si auto-dispatchava e con un generatore
 *    fast-failing girava a vuoto). L'unico esito osservabile del guasto è che la
 *    sezione smette di pubblicare, che è esattamente `section-dry`. Una
 *    condizione sulla «quota di run innescate dalla catena» avrebbe la stessa
 *    causa, la stessa cura e nessuna soglia difendibile — perché quella quota
 *    varia legittimamente con la produttività (misurata: 70% delle invocazioni
 *    il 2026-08-01, 47% nelle ultime 34 ore).
 *
 *  · **Il singolo run senza articolo.** È l'esito normale che il workflow
 *    dichiara esplicitamente. Sorvegliarlo produrrebbe decine di segnali al
 *    giorno: nella finestra misurata, 32 run su 129 (25%) non hanno prodotto
 *    nulla, e nella quasi totalità dei casi la run successiva ha prodotto.
 *
 *  · **I fallimenti veri delle run.** Sono già di `scan-failed-runs.mjs`, che
 *    ha il suo gate sui fallimenti consecutivi. Duplicarli qui vorrebbe dire due
 *    issue per lo stesso guasto, su due canali con due criteri di chiusura.
 *
 *  · **La pausa globale per quota LLM.** `generation-idle` la vede, ma nel
 *    corpo dell'issue è dichiarata come PRIMA cosa da guardare invece che come
 *    diagnosi, perché non è un difetto di questo repo e ha già il suo beacon.
 *    Una condizione separata «quota esaurita» richiederebbe di leggere lo stato
 *    dei provider, che è una sorgente che questo scanner non ha.
 *
 *  · **La qualità del contenuto pubblicato.** Fuori portata per costruzione: la
 *    coprono i gate di generazione (fedeltà alle fonti, wordcount, microcopy) e
 *    le loro suite. Qui si sorveglia la PRODUZIONE, non il prodotto — con
 *    l'unica eccezione di `duplicate-topic-burst`, che è un guard di regressione
 *    su un gate esistente e non un giudizio di qualità.
 *
 * ## Aprire e chiudere sono la STESSA passata, e non è un dettaglio
 *
 * `alert-pat-down.mjs` è arrivato in questo repo dichiarando in un commento che
 * un certo workflow era «l'unico punto di chiusura» del suo alert — e quel
 * workflow non esisteva (#45). La issue `priority:urgent` che apriva non poteva
 * essere chiusa da niente, e col dedup sul titolo sarebbe restata accesa per
 * sempre. `generator/tests/loop-references-exist.test.mjs` esiste per quella.
 *
 * Qui la chiusura non è un secondo script che ri-misura e può divergere: è la
 * stessa tabella `CONDITIONS`, valutata una volta sola. `reconcile()` apre le
 * condizioni `firing` e CHIUDE quelle non-`firing` che hanno una issue aperta.
 * Una condizione senza percorso di chiusura è quindi impossibile da scrivere:
 * non firing ⇒ resolve, per costruzione.
 * `generator/tests/generation-health-watchdog.test.mjs` lo asserisce, insieme
 * all'esistenza del workflow che esegue questo file.
 *
 * ## Fail-safe: «non ho misurato» ≠ «sta bene»
 *
 * Ogni gruppo di condizioni porta un flag `available`. Se la sorgente non si è
 * potuta leggere (API giù, log scaduti, corpus assente), le sue condizioni non
 * vengono NÉ aperte NÉ chiuse, e lo script lo dice con un `::warning::`.
 * Scambiare l'assenza di misura per salute è esattamente la classe di difetto
 * che questo scanner esiste per chiudere: non la si reintroduce qui dentro.
 *
 * ## Routing: `agent:fix-queued`, non `agent:fix` — deliberato
 *
 * `issue-fix.yml` ha `concurrency: group: issue-fix, cancel-in-progress: false`,
 * e GitHub con `cancel=false` tiene solo l'in-progress + l'ULTIMA pending e
 * CANCELLA le altre. È la starvation misurata il 2026-06-04 e documentata in
 * `scripts/ci/followup-drainer.mjs`. Uno scanner che può aprire fino a tre issue
 * in una passata e etichettarle tutte `agent:fix` produrrebbe esattamente quelle
 * run cancellate. Quindi qui si applica la coda (`agent:fix-queued` +
 * `fu-prio:high`) e la promozione a `agent:fix` resta del drainer, che la fa UNA
 * alla volta, a slot libero, dietro la sua guardia di quota — e col PAT, l'unico
 * token il cui evento `labeled` fa partire il fixer. L'esito richiesto (il
 * fixer parte) si ottiene comunque; ci si arriva senza bruciare gli slot.
 * `agent:in-progress` non viene MAI applicata: è mutua esclusione, non stato, e
 * appesa su una issue aperta la escluderebbe per sempre dal fixer.
 *
 * Uso:
 *   node scripts/ci/scan-generation-health.mjs [--dry-run] [--max-issues N]
 *        [--commit-lookback-hours H] [--max-log-runs N] [--run-lookback-hours H]
 * Env:
 *   GH_TOKEN            necessario per gh. Usare il PAT: una issue aperta dal
 *                       GITHUB_TOKEN non emette `issues: opened` e nasce fuori
 *                       dal triage.
 *   GITHUB_REPOSITORY   owner/repo (auto in Actions).
 */

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGithubIssue, resolveGithubIssue } from '../lib/github-issue-creator.mjs';
import { topicCoverageKey } from '../../generator/scripts/lib/topic-coverage-guard.mjs';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ─────────────────────────────────────────────────────────────────────────────
// Soglie. Ognuna porta la misura che l'ha scelta.
//
// Finestra di misura per lo storico dei commit: 2026-07-30 → 2026-08-10 (512
// commit su `main`, 215 articoli: 120 frontaliere + 95 svizzera).
// Finestra di misura per i log: le ultime 200 run di `generate-article.yml`
// (2026-08-09T05:53 → 2026-08-10T15:51), di cui 129 non cancellate e con
// sezione attribuita: 62 frontaliere, 67 svizzera.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `generation-idle` — nessun articolo da NESSUNA sezione.
 *
 * Misurato sui 215 intervalli fra articoli consecutivi (qualunque sezione):
 * p50 0,48h · p90 2,14h · p95 3,18h · p98 4,15h · p99 5,20h · max 11,21h.
 * A 6h: 2 intervalli su 215 (0,9%) in 11 giorni. A 12h: zero — cioè una soglia
 * a 12h sarebbe VACUA su tutto lo storico disponibile, che è il modo più facile
 * di scrivere un allarme che non suona mai.
 *
 * 6h è quindi il primo valore che sta sopra il p99 e continua a mordere.
 */
export const IDLE_HOURS = 6;

/**
 * `section-dry` — una sezione ferma MENTRE l'altra produce.
 *
 * La congiunzione è ciò che rende la condizione diagnostica invece che
 * ridondante: se produce anche solo l'altra sezione, la pipeline, i provider LLM
 * e la quota sono vivi, quindi il guasto è DELLA SEZIONE. Senza quel secondo
 * termine questa condizione ricadrebbe sullo stesso segnale di
 * `generation-idle` e su ogni pausa globale (quota esaurita), che non è cosa
 * sua: quella la vede `generation-idle`, e la quota ha già il suo beacon.
 *
 * Misurato sugli intervalli per sezione:
 *   svizzera    p50 0,92h · p90 4,15h · p95 7,45h · p98 12,89h · max 17,01h
 *   frontaliere p50 0,95h · p90 3,96h · p95 5,14h · p98 7,73h  · max 14,99h
 *
 * A 10h + almeno 3 articoli dell'altra sezione nello stesso intervallo:
 * 2 episodi in 11 giorni, entrambi svizzera (17,01h con 14 articoli
 * frontaliere dentro; 10,59h con 5), zero frontaliere. L'allarme sarebbe stato
 * attivo per 7,6h su 269h di storico, cioè il 2,8% del tempo.
 * A 6h gli episodi diventano 10 (~1 al giorno): rumore.
 */
export const SECTION_DRY_HOURS = 10;
export const SECTION_DRY_PEER_MIN = 3;

/**
 * `evergreen-pool-saturated` — il pool evergreen della sezione è esaurito.
 *
 * Quota di run non-cancellate e non-dry della sezione che stampano «Tutte le
 * keyword evergreen risultano già coperte dal pre-flight».
 *
 * Misurato su finestre scorrevoli di 12h (svizzera / frontaliere):
 *   50% / 0 · 42% / 0 · 19% / 0 · 0% / 0 · 16% / 0 · 36% / 0 ·
 *   64% / 0 · 84% / 0 · 89% / 0 · 92% / 0
 * Frontaliere è a ZERO in ogni finestra (0 su 62 run). Svizzera sale nel tempo:
 * è il pool che si satura progressivamente.
 *
 * 0,70 separa le finestre in cui svizzera PRODUCEVA ancora (≤64%, 17 articoli
 * il 2026-08-09) da quelle in cui è andata a secco (≥84%, ultimo articolo alle
 * 08:55 del 2026-08-10). Il campione minimo di 10 run scarta le finestre corte,
 * dove una quota su 3-4 run non significa niente.
 *
 * **La soglia è legata alla LUNGHEZZA della finestra, ed è il motivo per cui
 * `RUN_LOOKBACK_HOURS_DEFAULT` vale 12 e non di più.** Misurato sugli stessi
 * dati, la quota di svizzera è 87% su 12,6h, 63% su 16,6h e 47% su 21,1h: la
 * saturazione è recente, e allungare la finestra la annacqua con le run sane di
 * ieri finché la condizione non si accende più. Verificato in dry-run contro il
 * repo vivo il 2026-08-10: a 21h la condizione taceva su una sezione
 * effettivamente satura. Chi cambia una delle due cose deve cambiare l'altra.
 */
export const SATURATION_RATE = 0.70;
export const SATURATION_MIN_RUNS = 10;

/**
 * Finestra di default per le condizioni che leggono i log.
 *
 * 12h è la finestra su cui SATURATION_RATE e TOTAL_REJECTION_RATE sono state
 * tarate, e non è un parametro indipendente da loro (vedi SATURATION_RATE).
 * Il cap sulle run è una cintura di costo, non un secondo criterio: al ritmo
 * misurato (~3,8 run non cancellate l'ora) 12h ne contengono ~46, quindi 60 non
 * morde nella normalità e serve solo a non scaricare centinaia di log se il
 * ritmo esplode.
 */
export const RUN_LOOKBACK_HOURS_DEFAULT = 12;
export const MAX_LOG_RUNS_DEFAULT = 60;

/**
 * `news-pool-total-rejection` — la Fase 1 news della sezione esce sempre vuota.
 *
 * Quota di run della sezione che HANNO eseguito il pre-spend gate e ne escono
 * `emptied=1 recovered=none`. Il denominatore sono le sole run in cui il gate è
 * girato davvero: `finalizeRunReport` non emette la riga quando il gate non è
 * stato eseguito (FORCE_EVERGREEN, scan vuoto), e contare quelle come «non
 * svuotate» diluirebbe il segnale con run che non sono evidenza di niente.
 *
 * Misurato: svizzera 11 su 13 (85%), frontaliere 0 su 10 (0%). Su finestre
 * scorrevoli di 12h svizzera non scende mai sotto il 78% (5/6, 7/9, 11/13,
 * 11/12, 6/7, 4/4) e frontaliere resta a 0 in tutte.
 *
 * 0,70 sta 8 punti sotto il minimo osservato del lato rotto e 70 punti sopra il
 * massimo osservato del lato sano. Campione minimo 4: il gate gira ~0,38 volte
 * l'ora per sezione, quindi pretenderne di più significherebbe una finestra da
 * oltre 16h e un allarme che arriva il giorno dopo.
 */
export const TOTAL_REJECTION_RATE = 0.70;
export const TOTAL_REJECTION_MIN_GATE_RUNS = 4;

/**
 * `prompt-oversize` — il prompt supera il tetto di input del roster.
 *
 * Il cascade di `ai-models.mjs` salta un modello quando il prompt stimato supera
 * il suo tetto di token in INPUT, e lo dice per modello. Un salto isolato è
 * normale (i modelli piccoli hanno tetti a 3.000-4.000). Il guasto è quando il
 * prompt cresce oltre il tetto della MAGGIOR PARTE del roster: la run scivola su
 * un modello non validato, produce contenuto thin e viene poi rigettata a valle
 * — dopo aver speso.
 *
 * Misurato sulle 200 run: 7 hanno prodotto salti, e i modelli distinti saltati
 * per run sono 1, 2, 2, 5, 7, 20, 22 (su 18 modelli con tetto hardcoded in
 * `MODEL_MAX_REQUEST_TOKENS` più i default per provider). Le 4 run con ≥5
 * modelli distinti saltati stanno TUTTE nelle ultime 4,2 ore della finestra:
 * nelle 29 ore precedenti ce n'erano ZERO. La regressione è nata lì, e i prompt
 * stimati misurati sono 8.510-10.930 token contro tetti dichiarati di
 * 3.000/4.000/6.000/8.000.
 *
 * Soglia: almeno 2 run nella finestra con ≥5 modelli distinti saltati. Con 1
 * sola run la condizione sfarfallerebbe sul bordo della finestra; con 2 resta
 * accesa per tutta la durata reale della regressione e silenziosa nelle 29 ore
 * sane.
 */
export const OVERSIZE_MIN_MODELS = 5;
export const OVERSIZE_MIN_RUNS = 2;

/**
 * `duplicate-topic-burst` — due articoli sullo stesso argomento a distanza
 * ravvicinata.
 *
 * La chiave di argomento è `topicCoverageKey` (`topic-coverage-guard.mjs`),
 * IMPORTATA e non riscritta: resta una sola definizione di «stesso argomento»
 * nel repo, e questo controllo si rafforza da solo quando quella chiave viene
 * generalizzata. **È già successo**: #184 è atterrata il 2026-08-10 alle 16:47
 * e ha aggiunto i `kind` `comune-guide` e `canton-theme` a quello che prima era
 * il solo `profession-guide`. Questa condizione ha guadagnato due famiglie di
 * duplicati senza che una riga qui cambiasse per ottenerlo — quello che è
 * cambiato è la forma della chiave (`{kind, value}`), e la si legge ora tramite
 * `pairKeyOf()`, che rifiuta di collassare invece di indovinare.
 *
 * ── Rimisurato sul corpus DOPO #184 (3.846 articoli con data) ──────────────
 *
 * Articoli con una chiave: **252** (erano 162) — profession-guide 162,
 * comune-guide 51, canton-theme 39. Coppie a chiave uguale entro 24h: **86**
 * (erano 65).
 *
 * Il numero che conta non è quello storico ma quello DOPO il gate #120
 * (2026-08-09T17:52), cioè da quando `assertTopicNotRecentlyCovered` blocca:
 *
 *   coppie post-gate, per finestra: 15'→2 · 30'→4 · 60'→8 · 120'→10 ·
 *                                   **180'→11** · 240'→11 · 360'→11 · 720'→11
 *
 * e tutte e 11 sono `comune-guide` (10) o `canton-theme` (1); di
 * `profession-guide` ce ne sono ZERO. Cioè: il gate #120 tiene sui mestieri, e
 * le due famiglie che #184 ha appena insegnato al gate a vedere stavano ancora
 * uscendo in coppia fino a stamattina. **La condizione non è più il guard
 * spento che era prima di #184: si accende oggi**, e nelle prossime 24h è la
 * verifica in produzione che #184 funzioni davvero.
 *
 * ── Perché 180 minuti, rimisurato ─────────────────────────────────────────
 *
 * Le 11 coppie post-gate distano 12, 13, 16, 17, 33, 49, 54, 57, 74, 102 e 132
 * minuti: 180 le copre tutte, con 48 minuti di margine sulla peggiore. E fra
 * 180 e 360 minuti il conteggio non si muove — né sulle post-gate (11 → 11) né
 * sul totale storico (72 → 72). La soglia sta cioè all'INIZIO di un plateau
 * largo tre ore, quindi non è sensibile a ±3h di scelta: è la proprietà che
 * distingue una soglia misurata da una soglia scelta. Sotto, a 120 minuti, se
 * ne perderebbe una vera (ronago, 132 minuti).
 */
export const PAIR_WINDOW_MINUTES = 180;
export const PAIR_LOOKBACK_HOURS = 24;

/** Le due sezioni che `generate-article.yml` alterna. */
export const SECTIONS = ['frontaliere', 'svizzera'];

/** Sopra questa quota di log illeggibili le condizioni sui log non si valutano. */
export const MIN_LOG_SUCCESS_RATE = 0.5;

// ─────────────────────────────────────────────────────────────────────────────
// Parser puri — nessuna rete, nessun filesystem. Sono il cuore testabile.
// ─────────────────────────────────────────────────────────────────────────────

const COMMIT_ARTICLE_RE = /^Generate blog article \(([a-z]+)\)$/;
const COMMIT_REJECTED_RE = /^Record rejected topic candidates \(([a-z]+) — no article generated\)$/;

/**
 * Cosa dice di sé il titolo di un commit di generazione.
 *
 * `generate-article.yml` distingue già i due esiti nel subject, ed è l'unico
 * posto in cui la distinzione è registrata in modo permanente: i log delle run
 * scadono, i commit no.
 *
 * @param {string} subject prima riga del messaggio di commit
 * @returns {{kind: 'article'|'rejected', section: string}|null}
 */
export function parseGenerationCommit(subject) {
  const s = String(subject || '').trim();
  let m = COMMIT_ARTICLE_RE.exec(s);
  if (m) return { kind: 'article', section: m[1] };
  m = COMMIT_REJECTED_RE.exec(s);
  if (m) return { kind: 'rejected', section: m[1] };
  return null;
}

// `\w+` e non `.+`: la riga viene stampata DUE volte nel log, prima come eco del
// comando (`event=$EV chain=$CHAIN → section=$SEC dry_run=$DRY`) e poi con i
// valori risolti. `$EV` non è `\w+`, quindi l'eco non aggancia mai — e non
// serve distinguere le due occorrenze in un altro modo, più fragile.
const RUN_MODE_RE = /event=(\w+) chain=(\w+) → section=(\w+) dry_run=(\w+)/;
const TARGET_SECTION_RE = /TARGET_SECTION:\s*(\w+)/;
const GATE_OUTCOME_RE =
  /PRESPEND_GATE_OUTCOME emptied=(\d+) recovered=(\w+) before=(\d+) kept=(\d+) status=(\w+) section=(\w+)/;
const GATE_TOTAL_REJECTION_RE =
  /PRESPEND_GATE_TOTAL_REJECTION before=(\d+) classifier_calls=(\d+) anchor_candidates=(\d+) restored=(\d+) kept_after=(\d+) section=(\w+)/g;
const TOKEN_LIMIT_RE = /\[([^\]\s]+)\] Skipped — request would exceed (\d+)-token limit \(estimated (\d+)\)/g;
const EVERGREEN_SATURATED_RE = /Tutte le keyword evergreen risultano già coperte/;
const EVERGREEN_NONE_RE = /Nessuna keyword evergreen disponibile/;

/**
 * Estrae dai log di UNA run tutto ciò che le condizioni sanno leggere.
 *
 * Tollerante per costruzione: un marker assente non è un errore, è
 * un'informazione mancante di quel run. Un log troncato (run uccisa dal
 * `timeout … 2400s`) produce quindi un record parziale, non un'eccezione.
 *
 * @param {string} text log completo della run
 * @returns {{
 *   section: string|null, event: string|null, chain: boolean|null, dryRun: boolean|null,
 *   gate: {emptied: boolean, recovered: string, before: number, kept: number, status: string, section: string}|null,
 *   totalRejections: number,
 *   evergreenSaturated: boolean, evergreenNone: boolean,
 *   tokenLimitSkips: Array<{model: string, limit: number, estimated: number}>
 * }}
 */
export function parseRunLog(text) {
  const t = String(text || '');
  const mode = RUN_MODE_RE.exec(t);
  const gateM = GATE_OUTCOME_RE.exec(t);
  const targetM = TARGET_SECTION_RE.exec(t);

  const section = mode ? mode[3] : (targetM ? targetM[1] : (gateM ? gateM[6] : null));

  return {
    section,
    event: mode ? mode[1] : null,
    chain: mode ? mode[2] === 'true' : null,
    // Lo step `Generate the article` (dove vive TARGET_SECTION) è saltato quando
    // `dry == 'true'`, quindi la sua presenza è di per sé la prova che il run non
    // era dry — utile sui log in cui la riga `event=… dry_run=…` non è leggibile.
    dryRun: mode ? mode[4] === 'true' : (targetM ? false : null),
    gate: gateM
      ? {
        emptied: gateM[1] === '1',
        recovered: gateM[2],
        before: Number(gateM[3]),
        kept: Number(gateM[4]),
        status: gateM[5],
        section: gateM[6],
      }
      : null,
    totalRejections: [...t.matchAll(GATE_TOTAL_REJECTION_RE)].length,
    evergreenSaturated: EVERGREEN_SATURATED_RE.test(t),
    evergreenNone: EVERGREEN_NONE_RE.test(t),
    tokenLimitSkips: [...t.matchAll(TOKEN_LIMIT_RE)].map((m) => ({
      model: m[1],
      limit: Number(m[2]),
      estimated: Number(m[3]),
    })),
  };
}

/**
 * Aggrega i record di run per sezione.
 *
 * Escluse dai denominatori:
 *  - le run `dryRun` (lo step di generazione non parte: non sono evidenza);
 *  - le run senza sezione attribuita (log troncato prima dello step `mode`).
 * Le run cancellate sono già escluse a monte, dal chiamante: lo stesso motivo
 * per cui `scan-failed-runs.mjs` non guarda `cancelled` — il 2026-08-06 un
 * disservizio GitHub le ha prodotte a decine, e sono infrastruttura, non
 * pipeline.
 *
 * @param {Array<ReturnType<typeof parseRunLog>>} runs
 */
export function summarizeRuns(runs) {
  const bySection = new Map();
  for (const s of SECTIONS) {
    bySection.set(s, { runs: 0, saturated: 0, gateRuns: 0, gateEmptiedUnrecovered: 0, totalRejections: 0 });
  }
  let oversizeRuns = 0;
  let maxEstimated = 0;
  const limitsCrossed = new Set();
  const modelsSkipped = new Set();

  for (const r of runs || []) {
    if (!r || r.dryRun === true) continue;

    const distinctModels = new Set(r.tokenLimitSkips.map((s) => s.model));
    if (distinctModels.size >= OVERSIZE_MIN_MODELS) oversizeRuns++;
    for (const s of r.tokenLimitSkips) {
      if (s.estimated > maxEstimated) maxEstimated = s.estimated;
      limitsCrossed.add(s.limit);
      modelsSkipped.add(s.model);
    }

    const agg = bySection.get(r.section);
    if (!agg) continue;
    agg.runs++;
    if (r.evergreenSaturated) agg.saturated++;
    agg.totalRejections += r.totalRejections;
    if (r.gate) {
      agg.gateRuns++;
      if (r.gate.emptied && r.gate.recovered === 'none') agg.gateEmptiedUnrecovered++;
    }
  }

  return {
    bySection,
    oversize: {
      runs: oversizeRuns,
      maxEstimated,
      limitsCrossed: [...limitsCrossed].sort((a, b) => a - b),
      distinctModels: modelsSkipped.size,
      models: [...modelsSkipped].sort(),
    },
  };
}

/**
 * Coppie di articoli che condividono la chiave di argomento e sono usciti a
 * distanza ravvicinata.
 *
 * Considera solo le coppie il cui articolo PIÙ RECENTE cade nella finestra di
 * lookback: così una coppia storica non tiene accesa una issue per sempre, e la
 * condizione ha un rientro naturale (24h senza coppie nuove → si chiude).
 *
 * @param {Array<{id: string, title: string, date: string}>} articles
 * @param {{now?: number, lookbackHours?: number, pairWindowMinutes?: number}} [opts]
 */
/**
 * La chiave composita `<kind>:<value>` di un articolo, o `null` se la chiave
 * restituita dal guard non ha un `value` usabile.
 *
 * **Perché non c'è una catena di fallback.** La prima versione di questa riga
 * era `${kind}:${key.professionId || key.key || ''}`, scritta contro la forma
 * `{kind, professionId}` che il guard aveva fino a #184. Quando #184 ha
 * cambiato la forma in `{kind, value}`, quella catena non ha lanciato: ha
 * prodotto `profession-guide:` — la STESSA chiave per tutte e 162 le
 * guide-mestiere del corpus, cioè un confronto in cui ogni mestiere è
 * duplicato di ogni altro. Un fallback `|| ''` trasforma un cambio di
 * contratto in un difetto silenzioso che si presenta come una valanga di falsi
 * positivi, ed è esattamente la classe di guasto che questo watchdog esiste per
 * chiudere: non la si reintroduce nel watchdog stesso.
 *
 * Quindi: `value` o niente. Un articolo la cui chiave non è utilizzabile viene
 * ESCLUSO dal confronto (nessun falso positivo) e contato in un `::warning::`
 * (nessun silenzio). `generation-health-watchdog.test.mjs` pinna entrambe le
 * metà — che due mestieri DIVERSI non collassino, e che una chiave malformata
 * non produca coppie.
 *
 * @param {{kind?: string, value?: string}} key
 * @returns {string|null}
 */
export function pairKeyOf(key) {
  const kind = typeof key?.kind === 'string' ? key.kind.trim() : '';
  const value = typeof key?.value === 'string' ? key.value.trim() : '';
  if (!kind || !value) return null;
  return `${kind}:${value}`;
}

export function findDuplicateTopicPairs(articles, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const lookbackMs = (opts.lookbackHours ?? PAIR_LOOKBACK_HOURS) * 3_600_000;
  const windowMs = (opts.pairWindowMinutes ?? PAIR_WINDOW_MINUTES) * 60_000;

  const keyed = [];
  let malformed = 0;
  for (const a of articles || []) {
    const ts = a?.date ? Date.parse(a.date) : NaN;
    if (!Number.isFinite(ts)) continue; // fail-open, come il gate stesso
    const key = topicCoverageKey(a);
    if (!key) continue;
    const composite = pairKeyOf(key);
    if (composite === null) { malformed++; continue; }
    keyed.push({ ...a, ts, key: composite });
  }
  if (malformed > 0) {
    console.warn(`::warning::[generation-health] ${malformed} chiavi di argomento senza \`value\` utilizzabile — articoli ESCLUSI dal confronto. È cambiata la forma di topicCoverageKey: aggiornare pairKeyOf().`);
  }
  keyed.sort((x, y) => x.ts - y.ts);

  const pairs = [];
  const byKey = new Map();
  for (const a of keyed) {
    const prev = byKey.get(a.key);
    if (prev && a.ts - prev.ts <= windowMs && now - a.ts <= lookbackMs) {
      pairs.push({ key: a.key, minutesApart: (a.ts - prev.ts) / 60_000, first: prev, second: a });
    }
    byKey.set(a.key, a);
  }
  return pairs;
}

// ─────────────────────────────────────────────────────────────────────────────
// La tabella delle condizioni.
//
// `title` è STABILE per condizione — mai per run, mai con un numero dentro: è la
// chiave di deduplica di `createGithubIssue` (primi 60 caratteri) ED è la chiave
// con cui `resolveGithubIssue` richiude. Una issue nuova a ogni ciclo sarebbe
// rumore; un titolo che cambia quando cambia la misura sarebbe rumore E una
// issue vecchia impossibile da chiudere.
//
// `evaluate` restituisce `{firing, body}` — oppure `{available: false}` per dire
// «non ho potuto misurare», che non apre e non chiude.
// ─────────────────────────────────────────────────────────────────────────────

const REMEASURE = {
  commits: 'gh api "repos/$REPO/commits?sha=main&per_page=100" --jq \'.[] | "\\(.commit.committer.date)\\t\\(.commit.message | split("\\n")[0])"\'',
  runs: 'gh run list --repo "$REPO" --workflow=generate-article.yml --limit 200 --json databaseId,conclusion,createdAt'
    + ' && gh run view <id> --repo "$REPO" --log | grep -E "PRESPEND_GATE_|would exceed|Tutte le keyword evergreen|→ section="',
  corpus: '# rilegge il corpus del checkout e rifà il conto delle coppie, per finestra:\n'
    + 'node -e \'const{findDuplicateTopicPairs,collectCorpus}=await import("./scripts/ci/scan-generation-health.mjs");'
    + 'for(const w of [15,30,60,120,180,240,360]){const c=collectCorpus(process.cwd());'
    + 'console.log(w+"min →", findDuplicateTopicPairs(c.articles,{pairWindowMinutes:w,lookbackHours:24*365}).length)}\' --input-type=module',
};

const footer = (howToRemeasure) => [
  '',
  '---',
  '',
  '**Come ri-misurare**',
  '',
  '```bash',
  'REPO=nanakokyobashi-rgb/frontaliere-articles',
  howToRemeasure,
  '```',
  '',
  'Issue aperta automaticamente da `scripts/ci/scan-generation-health.mjs`'
  + ' (workflow `.github/workflows/generation-health-watchdog.yml`).'
  + ' **Si chiude da sola** alla prima passata in cui la condizione non è più vera:'
  + ' apertura e chiusura sono la stessa valutazione, non due script che possono divergere.',
].join('\n');

export const CONDITIONS = [
  {
    id: 'generation-idle',
    scope: 'global',
    priority: 2,
    title: () => 'Watchdog generazione: nessun articolo da nessuna sezione',
    evaluate(m) {
      if (!m.commits.available) return { available: false };
      const last = m.commits.lastArticleAt;
      if (last === null) {
        // Nessun articolo in TUTTA la finestra di commit letta: è la forma
        // estrema della stessa condizione, non un'assenza di dato.
        return {
          firing: true,
          body: [
            `Nessun commit \`Generate blog article (…)\` negli ultimi **${m.commits.lookbackHours}h** di storia di \`main\``,
            `(${m.commits.total} commit letti, ${m.commits.rejected} dei quali`,
            '`Record rejected topic candidates (… — no article generated)`).',
            '',
            `Soglia: ${IDLE_HOURS}h. Misura che l'ha scelta: sui 215 intervalli fra articoli consecutivi`,
            'dello storico 2026-07-30→08-10, p99 = 5,20h e solo 2 intervalli su 215 superano le 6h.',
            '',
            'Punto da cui guardare: `.github/workflows/generate-article.yml` (i quattro cron :07/:22/:37/:52 e la',
            'catena self-trigger su `content/**`) e `generator/scripts/create-article.mjs`.',
          ].join('\n') + footer(REMEASURE.commits),
        };
      }
      const hours = (m.now - last) / 3_600_000;
      if (hours < IDLE_HOURS) return { firing: false };
      return {
        firing: true,
        body: [
          `Ultimo articolo pubblicato **${hours.toFixed(1)}h fa** (soglia ${IDLE_HOURS}h), da nessuna delle due sezioni.`,
          '',
          `- Ultimo \`Generate blog article (…)\`: ${new Date(last).toISOString()}`,
          `- Commit \`Record rejected topic candidates\` nella finestra: ${m.commits.rejected}`,
          `- Articoli nella finestra, per sezione: ${SECTIONS.map((s) => `${s}=${m.commits.perSection[s].articles}`).join(', ')}`,
          '',
          `Soglia misurata: sui 215 intervalli fra articoli consecutivi (2026-07-30→08-10) p95 = 3,18h,`,
          `p99 = 5,20h, max 11,21h; a ${IDLE_HOURS}h ricadono 2 intervalli su 215 (0,9%). A 12h nessuno,`,
          'cioè una soglia più alta sarebbe vacua sullo storico disponibile.',
          '',
          'Va guardato prima: la quota dei provider LLM (una pausa globale è la causa più frequente e NON è',
          'un difetto di questo repo), poi `.github/workflows/generate-article.yml` e',
          '`generator/scripts/create-article.mjs`.',
        ].join('\n') + footer(REMEASURE.commits),
      };
    },
  },

  {
    id: 'evergreen-pool-saturated',
    scope: 'section',
    priority: 2,
    title: (section) => `Watchdog generazione, sezione ${section}: pool evergreen saturo`,
    evaluate(m, section) {
      if (!m.runs.available) return { available: false };
      const agg = m.runs.bySection.get(section);
      if (!agg || agg.runs < SATURATION_MIN_RUNS) {
        // Campione insufficiente: non è «sano», è «non misurabile». Non aprire —
        // ma nemmeno chiudere una issue aperta su una misura che era valida.
        return { available: false, reason: `campione ${agg ? agg.runs : 0} < ${SATURATION_MIN_RUNS} run` };
      }
      const rate = agg.saturated / agg.runs;
      if (rate < SATURATION_RATE) return { firing: false };
      return {
        firing: true,
        body: [
          `**${agg.saturated} run su ${agg.runs}** (${(rate * 100).toFixed(0)}%) della sezione \`${section}\` nella finestra`,
          `di ${m.runs.spanHours.toFixed(1)}h escono con «⚠️  Tutte le keyword evergreen risultano già coperte dal`,
          'pre-flight. Push prosegue senza nuovo articolo.» — il pool evergreen della sezione è saturo.',
          '',
          `- Soglia: ${(SATURATION_RATE * 100).toFixed(0)}% su almeno ${SATURATION_MIN_RUNS} run non-dry della sezione.`,
          `- Run della sezione nella finestra: ${agg.runs} (${m.runs.total} run totali analizzate).`,
          `- L'altra sezione, nella stessa finestra: ${SECTIONS.filter((s) => s !== section)
            .map((s) => { const o = m.runs.bySection.get(s); return `${s} ${o.saturated}/${o.runs}`; }).join(', ')}.`,
          '',
          '**Perché la soglia è 0,70.** Misurato su finestre scorrevoli di 12h (2026-08-09→10): la sezione',
          '`svizzera` è passata da 0% a 92% mentre il pool si esauriva, e continuava a PRODURRE fino al 64%',
          '(17 articoli il 2026-08-09); da 84% in su è andata a secco. `frontaliere` è a 0 su 62 run in tutte',
          'le finestre. La soglia sta quindi 14 punti sopra l\'ultima quota "sana" osservata e 70 sopra il lato sano.',
          '',
          'Punto da cui guardare: `generator/scripts/lib/evergreen-topic-generator.mjs` (la costruzione del pool —',
          '**è `identical` nel `loop-sync-manifest.json`, quindi la fix va fatta SUL SITO e scende al mirror**),',
          'e `generator/scripts/lib/article-topic-selector.mjs` (`adapted`: qui) per la selezione e le strike.',
          'La domanda concreta è se il pool della sezione abbia ancora keyword non coperte, o se vada allargato.',
        ].join('\n') + footer(REMEASURE.runs),
      };
    },
  },

  {
    id: 'news-pool-total-rejection',
    scope: 'section',
    priority: 2,
    title: (section) => `Watchdog generazione, sezione ${section}: pool news svuotato dal pre-spend gate`,
    evaluate(m, section) {
      if (!m.runs.available) return { available: false };
      const agg = m.runs.bySection.get(section);
      if (!agg || agg.gateRuns < TOTAL_REJECTION_MIN_GATE_RUNS) {
        return { available: false, reason: `campione ${agg ? agg.gateRuns : 0} < ${TOTAL_REJECTION_MIN_GATE_RUNS} run col gate` };
      }
      const rate = agg.gateEmptiedUnrecovered / agg.gateRuns;
      if (rate < TOTAL_REJECTION_RATE) return { firing: false };
      return {
        firing: true,
        body: [
          `Il pre-spend topic gate svuota il pool news della sezione \`${section}\` e il backstop non recupera nulla:`,
          `**${agg.gateEmptiedUnrecovered} run su ${agg.gateRuns}** (${(rate * 100).toFixed(0)}%) fra quelle in cui il gate`,
          `ha girato, nella finestra di ${m.runs.spanHours.toFixed(1)}h, escono`,
          '`PRESPEND_GATE_OUTCOME emptied=1 recovered=none`.',
          `Righe \`PRESPEND_GATE_TOTAL_REJECTION\` per la sezione nella finestra: ${agg.totalRejections}.`,
          '',
          `- Soglia: ${(TOTAL_REJECTION_RATE * 100).toFixed(0)}% su almeno ${TOTAL_REJECTION_MIN_GATE_RUNS} run in cui il gate è girato.`,
          `- L'altra sezione: ${SECTIONS.filter((s) => s !== section)
            .map((s) => { const o = m.runs.bySection.get(s); return `${s} ${o.gateEmptiedUnrecovered}/${o.gateRuns}`; }).join(', ')}.`,
          '',
          '**Il denominatore sono le sole run in cui il gate è girato**: `finalizeRunReport`',
          '(`generator/scripts/create-article.mjs:1400-1428`) non emette la riga quando il gate non è stato',
          'eseguito (FORCE_EVERGREEN, scan vuoto), e quelle run non sono evidenza in nessuna direzione.',
          '',
          '**Perché la soglia è 0,70.** Misurato sulle ultime 200 run di `generate-article.yml`',
          '(2026-08-09T05:53→08-10T15:51): `svizzera` 11/13 = 85%, `frontaliere` 0/10 = 0%. Su finestre',
          'scorrevoli di 12h svizzera non scende mai sotto il 78% e frontaliere resta a 0 in tutte.',
          '',
          'Punto da cui guardare: il campo `anchor_candidates` della riga `PRESPEND_GATE_TOTAL_REJECTION` dice',
          'PERCHÉ il backstop non ha recuperato — richiede un match di anchor stretto, e gli anchor sono',
          'frontaliere-specifici (`IS_FRONTALIERE ? … : \'\'`), quindi sulla sezione `svizzera` valgono 0 per',
          'costruzione e il backstop non può scattare. Il gate è in `generator/scripts/create-article.mjs:540-640`',
          '(`adapted` nel manifest: la fix si fa qui).',
        ].join('\n') + footer(REMEASURE.runs),
      };
    },
  },

  {
    id: 'prompt-oversize',
    scope: 'global',
    priority: 2,
    title: () => 'Watchdog generazione: prompt oltre il tetto di input del roster',
    evaluate(m) {
      if (!m.runs.available) return { available: false };
      const o = m.runs.oversize;
      if (o.runs < OVERSIZE_MIN_RUNS) return { firing: false };
      return {
        firing: true,
        body: [
          `**${o.runs} run** nella finestra di ${m.runs.spanHours.toFixed(1)}h hanno saltato almeno`,
          `${OVERSIZE_MIN_MODELS} modelli DISTINTI ciascuna perché il prompt supera il loro tetto di token in`,
          'input. Il cascade scivola così su modelli non validati, e il contenuto thin che ne esce viene poi',
          'rigettato a valle — dopo aver speso.',
          '',
          `- Prompt stimato massimo osservato: **${o.maxEstimated} token**.`,
          `- Tetti dichiarati superati: ${o.limitsCrossed.join(', ')}.`,
          `- Modelli distinti saltati nella finestra: ${o.distinctModels} — ${o.models.slice(0, 12).join(', ')}${o.models.length > 12 ? ', …' : ''}.`,
          '',
          `**Perché la soglia è ${OVERSIZE_MIN_RUNS} run con ≥${OVERSIZE_MIN_MODELS} modelli.** Misurato sulle ultime`,
          '200 run: 7 hanno prodotto salti, con 1, 2, 2, 5, 7, 20 e 22 modelli distinti. Le 4 run con ≥5 stanno',
          'tutte nelle ultime 4,2 ore della finestra; nelle 29 ore precedenti erano zero. Con una sola run la',
          'condizione sfarfallerebbe sul bordo della finestra.',
          '',
          'Punto da cui guardare: `generator/scripts/lib/ai-models.mjs:4250-4270` emette il salto e legge il tetto',
          'da `MODEL_MAX_REQUEST_TOKENS` / `_learnedRequestTokenLimits` / `DEFAULT_REQUEST_TOKENS_BY_PROVIDER`.',
          '**Il file è `identical` nel `loop-sync-manifest.json`: una fix lì va fatta SUL SITO** e scende al',
          'mirror. Ciò che si può ridurre da questo lato è la TAGLIA del prompt, che si costruisce in',
          '`generator/scripts/create-article.mjs` (`adapted`).',
        ].join('\n') + footer(REMEASURE.runs),
      };
    },
  },

  {
    id: 'duplicate-topic-burst',
    scope: 'global',
    priority: 3,
    title: () => 'Watchdog generazione: due articoli sullo stesso argomento a poca distanza',
    evaluate(m) {
      if (!m.corpus.available) return { available: false };
      const pairs = m.corpus.duplicatePairs;
      if (!pairs.length) return { firing: false };
      const lines = pairs.slice(0, 10).map((p) => [
        `- chiave \`${p.key}\` — **${p.minutesApart.toFixed(0)} minuti** di distanza`,
        `  - ${p.first.date}  \`${p.first.id}\``,
        `  - ${p.second.date}  \`${p.second.id}\``,
      ].join('\n'));
      const byKind = {};
      for (const p of pairs) {
        const k = p.key.split(':')[0];
        byKind[k] = (byKind[k] || 0) + 1;
      }
      const newest = pairs.reduce((n, p) => (Date.parse(p.second.date) > Date.parse(n.second.date) ? p : n), pairs[0]);
      return {
        firing: true,
        body: [
          `**${pairs.length} copp${pairs.length === 1 ? 'ia' : 'ie'}** di articoli con la stessa chiave di argomento`,
          `(\`topicCoverageKey\`) pubblicat${pairs.length === 1 ? 'a' : 'e'} a meno di ${PAIR_WINDOW_MINUTES} minuti di`,
          `distanza, con l'articolo più recente nelle ultime ${PAIR_LOOKBACK_HOURS}h.`,
          `Per famiglia di chiave: ${Object.entries(byKind).map(([k, n]) => `\`${k}\` ${n}`).join(', ')}.`,
          '',
          ...lines,
          pairs.length > 10 ? `\n_(altre ${pairs.length - 10} coppie omesse)_` : '',
          '',
          'Due articoli sullo stesso argomento si cannibalizzano in SERP: è il difetto che',
          '`assertTopicNotRecentlyCovered` (`generator/scripts/lib/topic-coverage-guard.mjs`) esiste per bloccare,',
          'ed è chiamato da `generator/scripts/create-article.mjs`. Se questa issue è aperta, quel gate è stato',
          'aggirato o non ha visto la coppia.',
          '',
          `**Prima di indagare, guarda la data della coppia più recente: ${newest.second.date}.** La finestra è di`,
          `${PAIR_LOOKBACK_HOURS}h, quindi subito dopo un allargamento della chiave (o un fix del gate) questa issue`,
          'elenca anche le coppie uscite PRIMA che il gate le potesse vedere — e in quel caso si spegne da sola',
          `entro ${PAIR_LOOKBACK_HOURS}h senza che nessuno tocchi niente. Se invece compaiono coppie NUOVE dopo il`,
          'fix, il gate non le sta vedendo.',
          '',
          '**La chiave è importata, non riscritta**: c\'è una sola definizione di «stesso argomento» nel repo, e',
          'questo controllo eredita ogni suo allargamento senza modifiche. È già successo con #184, che ha aggiunto',
          '`comune-guide` e `canton-theme` a quello che era il solo `profession-guide`.',
          '',
          '**Misura di riferimento**, rimisurata sul corpus dopo #184 (3.846 articoli con data, 252 dei quali con',
          'una chiave: 162 mestiere, 51 comune, 39 cantone). Coppie entro 24h: 86. Coppie uscite DOPO il gate #120',
          '(2026-08-09T17:52), per finestra: 15′→2, 30′→4, 60′→8, 120′→10, 180′→11, 240′→11, 360′→11 — tutte',
          `\`comune-guide\` o \`canton-theme\`, nessuna \`profession-guide\`. La finestra di ${PAIR_WINDOW_MINUTES} minuti`,
          'copre le 11 (la peggiore è a 132 minuti) e sta all\'inizio di un plateau largo tre ore, in cui il',
          'conteggio non cambia: non è sensibile alla scelta.',
        ].join('\n') + footer(REMEASURE.corpus),
      };
    },
  },

  {
    id: 'section-dry',
    scope: 'section',
    priority: 2,
    // Volutamente ULTIMA: è la condizione generale, e viene soppressa quando una
    // più specifica sulla stessa sezione sta già spiegando perché. Vedi
    // `evaluateConditions`.
    title: (section) => `Watchdog generazione, sezione ${section}: nessun articolo pubblicato`,
    evaluate(m, section) {
      if (!m.commits.available) return { available: false };
      const per = m.commits.perSection[section];
      const other = SECTIONS.find((s) => s !== section);
      const otherPer = m.commits.perSection[other];
      const last = per.lastArticleAt;
      const since = last === null ? m.commits.windowStart : last;
      const hours = (m.now - since) / 3_600_000;
      if (hours < SECTION_DRY_HOURS) return { firing: false };
      const peerArticles = otherPer.timestamps.filter((t) => t > since).length;
      if (peerArticles < SECTION_DRY_PEER_MIN) return { firing: false };
      return {
        firing: true,
        body: [
          `La sezione \`${section}\` non pubblica un articolo da **${hours.toFixed(1)}h**`,
          `(soglia ${SECTION_DRY_HOURS}h), mentre \`${other}\` ne ha pubblicati **${peerArticles}** nello stesso`,
          `intervallo (soglia ${SECTION_DRY_PEER_MIN}).`,
          '',
          last === null
            ? `- Nessun \`Generate blog article (${section})\` in tutta la finestra letta (${m.commits.lookbackHours}h).`
            : `- Ultimo \`Generate blog article (${section})\`: ${new Date(last).toISOString()}`,
          `- Commit \`Record rejected topic candidates (${section} — …)\` nell'intervallo: ${per.rejected}`,
          `- Ultimo articolo di \`${other}\`: ${otherPer.lastArticleAt === null ? '—' : new Date(otherPer.lastArticleAt).toISOString()}`,
          '',
          '**La congiunzione è il punto.** Se l\'altra sezione produce, la pipeline, i provider LLM e la quota',
          'sono vivi: il guasto è DELLA SEZIONE, non globale. Una pausa globale è un\'altra condizione',
          '(`generation-idle`) e ha un\'altra causa.',
          '',
          `**Perché ${SECTION_DRY_HOURS}h e ${SECTION_DRY_PEER_MIN} articoli.** Misurato sugli intervalli per sezione`,
          '(2026-07-30→08-10): svizzera p95 = 7,45h, frontaliere p95 = 5,14h. Con questa coppia di soglie lo',
          'storico produce 2 episodi in 11 giorni (entrambi svizzera: 17,01h con 14 articoli frontaliere dentro,',
          'e 10,59h con 5) e l\'allarme sarebbe stato attivo il 2,8% del tempo. A 6h gli episodi diventano 10,',
          'cioè circa uno al giorno: rumore.',
          '',
          'Nota sulla catena: `generate-article.yml` si auto-innesca solo su un push che tocca `content/**`, e un',
          'anello che non produce nulla non lo tocca. Una sezione improduttiva spezza quindi la catena per',
          'ENTRAMBE, e resta solo il cron a ripartire. È il motivo per cui questa condizione va guardata anche',
          'quando l\'altra sezione sembra sana.',
        ].join('\n') + footer(REMEASURE.commits),
      };
    },
  },
];

/**
 * Le condizioni specifiche che, quando sono accese sulla stessa sezione,
 * SOPPRIMONO `section-dry`.
 *
 * Una sola incidenza non deve produrre due issue: se sappiamo già dire PERCHÉ
 * la sezione è ferma (pool evergreen saturo, pool news svuotato), quella
 * diagnosi è ciò che serve al fixer, e «la sezione non pubblica più» ne sarebbe
 * solo l'eco. `section-dry` resta il caso generale, per i motivi che non abbiamo
 * ancora una condizione per nominare.
 */
export const SECTION_DRY_SUPPRESSORS = ['evergreen-pool-saturated', 'news-pool-total-rejection'];

/**
 * Valuta ogni condizione su ogni suo scope e restituisce i verdetti.
 *
 * Un verdetto ha SEMPRE una delle tre forme: `firing` (si apre), non-`firing`
 * (si chiude, se aperta), `available: false` (non si tocca). Non esiste una
 * quarta forma in cui una condizione si apre senza poter essere chiusa: è il
 * modo strutturale in cui questo file non ripete il precedente di
 * `alert-pat-down.mjs`.
 *
 * @returns {Array<{id: string, section: string|null, title: string, firing: boolean, available: boolean, priority: number, body: string|null, reason?: string}>}
 */
export function evaluateConditions(m) {
  const out = [];
  for (const cond of CONDITIONS) {
    for (const section of cond.scope === 'section' ? SECTIONS : [null]) {
      const verdict = cond.evaluate(m, section) || {};
      const available = verdict.available !== false;
      out.push({
        id: cond.id,
        section,
        title: cond.title(section),
        firing: available && verdict.firing === true,
        available,
        priority: cond.priority,
        body: available && verdict.firing === true ? verdict.body : null,
        reason: verdict.reason,
      });
    }
  }

  // Soppressione in una SECONDA passata, non durante la prima: legare il
  // risultato all'ordine di `CONDITIONS` renderebbe la soppressione un effetto
  // collaterale del riordino di un array — il tipo di dipendenza che si rompe in
  // silenzio quando qualcuno aggiunge una condizione in cima.
  for (const v of out) {
    if (v.id !== 'section-dry' || !v.firing || !v.section) continue;
    const explaining = out
      .filter((o) => o.section === v.section && o.firing && SECTION_DRY_SUPPRESSORS.includes(o.id))
      .map((o) => o.id);
    if (explaining.length) {
      v.firing = false;
      v.body = null;
      v.suppressedBy = explaining;
    }
  }
  return out;
}

/**
 * Applica i verdetti: apre ciò che è acceso, chiude ciò che è spento, non tocca
 * ciò che non è stato misurato.
 *
 * `io` è iniettabile perché il test possa provare la simmetria apri/chiudi senza
 * parlare con GitHub — che è l'unico modo di provarla davvero.
 *
 * @param {ReturnType<typeof evaluateConditions>} verdicts
 * @param {{createIssue: Function, resolveIssue: Function, routeIssue?: Function, log?: Function, maxIssues?: number, dryRun?: boolean}} io
 */
export async function reconcile(verdicts, io) {
  const log = io.log || console.log;
  const maxIssues = io.maxIssues ?? 3;
  let opened = 0;
  let closed = 0;
  let skipped = 0;
  let capped = 0;

  for (const v of verdicts) {
    if (!v.available) {
      log(`[generation-health] ${v.title} — non misurabile${v.reason ? ` (${v.reason})` : ''}: né aperta né chiusa.`);
      skipped++;
      continue;
    }
    if (!v.firing) {
      if (v.suppressedBy?.length) {
        log(`[generation-health] ${v.title} — soppressa da ${v.suppressedBy.join(', ')} (stessa incidenza).`);
      }
      if (io.dryRun) {
        log(`[generation-health] (dry-run) chiuderei, se aperta: "${v.title}"`);
      } else {
        // Idempotente: no-op quando non esiste una issue aperta con quel titolo.
        const res = io.resolveIssue(v.title, { workflow: 'Generation health watchdog' });
        if (res) closed++;
      }
      continue;
    }
    if (opened >= maxIssues) {
      // Un cap che tronca in silenzio si legge come «tutto coperto». Lo diciamo.
      capped++;
      continue;
    }
    if (io.dryRun) {
      log(`[generation-health] (dry-run) aprirei: "${v.title}"\n${v.body}\n`);
      opened++;
      continue;
    }
    const issue = await io.createIssue({
      title: v.title,
      description: v.body,
      priority: v.priority,
      labels: ['bug', 'automation'],
      workflow: 'Generation health watchdog',
    });
    if (issue) {
      opened++;
      if (io.routeIssue) io.routeIssue(issue, v);
    }
  }

  if (capped > 0) {
    console.warn(`::warning::[generation-health] cap di ${maxIssues} issue raggiunto — ${capped} condizione/i accese NON segnalate in questa passata. Verranno riprese alla prossima.`);
  }
  log(`[generation-health] fatto: aperte=${opened} chiuse=${closed} non-misurabili=${skipped} oltre-cap=${capped}`);
  return { opened, closed, skipped, capped };
}

// ─────────────────────────────────────────────────────────────────────────────
// Raccolta delle misure — l'unica parte che parla con la rete e col disco.
// ─────────────────────────────────────────────────────────────────────────────

function gh(args, fallback = null) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    console.warn(`[generation-health] gh ${args.slice(0, 3).join(' ')} fallito: ${String(e.message).slice(0, 140)}`);
    return fallback;
  }
}

/** Storia di `main`: chi ha prodotto un articolo e quando. */
export function collectCommits(repo, lookbackHours) {
  const cutoff = Date.now() - lookbackHours * 3_600_000;
  const perSection = Object.fromEntries(
    SECTIONS.map((s) => [s, { articles: 0, rejected: 0, lastArticleAt: null, timestamps: [] }]),
  );
  let total = 0;
  let rejected = 0;
  let lastArticleAt = null;
  let reachedCutoff = false;

  for (let page = 1; page <= 3 && !reachedCutoff; page++) {
    const raw = gh(['api', `repos/${repo}/commits?sha=main&per_page=100&page=${page}`,
      '--jq', '.[] | "\\(.commit.committer.date)\\t\\(.commit.message | split("\\n")[0])"']);
    if (raw === null) return { available: false, lookbackHours };
    const lines = raw.split('\n').filter(Boolean);
    if (!lines.length) break;
    for (const line of lines) {
      const tab = line.indexOf('\t');
      const ts = Date.parse(line.slice(0, tab));
      if (!Number.isFinite(ts)) continue;
      if (ts < cutoff) { reachedCutoff = true; continue; }
      total++;
      const parsed = parseGenerationCommit(line.slice(tab + 1));
      if (!parsed || !perSection[parsed.section]) continue;
      if (parsed.kind === 'rejected') {
        rejected++;
        perSection[parsed.section].rejected++;
        continue;
      }
      perSection[parsed.section].articles++;
      perSection[parsed.section].timestamps.push(ts);
      if (perSection[parsed.section].lastArticleAt === null || ts > perSection[parsed.section].lastArticleAt) {
        perSection[parsed.section].lastArticleAt = ts;
      }
      if (lastArticleAt === null || ts > lastArticleAt) lastArticleAt = ts;
    }
  }

  return {
    available: true,
    lookbackHours,
    windowStart: cutoff,
    total,
    rejected,
    lastArticleAt,
    perSection,
  };
}

/**
 * Log delle run recenti di `generate-article.yml`.
 *
 * Le run `cancelled` sono escluse a monte: su questo repo sono un terzo del
 * totale (67 su 200 misurate) e sono la coda di concorrenza, non la pipeline.
 * Il parallelismo è basso di proposito — è la stessa quota API del sito.
 */
export async function collectRunLogs(repo, { maxRuns, lookbackHours, concurrency = 4 } = {}) {
  const since = Date.now() - lookbackHours * 3_600_000;
  const raw = gh(['run', 'list', '--repo', repo, '--workflow=generate-article.yml',
    '--limit', String(Math.min(200, maxRuns * 3)),
    '--json', 'databaseId,conclusion,status,createdAt,updatedAt']);
  if (raw === null) return { available: false };

  let runs;
  try {
    runs = JSON.parse(raw || '[]');
  } catch {
    return { available: false };
  }
  const eligible = runs
    .filter((r) => r.status === 'completed' && r.conclusion && r.conclusion !== 'cancelled'
      && Date.parse(r.createdAt) >= since)
    .slice(0, maxRuns);

  if (!eligible.length) return { available: false };

  const parsed = [];
  let failures = 0;
  for (let i = 0; i < eligible.length; i += concurrency) {
    const batch = eligible.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async (r) => {
      try {
        const { stdout } = await execFileAsync(
          'gh', ['run', 'view', String(r.databaseId), '--repo', repo, '--log'],
          { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
        );
        return parseRunLog(stdout);
      } catch {
        return null;
      }
    }));
    for (const res of results) {
      if (res === null) failures++;
      else parsed.push(res);
    }
  }

  const okRate = eligible.length ? parsed.length / eligible.length : 0;
  if (okRate < MIN_LOG_SUCCESS_RATE) {
    console.warn(`::warning::[generation-health] solo ${parsed.length}/${eligible.length} log leggibili (${(okRate * 100).toFixed(0)}%) — le condizioni sui log NON vengono valutate: «non ho misurato» non è «sta bene».`);
    return { available: false };
  }

  const summary = summarizeRuns(parsed);
  const times = eligible.map((r) => Date.parse(r.createdAt)).filter(Number.isFinite);
  return {
    available: true,
    total: parsed.length,
    logFailures: failures,
    spanHours: times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 3_600_000 : 0,
    bySection: summary.bySection,
    oversize: summary.oversize,
  };
}

/**
 * Corpus del checkout: id, titolo e data di ogni articolo.
 *
 * Stessa estrazione della suite del gate (`article-topic-coverage-guard.test.mjs`):
 * i titoli stanno nei meta IT, le date nei registri. Se una delle due letture
 * non produce nulla, la sorgente è dichiarata non disponibile invece di
 * restituire un corpus vuoto — un corpus vuoto non ha coppie, e chiuderebbe la
 * issue affermando il contrario di ciò che si è misurato.
 */
export function collectCorpus(repoRoot = REPO_ROOT, now = Date.now()) {
  const readMap = (rel, re, pick) => {
    const abs = path.join(repoRoot, 'content', rel);
    if (!fs.existsSync(abs)) return new Map();
    const src = fs.readFileSync(abs, 'utf8');
    const out = new Map();
    for (const m of src.matchAll(re)) if (!out.has(m[1])) out.set(m[1], pick(m));
    return out;
  };
  const titleRe = /'blog\.article\.([^.']+)\.title':\s*'((?:[^'\\]|\\.)*)'/g;
  const dateRe = /id:\s*'([^']+)',[\s\S]{0,300}?date:\s*'([^']+)'/g;

  const titles = new Map([
    ...readMap('blog-meta-it.ts', titleRe, (m) => m[2].replace(/\\'/g, "'")),
    ...readMap('blog-meta-ch-it.ts', titleRe, (m) => m[2].replace(/\\'/g, "'")),
  ]);
  const dates = new Map([
    ...readMap('blog-articles-data.ts', dateRe, (m) => m[2]),
    ...readMap('swiss-articles-data.ts', dateRe, (m) => m[2]),
  ]);

  if (titles.size === 0 || dates.size === 0) {
    console.warn('::warning::[generation-health] corpus non leggibile (titoli o date a zero) — la condizione sui duplicati NON viene valutata.');
    return { available: false };
  }

  const articles = [...titles].map(([id, title]) => ({ id, title, date: dates.get(id) || null }));
  return {
    available: true,
    total: articles.length,
    // Esposto perché il comando di ri-misura nel corpo della issue possa
    // ricontarle con una finestra diversa. Un comando che cita un campo
    // inesistente è la stessa promessa non mantenuta di un commento che cita un
    // workflow inesistente — `generation-health-watchdog.test.mjs` lo esegue.
    articles,
    duplicatePairs: findDuplicateTopicPairs(articles, { now }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

const ARGV = process.argv.slice(2);
const flag = (n) => ARGV.includes(n);
const val = (n, d) => {
  const i = ARGV.indexOf(n);
  return i !== -1 && ARGV[i + 1] ? ARGV[i + 1] : d;
};

/**
 * Instrada una issue appena aperta nella CODA del ciclo, non direttamente al
 * fixer. Il razionale sta nell'intestazione del file: `issue-fix.yml` ha un solo
 * slot con `cancel-in-progress: false`, e la promozione uno-alla-volta è del
 * drainer. Best-effort: un routing mancato è un warning, non una run rossa.
 */
export const ROUTING_LABELS_ALREADY_SET = ['agent:fix', 'agent:fix-queued', 'agent:in-progress', 'fu-parked'];

function routeToQueue(issue) {
  const number = issue && (issue.number || issue.issueNumber);
  if (!number) return;
  const repo = process.env.GITHUB_REPOSITORY || process.env.GH_REPO || '';
  const repoFlag = repo ? ['--repo', repo] : [];

  // `createGithubIssue` restituisce la issue ESISTENTE quando dedupla (ci
  // commenta sopra invece di aprirne una nuova). Ri-accodare quella issue
  // sarebbe attivamente dannoso: il drainer può averla già promossa ad
  // `agent:fix`, e rimetterle addosso `agent:fix-queued` la farebbe promuovere
  // una seconda volta. Si legge quindi lo stato prima di scrivere.
  const raw = gh(['issue', 'view', String(number), ...repoFlag, '--json', 'labels', '--jq', '[.labels[].name] | join(",")'], '');
  const current = new Set(String(raw || '').split(',').map((s) => s.trim()).filter(Boolean));
  const already = ROUTING_LABELS_ALREADY_SET.filter((l) => current.has(l));
  if (already.length) {
    console.log(`[generation-health] #${number} ha già ${already.join(', ')} → nessun re-routing.`);
    return;
  }

  const res = gh(['issue', 'edit', String(number), ...repoFlag,
    '--add-label', 'agent:fix-queued', '--add-label', 'fu-prio:high']);
  if (res === null) {
    console.warn(`::warning::[generation-health] routing di #${number} non applicato (label assenti? scope del token?) — il triage la riprenderà su \`issues: opened\`.`);
  } else {
    console.log(`[generation-health] #${number} → agent:fix-queued + fu-prio:high (la promuove il drainer, a slot libero).`);
  }
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY || process.env.GH_REPO || '';
  if (!repo) {
    console.error('[generation-health] GITHUB_REPOSITORY non impostato — esco senza fare nulla.');
    return 0;
  }
  const dryRun = flag('--dry-run');
  const commitLookback = Number(val('--commit-lookback-hours', '48'));
  const runLookback = Number(val('--run-lookback-hours', String(RUN_LOOKBACK_HOURS_DEFAULT)));
  const maxLogRuns = Number(val('--max-log-runs', String(MAX_LOG_RUNS_DEFAULT)));
  const maxIssues = Number(val('--max-issues', '3'));

  const measurements = {
    now: Date.now(),
    commits: collectCommits(repo, commitLookback),
    runs: await collectRunLogs(repo, { maxRuns: maxLogRuns, lookbackHours: runLookback }),
    corpus: collectCorpus(REPO_ROOT),
  };

  console.log(
    `[generation-health] commits=${measurements.commits.available ? measurements.commits.total : 'n/d'}`
    + ` runs=${measurements.runs.available ? measurements.runs.total : 'n/d'}`
    + ` corpus=${measurements.corpus.available ? measurements.corpus.total : 'n/d'}`
    + `${dryRun ? ' (dry-run)' : ''}`,
  );

  const verdicts = evaluateConditions(measurements);
  for (const v of verdicts) {
    console.log(`  · ${v.id}${v.section ? `[${v.section}]` : ''} → ${!v.available ? 'non-misurabile' : v.firing ? 'ACCESA' : 'spenta'}`);
  }

  await reconcile(verdicts, {
    createIssue: createGithubIssue,
    resolveIssue: resolveGithubIssue,
    routeIssue: routeToQueue,
    maxIssues,
    dryRun,
  });
  return 0;
}

// Solo in modalità CLI: senza la guardia, importare questo modulo da un test lo
// eseguirebbe — e questo script apre issue sul repo.
if (process.argv[1] && process.argv[1].endsWith('scan-generation-health.mjs')) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      // PROCEED-SAFE, come `scan-failed-runs.mjs`: un watchdog rotto non deve far
      // fallire il workflow che lo ospita, altrimenti diventa esso stesso il
      // fallimento ricorrente da segnalare.
      console.error(`[generation-health] errore non fatale: ${e && e.stack ? e.stack : e}`);
      process.exit(0);
    },
  );
}
