/**
 * fixer-slot.mjs — UNA sorgente per "quante run del fixer sono in volo".
 *
 * Perché esiste (#974, item 3). Fino a #908 `issue-fix.yml` aveva una
 * `concurrency` a chiave COSTANTE: un solo fixer per volta, garantito da
 * GitHub. Su quell'invariante poggia tutto il resto del ciclo — la coda
 * `agent:fix-queued`, il drainer che promuove "una alla volta a slot libero",
 * e la logica di quota, che ragiona sull'issue in lavorazione **al singolare**
 * (`check-quota-backoff.mjs`) e chiude la porta solo DOPO che un 429 è stato
 * osservato.
 *
 * #908 ha spostato la chiave a `issue-fix-<numero issue>` — necessario, perché
 * la chiave costante sfrattava le pending (73 run `cancelled` in un giorno) —
 * ma con essa è sparita la mutua esclusione FRA issue diverse. Il drainer
 * continua a rispettarla per le proprie promozioni (`inFlightFixCount() === 0`),
 * mentre nulla la impone a una label `agent:fix` apposta a mano o instradata
 * direttamente da `issue-triage` (categoria `publish`): due fixer vivi sulla
 * stessa quota Claude condivisa col sito, che è esattamente ciò che la coda
 * esiste per evitare.
 *
 * Questo modulo tiene le parti PURE (statuti in volo, nome del workflow,
 * filtro di precedenza) in un posto solo: il gate `check-fixer-slot.mjs` e
 * `followup-drainer.mjs` devono contare la stessa cosa, o la coda e il gate si
 * raccontano due storie diverse sullo stesso slot (AGENTS.md #6).
 */

/** Gli status che GitHub considera "run viva". Un `waiting` (approvazione
 * ambiente) non esiste su questi workflow; se un giorno esistesse, andrebbe
 * qui — non in una lista parallela nel chiamante. */
export const IN_FLIGHT_STATUSES = ['queued', 'in_progress'];

/** I due stadi Claude del ciclo issue, ognuno col PROPRIO slot: il drainer li
 * conta separatamente (`inFlightFixCount` / `inFlightDecomposeCount`) e una
 * decomposizione in corso non blocca un fix. Restano separati anche qui. */
export const FIX_WORKFLOW_FILE = 'issue-fix.yml';
export const DECOMPOSE_WORKFLOW_FILE = 'issue-decompose.yml';

/**
 * Il file di workflow della run corrente, da `GITHUB_WORKFLOW_REF`
 * (`owner/repo/.github/workflows/<file>@refs/heads/<branch>`). Serve perché lo
 * stesso gate è invocato da `issue-fix.yml` e da `issue-decompose.yml`, e
 * ciascuno deve cedere il passo solo ai propri gemelli.
 * @param {string|undefined} ref
 * @returns {string} il basename, o '' se il ref è assente/illeggibile.
 */
export function workflowFileFromRef(ref) {
  if (typeof ref !== 'string' || !ref) return '';
  const withoutGitRef = ref.split('@')[0];
  const base = withoutGitRef.split('/').pop() || '';
  return /\.ya?ml$/.test(base) ? base : '';
}

/**
 * Le run che hanno PRECEDENZA su quella corrente: stesse condizioni di volo,
 * `databaseId` strettamente MINORE.
 *
 * Il `<` stretto non è un dettaglio, è ciò che rende il gate deadlock-free.
 * Con "cedi se ce n'è un'altra viva" due run che si vedono a vicenda si
 * ri-accodano entrambe e nessuna lavora (livelock, e la coda resta piena).
 * Gli id di run sono un ordine totale monotòno per repo, quindi cedere solo
 * alle PIÙ VECCHIE lascia sempre esattamente una run — la minima — che non
 * cede a nessuno: il progresso è garantito per costruzione, non per fortuna.
 *
 * Escludere la run corrente è implicito: il suo id non è minore di sé stesso.
 *
 * @param {Array<{databaseId?:number}>} runs run già filtrate per status/workflow
 * @param {number} selfRunId id della run corrente
 * @returns {number[]} gli id che precedono, dal più vecchio
 */
export function precedingRunIds(runs, selfRunId) {
  if (!Array.isArray(runs) || !Number.isFinite(selfRunId)) return [];
  return runs
    .map((r) => (r && Number.isFinite(r.databaseId) ? r.databaseId : null))
    .filter((id) => id !== null && id < selfRunId)
    .sort((a, b) => a - b);
}
