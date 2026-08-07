/**
 * githubApiHeaders.mjs — SINGLE SOURCE degli header per la GitHub REST API v3.
 *
 * ADATTAMENTO DICHIARATO rispetto al sito (vedi `scripts/ci/loop-sync-manifest.json`,
 * voce `githubApiHeaders`). Sul sito questo file è un re-export di tre righe da
 * `functions/src/githubApiHeaders.js`, perché lì il builder canonico deve finire
 * dentro il bundle delle Cloud Functions (`githubProxy.js` lo importa) ed essere
 * caricabile anche dal pannello admin nel browser.
 *
 * Questo repo non ha `functions/`, non deploya Cloud Functions e non ha un
 * frontend: quel vincolo non esiste. Portare lo shim avrebbe richiesto di
 * portare anche `functions/src/` — cioè un albero che qui non ha nessun altro
 * consumatore — quindi l'implementazione è inline.
 *
 * La conseguenza da conoscere: `X-GitHub-Api-Version` ora esiste in DUE copie,
 * una per repo. È esattamente il tipo di divergenza che il drift detector
 * (`loop-drift-check.mjs`) è fatto per sorvegliare — la voce nel manifest
 * dichiara l'adattamento come intenzionale ma confronta comunque il VALORE
 * della versione API, così un pin che cambia solo da un lato viene segnalato.
 */

export const GITHUB_API_VERSION = '2022-11-28';

/**
 * @param {string} token - Bearer token (PAT / App installation token / OAuth token)
 * @param {Record<string, string>} [extra] - header aggiuntivi, mergiati per ultimi
 * @returns {Record<string, string>}
 */
export function githubApiHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    ...extra,
  };
}
