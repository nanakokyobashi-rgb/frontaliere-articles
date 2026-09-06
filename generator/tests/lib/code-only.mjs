// Lo stripping dei commenti su cui gira il censimento dei choke-point
// (`corpus-write-atomic.test.mjs`). Vive qui, e non piu' come closure dentro
// quel test, per una ragione precisa: e' la parte che puo' rendere il
// censimento CIECO restando verde, e finche' era una closure l'unica prova
// che aveva era l'assertion `blind` sui nove file gia' pinnati — cioe' non
// copriva il caso per cui il censimento esiste, il file NUOVO.
//
// Asimmetria di costo, invariata dal round 2: togliere troppo perde un
// choke-point vero in silenzio, togliere troppo poco lascia solo rumore.
// Quindi si toglie SOLO il commento che occupa la riga intera, e mai dentro
// un template literal.
//
// #922 item 4: la macchina a stati precedente decideva sul `trim()` della
// riga, senza sapere se quella riga fosse dentro un backtick. Questi script
// emettono il corpo `.ts` del corpus VIA template literal: la prima riga
// emessa che dentro un backtick inizia con `//` o `/*` faceva sparire un
// match vero. Da qui il tracking di `inTemplate`, che e' l'unico motivo per
// cui esiste `scanLine()`.

// Percorre una riga aggiornando lo stato che sopravvive al newline: dentro un
// template literal, e blocco `/* … */` lasciato aperto a fine riga. Salta i
// caratteri escapati e il contenuto di stringhe '…' / "…", cosi' un backtick
// o un `//` dentro una stringa (un URL, per dire) non sposta lo stato.
//
// Non c'e' riconoscimento dei literal regex, e la scelta e' deliberata: un
// backtick dentro una regex apre un template fantasma, e l'effetto e' che si
// smette di togliere commenti — la direzione innocua. Il contrario (perdere
// codice) non e' raggiungibile da qui.
const scanLine = (line, state) => {
  let inTemplate = state.inTemplate;
  let inBlock = state.inBlock;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') { i++; continue; }
    if (inBlock) {
      if (c === '*' && line[i + 1] === '/') { inBlock = false; i++; }
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (inTemplate) {
      if (c === '`') inTemplate = false;
      continue;
    }
    if (c === '`') { inTemplate = true; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '/' && line[i + 1] === '/') return { inTemplate, inBlock: false };
    if (c === '/' && line[i + 1] === '*') { inBlock = true; i++; continue; }
  }
  // Una stringa non chiusa a fine riga non esiste in JS: se `quote` e' ancora
  // aperto abbiamo letto male (tipicamente un apostrofo dentro una regex), e
  // lo stato si azzera da solo alla riga dopo invece di propagare l'errore.
  return { inTemplate, inBlock };
};

/**
 * Sostituisce con righe vuote i soli commenti a riga intera, preservando il
 * numero di righe e ogni carattere di codice. Il resto di una riga che CHIUDE
 * un blocco viene mantenuto: `/* x *\/ const p = 'blog-body'` conserva il
 * codice a destra invece di sparire tutto.
 */
export const codeOnly = (src) => {
  const out = [];
  let state = { inTemplate: false, inBlock: false };
  for (const line of src.split('\n')) {
    if (state.inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) { out.push(''); continue; }
      const rest = line.slice(end + 2);
      state = scanLine(rest, { inTemplate: state.inTemplate, inBlock: false });
      out.push(rest);
      continue;
    }
    const t = line.trim();
    if (!state.inTemplate && t.startsWith('//')) { out.push(''); continue; }
    if (!state.inTemplate && t.startsWith('/*')) {
      const end = line.indexOf('*/');
      if (end === -1) { state = { ...state, inBlock: true }; out.push(''); continue; }
      const rest = line.slice(end + 2);
      state = scanLine(rest, { inTemplate: state.inTemplate, inBlock: false });
      out.push(rest);
      continue;
    }
    state = scanLine(line, state);
    out.push(line);
  }
  return out.join('\n');
};

// Specificatori di import RELATIVI, in ogni forma che il repo usa davvero.
//
// #922 item 1: la versione precedente agganciava solo `from '…'`, cioe' i soli
// import statici. Un `await import('./lib/…')` era invisibile — e la forma
// esiste gia' nel repo (`generator/scripts/load-rc-env.mjs`). Un choke-point
// che raggiungesse per import dinamico il modulo che definisce il path
// pubblicato usciva dal censimento in silenzio: e' meta' del buco che #571
// voleva chiudere.
export const RELATIVE_IMPORT_SPEC =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](\.[^'"]+)['"]/g;
