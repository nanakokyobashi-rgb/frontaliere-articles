/**
 * Piano dei giri di fact-check dentro la finestra che resta al run.
 *
 * ── IL GUASTO CHE QUESTO MODULO CHIUDE ─────────────────────────────────────
 * Il 27-28/11/2026 il 33% dei run di generazione (22 su 72 nel campione F4.0)
 * ha perso l'articolo per «Codex auth broker socket timed out»: Codex Luna era
 * l'unico verificatore capace di dare un voto e il fact-check non riceveva mai
 * un verdetto. Non era il broker: nei log (runs 46013453578, 46026931413,
 * 46031258981, 46061738535, 46071772492, 46096712400, 46108602728) l'errore
 * arriva sempre a `deadlineMs` del giro, mentre il processo Codex e' ancora in
 * esecuzione ("in-flight 120s (hard cap 139s)", "60s (hard cap 100s)"). Con
 * `started=true` il client misura `timeoutMs = scadenza - adesso` e il watchdog
 * assoluto del chiamante scatta prima della risposta del broker.
 *
 * La finestra era troppo corta per Codex: un fact-check da ~9k token di prompt
 * richiede 90-230 s (verdetti arrivati a 90-142 s nei log), ma la finestra
 * residua del run (~7 minuti dopo 3-6 rigenerazioni) veniva spezzata in 3 giri
 * da `FACTCHECK_MIN_ROUND_MS = 15 s` ciascuno: ogni giro dava a Codex 80-250 s
 * condivisi col verificatore indipendente, lo uccideva a meta' e consumava la
 * finestra. Il numero di giri contava la finestra in multipli di 15 s, il tempo
 * minimo di un verificatore libero, non di Codex.
 *
 * Qui il numero di giri si calcola con il tempo minimo del verificatore piu'
 * lento presente nel roster: se Codex e' tra i verificatori, un giro vale
 * almeno `CODEX_FACTCHECK_ROUND_MS`; sotto quella soglia c'e' un solo giro con
 * tutta la finestra. Il gate non cambia: niente verdetto, niente pubblicazione.
 */

export const FACTCHECK_MIN_ROUND_MS = 15_000;
export const FACTCHECK_FINAL_RESERVE_MS = 30_000;
export const FACTCHECK_MAX_FINAL_RESERVE_MS = 45_000;
export const FACTCHECK_INFRA_RETRIES = 3;
/** Tempo oltre il quale una chiamata Codex di fact-check non e' piu' attesa a vuoto (p90 osservato ~230 s). */
export const CODEX_FACTCHECK_ROUND_MS = 240_000;

/**
 * @param {number} initialFactCheckMs finestra totale del fact-check (ms)
 * @param {{ codexVerifier?: boolean, infraRetries?: number, codexRoundMs?: number }} [options]
 * @returns {{ finalReserveMs: number, maxPrimaryRounds: number, minRoundMs: number }}
 */
export function planFactCheckRounds(initialFactCheckMs, options = {}) {
  const { codexVerifier = false, infraRetries = FACTCHECK_INFRA_RETRIES, codexRoundMs = CODEX_FACTCHECK_ROUND_MS } = options;
  const window = Number.isFinite(initialFactCheckMs) ? Math.max(0, initialFactCheckMs) : 0;
  const finalReserveThreshold = FACTCHECK_MIN_ROUND_MS + FACTCHECK_FINAL_RESERVE_MS;
  const finalReserveMs = window >= finalReserveThreshold
    ? Math.min(
      FACTCHECK_MAX_FINAL_RESERVE_MS,
      window - FACTCHECK_MIN_ROUND_MS,
      Math.max(FACTCHECK_FINAL_RESERVE_MS, Math.floor((window - 60_000) / 4)),
    )
    : 0;
  const minRoundMs = codexVerifier ? Math.max(FACTCHECK_MIN_ROUND_MS, codexRoundMs) : FACTCHECK_MIN_ROUND_MS;
  const maxPrimaryRounds = Math.min(
    infraRetries,
    Math.max(1, Math.floor((window - finalReserveMs) / minRoundMs)),
  );
  return { finalReserveMs, maxPrimaryRounds, minRoundMs };
}

/** Giri ancora sostenibili con `remainingMs`: mai piu' dei restanti, mai meno di uno. */
export function remainingFactCheckRounds(remainingMs, roundsLeft, minRoundMs = FACTCHECK_MIN_ROUND_MS) {
  return Math.min(roundsLeft, Math.max(1, Math.floor(remainingMs / minRoundMs)));
}
