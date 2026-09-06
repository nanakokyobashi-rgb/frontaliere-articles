/**
 * import-specifiers.mjs — UNA sorgente per «quali moduli importa questo file».
 *
 * ## Perche' esiste
 *
 * La stessa clausola regex viveva copiata in cinque siti (issue #929 item 5):
 * `scripts/ci/loop-drift-check.mjs`, `generator/tests/import-closure.test.mjs`,
 * `generator/tests/loop-scripts-closure.test.mjs` (due test),
 * `generator/tests/needs-human-prepass-sparse-closure.test.mjs` e
 * `generator/tests/rewire-json-contracts.test.mjs`. Ogni indurimento andava
 * applicato cinque volte, cioe' — misurato due volte di fila — applicato
 * quattro. AGENTS.md #6: un valore condiviso ha UNA sorgente.
 *
 * Il mestiere di questi guard e' lo stesso: un modulo mancante e' un difetto di
 * LOAD TIME, che nessun test che importa il modulo puo' intercettare, e che
 * esce come `ERR_MODULE_NOT_FOUND` a generazione — corpus e superficie fermi,
 * CI verde. Un estrattore cieco rende il guard verde e vacuo.
 *
 * ## Cosa conta come dipendenza
 *
 * - `import … from '…'`, `import '…'` (solo effetto), `export … from '…'`,
 *   inclusa la forma BRACED SU PIU' RIGHE e la forma SENZA SPAZI
 *   (`import x from'./y.mjs'`, `import{a}from'./y.mjs'`): JS valido che
 *   prettier non produce, e che quindi entra solo da un file che prettier non
 *   ha visto — una copia dal sito, un paste minificato. Il giorno in cui entra,
 *   la copertura non deve sparire in silenzio (issue #929 item 2).
 * - `import('…')` DINAMICO, che non sta a inizio riga perche' sta in mezzo a
 *   un'espressione: `generator/scripts/lib/article-topic-selector.mjs` carica
 *   cosi' `./ai-models.mjs`, `generator/scripts/load-rc-env.mjs` carica cosi'
 *   `./lib/google-service-account-token.mjs` e `scripts/ci/lib/mergePreviewCheck.mjs`
 *   carica cosi' `./duplicateDeclarations.mjs` — uno dei tre giri che
 *   `loop-scripts-closure.test.mjs` cita in intestazione come «albero da
 *   chiudere», e che era invisibile al guard che dice di chiuderlo
 *   (issue #929 item 1).
 *
 * ## Cosa NON conta: il codice dentro una stringa o un commento
 *
 * Un `import` scritto dentro un literal non e' una dipendenza del file che lo
 * CONTIENE — e' (al massimo) una dipendenza del file che quel testo produrra',
 * risolta da un'altra directory. Contarlo produce un fantasma:
 * `scripts/ci/scan-generation-health.mjs` documenta un comando shell che
 * contiene `await import("./scripts/ci/scan-generation-health.mjs")`, e un ramo
 * dinamico ingenuo lo risolve come `scripts/ci/scripts/ci/…` — guard ROSSO su
 * codice corretto. Stessa storia per i fixture-sorgente dei test
 * (`censimento-source.test.mjs`) e per gli script che EMETTONO codice via
 * template literal (issue #929 item 4).
 *
 * La decisione, presa una volta per tutti e cinque i siti: dentro un literal o
 * un commento **non e' una dipendenza**. E' fail-open sul fantasma e non sulla
 * cecita', perche' l'unica cosa che il filtro puo' nascondere e' un import che
 * il motore JS non eseguirebbe comunque da quel file.
 *
 * `inertSpans()` ha il suo fail-safe: se lo scanner finisce desincronizzato
 * (tipico: un literal regex che l'euristica sul token precedente sbaglia)
 * restituisce `null`, e chi filtra torna a contare TUTTO. Sbagliare per rumore
 * e' recuperabile — un guard rosso si legge; sbagliare per cecita' no.
 */

/**
 * Le due forme, esportate come SORGENTE e non come literal `/g` condiviso:
 * `matchAll`, `exec` e `test` scrivono `lastIndex` sull'oggetto regex, quindi
 * una regex globale condivisa fra due scansioni fa ripartire la seconda a meta'
 * file — import persi in silenzio, cioe' di nuovo un guard cieco. Ogni
 * consumatore istanzia la sua.
 *
 * Statica: ancorata a `^[ \t]*` (e non `^\s*`, che mangia i newline e farebbe
 * ripartire l'ancora a meta' di una riga di commento). La clausola fra
 * `import` e `from` e' `[^'";]*?`: senza `\n` nella classe negata l'import
 * braced su piu' righe viene visto, e vietare apici e `;` impedisce al match
 * non greedy di attraversare la fine dello statement e agganciare la stringa
 * dell'import successivo. `\b` invece di `\s+` dopo `import`/`export` e prima
 * di `from` copre la forma senza spazi senza agganciare `important`,
 * `exports.x` o un identificatore che finisce per `from`.
 *
 * Il `from` e' opzionale solo per `import`, cosi' `import './x.mjs'` resta
 * coperto mentre `export default './x'` — che non e' una dipendenza — no.
 */
export const STATIC_IMPORT_SOURCE =
  "^[ \\t]*(?:import\\b\\s*(?:[^'\";]*?\\bfrom\\s*)?|export\\b[^'\";]*?\\bfrom\\s*)(['\"])([^'\"]+)\\1";

/**
 * Dinamica: NON ancorata a inizio riga, perche' un `import()` sta in mezzo a
 * un'espressione (`const mod = await import('./x.mjs')`). E' l'assenza
 * dell'ancora a rendere indispensabile il filtro di `inertSpans()`: senza
 * ancora, la prosa di un commento e il codice dentro una stringa tornano
 * agganciabili.
 */
export const DYNAMIC_IMPORT_SOURCE = "\\bimport\\s*\\(\\s*(['\"])([^'\"]+)\\1";

/** Gruppo 1 = apice, gruppo 2 = specificatore, in ENTRAMBE le forme. */
export const staticImportRe = () => new RegExp(STATIC_IMPORT_SOURCE, 'gm');
export const dynamicImportRe = () => new RegExp(DYNAMIC_IMPORT_SOURCE, 'g');

const REGEX_OK_AFTER_CHAR = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>',
]);
const REGEX_OK_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do',
  'else', 'yield', 'await',
]);

const isWordChar = (c) => c !== undefined && /[\w$]/.test(c);

/**
 * `/` apre un literal regex o e' una divisione? Si decide sul token
 * precedente, che e' l'euristica standard: dopo un valore (identificatore,
 * numero, `)`, `]`) e' una divisione, altrimenti e' un literal.
 *
 * Sbagliare in un verso espone gli apici DENTRO la regex (`/['"]/` e' comune
 * proprio nei file che estraggono import), nell'altro divora testo fino alla
 * `/` successiva. Entrambi finiscono nel fail-safe di `inertSpans()`, che e'
 * il motivo per cui l'euristica puo' permettersi di essere un'euristica.
 *
 * Il walk-back scavalca i COMMENTI gia' visti, non le stringhe: un array di
 * regex commentato riga per riga (`// English\n  /you\s+won['’]?t/i`) e' la
 * forma piu' comune del pattern in questo repo, e fermarsi sull'ultima parola
 * del commento fa leggere la regex come divisione — da li' l'apostrofo dentro
 * la regex apre una stringa fantasma. Dopo una STRINGA, invece, `/` e'
 * davvero una divisione.
 */
function regexLiteralHere(src, i, comments) {
  let j = i - 1;
  for (;;) {
    while (j >= 0 && /\s/.test(src[j])) j--;
    const c = comments.find(([s, e]) => j >= s && j < e);
    if (!c) break;
    j = c[0] - 1;
  }
  if (j < 0) return true;
  const c = src[j];
  if (REGEX_OK_AFTER_CHAR.has(c)) return true;
  if (!isWordChar(c)) return false;
  let k = j;
  while (k >= 0 && isWordChar(src[k])) k--;
  return REGEX_OK_AFTER_WORD.has(src.slice(k + 1, j + 1));
}

/**
 * Gli intervalli `[start, end)` del sorgente che sono TESTO e non codice:
 * stringhe, template literal (interpolazioni comprese) e commenti.
 *
 * @returns {[number, number][] | null} `null` se lo scan e' desincronizzato —
 *   in quel caso nessuna decisione presa da li' in poi vale, e chi filtra deve
 *   tornare a contare tutto invece di fidarsi di spans sbagliati.
 */
export function inertSpans(src) {
  const spans = [];
  const comments = [];
  const stack = [];
  let i = 0;
  while (i < src.length) {
    const top = stack[stack.length - 1];
    const c = src[i];

    if (top && top.type === 'template') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); spans.push([top.start, i + 1]); i++; continue; }
      // Dentro `${…}` si torna a CODICE, ma lo span del template lo copre
      // comunque: un import dentro un'interpolazione resta testo emesso.
      if (c === '$' && src[i + 1] === '{') { stack.push({ type: 'expr', depth: 0 }); i += 2; continue; }
      i++;
      continue;
    }

    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      spans.push([i, end]);
      comments.push([i, end]);
      i = end;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) return null;
      spans.push([i, end + 2]);
      comments.push([i, end + 2]);
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c || src[j] === '\n') break;
        j++;
      }
      // Una stringa non chiusa a fine riga non esiste in JS valido: se
      // succede abbiamo letto male (tipicamente un apostrofo dentro una regex
      // che l'euristica ha preso per una divisione).
      if (j >= src.length || src[j] === '\n') return null;
      spans.push([i, j + 1]);
      i = j + 1;
      continue;
    }
    if (c === '`') { stack.push({ type: 'template', start: i }); i++; continue; }
    if (c === '/' && regexLiteralHere(src, i, comments)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') return null;
        if (inClass) { if (d === ']') inClass = false; }
        else if (d === '[') inClass = true;
        else if (d === '/') break;
        j++;
      }
      if (j >= src.length) return null;
      i = j + 1;
      continue;
    }
    if (top && top.type === 'expr') {
      if (c === '{') top.depth += 1;
      else if (c === '}') {
        if (top.depth === 0) stack.pop();
        else top.depth -= 1;
      }
    }
    i++;
  }
  return stack.length === 0 ? spans : null;
}

/**
 * Tutti gli specificatori importati da `src`, nell'ordine in cui compaiono,
 * duplicati compresi (chi vuole un insieme lo costruisce).
 */
export function importSpecifiers(src) {
  const spans = inertSpans(src);
  const inert = (at) => spans !== null && spans.some(([s, e]) => at > s && at < e);
  const hits = [];
  for (const re of [staticImportRe(), dynamicImportRe()]) {
    for (const m of src.matchAll(re)) {
      if (inert(m.index)) continue;
      hits.push({ at: m.index, spec: m[2] });
    }
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.spec);
}

/** Solo gli specificatori RELATIVI: pacchetti e builtin non stanno nell'albero. */
export const relativeImportSpecifiers = (src) =>
  importSpecifiers(src).filter((s) => s.startsWith('.'));

/**
 * I candidati che Node prova per uno specificatore, nell'ordine.
 *
 * Il fallback di estensione non e' un lusso: gli script del ciclo scrivono
 * l'estensione, ma `engine/` e `host/` (e i `.ts` sotto `generator/`) usano la
 * forma senza — in TypeScript l'import relativo si scrive `from './foo'`. Un
 * guard che risolve nudo diventa rosso sul primo file corretto che la usa
 * (issue #929 item 3).
 *
 * @param {string} base path (o path parziale) gia' risolto rispetto all'importatore
 * @param {(p: string) => string} join come comporre `base` con un segmento (default POSIX-ish)
 */
export function resolutionCandidates(base, join = (a, b) => `${a}/${b}`) {
  return [
    base,
    `${base}.mjs`,
    `${base}.js`,
    `${base}.ts`,
    join(base, 'index.mjs'),
    join(base, 'index.js'),
    join(base, 'index.ts'),
  ];
}

/**
 * Il primo candidato accettato da `accept`, o `null`.
 * `accept` decide cosa vuol dire «esiste»: sul disco e' «e' un FILE» (una
 * directory che esiste non risolve un import), nel manifest e' «lo conosco».
 */
export function resolveSpecifier(base, accept, join) {
  return resolutionCandidates(base, join).find(accept) ?? null;
}
