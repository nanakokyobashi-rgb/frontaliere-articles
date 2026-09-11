/**
 * ── PINNARE UN IDENTIFICATORE ALLE FUNZIONI CHE POSSONO NOMINARLO ──────────
 *
 * Alcuni gate di questo repo dimostrano che uno stato condiviso ha UNA sola
 * porta di scrittura: `_dirtyModels` (il documento Firestore
 * `ai_model_scores/_all`, scritto dai workflow di DUE repo) e la coppia
 * `_exhaustReason`/`_exhaustDetail`. La prova era testuale — «nel sorgente
 * esiste un solo `_dirtyModels.add(`» — e prova l'assenza di una STRINGA, non
 * l'unicita' della porta (#1047). Tre forme la scavalcano restando verdi:
 *
 *   const d = _dirtyModels;  d.add(id);              // alias
 *   const add = _dirtyModels.add.bind(_dirtyModels); // bind
 *   riempiLaCoda(_dirtyModels, id);                  // il Set passato a una helper
 *
 * Ognuna e' un secondo ingresso REALE sul documento condiviso, cioe' proprio la
 * forma di bug (#630, #783, #838, #845, #864, #874, #881) che il pin esiste per
 * chiudere.
 *
 * Qui il pin cambia unita' di misura: non la stringa `.add(`, ma **ogni
 * riferimento all'identificatore**, vincolato a un'allowlist esplicita di
 * funzioni. Alias, bind e passaggio a una helper devono tutti nominare
 * `_dirtyModels` almeno una volta, quindi cadono tutti dentro la stessa rete,
 * e un riferimento nuovo in una funzione nuova e' rosso per default: chi lo
 * aggiunge deve allargare l'allowlist a mano, cioe' decidere consapevolmente.
 *
 * ## Perche' un lettore a stati e non una regex
 *
 * L'attribuzione «in quale funzione sta la riga N» era fatta risalendo alla
 * `function` dichiarata piu' sopra. E' sbagliata appena una funzione FINISCE
 * prima della riga: la dichiarazione top-level `const _dirtyModels = new Set()`
 * veniva attribuita all'ultima funzione chiusa sopra di lei, e un riferimento
 * a livello di modulo — l'alias piu' facile da scrivere — ereditava un nome di
 * funzione che poteva benissimo essere quello della porta. Il pin sarebbe
 * rimasto verde sulla violazione.
 *
 * Serve la profondita' delle graffe, e per contarla bisogna sapere quali graffe
 * sono codice: stringhe, template literal (con i loro `${}` annidati), regex
 * letterali e commenti ne contengono, e sbagliarne una sfasa il resto del file.
 * Il lettore qui sotto le attraversa, e **si autoverifica**: se alla fine la
 * profondita' non e' zero lancia invece di rendere un'attribuzione inventata.
 * Un parser vero non e' un'opzione — la suite gira senza `node_modules`
 * (AGENTS.md, «Build e test»).
 *
 * ## Su cosa opera
 *
 * Su una STRINGA di sorgente, non su un file: e' cio' che permette
 * all'osservatore di alimentare il gate con un sorgente sintetico che deve far
 * rosso. Un pin che nessuno ha mai visto dire di no non e' una prova.
 */

/** Il nome fittizio dello scope di modulo. */
export const TOP_LEVEL = '(top-level)';

/**
 * Le parole chiave che aprono un blocco senza nominare una funzione. Senza
 * questa lista `} catch (err) {` si chiama «catch» e `if (x) {` si chiama «if»:
 * nomi di funzione inventati, e quindi un'allowlist che parla di cose che non
 * esistono.
 */
const BLOCCHI_DI_CONTROLLO = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'try', 'catch',
  'finally', 'with', 'return', 'function', 'class',
]);

const KEYWORD_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
]);

/**
 * Vero se il `/` all'indice `i` apre un letterale regex e non e' una divisione.
 * Si decide dal token significativo che precede: dopo un valore (identificatore,
 * numero, `)`, `]`) il `/` divide; dopo un operatore o l'inizio di
 * un'espressione, apre.
 */
function isRegexStart(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const c = src[j];
  if (/[\w$)\]]/.test(c)) {
    // Un identificatore che e' in realta' una parola chiave e' un operatore.
    if (!/[\w$]/.test(c)) return false;
    let k = j;
    while (k >= 0 && /[\w$]/.test(src[k])) k--;
    return KEYWORD_BEFORE_REGEX.has(src.slice(k + 1, j + 1));
  }
  return true;
}

/**
 * Il nome della funzione che l'header `pending` sta aprendo, o `null` per un
 * blocco senza nome (un `if`, un `for`, una callback anonima). I blocchi senza
 * nome sono TRASPARENTI: chi ci sta dentro appartiene alla funzione con nome
 * che li contiene, che e' la lettura giusta — una callback dentro la porta e'
 * ancora la porta, una callback a livello di modulo e' ancora il modulo.
 */
function headerName(pending) {
  const coda = pending.slice(-400);
  const forme = [
    /(?:^|[\s;{}()=,:[])(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)\s*\([^]*$/,
    /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?function\s*\*?\s*[\w$]*\s*\([^]*$/,
    /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>\s*$/,
    /([\w$]+)\s*:\s*(?:async\s+)?function\s*\*?\s*[\w$]*\s*\([^]*$/,
    /([\w$]+)\s*:\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>\s*$/,
    /(?:^|[\s;{},])(?:static\s+)?(?:async\s+)?\*?\s*([\w$]+)\s*\([^()]*\)\s*$/,
  ];
  let migliore = null;
  let dove = -1;
  for (const re of forme) {
    const m = coda.match(re);
    if (m && m.index >= dove) { dove = m.index; migliore = m[1]; }
  }
  return migliore && !BLOCCHI_DI_CONTROLLO.has(migliore) ? migliore : null;
}

/**
 * Per ogni riga di `src` (1-based), il nome della funzione con nome piu'
 * interna che la contiene, o `TOP_LEVEL`.
 *
 * @param {string} src sorgente JS/TS
 * @returns {string[]} indicizzato per numero di riga (l'indice 0 non si usa)
 */
export function enclosingFunctionByLine(src) {
  const owner = new Array(src.split('\n').length + 1).fill(TOP_LEVEL);
  /** @type {{name: string|null, depth: number, pending: string}[]} */
  const stack = [];
  /** Le graffe aperte dai `${}` dei template literal, per sapere quando si torna nel testo. */
  const tpl = [];
  let depth = 0;
  let riga = 1;
  let pending = '';
  let stato = 'code';

  const nomeCorrente = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].name) return stack[i].name;
    return TOP_LEVEL;
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') { riga++; owner[riga] = nomeCorrente(); if (stato === 'line') stato = 'code'; continue; }
    owner[riga] = nomeCorrente();

    switch (stato) {
      case 'line':
        continue;
      case 'block':
        if (c === '*' && src[i + 1] === '/') { stato = 'code'; i++; }
        continue;
      case 'sq':
      case 'dq':
        if (c === '\\') { i++; } else if (c === (stato === 'sq' ? "'" : '"')) stato = 'code';
        continue;
      case 'regex':
        if (c === '\\') { i++; } else if (c === '[') stato = 'class';
        else if (c === '/') stato = 'code';
        continue;
      case 'class':
        if (c === '\\') i++; else if (c === ']') stato = 'regex';
        continue;
      case 'tpl':
        if (c === '\\') { i++; } else if (c === '`') stato = 'code';
        else if (c === '$' && src[i + 1] === '{') { tpl.push(depth); depth++; i++; stato = 'code'; }
        continue;
      default:
        break;
    }

    if (c === '/' && src[i + 1] === '/') { stato = 'line'; i++; continue; }
    if (c === '/' && src[i + 1] === '*') { stato = 'block'; i++; continue; }
    if (c === "'") { stato = 'sq'; pending += c; continue; }
    if (c === '"') { stato = 'dq'; pending += c; continue; }
    if (c === '`') { stato = 'tpl'; pending += c; continue; }
    if (c === '/' && isRegexStart(src, i)) { stato = 'regex'; pending += c; continue; }

    if (c === '{') {
      stack.push({ name: headerName(pending), depth, pending });
      depth++;
      pending = '';
      owner[riga] = nomeCorrente();
      continue;
    }
    if (c === '}') {
      depth--;
      if (tpl.length && tpl[tpl.length - 1] === depth) { tpl.pop(); stato = 'tpl'; continue; }
      // L'header riprende da dov'era, col gruppo appena chiuso ridotto a `{}`.
      // Serve ai parametri destrutturati: in
      // `function f(a, { b } = {}) {` le graffe dei default sono tre coppie
      // PRIMA del corpo, e azzerare l'header a ognuna lasciava il corpo senza
      // nome — cioe' la porta `_proposeLedgerWrite` attribuita al modulo.
      let chiuso = null;
      while (stack.length && stack[stack.length - 1].depth >= depth) chiuso = stack.pop();
      pending = chiuso ? `${chiuso.pending}{}` : '';
      owner[riga] = nomeCorrente();
      continue;
    }
    if (c === ';') { pending = ''; continue; }
    pending += c;
  }

  if (depth !== 0 || stack.length) {
    throw new Error(
      `lettura del sorgente sbilanciata: profondita' finale ${depth}, ${stack.length} blocchi aperti ` +
      `(${stack.map((f) => f.name || '(anonimo)').join(', ')}). L'attribuzione riga→funzione sarebbe inventata, ` +
      'quindi il pin lancia invece di rendere un verdetto che sembra una prova.',
    );
  }
  return owner;
}

/**
 * Lascia intatto il codice e sostituisce commenti e letterali con spazi,
 * conservando i newline. Il pin deve cercare un identificatore nel CODICE:
 * una citazione in un commento inline, una stringa, un regex literal o il
 * testo di un template non e' un riferimento al binding del modulo.
 *
 * Le espressioni `${...}` dei template tornano nel lettore `code`, quindi un
 * riferimento vero dentro un'interpolazione resta visibile. La stessa
 * grammatica a stati di `enclosingFunctionByLine` impedisce a `//` dentro un
 * regex o a graffe dentro una stringa di cambiare il confine del codice.
 */
function maskNonCode(src, { preserveStrings = false } = {}) {
  // Keep UTF-16 indexing aligned with `src`: `[...src]` collapses surrogate
  // pairs, so one emoji in an earlier comment would shift every later mask.
  const masked = src.split('');
  const blank = (i) => { if (masked[i] !== '\n') masked[i] = ' '; };
  const templateDepths = [];
  let depth = 0;
  let state = 'code';

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') {
      if (state === 'line') state = 'code';
      continue;
    }

    switch (state) {
      case 'line':
        blank(i);
        continue;
      case 'block':
        blank(i);
        if (c === '*' && src[i + 1] === '/') {
          blank(i + 1);
          i++;
          state = 'code';
        }
        continue;
      case 'sq':
      case 'dq':
        if (!preserveStrings) blank(i);
        if (c === '\\' && i + 1 < src.length) {
          if (!preserveStrings) blank(i + 1);
          i++;
        } else if (c === (state === 'sq' ? "'" : '"')) {
          state = 'code';
        }
        continue;
      case 'regex':
        blank(i);
        if (c === '\\' && i + 1 < src.length) {
          blank(i + 1);
          i++;
        } else if (c === '[') {
          state = 'class';
        } else if (c === '/') {
          state = 'code';
        }
        continue;
      case 'class':
        blank(i);
        if (c === '\\' && i + 1 < src.length) {
          blank(i + 1);
          i++;
        } else if (c === ']') {
          state = 'regex';
        }
        continue;
      case 'tpl':
        blank(i);
        if (c === '\\' && i + 1 < src.length) {
          blank(i + 1);
          i++;
        } else if (c === '`') {
          state = 'code';
        } else if (c === '$' && src[i + 1] === '{') {
          blank(i + 1);
          i++;
          templateDepths.push(depth);
          depth++;
          state = 'code';
        }
        continue;
      default:
        break;
    }

    if (c === '/' && src[i + 1] === '/') {
      blank(i);
      blank(i + 1);
      i++;
      state = 'line';
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      blank(i);
      blank(i + 1);
      i++;
      state = 'block';
      continue;
    }
    if (c === "'") {
      if (!preserveStrings) blank(i);
      state = 'sq';
      continue;
    }
    if (c === '"') {
      if (!preserveStrings) blank(i);
      state = 'dq';
      continue;
    }
    if (c === '`') {
      blank(i);
      state = 'tpl';
      continue;
    }
    if (c === '/' && isRegexStart(src, i)) {
      blank(i);
      state = 'regex';
      continue;
    }
    if (c === '{') {
      depth++;
      continue;
    }
    if (c === '}') {
      depth--;
      if (templateDepths.length && templateDepths.at(-1) === depth) {
        templateDepths.pop();
        state = 'tpl';
      }
    }
  }

  return masked.join('');
}

/**
 * Ogni riferimento all'identificatore NUDO `name` in `src`, con la funzione che
 * lo contiene. Prima del confronto il lettore a stati svuota i commenti a
 * livello di carattere (anche quando sono in coda a una riga), mentre
 * `codeText` conserva solo il codice per non contare un identificatore dentro
 * una stringa. `text` conserva le stringhe statiche necessarie a riconoscere
 * una mutazione computed come `_dirtyModels['add'](`.
 *
 * `foo._dirtyModels` non conta: e' la proprieta' di qualcun altro, non questo
 * binding di modulo.
 *
 * @param {string} src
 * @param {string} name
 * @returns {{line: number, text: string, fn: string}[]}
 */
export function identifierReferences(src, name) {
  const owner = enclosingFunctionByLine(src);
  // `..._dirtyModels` E' un riferimento: il lookbehind scarta il punto
  // dell'accesso a proprieta' ma non i tre dello spread, che e' esattamente la
  // forma con cui il Set viene passato a una helper.
  const re = new RegExp(`(?<![\\w$])(?<!(?<!\\.\\.)\\.)${name.replace(/[$]/g, '\\$&')}\\b`);
  const code = maskNonCode(src);
  const codeLines = code.split('\n');
  return maskNonCode(src, { preserveStrings: true })
    .split('\n')
    .map((text, i) => ({
      line: i + 1,
      text: text.trim(),
      codeText: codeLines[i].trim(),
      fn: owner[i + 1] ?? TOP_LEVEL,
    }))
    .filter(({ codeText }) => re.test(codeText));
}

/**
 * Il verdetto del pin: quali riferimenti a `name` stanno fuori dall'allowlist,
 * e quali voci dell'allowlist non contengono piu' nessun riferimento.
 *
 * `declaration` e' l'UNICA forma ammessa a livello di modulo. Ammettere
 * genericamente il top-level riaprirebbe la porta dal lato piu' comodo — un
 * alias di modulo e' una riga sola e non sta dentro nessuna funzione.
 *
 * I `fantasmi` contano quanto gli `scoperti`: un'allowlist che nomina funzioni
 * sparite e' un pin che ha smesso di misurare senza dirlo.
 *
 * @param {string} src
 * @param {string} name
 * @param {{functions: string[], declaration: RegExp}} opts
 */
export function pinIdentifierToFunctions(src, name, { functions, declaration }) {
  const ammesse = new Set(functions);
  const riferimenti = identifierReferences(src, name);
  const scoperti = riferimenti.filter(
    ({ fn, text }) => !ammesse.has(fn) && !(fn === TOP_LEVEL && declaration.test(text)),
  );
  const visti = new Set(riferimenti.map(({ fn }) => fn));
  return {
    riferimenti,
    scoperti: scoperti.map(({ line, text, fn }) => `${line}: ${text} [in ${fn}]`),
    fantasmi: functions.filter((f) => !visti.has(f)),
  };
}
