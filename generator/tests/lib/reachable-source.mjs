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

import fs from 'node:fs';
import path from 'node:path';

// Percorre una riga aggiornando lo stato che sopravvive al newline: la pila dei
// contesti (template literal e interpolazioni `${…}`) e il blocco `/* … */`
// lasciato aperto a fine riga. Salta i caratteri escapati e il contenuto di
// stringhe '…' / "…", cosi' un backtick o un `//` dentro una stringa (un URL,
// per dire) non sposta lo stato.
//
// La pila serve perche' un template vero contiene interpolazioni, e dentro
// un'interpolazione si torna a CODICE: `${x ? 'a ` b' : ''}` ha un backtick
// dentro una stringa normale, e contarlo come toggle desincronizza tutto il
// resto del file. Su `create-article.mjs` succedeva davvero, e l'effetto era
// che un centinaio di righe di commento veniva letto come testo emesso.
//
// Non c'e' riconoscimento dei literal regex: un backtick dentro una regex apre
// un template fantasma, e da li' in poi la parita' e' invertita. NON e' una
// direzione innocua per costruzione — il PROSSIMO backtick, quello di un
// template VERO, chiude il fantasma, quindi il corpo del template vero viene
// letto come CODICE e le sue righe emesse che iniziano con `//` o `/*` vengono
// azzerate: perdere codice E' raggiungibile da qui. Il meccanismo e' gia' vivo
// nel repo (`generator/scripts/lib/llm-payload-diagnostics.mjs:87`, `/```+\s*$/`).
// Quello che rende sicura la direzione non e' il riconoscimento delle regex —
// che richiederebbe l'euristica sul token precedente, e sbaglia nella direzione
// pericolosa — ma il fail-safe di fine file in `codeOnly()`: se lo scan finisce
// desincronizzato, quel file non viene strippato affatto.
const scanLine = (line, state) => {
  const stack = state.stack.slice();
  let inBlock = state.inBlock;
  let quote = null;
  const top = () => stack[stack.length - 1];
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    // L'escape si valuta DOPO il blocco: dentro `/* … */` il backslash non
    // e' un escape, e trattarlo come tale fa mancare la chiusura di un blocco
    // che finisce con `\*/` — da li' `codeOnly()` azzera tutto il resto del
    // file, cioe' la direzione che fa danno in silenzio.
    if (inBlock) {
      if (c === '*' && line[i + 1] === '/') { inBlock = false; i++; }
      continue;
    }
    if (c === '\\') { i++; continue; }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (top()?.type === 'template') {
      if (c === '`') { stack.pop(); continue; }
      if (c === '$' && line[i + 1] === '{') { stack.push({ type: 'expr', depth: 0 }); i++; }
      continue;
    }
    // Contesto di CODICE: il livello esterno, oppure dentro un `${…}`.
    if (c === '`') { stack.push({ type: 'template' }); continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '/' && line[i + 1] === '/') return { stack, inBlock: false };
    if (c === '/' && line[i + 1] === '*') { inBlock = true; i++; continue; }
    if (top()?.type === 'expr') {
      if (c === '{') top().depth += 1;
      else if (c === '}') {
        if (top().depth === 0) stack.pop();
        else top().depth -= 1;
      }
    }
  }
  // Una stringa non chiusa a fine riga non esiste in JS: se `quote` e' ancora
  // aperto abbiamo letto male (tipicamente un apostrofo dentro una regex), e
  // lo stato si azzera da solo alla riga dopo invece di propagare l'errore.
  return { stack, inBlock };
};

/**
 * Sostituisce con righe vuote i soli commenti a riga intera, preservando il
 * numero di righe e ogni carattere di codice. Il resto di una riga che CHIUDE
 * un blocco viene mantenuto: `/* x *\/ const p = 'blog-body'` conserva il
 * codice a destra invece di sparire tutto.
 */
export const codeOnly = (src) => {
  const out = [];
  let state = { stack: [], inBlock: false };
  const inTemplate = () => state.stack[state.stack.length - 1]?.type === 'template';
  for (const line of src.split('\n')) {
    if (state.inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) { out.push(''); continue; }
      const rest = line.slice(end + 2);
      state = scanLine(rest, { stack: state.stack, inBlock: false });
      out.push(rest);
      continue;
    }
    const t = line.trim();
    if (!inTemplate() && t.startsWith('//')) { out.push(''); continue; }
    if (!inTemplate() && t.startsWith('/*')) {
      const end = line.indexOf('*/');
      if (end === -1) { state = { stack: state.stack, inBlock: true }; out.push(''); continue; }
      const rest = line.slice(end + 2);
      state = scanLine(rest, { stack: state.stack, inBlock: false });
      out.push(rest);
      continue;
    }
    state = scanLine(line, state);
    out.push(line);
  }
  // Fail-safe: a fine file la pila dei contesti deve essere vuota e nessun
  // blocco puo' restare aperto — un sorgente JS valido non finisce dentro un
  // template o dentro `/* …`. Se succede, lo scan e' desincronizzato (tipico:
  // un backtick dentro un literal regex, che questo scanner non riconosce) e
  // ogni decisione presa da li' in poi vale zero. In quel caso si restituisce
  // il sorgente NON strippato: piu' rumore nel censimento, mai un file letto
  // a meta'. Sbagliare per rumore e' recuperabile, sbagliare per cecita' no.
  if (state.stack.length > 0 || state.inBlock) return src;
  return out.join('\n');
};

// Specificatori di import RELATIVI, in ogni forma che il repo usa davvero.
//
// #922 item 1: la versione precedente agganciava solo `from '…'`, cioe' i soli
// import statici. Un `await import('./lib/…')` era invisibile — e la forma
// esiste gia' nel repo (`generator/scripts/load-rc-env.mjs`). Un choke-point
// che raggiungesse per import dinamico il modulo che definisce il path
// pubblicato usciva dal censimento in silenzio: e' meta' del buco che #571
// voleva chiudere. Stessa storia per l'import di solo effetto
// (`import './setup.mjs'`), che non ha nemmeno un `from` da agganciare.
//
// Esportato come SORGENTE, non come literal `/g` condiviso: `matchAll` copia
// `lastIndex` dalla regex sorgente, quindi una sola `.test()` o `.exec()` da
// parte di chiunque farebbe partire ogni scansione successiva a meta' file —
// import persi in silenzio, cioe' di nuovo censimento cieco. Ogni consumatore
// istanzia la sua.
export const RELATIVE_IMPORT_SPEC_SOURCE =
  "(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s+|\\brequire\\s*\\(\\s*)['\"](\\.[^'\"]+)['\"]";

export const relativeImportSpec = () => new RegExp(RELATIVE_IMPORT_SPEC_SOURCE, 'g');

const resolveRelativeImport = (fromFile, spec) => {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.mjs`, `${base}.js`, path.join(base, 'index.mjs'), path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
};

/**
 * Sorgente raggiungibile da un file seguendo solo import RELATIVI ('./', '../'),
 * cosi' i pacchetti npm e i builtin di Node restano fuori. Serve perche' un
 * choke-point puo' scrivere un path che non nomina mai, importandolo da un
 * modulo condiviso (#571): il criterio testuale sul singolo file non lo
 * vedrebbe.
 *
 * Ogni chiamata a questa factory ha la sua cache, condivisa fra i root visitati
 * — e' il punto dell'esercizio, perche' i choke-point importano gli stessi lib.
 *
 * `ancestors` e' lo STACK del ramo corrente (rimosso al backtrack): evita di
 * rientrare in un ciclo senza inquinare la cache. Se fosse un set che cresce
 * solo (o venisse controllato prima della cache), un modulo condiviso raggiunto
 * da due rami fratelli (A importa B e C, entrambi importano D) risulterebbe
 * troncato sul secondo ramo.
 *
 * #922 item 2: il ramo ciclico non cacheava il proprio `''`, ma il chiamante
 * cacheava il COMBINATO che quel `''` aveva troncato. Con A→B→A la chiamata su
 * B produce `srcB + ''`, e quella voce finiva in cache per B: un letterale
 * pubblicato definito in A restava invisibile a TUTTI gli altri importatori di
 * B, senza rumore. Ora il taglio si propaga come `cyclic` lungo lo stack e chi
 * lo riceve non si cachea — una ri-visita sui grafi ciclici, zero costo sugli
 * altri.
 */
export const createReachableSource = () => {
  const cache = new Map();
  const walk = (file, ancestors) => {
    if (cache.has(file)) return { text: cache.get(file), cyclic: false };
    if (ancestors.has(file)) return { text: '', cyclic: true };
    ancestors.add(file);
    let src;
    try {
      src = codeOnly(fs.readFileSync(file, 'utf-8'));
    } catch {
      ancestors.delete(file);
      return { text: '', cyclic: false };
    }
    let combined = src;
    let cyclic = false;
    for (const m of src.matchAll(relativeImportSpec())) {
      const resolved = resolveRelativeImport(file, m[1]);
      if (!resolved) continue;
      const child = walk(resolved, ancestors);
      combined += `\n${child.text}`;
      cyclic = cyclic || child.cyclic;
    }
    ancestors.delete(file);
    if (!cyclic) cache.set(file, combined);
    return { text: combined, cyclic };
  };
  return (file) => walk(file, new Set()).text;
};
