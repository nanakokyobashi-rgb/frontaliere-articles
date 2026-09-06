/**
 * parse-positive-num.mjs — la lettura di un override numerico (argv o env),
 * unica per tutto il repo.
 *
 * ## Perché una libreria e non un `Number(env || default)` per chiamante
 *
 * `Number('tre')` è `NaN`, e ogni confronto con `NaN` è `false`. Un override
 * illeggibile non degrada al default: SPEGNE la regola che quel numero
 * governa, e la passata resta VERDE. Misurato su tre leve diverse dello stesso
 * repo (issue #871):
 *
 *   · `STRANDED_AFTER_DAYS=tre` → `ageDays >= NaN` sempre falso → la classe
 *     `stranded-twin` non viene più emessa. È l'unico canale che intercetta un
 *     gemello `identical` che nessun trasporto porterà mai: senza di lei il
 *     file resta indietro per sempre e nessun report lo dice.
 *   · `BLOG_INDEX_LIMIT=-5` → `entries.slice(0, -5)` → l'indice fast-path viene
 *     PUBBLICATO con cinque voci in meno. Il sito lo accetta senza errore e
 *     mostra meno di quello che c'è: un guasto della superficie pubblicata che
 *     non fallisce da nessuna parte.
 *   · `TRANSPORT_MAX_FILES=0.5` → `slice(0, 0.5)` è `slice(0, 0)`: zero file
 *     copiati, «niente da portare», verde. Un valore POSITIVO che spegne
 *     comunque il canale — la ragione per cui esiste l'opzione `integer`.
 *
 * Tre validazioni copiaincollate avrebbero coperto tre di questi casi e non il
 * quarto che nasce domani. Questo file è la sorgente unica: `tool` esiste
 * perché il prefisso del warning nomini chi ha davvero ignorato l'override,
 * altrimenti il log manda a leggere lo script sbagliato.
 *
 * ## Perché degrada al default invece di lanciare
 *
 * Il difetto da chiudere è «il gate si spegne», non «il gate rifiuta di
 * partire». Tornare al default RIARMA la regola al suo comportamento
 * documentato, mentre lanciare farebbe morire l'intera passata — il report
 * giornaliero, o la pubblicazione dell'indice — per un refuso in una variabile
 * di repository. L'intenzione tradita non resta però muta: `::warning::` è
 * un'annotazione visibile sulla run, e dice a chiare lettere che il
 * comportamento comprato NON è attivo.
 *
 * ## `sentinels`: i valori non positivi che in UN chiamante vogliono dire qualcosa
 *
 * "Positivo" è la regola giusta per una durata o un conteggio, non per una leva
 * a tre stati. `--gate -1` disattiva il gate di ricorrenza di
 * `scan-failed-runs.mjs`: rifiutarlo come "non positivo" ha reso quella leva
 * inesistente da CLI (#811 item 6). I sentinel vanno DICHIARATI dal chiamante,
 * uno per leva: un `-1` accettato ovunque riaprirebbe il buco su
 * `--lookback-min`, dove non significa niente.
 *
 * ## Il gemello del sito: non esiste, e non deve
 *
 * La voce di `scripts/ci/loop-sync-manifest.json` e' `corpus-only`, non
 * `corpus-only-pending`: il sito copre la STESSA classe con
 * `scripts/lib/int-from-env.mjs` — `intFromEnv` (assente/vuota → default in
 * silenzio, illeggibile → default + `::warning::`) e `positiveIntFromEnv`, che
 * rifiuta anche lo zero e i negativi (valerielinc-ops/frontaliere-si-o-no#7610,
 * mergiata il 2026-09-06, sui call site che finiscono in uno `slice` o nel passo
 * di un `for`). Portare QUESTO file di la' darebbe due sorgenti per la stessa
 * validazione, che e' il difetto vietato da AGENTS.md #6. La misura della issue
 * #884 («zero equivalenti sul sito») cercava solo
 * `parsePositiveNum|parsePositiveInt|readPositiveEnv|envPositive`, e l'helper
 * del sito si chiama diversamente: prima di riaprire il debito, cerca la
 * FUNZIONE, non il nome.
 *
 * @param {unknown} raw valore grezzo (argv o env)
 * @param {number} fallback default da usare se `raw` è assente o illeggibile
 * @param {{label: string, warn?: (msg: string) => void, sentinels?: number[], tool?: string, integer?: boolean}} opts
 * @returns {number} il valore, il sentinel, o `fallback`
 */
export function parsePositiveNum(
  raw,
  fallback,
  { label, warn = console.warn, sentinels = [], tool = 'scan-failed-runs', integer = false } = {},
) {
  const n = Number(raw);
  // `integer` non è pedanteria: un conteggio frazionario passa il test
  // "positivo" e poi viene TRONCATO dal consumatore (`slice`, `>=` su un
  // indice), quindi `0.5` vale zero e il canale si spegne restando verde.
  const shaped = Number.isFinite(n) && n > 0 && (!integer || Number.isInteger(n));
  if (shaped) return n;
  // `Number('')` e' 0 e `Number(null)` pure: il sentinel si concede solo a un
  // valore davvero presente, altrimenti "leva non tirata" diventerebbe "leva
  // tirata a 0" per qualunque sentinel che valga 0.
  const present = raw !== undefined && raw !== null && String(raw).trim() !== '';
  if (present && Number.isFinite(n) && sentinels.includes(n)) return n;
  if (present) {
    warn(
      `::warning::[${tool}] ${label}=${String(raw)} non e' un numero ${integer ? 'intero ' : ''}positivo`
        + `${sentinels.length ? ` ne' uno dei valori speciali ammessi (${sentinels.join(', ')})` : ''} — `
        + `override IGNORATO, si prosegue col default ${fallback}. `
        + 'Attenzione: il comportamento che stavi comprando NON e\' attivo.',
    );
  }
  return fallback;
}
