/**
 * sanitize-body-braces.mjs — la graffa spaiata che non deve finire in `content/`.
 *
 * Estratto da `create-article.mjs` (dove viveva come funzione privata) quando
 * un secondo scrittore di body ne ha avuto bisogno:
 * `retranslate-blocking-bodies.mjs` ri-traduce body gia' pubblicati e scrive lo
 * stesso identico tipo di output — l'uscita di `translateFieldFreeMt` — che il
 * percorso di generazione sanifica qui. Senza l'estrazione le due strade
 * avrebbero avuto due idee diverse di cosa e' scrivibile, che e' precisamente
 * il modo in cui una delle due torna a pubblicare il difetto (AGENTS.md #6: una
 * costante o una regola in due file diventa un modulo solo).
 *
 * Perche' NON sta in `lib/article-sanitizers.mjs`, che sarebbe il vicinato
 * naturale: quel file e' `identical` in `scripts/ci/loop-sync-manifest.json`,
 * quindi aggiungerci un export dal corpus creerebbe `corpus-ahead` e il drift
 * check diventerebbe rosso. La sorgente di un `identical` e' il sito. Questo
 * modulo e' invece assente dal manifest — nessun vincolo di mirror — ed e'
 * consumato solo dai due scrittori del corpus.
 *
 * Il difetto che intercetta, verbatim dal commento originale:
 *
 *   L'LLM produce occasionalmente `}` spaiate — tipicamente a fine frase, dove
 *   una virgoletta bassa tedesca („ ") e' stata chiusa male con `}`. Il body di
 *   un articolo e' markdown puro e non deve mai contenere graffe sbilanciate;
 *   quando passano (a) rompono i parser non-string-aware e (b) si vedono rotte
 *   nell'articolo renderizzato.
 *
 * Vale per la cascata MT esattamente come per l'LLM: e' la stessa classe di
 * chiusura mal fatta, e sul tedesco e' il caso tipico.
 */

/**
 * Toglie le graffe spaiate lasciando intatte le coppie bilanciate.
 *
 * Strategia (invariata rispetto alla copia privata che sostituisce):
 *   - percorre il testo tenendo la profondita' di `{`
 *   - scarta ogni `}` che arriva con profondita' gia' 0
 *   - lascia intatte le coppie `{...}` (ancore, placeholder)
 *   - se restano `{` non chiuse, toglie anche quelle
 *
 * @param {string} s
 * @param {(msg: string) => void} [log] dove finisce l'avviso. Iniettabile per i
 *   test: il default resta `console.error`, cioe' il comportamento originale.
 * @returns {string}
 */
export function sanitizeBodyText(s, log = (m) => console.error(m)) {
  if (typeof s !== 'string' || s.length === 0) return s;
  const out = [];
  let depth = 0;
  let droppedCount = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') {
      depth++;
      out.push(ch);
    } else if (ch === '}') {
      if (depth === 0) {
        droppedCount++;
        continue; // stray — skip
      }
      depth--;
      out.push(ch);
    } else {
      out.push(ch);
    }
  }
  // Se le graffe restano sbilanciate (piu' `{` che `}`), si tolgono anche le
  // aperture non chiuse: lascerebbero una graffa aperta nella stringa TS
  // serializzata, capace di nascondere problemi a valle.
  if (depth > 0) {
    let i = out.length - 1;
    let toStrip = depth;
    while (i >= 0 && toStrip > 0) {
      if (out[i] === '{') {
        out[i] = '';
        toStrip--;
      }
      i--;
    }
    droppedCount += depth;
  }
  if (droppedCount > 0) {
    log(`    ⚠️  sanitizeBodyText: removed ${droppedCount} stray brace char(s)`);
  }
  return out.join('');
}
