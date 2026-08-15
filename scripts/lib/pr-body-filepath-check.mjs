#!/usr/bin/env node
/**
 * pr-body-filepath-check.mjs — i path che il body di una PR CITA devono esistere.
 *
 * ## Il buco che chiude
 *
 * `pr-body-sections-check.mjs` verifica che le due sezioni ci siano e non siano
 * vuote. `pr-body-nextstep-check.mjs` (atterrato il 2026-08-14 con #353) verifica
 * che ogni voce di `## Non implementato (ancora)` porti uno STATO invece di una
 * scappatoia. Entrambi guardano la FORMA. Nessuno dei due guarda se cio' che il
 * body afferma sia VERO, e un body puo' essere impeccabile e falso:
 *
 *     node scripts/lib/pr-body-nextstep-check.mjs --json "<body di #358>"  →  ok: true
 *
 * mentre il reviewer di #358, pagando un ciclo di review, trovava questo:
 *
 *     🟡 cita `scripts/repair-blog-key-marker-corruption.mjs` e
 *        `scripts/repair-unicode-escape-titles.mjs` come «famiglia di gemelli
 *        plausibili» — nessuno dei due file esiste nel repo, ne' in `scripts/`
 *        /`generator/scripts/`, ne' in tutta `git log --all --diff-filter=A`.
 *
 * E' la stessa forma dell'escalation #140: la regola c'era, il gate era verde, e
 * la violazione tornava come finding del reviewer. Un path e' l'unica cosa in un
 * body che una macchina puo' verificare senza interpretare la prosa — quindi e'
 * qui che il triage si sposta a sinistra, e nessuno paga una review per sapere
 * se un file esiste.
 *
 * E' anche la meta' mancante di `generator/tests/loop-references-exist.test.mjs`,
 * che pone la stessa domanda ai file del ciclo: li' il testo che cita e' il
 * CODICE, qui e' il body di una PR. La classe e' identica — «un riferimento che
 * non ha forma di import non e' coperto da niente».
 *
 * ## I falsi positivi, e perche' NON si indovinano dalla prosa
 *
 * Un path citato e assente non e' di per se' un difetto: un body descrive anche
 * file del SITO, file che la PR sta proponendo, esempi. Le tre uscite, in ordine
 * di forza:
 *
 *   1. **Strutturale (la piu' importante, e non e' un'euristica).**
 *      `pr-body-contract.yml` gira su `pull_request` con `actions/checkout@v5`,
 *      che su quell'evento estrae il MERGE REF — cioe' l'albero della PR gia'
 *      fusa nella base. Un file che la PR AGGIUNGE esiste li' dentro: la classe
 *      «ho citato il file che sto creando» non produce un finding per
 *      costruzione, senza che nessuno debba annotare niente.
 *      Il chiamante chiude anche l'altra meta' passando in `extraExisting` i
 *      file toccati dalla PR (`gh api …/pulls/N/files`, QUALUNQUE `status`):
 *      cosi' anche un file che la PR RIMUOVE, e che il body nomina per dire che
 *      l'ha rimosso, resta legittimo.
 *
 *   2. **Il perimetro.** Si guardano SOLO i path sotto i root di questo repo
 *      ({@link KNOWN_ROOTS}) e SOLO con un'estensione di file. `tests/foo.test.ts`
 *      o `build-plugins/shared/titleSuffix.ts` — path del sito — non entrano
 *      nemmeno in lista. E' una calibrazione volutamente stretta: preferisce
 *      tacere su un path del sito che gridare al lupo.
 *
 *   3. **L'annotazione LETTERALE.** {@link ANNOTATIONS} e' un insieme CHIUSO di
 *      marcatori fra parentesi adiacenti alla citazione (`(nuovo)`, `(esempio)`,
 *      `(sul sito)`, `(rimosso)`…). Chi sa che il path non esiste lo dichiara, e
 *      la dichiarazione e' un atto — esattamente come i `kind` di
 *      `loop-references-exist.test.mjs`.
 *
 * **Perche' un'annotazione letterale e non una lettura della frase.** Perche' la
 * frase e' proprio cio' che sbaglia. Il bullet di #358 dice, testualmente, «**il
 * sito** ha una famiglia di gemelli plausibili (`scripts/…`, `scripts/…`)»:
 * qualunque euristica che esenti una citazione perche' la riga nomina il sito
 * assolverebbe l'UNICO caso per cui questo modulo esiste. Stessa lezione di
 * `loop-references-exist.test.mjs` («qui la prosa non viene interpretata») e del
 * lookbehind di negazione che `false-positive-declaration.mjs` ha dovuto
 * crescere dopo un bug trovato in review.
 *
 *   4. **Le dislocazioni** ({@link DISLOCATIONS}): `scripts/X` risolve anche su
 *      `generator/scripts/X`, perche' i due repo tengono lo stesso meccanismo
 *      sotto due prefissi. Offline e deterministica.
 *
 * ## Perche' ADVISORY e non bloccante — la misura
 *
 * Misurato sulle ULTIME 45 PR MERGIATE (2026-08-15), con l'esistenza valutata
 * contro `git ls-files` piu' i file toccati da ogni PR:
 *
 *   178  citazioni di path dentro il perimetro
 *    18  non risolte a colpo secco
 *   -10  dislocazioni note (3 path distinti, tutti col gemello sotto `generator/`)
 *   ---
 *     8  segnalazioni residue, su 6 PR su 45
 *
 * E il pezzo che decide: di quelle 8, **sette esistono sul SITO** (verificate una
 * per una con `raw.githubusercontent`, HTTP 200) e l'ottava —
 * `generator/tests/unescape-ts-string.test.mjs` di #305 — e' un test che quel
 * body dichiara ESPLICITAMENTE di non aver scritto (`blocked: il gemello vitest
 * del sito e' gia' l'osservatore`). **Zero path inventati in 45 PR.**
 *
 * Un gate bloccante con questo profilo fermerebbe 6 PR su 45 senza aver trovato
 * un solo difetto vero: e' il tasso che il docblock di
 * `pr-body-nextstep-check.mjs` descrive come «un gate con quel tasso lo si
 * spegne, non lo si rispetta». Quindi le violazioni di questo modulo escono dal
 * canale `advisories` di `scripts/ci/pr-body-contract.mjs`, che commenta e non
 * fa fallire il check.
 *
 * Il valore resta, ed e' quello per cui #140 e' stata aperta: la citazione non
 * qualificata **il reviewer la trova comunque** — sulla #358 ha speso un ciclo
 * di review per dire che due path «non esistono nel repo». Dirlo qui, prima,
 * costa zero Claude; e la remediation e' nove caratteri, `(sul sito)`.
 *
 * ## Limite dichiarato
 *
 * Il modulo NON sa distinguere un path del sito da uno inventato: entrambi sono
 * «assente qui», e la differenza vive in un repo che questo modulo non
 * interroga. Dichiararlo e' una scelta: interrogare il sito costerebbe una fetch
 * per path e renderebbe il gate dipendente dalla rete, per separare due classi
 * che hanno **la stessa remediation** — qualificare la citazione. Chi vuole la
 * distinzione la trova gia' in `scripts/ci/loop-drift-check.mjs`, che il sito lo
 * interroga per mestiere.
 *
 * L'altra faccia dello stesso limite: un path del sito citato senza marcatore
 * produce un avviso. E' voluto, ed e' la stessa forma della citazione
 * contrastiva che `loop-references-exist.test.mjs` risolve con una
 * dichiarazione, non con un indovinello.
 *
 * Uso:
 *   node scripts/lib/pr-body-filepath-check.mjs "$BODY"
 *   node scripts/lib/pr-body-filepath-check.mjs --json "$BODY"
 *
 * Returns: { ok, violations, checked, exempted }
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripNonContent } from './pr-body-sections-check.mjs';

/**
 * I root di QUESTO repo. Un path che non comincia con uno di questi non viene
 * nemmeno guardato: `tests/`, `build-plugins/`, `packages/` sono del sito e un
 * body di qui li nomina di continuo, legittimamente.
 */
export const KNOWN_ROOTS = Object.freeze([
  'scripts/',
  'generator/',
  'content/',
  'host/',
  '.github/',
]);

/**
 * I marcatori che esentano una citazione, in forma LETTERALE e adiacente.
 *
 * Insieme chiuso: aggiungerne uno e' un atto cosciente, come scegliere un `kind`
 * in `loop-references-exist.test.mjs`. Il confronto e' case-insensitive e ignora
 * gli spazi interni, ma non e' una ricerca di parole nella frase: il marcatore
 * deve stare entro {@link ANNOTATION_WINDOW} caratteri dalla citazione.
 */
export const ANNOTATIONS = Object.freeze([
  'nuovo',
  'new',
  'esempio',
  'example',
  'ipotetico',
  'proposto',
  'da creare',
  'rimosso',
  'cancellato',
  'sul sito',
  'solo sul sito',
  'non esiste',
  'assente',
  'mai esistito',
]);

/** Quanto lontano dalla citazione puo' stare il marcatore, in caratteri. */
export const ANNOTATION_WINDOW = 48;

/**
 * Le DISLOCAZIONI note: riscritture di prefisso da provare prima di dire che un
 * path non esiste.
 *
 * Non e' un'euristica di comodo, e' la topologia dei due repo: il sito tiene gli
 * entry point del generatore sotto `scripts/`, qui vivono sotto
 * `generator/scripts/`. Un body che scrive `scripts/create-article.mjs` non sta
 * inventando niente — sta nominando lo stesso meccanismo col nome che ha di la'.
 * E' la classe che `generator/tests/loop-references-exist.test.mjs` dichiara a
 * mano come `renamed-here` (`scripts/load-rc-env.mjs` →
 * `generator/scripts/load-rc-env.mjs`), qui risolta in automatico perche' su un
 * body non c'e' un registro dove dichiararla.
 *
 * MISURATA su 45 PR mergiate (2026-08-15): 10 delle 18 citazioni non risolte —
 * `scripts/create-article.mjs` (5 PR), `scripts/lib/ai-models.mjs` (4),
 * `scripts/lib/prompt-placeholder-guard.mjs` (1) — sono TUTTE questa classe, e
 * tutte hanno il gemello qui sotto `generator/`. Senza questa regola il modulo
 * parlerebbe su 15 PR su 45; con essa su 6.
 */
export const DISLOCATIONS = Object.freeze([
  Object.freeze({ from: 'scripts/', to: 'generator/scripts/' }),
]);

/** Span di codice inline: un solo backtick, niente a capo dentro. */
const CODE_SPAN_RE = /`([^`\n]+)`/g;

/**
 * Suffissi di localizzazione che si attaccano a un path in una citazione e non
 * ne fanno parte: `create-article.mjs:L6591` (forma usata dalle review), `:120`,
 * `#L42`.
 */
const LOCATOR_SUFFIX_RE = /(?::L?\d+(?:-L?\d+)?|#L\d+(?:-L\d+)?)$/;

/** Ultimo segmento con un'estensione plausibile — `.mjs`, `.ts`, `.json`, `.yml`… */
const HAS_EXTENSION_RE = /\.[A-Za-z0-9]{1,6}$/;

/**
 * Caratteri che rendono lo span un TEMPLATE, non un path: placeholder (`<n>`,
 * `{locale}`, `$VAR`), glob (`*`), spazi (e' un comando, non un path).
 */
const NOT_A_LITERAL_PATH_RE = /[\s<>{}$*?|"'()\[\]]/;

const ANNOTATION_RE = new RegExp(
  `\\((?:${ANNOTATIONS.map((a) => a.replace(/ /g, '\\s+')).join('|')})\\)`,
  'i',
);

/**
 * Normalizza uno span in un path candidato, o `null` se non lo e'.
 *
 * @param {string} span contenuto fra backtick
 * @returns {string|null}
 */
export function candidatePath(span) {
  let s = String(span ?? '').trim();
  if (!s) return null;
  if (NOT_A_LITERAL_PATH_RE.test(s)) return null;
  s = s.replace(LOCATOR_SUFFIX_RE, '');
  s = s.replace(/^\.\//, '');
  if (s.endsWith('/')) return null;
  if (!KNOWN_ROOTS.some((r) => s.startsWith(r))) return null;
  if (!HAS_EXTENSION_RE.test(s.split('/').pop() || '')) return null;
  return s;
}

/**
 * True se una delle {@link ANNOTATIONS} sta entro {@link ANNOTATION_WINDOW}
 * caratteri prima o dopo la citazione.
 *
 * @param {string} text testo completo
 * @param {number} start indice del backtick di apertura
 * @param {number} end indice DOPO il backtick di chiusura
 */
export function isAnnotated(text, start, end) {
  const before = text.slice(Math.max(0, start - ANNOTATION_WINDOW), start);
  const after = text.slice(end, end + ANNOTATION_WINDOW);
  return ANNOTATION_RE.test(before) || ANNOTATION_RE.test(after);
}

/**
 * Estrae le citazioni di path dal body, gia' filtrate e annotate.
 *
 * @param {string} body
 * @returns {Array<{path: string, span: string, index: number, annotated: boolean}>}
 */
export function extractCitedPaths(body = '') {
  // I blocchi recintati e i commenti HTML escono di scena: la «Forma attesa»
  // che questo stesso gate incolla nel commento sticky e' un blocco ```markdown,
  // e un gate che si segnalasse da solo sarebbe un anello chiuso.
  const text = stripNonContent(String(body ?? ''));
  const out = [];
  const seen = new Set();
  CODE_SPAN_RE.lastIndex = 0;
  let m;
  while ((m = CODE_SPAN_RE.exec(text)) !== null) {
    const rel = candidatePath(m[1]);
    if (!rel) continue;
    const annotated = isAnnotated(text, m.index, m.index + m[0].length);
    // Una citazione ripetuta si conta una volta sola, ma basta UNA occorrenza
    // annotata perche' l'intero path sia dichiarato: chi lo annota una volta
    // non deve annotarlo in ogni frase in cui lo nomina.
    const prev = seen.has(rel) ? out.find((o) => o.path === rel) : null;
    if (prev) {
      if (annotated) prev.annotated = true;
      continue;
    }
    seen.add(rel);
    out.push({ path: rel, span: m[1].trim(), index: m.index, annotated });
  }
  return out;
}

/**
 * L'inventario dei file tracciati, da `git ls-files`. Fallback su `fs` quando
 * git non e' disponibile o la cartella non e' un repo (il chiamante non deve
 * perdere il check per questo).
 *
 * @param {string} cwd
 * @returns {Set<string>|null} null → nessun inventario, si usa `fs.existsSync`
 */
export function trackedFiles(cwd = process.cwd()) {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const set = new Set(out.split('\0').filter(Boolean));
    return set.size ? set : null;
  } catch {
    return null;
  }
}

/**
 * Verifica che ogni path citato nel body esista.
 *
 * @param {string} body
 * @param {object} [opts]
 * @param {string} [opts.cwd] radice del repo
 * @param {Iterable<string>} [opts.extraExisting] path da considerare esistenti
 *   anche se assenti dall'albero: i file toccati dalla PR (vedi il punto 1 del
 *   docblock). Passarli e' cio' che rende innocuo citare un file che la PR
 *   rimuove.
 * @param {(p: string) => boolean} [opts.exists] override completo, per i test
 * @returns {{ok: boolean, violations: Array, checked: number, exempted: Array}}
 */
export function checkCitedFilePaths(body = '', opts = {}) {
  const cited = extractCitedPaths(body);
  if (!cited.length) return { ok: true, violations: [], checked: 0, exempted: [] };

  const extra = new Set(opts.extraExisting || []);
  let exists = opts.exists;
  if (!exists) {
    const cwd = opts.cwd || process.cwd();
    const tracked = trackedFiles(cwd);
    exists = tracked
      ? (p) => tracked.has(p)
      : (p) => {
          // `path.resolve` sotto `cwd` e non concatenazione: un `..` in una
          // citazione non deve poter guardare fuori dal repo.
          const abs = path.resolve(cwd, p);
          return abs.startsWith(path.resolve(cwd) + path.sep) && fs.existsSync(abs);
        };
  }

  /** Il path stesso, piu' le sue dislocazioni note. Basta che UNA risolva. */
  const resolvesSomewhere = (rel) => {
    if (extra.has(rel) || exists(rel)) return true;
    for (const d of DISLOCATIONS) {
      if (!rel.startsWith(d.from)) continue;
      const alt = d.to + rel.slice(d.from.length);
      if (extra.has(alt) || exists(alt)) return true;
    }
    return false;
  };

  const violations = [];
  const exempted = [];
  for (const c of cited) {
    if (resolvesSomewhere(c.path)) continue;
    if (c.annotated) {
      exempted.push(c.path);
      continue;
    }
    violations.push({
      type: 'cited-path-missing',
      path: c.path,
      index: c.index,
      message:
        `Il body cita \`${c.path}\`, che in questo repo non esiste ` +
        `(ne' fra i file tracciati, ne' fra quelli toccati da questa PR). ` +
        `Correggi il path, oppure — se e' voluto — dichiaralo con un marcatore ` +
        `letterale adiacente: \`${c.path}\` (sul sito) | (nuovo) | (esempio).`,
    });
  }
  return { ok: violations.length === 0, violations, checked: cited.length, exempted };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const bodyArg = argv.filter((a) => !a.startsWith('--'))[0];
  const run = (body) => {
    const res = checkCitedFilePaths(body);
    if (asJson) {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    } else {
      for (const v of res.violations) process.stderr.write(`✗ [${v.type}] ${v.message}\n`);
      if (res.ok) {
        process.stdout.write(
          `✓ ${res.checked} path citati, tutti esistenti` +
            (res.exempted.length ? ` (${res.exempted.length} dichiarati assenti)` : '') +
            '.\n',
        );
      }
    }
    if (!res.ok) process.exitCode = 1;
  };
  if (typeof bodyArg === 'string') {
    run(bodyArg);
  } else {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => run(buf));
  }
}
