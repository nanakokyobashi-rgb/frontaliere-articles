/**
 * Due scadenze per un run di generazione (F3.A.5).
 *
 * - DURA (`hardMs`): il tetto cooperativo storico (`CREATE_ARTICLE_MAX_WALL_MS`,
 *   cap del workflow meno 60 s). Governa fact-check, traduzione, immagini e ogni
 *   run in convergenza: valeva cosi' prima di F3.A.5 e non cambia.
 * - MORBIDA (`softMs`, `CREATE_ARTICLE_SOFT_WALL_MS`, default 1380000): vale
 *   soltanto per APRIRE nuovi tentativi (altro topic, altra rigenerazione) e
 *   solo finche' NESSUNA bozza IT ha superato i gate deterministici. Appena una
 *   bozza li supera il run e' "in convergenza": la morbida smette di valere e
 *   restano la dura e il SIGTERM.
 *
 * Il modulo e' puro: orologio e flag di stop sono iniettati, cosi' il
 * comportamento si prova senza avviare create-article.
 */

export const DEFAULT_SOFT_WALL_MS = 1_380_000;

/** Intero positivo da env, oppure `fallback`. */
export function parseWallMs(raw, fallback) {
  const s = String(raw ?? '').trim();
  if (!/^[0-9]+$/.test(s)) return fallback;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/**
 * @param {{ startMs: number, hardMs: number, softMs?: number, now?: () => number, stopRequested?: () => boolean }} input
 */
export function createRunDeadline({
  startMs,
  hardMs,
  softMs = DEFAULT_SOFT_WALL_MS,
  now = Date.now,
  stopRequested = () => false,
}) {
  // La morbida non puo' superare la dura: con un cap corto le due coincidono.
  const effectiveSoftMs = Math.min(softMs, hardMs);
  let converging = false;
  let applied = null;

  const elapsedMs = () => now() - startMs;
  const note = (kind) => {
    if (applied === null) applied = kind;
    return true;
  };

  return {
    softMs: effectiveSoftMs,
    hardMs,
    /** Una bozza IT ha superato i gate deterministici. Irreversibile per il run. */
    markConverging() { converging = true; },
    get converging() { return converging; },
    /** La scadenza dura (o un SIGTERM cooperativo): vale per ogni fase. */
    hardExceeded() {
      if (stopRequested()) return note('sigterm');
      return elapsedMs() > hardMs ? note('hard') : false;
    },
    /** Puo' aprirsi un NUOVO tentativo? `true` = no, fermarsi con esito dichiarato. */
    newAttemptBlocked() {
      if (stopRequested()) return note('sigterm');
      const elapsed = elapsedMs();
      if (elapsed > hardMs) return note('hard');
      if (!converging && elapsed > effectiveSoftMs) return note('soft');
      return false;
    },
    /** Quale scadenza ha fermato il run (`soft`, `hard`, `sigterm`) o `null`. */
    get applied() { return applied; },
    snapshot() {
      return { softWallMs: effectiveSoftMs, hardWallMs: hardMs, draftPassedGates: converging, deadlineApplied: applied };
    },
  };
}
