#!/usr/bin/env node
/**
 * merge-content-registry-conflict.mjs — risolve un conflitto di rebase su un
 * REGISTRO APPEND-ONLY del corpus fondendo i RECORD, non scegliendo un lato.
 *
 * Uso:
 *   node scripts/lib/merge-content-registry-conflict.mjs <file>...
 *   node scripts/lib/merge-content-registry-conflict.mjs --check <file>...
 *
 * Exit 0 = ogni file e' stato riscritto senza marker e ha superato il backstop
 *          (il chiamante puo' fare `git add`). Exit 1 = ABORTIRE: nessun file
 *          e' stato toccato, l'albero resta esattamente come lo abbiamo trovato.
 *
 * ── Perche' non basta l'allowlist di rebase-onto-remote.sh (issue #255) ──────
 *
 * `rebase-onto-remote.sh` sa risolvere un conflitto in un modo solo: prendere
 * la copia UPSTREAM. E' la risoluzione giusta per una cache di bookkeeping —
 * `topic-candidates-evergreen-rejected.json` viene riscritta da zero al giro
 * dopo, perdere un aggiornamento costa una valutazione ridondante.
 *
 * Su `content/blog-articles-data.ts` sarebbe la risoluzione SBAGLIATA, e per
 * una ragione strutturale: quel file non e' una cache, e' un REGISTRO
 * APPEND-ONLY. Prendere un lato non «perde un aggiornamento», CANCELLA I
 * RECORD che quel lato aveva e l'altro no. Per questo i registri non sono mai
 * entrati nell'allowlist, e per questo — non essendoci una terza opzione — lo
 * script abortiva: dopo 5 tentativi `generate-article.yml` moriva su «the
 * article is registered locally but not pushed» ed `exit 1` portava via il
 * runner insieme al commit. L'articolo generato (LLM, quattro traduzioni DeepL,
 * immagine hero: tutto gia' pagato) e' PERSO, non ritardato. Misurato: le issue
 * #255, #281 e #285 sono tre occorrenze della stessa causa, le ultime due sui
 * path della famiglia SVIZZERA.
 *
 * La terza opzione e' questa: unire gli id di ENTRAMBI i lati.
 *   · un id presente da un solo lato   → si tiene, sempre;
 *   · un id presente da entrambi       → vince il commit REBASATO (l'articolo
 *                                        appena generato), perche' per
 *                                        costruzione upstream non dovrebbe
 *                                        avere quello slug: se ce l'ha, la
 *                                        versione appena scritta e' quella
 *                                        completa.
 *
 * Nota sui lati, ed e' la cosa piu' facile da invertire: in un rebase HEAD e'
 * il ramo su cui si RIGIOCA, quindi il lato in alto (`<<<<<<<`) e' UPSTREAM e
 * il lato in basso (`>>>>>>>`) e' il commit nostro. E' l'inverso di un merge.
 *
 * ── Il rischio, che qui e' un requisito e non un avvertimento ───────────────
 *
 * Questi registri sono TypeScript, non JSON: la fusione e' testuale, e un
 * boundary di conflitto che cade a META' ENTRY puo' FONDERE DUE RECORD in uno.
 * Sarebbe barattare «articolo perso» con «registro corrotto che passa la CI» —
 * peggio, perche' silenzioso. E' esattamente la corruzione che sul sito ha
 * rotto la build per-locale (due articoli SVIZZERA fusi in un oggetto solo con
 * id/category/date duplicati).
 *
 * Quindi qui NON si fa mai «togli i marker e tieni entrambi i lati», che e'
 * esattamente la riparazione che produce la fusione. E soprattutto non si
 * guarda l'INTERNO dell'hunk: si ricostruiscono i due DOCUMENTI interi, si
 * decompongono i contenitori di record di entrambi e si uniscono per chiave —
 * vedi la sezione «Merge» piu' sotto per il fixture che dimostra perche' il
 * merge hunk-locale non poteva funzionare.
 *
 * E prima di scrivere qualunque byte, il risultato passa un backstop:
 *   (a) niente marker residui e il file si RI-ANALIZZA senza errori
 *       (bracket bilanciati, stringhe e commenti terminati);
 *   (b) nessuna chiave duplicata nello stesso oggetto, nessun id duplicato fra
 *       record fratelli — e' la firma di due record saldati in uno;
 *   (c) nessun id perso: ogni record presente in uno dei due lati deve essere
 *       nel risultato, e il conteggio dev'essere >= max(nostri, loro).
 * Se uno dei tre fallisce il file NON viene scritto e il processo esce 1.
 *
 * Il backstop (a) gira in due strati:
 *   · lo strato PORTANTE e' offline e sempre attivo — l'analizzatore qui sotto,
 *     che e' quello che decide;
 *   · sopra ci va, quando si riesce a ottenerlo, il parere del compilatore vero
 *     (`npx -y tsx@4`, non `node`: questi sorgenti usano specificatori relativi
 *     senza estensione, che Node ESM puro non risolve). E' deliberatamente NON
 *     fatale quando lo strumento non e' disponibile: metterlo sul percorso
 *     critico di un push renderebbe un intoppo di rete indistinguibile da una
 *     corruzione, e la reazione a entrambi sarebbe abortire — cioe' ributtare
 *     via l'articolo per un motivo che non c'entra. Un errore di sintassi
 *     RIPORTATO dal probe invece e' fatale.
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// ── Analizzatore ────────────────────────────────────────────────────────────
// Non e' un parser TypeScript completo e non deve esserlo: deve sapere dove
// finiscono stringhe, template literal e commenti (perche' li' dentro `{`, `}`
// e `,` non sono struttura) e tenere la pila dei contenitori. Basta a rispondere
// alle sole domande del backstop — «e' bilanciato?», «ci sono chiavi doppie?»,
// «quanti record ci sono?» — e a differenza di una regex non si fa ingannare da
// una graffa dentro una stringa.

const IDENT = /[A-Za-z_$0-9@.\-]/;

/**
 * @typedef {{ kind: string, open: number, close: number|null,
 *             entries: Array<{key: string, quoted: boolean, value: string|null}>,
 *             children: Container[] }} Container
 */

/**
 * @param {string} src
 * @returns {{ root: Container, literals: Array<{value: string, start: number, end: number}> }}
 * @throws {SyntaxError} se il sorgente non e' bilanciato o ha una stringa/commento aperto
 */
export function analyze(src) {
  /** @type {Container} */
  const root = { kind: 'root', open: 0, close: null, entries: [], children: [] };
  const stack = [root];
  const literals = [];
  let i = 0;
  const N = src.length;
  let lastAtom = null; // { value, quoted }
  let pendingKey = null; // l'ultima entry in attesa del proprio valore

  const top = () => stack[stack.length - 1];

  while (i < N) {
    const c = src[i];

    if (c === '/' && src[i + 1] === '/') {
      while (i < N && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new SyntaxError(`commento a blocco non chiuso (offset ${i})`);
      i = end + 2;
      continue;
    }

    if (c === "'" || c === '"') {
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < N) {
        const d = src[j];
        if (d === '\\') { value += src[j + 1] ?? ''; j += 2; continue; }
        if (d === c) { closed = true; break; }
        if (d === '\n') break; // una stringa non template non attraversa una riga
        value += d;
        j++;
      }
      if (!closed) throw new SyntaxError(`stringa non chiusa (offset ${i})`);
      literals.push({ value, start: i, end: j + 1 });
      lastAtom = { value, quoted: true };
      if (pendingKey && pendingKey.value === null) { pendingKey.value = value; pendingKey = null; }
      i = j + 1;
      continue;
    }

    if (c === '`') {
      let j = i + 1;
      let interp = 0;
      let closed = false;
      while (j < N) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '$' && src[j + 1] === '{') { interp++; j += 2; continue; }
        if (d === '}' && interp > 0) { interp--; j++; continue; }
        if (d === '`' && interp === 0) { closed = true; break; }
        j++;
      }
      if (!closed) throw new SyntaxError(`template literal non chiuso (offset ${i})`);
      lastAtom = null;
      pendingKey = null;
      i = j + 1;
      continue;
    }

    if (c === '{' || c === '[' || c === '(') {
      /** @type {Container} */
      const node = { kind: c, open: i, close: null, entries: [], children: [] };
      top().children.push(node);
      stack.push(node);
      lastAtom = null;
      pendingKey = null;
      i++;
      continue;
    }

    if (c === '}' || c === ']' || c === ')') {
      const expected = { '}': '{', ']': '[', ')': '(' }[c];
      if (stack.length === 1 || top().kind !== expected) {
        throw new SyntaxError(`'${c}' senza apertura corrispondente (offset ${i})`);
      }
      top().close = i;
      stack.pop();
      lastAtom = null;
      pendingKey = null;
      i++;
      continue;
    }

    if (c === ':') {
      if (lastAtom) {
        const entry = { key: lastAtom.value, quoted: lastAtom.quoted, value: null };
        top().entries.push(entry);
        pendingKey = entry;
        lastAtom = null;
      }
      i++;
      continue;
    }

    if (c === ',' || c === ';') {
      lastAtom = null;
      pendingKey = null;
      i++;
      continue;
    }

    if (IDENT.test(c)) {
      let j = i;
      while (j < N && IDENT.test(src[j])) j++;
      lastAtom = { value: src.slice(i, j), quoted: false };
      i = j;
      continue;
    }

    if (c !== ' ' && c !== '\n' && c !== '\t' && c !== '\r') {
      lastAtom = null;
      pendingKey = null;
    }
    i++;
  }

  if (stack.length !== 1) {
    throw new SyntaxError(`${stack.length - 1} contenitore/i non chiuso/i`);
  }
  return { root, literals };
}

/** Percorre tutti i contenitori, radice inclusa. */
function* walk(container) {
  yield container;
  for (const child of container.children) yield* walk(child);
}

/**
 * L'id di un record: la entry `id` di un oggetto (registri ARTICLES/SWISS_ARTICLES).
 * @param {Container} c
 */
function idOf(c) {
  const e = c.entries.find((x) => x.key === 'id' && x.value !== null);
  return e ? e.value : null;
}

/**
 * Le due misure del backstop (c). Nessuna delle due conosce la forma dei file:
 *  · `records`  = quanti figli ha il contenitore piu' popoloso — l'array
 *                 RAW_ARTICLES, la mappa BLOG_SLUGS, la mappa dei meta, la
 *                 mappa SEO, a seconda del file;
 *  · `literals` = quante stringhe DISTINTE compaiono nel file — l'unica misura
 *                 che vede crescere `blogArticleIds.ts`, che non ha contenitori
 *                 ma union di literal.
 * @param {string} src
 */
export function countRecords(src) {
  const { root, literals } = analyze(src);
  let records = 0;
  for (const c of walk(root)) {
    const quotedKeys = c.entries.filter((e) => e.quoted).length;
    const idBearing = c.children.filter((k) => idOf(k) !== null).length;
    records = Math.max(records, quotedKeys + idBearing);
  }
  return { records, literals: new Set(literals.map((l) => l.value)).size };
}

/**
 * Backstop (b): nessuna chiave duplicata nello STESSO contenitore, nessun id
 * duplicato fra i figli dello stesso array. E' il controllo che vede la fusione
 * di due record: due entry fuse in un oggetto solo producono `id`, `category`,
 * `date` due volte nello stesso contenitore.
 *
 * Dentro un OGGETTO (`{ … }`) contano tutte le chiavi, quotate o nude: la
 * fusione di due entry di `blog-articles-data.ts` non produce chiavi quotate,
 * produce `id`, `category`, `date` due volte nude nello stesso oggetto, e
 * guardare solo le quotate lascerebbe passare proprio il caso che questo
 * controllo esiste per vedere (misurato: la riparazione ingenua su questo
 * boundary passava il backstop). Fuori dagli oggetti si restringe alle quotate,
 * dove una chiave nuda potrebbe venire da un ternario o da un tipo.
 * @param {string} src
 * @returns {string[]} i problemi trovati (vuoto = pulito)
 */
export function findDuplicates(src) {
  const { root } = analyze(src);
  const problems = [];
  for (const c of walk(root)) {
    const seen = new Set();
    for (const e of c.entries) {
      if (!e.quoted && c.kind !== '{') continue;
      if (seen.has(e.key)) problems.push(`chiave duplicata nello stesso contenitore: '${e.key}'`);
      seen.add(e.key);
    }
    const ids = new Set();
    for (const child of c.children) {
      const id = idOf(child);
      if (id === null) continue;
      if (ids.has(id)) problems.push(`id duplicato fra record fratelli: '${id}'`);
      ids.add(id);
    }
  }
  return problems;
}

// ── Decomposizione di un lato in record ─────────────────────────────────────

/**
 * Spezza il testo di UN LATO del conflitto nei suoi record di primo livello.
 *
 * Un record finisce al primo `,` (o `;`) incontrato a profondita' 0. Se lo
 * scanner trova una chiusura senza apertura, o resta con un contenitore aperto
 * alla fine, il lato NON e' decomponibile: e' un lato che comincia o finisce a
 * meta' entry, cioe' il caso che fonderebbe due record. Si ritorna `null`, e il
 * chiamante abortisce.
 *
 * @param {string} side
 * @returns {Array<{key: string|null, text: string, hasSep: boolean}>|null}
 */
export function splitRecords(side) {
  const chunks = [];
  let start = 0;
  let i = 0;
  let depth = 0;
  const N = side.length;

  while (i < N) {
    const c = side[i];

    if (c === '/' && side[i + 1] === '/') { while (i < N && side[i] !== '\n') i++; continue; }
    if (c === '/' && side[i + 1] === '*') {
      const end = side.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < N) {
        if (side[j] === '\\') { j += 2; continue; }
        if (side[j] === c) { closed = true; break; }
        if (side[j] === '\n') break;
        j++;
      }
      if (!closed) return null;
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let interp = 0;
      let closed = false;
      while (j < N) {
        if (side[j] === '\\') { j += 2; continue; }
        if (side[j] === '$' && side[j + 1] === '{') { interp++; j += 2; continue; }
        if (side[j] === '}' && interp > 0) { interp--; j++; continue; }
        if (side[j] === '`' && interp === 0) { closed = true; break; }
        j++;
      }
      if (!closed) return null;
      i = j + 1;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') { depth++; i++; continue; }
    if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth < 0) return null; // chiusura senza apertura → lato a meta' record
      i++;
      continue;
    }
    if ((c === ',' || c === ';') && depth === 0) {
      // il record si porta dietro il proprio separatore e la coda di riga
      let j = i + 1;
      while (j < N && (side[j] === ' ' || side[j] === '\t' || side[j] === '\r')) j++;
      if (side[j] === '\n') j++;
      chunks.push({ text: side.slice(start, j), hasSep: true, key: null });
      start = j;
      i = j;
      continue;
    }
    i++;
  }

  if (depth !== 0) return null; // contenitore lasciato aperto → lato a meta' record
  const tail = side.slice(start);
  if (tail.trim() !== '') chunks.push({ text: tail, hasSep: false, key: null });

  for (const chunk of chunks) {
    chunk.key = keyOfRecord(chunk.text);
    if (chunk.key === null) return null; // un record senza chiave non e' fondibile
  }
  return chunks;
}

/**
 * La chiave di un record, cercata STRUTTURALMENTE e non con una regex sul testo
 * grezzo (dentro una stringa `id:` compare eccome).
 *   · mappa   `'slug': { … },`      → la chiave quotata di primo livello;
 *   · array   `{ id: 'slug', … },`  → il valore di `id` del primo oggetto.
 * @param {string} text
 * @returns {string|null}
 */
export function keyOfRecord(text) {
  let parsed;
  try {
    parsed = analyze(text);
  } catch {
    return null;
  }
  const quoted = parsed.root.entries.find((e) => e.quoted);
  if (quoted) return quoted.key;
  for (const child of parsed.root.children) {
    const id = idOf(child);
    if (id !== null) return id;
  }
  // Elenco piatto di literal (`ALL_BLOG_ARTICLE_IDS`): il record E' il literal.
  // Solo quando non c'e' NIENT'ALTRO: `image: '/images/…',` ha una entry, e
  // scambiarne il valore per una chiave farebbe passare per record un pezzo di
  // record — cioe' proprio la fusione che qui si deve impedire.
  if (parsed.root.entries.length === 0 && parsed.root.children.length === 0 && parsed.literals.length === 1) {
    return parsed.literals[0].value;
  }
  return null;
}

// ── Merge: si guardano i DOCUMENTI, non gli hunk ────────────────────────────
//
// Prima versione di questo file: fondere i due lati di ogni hunk. Sbagliato, e
// il fixture reale lo dice in tre righe. Le entry di questi registri condividono
// quasi tutte le righe — `  {`, `   category: 'pratico',`, `   hasCalculator:
// false,`, `   authorName: 'Redazione…',`, `  },` — quindi quando due run
// appendono due articoli diversi, git NON allinea il confine fra le due entry:
// lo mette in mezzo, e il conflitto vero ha questa forma
//
//     {
//   <<<<<<< HEAD
//      id: 'svizzera-upstream',
//      ...
//      image: '…upstream.webp',
//   =======
//      id: 'svizzera-mio',
//      ...
//      image: '…mio.webp',
//   >>>>>>> (mine)
//      hasCalculator: false,
//      authorName: 'Redazione Frontaliere Ticino',
//     },
//
// cioe' UNA graffa sola con due `id` dentro. E' esattamente la fusione che il
// «togli i marker e tieni entrambi i lati» produce, ed e' la forma NORMALE, non
// il caso limite: guardando solo l'interno dell'hunk non ci sono due record da
// unire, ce n'e' mezzo per lato.
//
// La chiave sta nel CONTESTO fuori dai marker, che e' quello che completa i due
// record. Quindi si ricostruiscono i due documenti interi — prendendo un lato
// ovunque si ottiene la versione di quel commit — si decompongono i CONTENITORI
// di record di entrambi, e si uniscono per chiave. Dove git ha messo il confine
// diventa irrilevante, che e' il punto.

/**
 * Il nome a cui e' ancorato un contenitore: l'identificatore della
 * dichiarazione che lo apre (`RAW_ARTICLES`, `SWISS_SLUGS`, `blogMetaChIt`,
 * `BLOG_CH_SEO_METADATA`, `ALL_BLOG_ARTICLE_IDS`). Un contenitore annidato —
 * l'oggetto di un record, o `({ ...a })` dentro una `.map()` — non ha `=` prima
 * e quindi non ha ancora: e' cosi' che i record non vengono scambiati per
 * contenitori di record.
 */
const ANCHOR = /([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*$/;

function anchorOf(src, openOffset) {
  const from = Math.max(0, openOffset - 300);
  const m = ANCHOR.exec(src.slice(from, openOffset));
  return m ? m[1] : null;
}

/**
 * I contenitori di record del documento, per ancora.
 * @param {string} src
 * @returns {Map<string, {open: number, close: number, records: Array}>|null}
 *          null = il documento non si analizza, o due contenitori condividono
 *          l'ancora (nel dubbio non si tocca niente).
 */
export function recordContainers(src) {
  let root;
  try {
    ({ root } = analyze(src));
  } catch {
    return null;
  }
  const found = new Map();
  for (const c of walk(root)) {
    if (c.kind === 'root' || c.close === null) continue;
    const anchor = anchorOf(src, c.open);
    if (!anchor) continue;
    const records = splitRecords(src.slice(c.open + 1, c.close));
    if (!records || records.length === 0) continue;
    if (found.has(anchor)) return null;
    found.set(anchor, { open: c.open, close: c.close, records });
  }
  return found;
}

/**
 * Le union di literal che non hanno contenitore: `type _BlogId12 = 'a' | 'b';`
 * in `blogArticleIds.ts`. Qui il record e' il singolo literal, e tenere
 * entrambi i lati darebbe due dichiarazioni con lo stesso nome.
 */
const TYPE_UNION = /\btype\s+([A-Za-z_$][\w$]*)\s*=\s*((?:'[^']*'\s*\|\s*)*'[^']*')\s*;/g;

function typeUnions(src) {
  const found = new Map();
  for (const m of src.matchAll(TYPE_UNION)) {
    const literals = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    found.set(m[1], { start: m.index + m[0].indexOf(m[2]), end: m.index + m[0].indexOf(m[2]) + m[2].length, literals });
  }
  return found;
}

/** Unione ordinata di due liste di record. Il commit rigiocato vince sui pari. */
function unionRecords(mine, theirs) {
  const byKey = new Map();
  const order = [];
  for (const r of [...mine, ...theirs]) {
    if (!byKey.has(r.key)) order.push(r.key);
    byKey.set(r.key, r);
  }
  const sep = [...mine, ...theirs].some((r) => r.text.trimEnd().endsWith(';')) ? ';' : ',';
  return order.map((key, idx) => {
    const r = byKey.get(key);
    if (r.hasSep || idx === order.length - 1) return r.text;
    const m = /\s*$/.exec(r.text);
    const withSep = `${r.text.slice(0, m.index)}${sep}${r.text.slice(m.index)}`;
    return /\n$/.test(withSep) ? withSep : `${withSep}\n`;
  }).join('');
}

/** Tutte le chiavi di record di un documento — la misura di «niente perso». */
export function recordKeys(src) {
  const keys = new Set();
  const containers = recordContainers(src);
  if (containers) for (const c of containers.values()) for (const r of c.records) keys.add(r.key);
  for (const u of typeUnions(src).values()) for (const l of u.literals) keys.add(l);
  return keys;
}

/**
 * Fonde i due documenti. `ours` (upstream) fa da base del testo: le differenze
 * che NON stanno in un contenitore di record si risolvono su upstream, ed e' il
 * motivo per cui piu' sotto si pretende che ogni hunk tocchi almeno un
 * contenitore fuso — altrimenti una modifica del commit rigiocato sparirebbe in
 * silenzio, che e' la classe di difetto che questo file esiste per non ripetere.
 *
 * @returns {{ ok: true, text: string, spans: Array<[number, number]> }
 *          |{ ok: false, reason: string }}
 */
export function mergeDocuments(ours, theirs) {
  const A = recordContainers(ours);
  const B = recordContainers(theirs);
  if (A === null) return { ok: false, reason: 'la versione upstream non si decompone in record' };
  if (B === null) return { ok: false, reason: 'la versione del commit rigiocato non si decompone in record' };

  for (const anchor of B.keys()) {
    if (!A.has(anchor)) {
      return { ok: false, reason: `'${anchor}' esiste nel commit rigiocato ma non in upstream: la struttura e' cambiata` };
    }
  }

  /** @type {Array<{start: number, end: number, text: string}>} */
  const edits = [];
  const oursRegions = [];
  const theirsRegions = [];
  for (const [anchor, mine] of A) {
    const other = B.get(anchor);
    if (!other) continue; // contenitore che il commit rigiocato non tocca
    edits.push({ start: mine.open + 1, end: mine.close, text: unionRecords(mine.records, other.records) });
    oursRegions.push([mine.open + 1, mine.close]);
    theirsRegions.push([other.open + 1, other.close]);
  }

  const UA = typeUnions(ours);
  const UB = typeUnions(theirs);
  for (const [name, other] of UB) {
    const mine = UA.get(name);
    if (!mine) return { ok: false, reason: `la union '${name}' esiste nel commit rigiocato ma non in upstream` };
    const seen = new Set(mine.literals);
    const united = [...mine.literals];
    for (const l of other.literals) if (!seen.has(l)) { seen.add(l); united.push(l); }
    edits.push({ start: mine.start, end: mine.end, text: united.map((l) => `'${l}'`).join(' | ') });
    oursRegions.push([mine.start, mine.end]);
    theirsRegions.push([other.start, other.end]);
  }

  if (edits.length === 0) return { ok: false, reason: 'nessun contenitore di record in comune fra i due lati' };

  edits.sort((a, b) => a.start - b.start);
  for (let i = 1; i < edits.length; i++) {
    if (edits[i].start < edits[i - 1].end) return { ok: false, reason: 'contenitori di record sovrapposti' };
  }

  let text = ours;
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    text = text.slice(0, e.start) + e.text + text.slice(e.end);
  }

  return { ok: true, text, oursRegions, theirsRegions };
}

// ── Lettura dei marker ──────────────────────────────────────────────────────

const START = /^<{7}(?: .*)?$/;
const BASE = /^\|{7}(?: .*)?$/;
const SEP = /^={7}$/;
const END = /^>{7}(?: .*)?$/;

/**
 * I segmenti sono ARRAY DI RIGHE, non stringhe: ricomporre con un `join('\n')`
 * su righe e' esatto per costruzione, mentre incollare stringhe che a volte
 * finiscono con `\n` e a volte no e' il modo classico di perdere (o aggiungere)
 * una riga a ogni hunk.
 *
 * @param {string} src
 * @returns {{ segments: Array<string[]|{ours: string[], theirs: string[]}>, hunks: number }}
 */
export function readHunks(src) {
  const lines = src.split('\n');
  const segments = [];
  let plain = [];
  let hunks = 0;
  let i = 0;

  while (i < lines.length) {
    if (!START.test(lines[i])) { plain.push(lines[i]); i++; continue; }

    segments.push(plain);
    plain = [];
    i++;
    const ours = [];
    const theirs = [];
    let bucket = ours;
    let closed = false;
    while (i < lines.length) {
      if (BASE.test(lines[i])) { bucket = []; i++; continue; } // stile diff3: la base si scarta
      if (SEP.test(lines[i])) { bucket = theirs; i++; continue; }
      if (END.test(lines[i])) { closed = true; i++; break; }
      if (START.test(lines[i])) throw new SyntaxError('marker di conflitto annidati');
      bucket.push(lines[i]);
      i++;
    }
    if (!closed) throw new SyntaxError('marker di conflitto non chiuso');
    segments.push({ ours, theirs });
    hunks++;
  }
  segments.push(plain);
  return { segments, hunks };
}

/** Ricompone il file scegliendo un lato ovunque: si riottiene quella versione. */
function assemble(segments, pick) {
  const out = [];
  for (const seg of segments) {
    if (Array.isArray(seg)) { out.push(...seg); continue; }
    out.push(...pick(seg));
  }
  return out.join('\n');
}

/**
 * Fonde un intero file conflittato.
 * @param {string} src
 * @returns {{ ok: true, merged: string, ours: string, theirs: string, hunks: number }
 *          |{ ok: false, reason: string }}
 */
export function mergeSource(src) {
  let read;
  try {
    read = readHunks(src);
  } catch (e) {
    return { ok: false, reason: String(e.message) };
  }
  if (read.hunks === 0) return { ok: false, reason: 'nessun marker di conflitto nel file' };

  const ours = assemble(read.segments, (s) => s.ours);
  const theirs = assemble(read.segments, (s) => s.theirs);
  const merged = mergeDocuments(ours, theirs);
  if (!merged.ok) return merged;

  // Fuori dai contenitori fusi i due lati devono essere IDENTICI.
  //
  // `ours` e `theirs` condividono tutto il contesto non conflittuale, quindi
  // cio' in cui differiscono E' l'insieme degli hunk. Se, una volta oscurato il
  // contenuto dei contenitori fusi, i due testi coincidono, allora ogni
  // conflitto stava dentro un record ed e' stato unito. Se non coincidono c'e'
  // un conflitto che le regole qui sopra non sanno fondere — un import, un
  // commento d'intestazione riscritto — e tenere `ours` come base lo
  // risolverebbe su upstream SENZA che nessuno lo dica. Perdere in silenzio una
  // modifica del commit rigiocato e' la classe di difetto che questo file esiste
  // per non ripetere, quindi si rifiuta.
  if (blankRegions(ours, merged.oursRegions) !== blankRegions(theirs, merged.theirsRegions)) {
    return {
      ok: false,
      reason: 'i due lati differiscono anche FUORI dai contenitori di record — '
        + 'il conflitto non e\' (solo) fra record, e risolverlo qui perderebbe una modifica',
    };
  }

  return { ok: true, merged: merged.text, ours, theirs, hunks: read.hunks };
}

/** Sostituisce il contenuto di ogni regione con un segnaposto di lunghezza fissa. */
function blankRegions(src, regions) {
  const sorted = [...regions].sort((a, b) => b[0] - a[0]);
  let out = src;
  for (const [start, end] of sorted) out = `${out.slice(0, start)}[REGIONE-FUSA]${out.slice(end)}`;
  return out;
}

// ── Backstop ────────────────────────────────────────────────────────────────

/**
 * @param {string} merged
 * @param {string} ours
 * @param {string} theirs
 * @returns {string[]} i motivi per abortire (vuoto = si puo' scrivere)
 */
export function backstop(merged, ours, theirs) {
  const problems = [];

  if (/^<{7}|^={7}$|^>{7}/m.test(merged)) {
    problems.push('(a) marker di conflitto residui nel risultato');
    return problems;
  }

  let mergedCounts;
  try {
    mergedCounts = countRecords(merged);
  } catch (e) {
    problems.push(`(a) il risultato non si ri-analizza: ${e.message}`);
    return problems;
  }

  for (const p of findDuplicates(merged)) problems.push(`(b) ${p}`);

  let oursCounts;
  let theirsCounts;
  try {
    oursCounts = countRecords(ours);
    theirsCounts = countRecords(theirs);
  } catch (e) {
    // I due lati puri vengono dai commit, non dalla fusione: se non si
    // analizzano il problema e' a monte e il confronto non e' significativo.
    problems.push(`(c) un lato non si analizza, conteggio impossibile: ${e.message}`);
    return problems;
  }

  // (c), la meta' che conta di piu': non un conteggio ma i NOMI. Un registro
  // append-only ha una sola cosa da non fare, perdere un id; contarli lascerebbe
  // passare uno scambio (uno perso, uno duplicato), i nomi no.
  const mergedKeys = recordKeys(merged);
  for (const side of [['upstream', ours], ['commit rigiocato', theirs]]) {
    for (const key of recordKeys(side[1])) {
      if (!mergedKeys.has(key)) problems.push(`(c) il record '${key}' di ${side[0]} non c'e' piu' nel risultato`);
    }
  }

  const needRecords = Math.max(oursCounts.records, theirsCounts.records);
  if (mergedCounts.records < needRecords) {
    problems.push(`(c) ${mergedCounts.records} record nel risultato, ne servono almeno ${needRecords} `
      + `(upstream ${oursCounts.records}, commit rigiocato ${theirsCounts.records})`);
  }
  const needLiterals = Math.max(oursCounts.literals, theirsCounts.literals);
  if (mergedCounts.literals < needLiterals) {
    problems.push(`(c) ${mergedCounts.literals} literal distinti nel risultato, ne servono almeno ${needLiterals} `
      + `(upstream ${oursCounts.literals}, commit rigiocato ${theirsCounts.literals})`);
  }
  return problems;
}

/**
 * Strato 2 di (a): il parere del compilatore vero, via `npx -y tsx@4`.
 *
 * Gira su una COPIA accanto all'originale — stessa cartella, cosi' gli import
 * relativi senza estensione risolvono — e l'originale non viene toccato finche'
 * il probe non ha detto la sua.
 *
 * @returns {{ status: 'ok'|'fail'|'unavailable', detail: string }}
 */
export function tsxParseProbe(file, contents) {
  if (process.env.MERGE_REGISTRY_TSX_PROBE === 'off') {
    return { status: 'unavailable', detail: 'probe disattivato da MERGE_REGISTRY_TSX_PROBE=off' };
  }
  const dir = path.dirname(file);
  const stamp = `${process.pid}-${Date.now()}`;
  const candidate = path.join(dir, `.merge-probe-${stamp}.ts`);
  const runner = path.join(dir, `.merge-probe-${stamp}.mjs`);
  try {
    writeFileSync(candidate, contents);
    writeFileSync(runner, [
      "import { pathToFileURL } from 'node:url';",
      `await import(pathToFileURL(${JSON.stringify(candidate)}).href)`,
      "  .then(() => console.log('__MERGE_PROBE_OK__'))",
      "  .catch((e) => console.log('__MERGE_PROBE_FAIL__ ' + String(e && e.message).replace(/\\s*\\n\\s*/g, ' | ').slice(0, 300)));",
    ].join('\n'));

    const res = spawnSync('npx', ['-y', 'tsx@4', runner], {
      encoding: 'utf8',
      timeout: 240_000,
      env: { ...process.env, NODE_TEST_CONTEXT: '' },
    });
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    if (out.includes('__MERGE_PROBE_OK__')) return { status: 'ok', detail: '' };
    if (out.includes('__MERGE_PROBE_FAIL__')) {
      return { status: 'fail', detail: out.split('__MERGE_PROBE_FAIL__')[1].split('\n')[0].trim() };
    }
    return { status: 'unavailable', detail: (out.trim().split('\n').pop() || 'nessun output').slice(0, 200) };
  } catch (e) {
    return { status: 'unavailable', detail: String(e.message).slice(0, 200) };
  } finally {
    for (const f of [candidate, runner]) if (existsSync(f)) { try { unlinkSync(f); } catch { /* ignore */ } }
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function resolveFile(file) {
  const src = readFileSync(file, 'utf8');
  const result = mergeSource(src);
  if (!result.ok) {
    console.error(`::warning::${file}: merge per-record impossibile — ${result.reason}`);
    return false;
  }

  const problems = backstop(result.merged, result.ours, result.theirs);
  if (problems.length) {
    for (const p of problems) console.error(`::warning::${file}: backstop fallito — ${p}`);
    return false;
  }

  const probe = tsxParseProbe(file, result.merged);
  if (probe.status === 'fail') {
    console.error(`::warning::${file}: backstop fallito — (a) tsx non compila il risultato: ${probe.detail}`);
    return false;
  }
  if (probe.status === 'unavailable') {
    console.error(`::warning::${file}: probe tsx non disponibile (${probe.detail}) — `
      + 'vale il backstop offline, che e\' passato');
  }

  writeFileSync(file, result.merged);
  const counts = countRecords(result.merged);
  console.log(`merge per-record: ${file} — ${result.hunks} hunk, ${counts.records} record, ${counts.literals} literal`);
  return true;
}

function checkFile(file) {
  const src = readFileSync(file, 'utf8');
  try {
    const counts = countRecords(src);
    const dupes = findDuplicates(src);
    if (dupes.length) {
      for (const d of dupes) console.error(`::warning::${file}: ${d}`);
      return false;
    }
    console.log(`ok: ${file} — ${counts.records} record, ${counts.literals} literal`);
    return true;
  } catch (e) {
    console.error(`::warning::${file}: non si analizza — ${e.message}`);
    return false;
  }
}

function main(argv) {
  const check = argv[0] === '--check';
  const files = check ? argv.slice(1) : argv;
  if (files.length === 0) {
    console.error('uso: merge-content-registry-conflict.mjs [--check] <file>...');
    return 2;
  }
  // Nessun file viene scritto finche' non ha superato TUTTO: `resolveFile`
  // scrive solo in fondo, quindi un abort a meta' lista lascia i file rimanenti
  // ancora conflittati e il chiamante abortisce il rebase comunque.
  let ok = true;
  for (const f of files) {
    if (!(check ? checkFile(f) : resolveFile(f))) ok = false;
  }
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
