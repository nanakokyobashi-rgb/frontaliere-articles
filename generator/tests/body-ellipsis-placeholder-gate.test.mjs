/**
 * body-ellipsis-placeholder-gate.test.mjs — zero corpi pubblicati che sono
 * ancora il segnaposto «...» di una traduzione mai fatta.
 *
 * ## Perche' esiste
 *
 * Quando il generatore non produce un corpo tradotto, lascia nel campo
 * `bodyN` un'ellissi ASCII, da sola o in testa al blocco di tool che appende
 * dopo. L'engine lo riconosce (`engine/shared/articleBodyQuality.ts`,
 * `hasArticleBodyPromptPlaceholder`) e rende la pagina `noindex,follow` con un
 * `<p>...</p>` al posto della sezione: giusto per la pagina, ma il difetto resta
 * nella sorgente e nessun gate di questo repo lo vedeva. Il gate di
 * `prompt-placeholder-guard.test.mjs` scansiona gli stessi campi con
 * `hasPromptPlaceholder`, che non ha una regola per l'ellissi: era verde mentre
 * tre corpi (fials-vigilanza-ospedale-varese body2 FR e DE,
 * libro-boom-frontalieri-svizzera body3 FR) servivano pagine noindex.
 *
 * ## Una sola sorgente per il predicato
 *
 * `node --test` non importa TypeScript, quindi il regex non si puo' importare
 * dall'engine. Si RI-ESTRAE dal sorgente dell'engine (LOCK): se l'engine cambia
 * la regola, questo gate la segue invece di invecchiare accanto a una copia.
 *
 * ## Perche' le soglie di conteggio
 *
 * `content/blog-body**` e' escluso dagli worktree sparse: uno scan su zero file
 * passerebbe. Stesse soglie di `prompt-placeholder-guard.test.mjs`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORPUS_SECTIONS } from '../../scripts/lib/corpus-sections.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE_QUALITY = path.join(ROOT, 'engine', 'shared', 'articleBodyQuality.ts');
const BODY_ROOT_DIRS = CORPUS_SECTIONS.map((section) => path.basename(section.bodyDir));

/** Re-extract a `const NAME = /…/flags;` literal from the engine source. */
function engineRegex(source, name) {
  const m = source.match(new RegExp(`const ${name} = /((?:\\\\.|[^/\\n])+)/([a-z]*);`));
  assert.ok(m, `${name} non trovato in engine/shared/articleBodyQuality.ts: il LOCK va aggiornato`);
  return new RegExp(m[1], m[2]);
}

const engineSource = fs.readFileSync(ENGINE_QUALITY, 'utf-8');
const BODY_FIELD_RE = engineRegex(engineSource, 'BODY_FIELD_RE');
const PROMPT_PLACEHOLDER_PREFIX_RE = engineRegex(engineSource, 'PROMPT_PLACEHOLDER_PREFIX_RE');

/** Same predicate as `isArticleBodyPromptPlaceholder` in the engine. */
const isPlaceholderBody = (value) => PROMPT_PLACEHOLDER_PREFIX_RE.test(value.trimStart());

const unescapeTs = (s) => s.replace(/\\(.)/gs, (_, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c));

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('LOCK — il predicato e\' quello dell\'engine', () => {
  it('riconosce le forme reali uscite in produzione', () => {
    // Verbatim dai tre corpi corretti il 2026-10-24.
    assert.equal(isPlaceholderBody('...'), true);
    assert.equal(isPlaceholderBody('...\n\n## Empfohlene Tools\nFür eine aktuelle Schätzung nutzen Sie den [Nettolohnrechner](nav:calculator).'), true);
    assert.equal(isPlaceholderBody('...\n\nPour un calcul précis du salaire net, utilisez notre [comparateur fiscal](nav:calculator).'), true);
  });

  it('non tocca la prosa che contiene un\'ellissi', () => {
    assert.equal(isPlaceholderBody('Il sindacato chiede... una revisione.'), false);
    assert.equal(isPlaceholderBody('## In breve\n- ...e altro'), false);
  });

  it('i campi controllati sono i bodyN, non la FAQ', () => {
    assert.equal(BODY_FIELD_RE.test('body2'), true);
    assert.equal(BODY_FIELD_RE.test('faq'), false);
  });
});

describe('gate — nessun corpo pubblicato e\' il segnaposto «...»', () => {
  const files = BODY_ROOT_DIRS.flatMap((radice) => walk(path.join(ROOT, 'content', radice)));

  it('trova piu\' di 10.000 file body (uno sparse checkout non deve passare a vuoto)', () => {
    assert.ok(files.length > 10000, `trovati solo ${files.length} file body`);
  });

  const campi = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf-8');
    const re = /'blog\.article\.([^']+)\.([A-Za-z0-9]+)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      if (!BODY_FIELD_RE.test(m[2])) continue;
      campi.push({ f: path.relative(ROOT, f), id: m[1], field: m[2], value: unescapeTs(m[3]) });
    }
  }

  it('legge piu\' di 30.000 campi bodyN (idem)', () => {
    assert.ok(campi.length > 30000, `letti solo ${campi.length} campi bodyN`);
  });

  it('zero corpi segnaposto: l\'engine li renderebbe noindex con <p>...</p>', () => {
    const offenders = campi
      .filter((c) => isPlaceholderBody(c.value))
      .map((c) => `${c.f} [${c.field}] ${JSON.stringify(c.value.slice(0, 70))}`);
    assert.deepEqual(
      offenders,
      [],
      'Traduci il corpo dalla versione italiana dello stesso articolo (stessa struttura degli altri bodyN del file).',
    );
  });
});
