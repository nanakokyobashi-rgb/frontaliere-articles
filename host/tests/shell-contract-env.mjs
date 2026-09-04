/**
 * Normalizzazione dell'ambiente per i gate che PINNANO `SiteShellContract`.
 *
 * ## Il difetto che chiude (follow-up di #764, issue #788)
 *
 * `host/shell-contract-fingerprint.json` registra lo SHA-256 della metà scalare
 * del contratto, e i due repo lo asseriscono entrambi: è il gate che tiene
 * insieme le due metà. Ma uno dei 22 scalari — `cdnPreconnectHint` — non è un
 * letterale: `host/constants.ts` lo deriva da `process.env.ASSET_CDN` dentro
 * una IIFE valutata al PRIMO import del modulo. Il digest quindi non è una
 * funzione della sorgente, è una funzione della sorgente E dell'ambiente:
 *
 *   senza `ASSET_CDN`                            → a8d61011… (il valore registrato)
 *   con `ASSET_CDN=https://cdn.frontaliereticino.ch` → 297c380c…
 *
 * Nel secondo caso il test fallisce dicendo «host chrome drifted from the main
 * repo», che è una diagnosi FALSA: nessuno dei due lati si è mosso. Oggi nessuno
 * step esporta quella variabile prima dei test di `host/`, ma niente lo pinna —
 * e `scripts/publish-article-fast.mjs` la imposta di proposito (`ASSET_CDN =
 * CDN_BASE`, richiesto per la byte-identity), quindi la variabile è già di casa
 * in questo repo. Un gate che accusa l'altro repo quando cambia l'ambiente del
 * runner insegna a non credergli, ed è il modo in cui un gate muore.
 *
 * ## Perché normalizzare e non escludere lo scalare
 *
 * L'alternativa era togliere `cdnPreconnectHint` dagli scalari fingerprintati:
 * cambierebbe `scalarFields` (22 → 21) e il digest, e il digest va ri-registrato
 * nei DUE repo nella stessa modifica coordinata — che da qui non si può fare.
 * Azzerare l'ambiente lascia il digest esattamente dov'è (il valore registrato È
 * quello con hint vuoto) e rende il gate deterministico: stessa sorgente,
 * stesso verdetto, su qualunque runner.
 *
 * ## Perché una sola variabile
 *
 * `ASSET_CDN` è l'unica letta da `host/` che raggiunga la superficie pinnata.
 * Le altre due sono state verificate e NON la raggiungono:
 *   · `WRITE_COLLISION_MODE` (`host/sharedWriteRegistry.ts`) è letta per
 *     chiamata dentro `currentMode()`, e la probe di
 *     `shell-contract-functions.test.mjs` pinna solo la forma di
 *     `WriteCollector` (typeof add/flush, `skippedByHash` iniziale);
 *   · `BUILD_LOCALE` (`host/shared/localeEmitFilter.ts`) non è raggiunta dal
 *     contratto.
 * Se un domani un valore del contratto ne leggesse una nuova, va aggiunta QUI:
 * questa lista è la dichiarazione di quali variabili possono muovere il digest,
 * ed è l'unico posto in cui vive (AGENTS.md #6).
 */

/** Le variabili d'ambiente che `host/` legge e che raggiungono il contratto. */
export const CONTRACT_ENV_KEYS = ['ASSET_CDN'];

/**
 * Azzera l'ambiente PRIMA del primo import di `host/siteShellBootstrap.ts`.
 *
 * DEVE essere chiamata al top level del file di test, non dentro il `test()`:
 * la valutazione del modulo è cachata per processo, quindi un `delete` dopo il
 * primo import è un no-op silenzioso — esattamente la trappola documentata in
 * `scripts/publish-article-fast.mjs` per il caso opposto (impostarla troppo
 * tardi).
 */
export function normalizeContractEnv() {
  for (const key of CONTRACT_ENV_KEYS) delete process.env[key];
}
