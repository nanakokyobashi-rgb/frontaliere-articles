/**
 * Firebase Auth persistence key — la metà `host/` di
 * `frontaliere-si-o-no/services/firebaseAuthPersistence.ts`.
 *
 * ## Cosa e' questa chiave, e perche' serve al contratto
 *
 * Firebase Auth persiste la sessione del browser sotto
 * `firebase:authUser:<Web API key>:[DEFAULT]`. Il registro Offerwall
 * trasportato in `host/constants.ts` legge un marker esplicito scritto da
 * authService, così la shell statica non deve conoscere la chiave del progetto
 * né confondere la sessione di un altro progetto Firebase.
 *
 * ## Perche' la chiave NON sta in questo file
 *
 * Perche' e' stata inlinata una volta e non si puo' piu' togliere dalla storia.
 * La PR #1315 (2026-09-10) ha scritto la Web API key come letterale in
 * `host/constants.ts` — con la CI verde, perche' era una costante di stringa
 * come le altre — e il secret scanning di GitHub ha aperto l'alert su
 * `host/constants.ts#L66` (commit c9bc65a4) quando ormai era pubblica.
 *
 * Il sito NON la inlina. Il codice applicativo può chiamare
 * `getFirebaseAuthPersistenceKey()` quando deve restringere la ricerca; il valore arriva da
 * `import.meta.env.VITE_FIREBASE_API_KEY`. Qui vale la stessa regola di
 * `AGENTS.md` § Credenziali: il valore vive in Firebase Remote Config e
 * arriva a `process.env` per l'unica strada che questo repo ha,
 * `generator/scripts/load-rc-env.mjs` (parametro `FIREBASE_API_KEY` →
 * `FIREBASE_API_KEY`/`VITE_FIREBASE_API_KEY`).
 *
 * ## Cosa succede quando l'ambiente non ce l'ha, che e' il punto delicato
 *
 * Il sito ha un fallback offuscato (XOR+base64) che rende la chiave SEMPRE
 * disponibile; qui non c'e', ed e' voluto: un fallback offuscato e' la stessa
 * chiave con un giro in piu', aggirerebbe `scripts/ci/scan-hardcoded-secrets.mjs`
 * per costruzione, e rimetterebbe nel repo cio' che questo file esiste per
 * togliere.
 *
 * Senza chiave questa funzione rende **stringa vuota**, e ogni chiamante DEVE
 * trattarla come «non la so» invece di emettere una lookup su `''` — che
 * tornerebbe sempre `null` e negherebbe l'accesso a ogni utente autenticato.
 * La shell trasportata in `host/constants.ts` usa il marker esplicito; il
 * comportamento resta quindi indipendente dalla configurazione runtime anche
 * quando questo helper non viene chiamato.
 */

/** Nome dell'app Firebase di default, la sola che il sito inizializzi. */
const DEFAULT_FIREBASE_APP_NAME = '[DEFAULT]';
export const FIREBASE_AUTH_SESSION_MARKER_KEY = 'frontaliere:auth-session';

/**
 * La Web API key, da Remote Config via `load-rc-env.mjs`. `VITE_` per primo:
 * e' il nome con cui la legge il sito, quindi un ambiente preparato per il
 * build del sito funziona qui senza aggiungere niente.
 *
 * @returns {string} la chiave, o `''` se l'ambiente non ce l'ha.
 */
export function getFirebaseApiKey(): string {
  const raw = process.env.VITE_FIREBASE_API_KEY || process.env.FIREBASE_API_KEY || '';
  return raw.trim();
}

/**
 * @returns {string} `firebase:authUser:<key>:[DEFAULT]`, o `''` se la chiave
 * non e' nell'ambiente — vedi l'intestazione: `''` significa «non la so», mai
 * «cerca la stringa vuota».
 */
export function getFirebaseAuthPersistenceKey(): string {
  const apiKey = getFirebaseApiKey();
  if (!apiKey) return '';
  return `firebase:authUser:${apiKey}:${DEFAULT_FIREBASE_APP_NAME}`;
}
