/**
 * ── COSA FARE DI UNA CASCATA CHE SI E' SVUOTATA (issue #313 / #348) ─────────
 *
 * `callLLM()` lancia `code = 'ALL_MODELS_EXHAUSTED'` ogni volta che la catena
 * si svuota, QUALUNQUE sia la ragione. Chi la riceve deve decidere una cosa
 * sola: aspettare, o gridare. Questo modulo e' quella decisione, e sta in un
 * file suo per un motivo preciso — `create-article.mjs` non e' importabile da
 * un test (761 KB, e la prima cosa che fa e' una chiamata di rete), quindi una
 * regola scritta la' dentro e' verificabile solo leggendo il sorgente come
 * testo. Qui invece `node --test` la esegue davvero.
 *
 * IL DIFETTO CHE HA RESO NECESSARIO IL MODULO. `isQuotaExhaustedError()` si
 * fida di `err.transientExhaustion`, che `classifyExhaustionCause()` calcola
 * come `transient >= persistent`: un voto di MAGGIORANZA sulle ragioni di
 * fallimento, con il PAREGGIO che va al transitorio. Accanto a quel calcolo
 * c'e' pero' un invariante dichiarato piu' forte del voto:
 *
 *   «The input-cap class stays PERSISTENT on purpose … a prompt larger than
 *    every declared cap does not get smaller at the next quota window, so
 *    deferring on it would loop forever and swallow the alert.»
 *
 * Niente teneva insieme le due cose, e il voto ha vinto. MISURATO sulla run
 * 31817957722 del 2026-08-14, ricontando i 107 errori del messaggio aggregato
 * con le stesse due regex di `classifyExhaustionCause`:
 *
 *     transient = 53   persistent = 53   ambiguo = 1
 *     di cui rifiuti su input cap = 38
 *     → 53 >= 53 → transientExhaustion = true → exit 0 → run VERDE
 *
 * Un pareggio esatto. Il ramo di differimento ha poi stampato «tutti i modelli
 * AI gratuiti sono temporaneamente esauriti (quota giornaliera)», che era
 * falso: i modelli non venivano chiamati, venivano SALTATI dal pre-flight
 * perche' il prompt (~9740 token stimati) superava il cap piu' permissivo del
 * roster (8000). Nessuna finestra di quota rimpicciolisce un prompt, quindi il
 * run successivo ha rifatto identico: 60+ run `success` di fila senza un
 * articolo, dalle 06:06Z alle 16:30Z, e nessuna «Workflow Failure» perche'
 * `scan-failed-runs.mjs` raccoglie solo le run `failure`.
 */

/**
 * Exit code dedicato: «il roster non puo' servire questo prompt».
 *
 * Non un generico `1`. Serve al chiamante — lo step «Generate the article» di
 * `.github/workflows/generate-article.yml` — per distinguere QUESTA condizione
 * da tutte le altre uscite non-zero, che quello step assorbe deliberatamente
 * come `no-article-this-run` (una fonte inadatta, un rigetto di qualita': sono
 * esiti normali, e farli fallire spegnerebbe la catena).
 *
 * Il branch la' e' scritto sul CODICE DI USCITA e non su una stringa dello
 * stdout: quel flusso e' pieno di sequenze ANSI e di virgolette tipografiche, e
 * un `grep` su di esso e' un oracolo che si acceca senza dirlo.
 *
 * 3 e non 2: `node` usa 1 per un'eccezione non gestita e 2 per un uso errato
 * della CLI, quindi il primo codice libero e non ambiguo e' 3.
 */
export const EXIT_ROSTER_CANNOT_SERVE_PROMPT = 3;

/**
 * Vero quando differire sarebbe un ciclo infinito: la cascata si e' svuotata e
 * almeno un modello ha rifiutato il payload sulla TAGLIA.
 *
 * LA REGOLA, e perche' e' formulata cosi'. Quando `inputCapReport` esiste — e
 * `callLLM` lo popola esattamente quando ≥1 modello ha rifiutato su input cap —
 * il pareggio non va piu' al transitorio: serve che il transitorio superi
 * STRETTAMENTE il persistente per poter differire. E' l'inversione minima del
 * `>=` che ha prodotto il verde, e lascia il comportamento IDENTICO su ogni
 * cascata senza rifiuti su taglia: li' il pareggio continua a differire, com'e'
 * giusto, perche' quelle ragioni si curano da sole a mezzanotte UTC.
 *
 * NON e' «piu' rosso per prudenza»: e' che le due classi hanno rimedi diversi e
 * incompatibili. Una quota si aspetta; un prompt sopra ogni cap si accorcia, e
 * finche' nessuno lo accorcia la condizione e' stabile per costruzione. Il
 * falso rosso costa una issue; il falso verde e' costato dieci ore di silenzio.
 *
 * @param {unknown} err l'errore risalito fino al catch di primo livello
 * @returns {boolean} true → uscire con EXIT_ROSTER_CANNOT_SERVE_PROMPT
 */
export function isInputCapDeferralVeto(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code !== 'ALL_MODELS_EXHAUSTED') return false;
  const cap = err.inputCapReport;
  if (!cap || typeof cap !== 'object') return false;
  if (!(Number(cap.count) > 0)) return false;
  const breakdown = err.exhaustionBreakdown || {};
  const transient = Number(breakdown.transient) || 0;
  const persistent = Number(breakdown.persistent) || 0;
  // Il pareggio passa al PERSISTENTE: `>` e non `>=` — esattamente il confronto
  // di classifyExhaustionCause, invertito sul solo caso di parita'.
  return !(transient > persistent);
}

/**
 * La riga che dice al chiamante DI QUANTO tagliare. Separata dal predicato
 * perche' il numero e' l'unica cosa azionabile e non deve dipendere dal fatto
 * che qualcuno legga il messaggio lungo.
 */
export function inputCapVetoSummary(err) {
  const cap = (err && err.inputCapReport) || {};
  const est = Number(cap.estimatedRequestTokens) || 0;
  const best = Number(cap.maxSkippedReqLimit) || 0;
  return {
    estimatedRequestTokens: est,
    maxSkippedReqLimit: best,
    over: est - best,
    refusals: Number(cap.count) || 0,
  };
}
