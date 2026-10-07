/**
 * workflow-file-list-import-closure.test.mjs — un workflow che materializza un
 * file JS con un ELENCO deve materializzare anche cio' che quel file importa.
 *
 * ## Il difetto che chiude (2026-10-07)
 *
 * `generator/scripts/load-rc-env.mjs` ha guadagnato un import statico,
 * `./lib/source-copy-guard.mjs`. Cinque workflow portano il loader sul runner
 * senza un checkout intero, nominando i file uno per uno: due li scaricano
 * (`enable-native-automerge.yml`, `auto-merge-enroll-sweep.yml`), tre li
 * elencano in uno `sparse-checkout` (`orphan-push-warn.yml`,
 * `review-quota-rescuer.yml`, `retry-code-check-after-body-edit.yml`). Nessuno
 * dei cinque elenchi nominava il modulo nuovo. Il terzo sparse si e' salvato
 * per la sua modalita': in cone mode nominare un file porta sul runner tutti
 * i file della stessa cartella. Per gli altri quattro, dal merge in poi:
 *
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find module
 *     '.../native-automerge-helpers/lib/source-copy-guard.mjs' imported from
 *     '.../native-automerge-helpers/load-rc-env.mjs'
 *
 * Gli import ESM sono statici: il loader muore prima di leggere Remote Config,
 * e senza Remote Config non c'e' il PAT. Effetto: nessuna PR approvata poteva
 * piu' armare l'auto-merge, ne' dal job post-review ne' dallo sweep di riserva.
 *
 * ## Perche' i test esistenti restavano verdi
 *
 * `import-closure` e `loop-scripts-closure` provano che ogni import risolve a
 * un file che ESISTE nel repository: qui esiste. I test di chiusura per job
 * (`needs-human-prepass-sparse-closure`, `review-gate-bootstrap-closure`)
 * coprono ciascuno il proprio job. La condizione che rompe non e' un file che
 * manca dal repository ma un file che manca da un ELENCO, e nessuno confrontava
 * gli elenchi con gli import.
 *
 * ## La regola
 *
 * Per ogni elenco esplicito di un workflow — un blocco `sparse-checkout: |` o
 * gli argomenti di `download_and_check` — ogni file JS NOMINATO nell'elenco
 * deve avere la chiusura dei propri import relativi (statici e dinamici, come
 * li estrae lo scanner condiviso) coperta dallo stesso elenco.
 *
 * Solo i file nominati sono radici: una voce di cartella non dice quale script
 * il job esegue, e pretendere la chiusura di ogni file di una cartella darebbe
 * falsi rossi su script che quel job non lancia. Per i download la copertura
 * e' l'appartenenza all'elenco; la corrispondenza fra le destinazioni resta ai
 * test dei singoli workflow.
 */
import './lib/stdout-off-runner-pipe.mjs'; // stdout e' la pipe dei frame di node:test (issue 1819)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { relativeImportSpecifiers } from '../../scripts/ci/lib/import-specifiers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const JS_FILE_RE = /\.(?:mjs|cjs|js)$/;

const isFile = (root, file) => {
  try { return fs.statSync(path.join(root, file)).isFile(); } catch { return false; }
};

/** Chiusura degli import relativi di `entry`; un import che non risolve e' riportato a parte. */
function importClosure(root, entry) {
  const files = new Set();
  const unresolved = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file)) continue;
    if (!isFile(root, file)) { unresolved.push(file); continue; }
    files.add(file);
    if (!JS_FILE_RE.test(file)) continue;
    for (const specifier of relativeImportSpecifiers(fs.readFileSync(path.join(root, file), 'utf8'))) {
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
    }
  }
  return { files: [...files], unresolved };
}

const stripSlashes = (pattern) => pattern.replace(/^\//, '').replace(/\/$/, '');

function patternToRegExp(pattern) {
  const body = stripSlashes(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${body}(?:/.*)?$`);
}

/** Copertura di un blocco sparse: gitignore (vince l'ultima regola) oppure cone. */
function sparseCoverage(entries, cone) {
  const rules = entries.map((entry) => ({
    negative: entry.startsWith('!'),
    raw: stripSlashes(entry.replace(/^!/, '')),
    re: patternToRegExp(entry.replace(/^!/, '')),
  }));
  if (cone) {
    return (file) => {
      if (!file.includes('/')) return true; // i file di radice ci sono sempre
      const dir = path.posix.dirname(file);
      return rules.some(({ negative, raw }) => !negative
        // la cartella nominata, ricorsivamente; e i file diretti di ogni suo antenato
        && (file.startsWith(`${raw}/`) || raw === dir || raw.startsWith(`${dir}/`)));
    };
  }
  return (file) => {
    let included = false;
    for (const rule of rules) if (rule.re.test(file)) included = !rule.negative;
    return included;
  };
}

/** I blocchi `sparse-checkout: |` di un workflow, con la modalita' cone del loro step. */
export function sparseLists(yamlText) {
  const lines = yamlText.split('\n');
  const indentOf = (line) => line.match(/^\s*/)[0].length;
  const lists = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)sparse-checkout:\s*\|/.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length;
    const entries = [];
    let end = i + 1;
    for (; end < lines.length; end += 1) {
      if (lines[end].trim() === '') continue;
      if (indentOf(lines[end]) <= indent) break;
      const entry = lines[end].trim();
      if (!entry.startsWith('#')) entries.push(entry);
    }
    // Le altre chiavi dello stesso `with:` stanno alla stessa indentazione,
    // prima o dopo il blocco.
    const siblings = [];
    for (let j = i - 1; j >= 0 && (lines[j].trim() === '' || indentOf(lines[j]) >= indent); j -= 1) siblings.push(lines[j]);
    for (let j = end; j < lines.length && (lines[j].trim() === '' || indentOf(lines[j]) >= indent); j += 1) siblings.push(lines[j]);
    const cone = !siblings.some((line) => /^\s*sparse-checkout-cone-mode:\s*false\b/.test(line));
    lists.push({ where: `sparse-checkout alla riga ${i + 1}`, entries, cone });
  }
  return lists;
}

/** I file che un workflow scarica con `download_and_check`: primo argomento, o `sorgente|destinazione`. */
export function downloadList(yamlText) {
  if (!/download_and_check\s*\(\)/.test(yamlText)) return null;
  const direct = [...yamlText.matchAll(/download_and_check\s*(?:\\\s*\n\s*)?'([^'|\n]+)'/g)].map((match) => match[1]);
  const specs = [...yamlText.matchAll(/'([^'|\s]+)\|[^'\n]+'/g)].map((match) => match[1]);
  return { where: 'download_and_check', sources: [...new Set([...direct, ...specs])] };
}

/** Le violazioni della regola in un workflow: `{ where, root, missing }`. */
export function listViolations(root, yamlText) {
  const violations = [];
  let lists = 0;
  for (const list of sparseLists(yamlText)) {
    const positive = list.entries.filter((entry) => !entry.startsWith('!')).map(stripSlashes);
    const named = positive.filter((entry) => JS_FILE_RE.test(entry) && !entry.includes('*') && isFile(root, entry));
    if (named.length === 0) continue;
    lists += 1;
    const covers = sparseCoverage(list.entries, list.cone);
    for (const file of named) {
      const { files, unresolved } = importClosure(root, file);
      const missing = [...files.filter((dep) => !covers(dep)), ...unresolved];
      if (missing.length > 0) violations.push({ where: list.where, root: file, missing });
    }
  }
  const download = downloadList(yamlText);
  if (download) {
    const named = download.sources.filter((source) => JS_FILE_RE.test(source) && isFile(root, source));
    if (named.length > 0) {
      lists += 1;
      for (const file of named) {
        const { files, unresolved } = importClosure(root, file);
        const missing = [...files.filter((dep) => !download.sources.includes(dep)), ...unresolved];
        if (missing.length > 0) violations.push({ where: download.where, root: file, missing });
      }
    }
  }
  return { lists, violations };
}

test('ogni elenco di file di un workflow porta con se\' gli import dei file che nomina', () => {
  const dir = path.join(ROOT, '.github/workflows');
  const report = [];
  const examined = new Map();
  for (const name of fs.readdirSync(dir).filter((file) => /\.ya?ml$/.test(file)).sort()) {
    const { lists, violations } = listViolations(ROOT, fs.readFileSync(path.join(dir, name), 'utf8'));
    if (lists > 0) examined.set(name, lists);
    for (const { where, root, missing } of violations) {
      report.push(`${name} (${where}): ${root} importa ${missing.join(', ')}, che l'elenco non porta`);
    }
  }
  // Se il parser smettesse di trovare gli elenchi, il test sarebbe verde a vuoto.
  for (const known of [
    'enable-native-automerge.yml',
    'auto-merge-enroll-sweep.yml',
    'orphan-push-warn.yml',
    'retry-code-check-after-body-edit.yml',
    'review-quota-rescuer.yml',
  ]) {
    assert.ok(examined.has(known), `${known}: l'elenco che materializza il loader non e' stato esaminato`);
  }
  assert.deepEqual(report, []);
});

function fixtureTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-list-closure-'));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write('tools/run.mjs', "import { a } from './lib/a.mjs';\nconst b = await import('./lib/b.mjs');\nexport { a, b };\n");
  write('tools/lib/a.mjs', "import './deep/c.mjs';\nexport const a = 1;\n");
  write('tools/lib/b.mjs', 'export const b = 2;\n');
  write('tools/lib/deep/c.mjs', 'export const c = 3;\n');
  write('package.json', '{}\n');
  return root;
}

const sparseStep = (entries, extra = '') => [
  'jobs:',
  '  job:',
  '    steps:',
  '      - uses: actions/checkout@v7',
  '        with:',
  '          sparse-checkout: |',
  ...entries.map((entry) => `            ${entry}`),
  ...(extra ? [`          ${extra}`] : []),
  '      - run: node tools/run.mjs',
].join('\n');

test('un file nominato senza i suoi import e\' una violazione; con gli import non lo e\'', () => {
  const root = fixtureTree();
  try {
    const stale = listViolations(root, sparseStep(['tools/run.mjs', 'tools/lib/a.mjs'], 'sparse-checkout-cone-mode: false'));
    assert.equal(stale.lists, 1);
    // Statico transitivo (c.mjs, da a.mjs) e dinamico (b.mjs): entrambi contano.
    assert.deepEqual(
      stale.violations.map(({ root: file, missing }) => [file, [...missing].sort()]),
      [['tools/run.mjs', ['tools/lib/b.mjs', 'tools/lib/deep/c.mjs']], ['tools/lib/a.mjs', ['tools/lib/deep/c.mjs']]],
    );

    const complete = listViolations(root, sparseStep(
      ['tools/run.mjs', 'tools/lib/a.mjs', 'tools/lib/b.mjs', 'tools/lib/deep/c.mjs'],
      'sparse-checkout-cone-mode: false',
    ));
    assert.deepEqual(complete.violations, []);

    // Una cartella copre il suo albero; un'esclusione successiva lo toglie di nuovo.
    const byDirectory = listViolations(root, sparseStep(['tools/run.mjs', '/tools/lib/'], 'sparse-checkout-cone-mode: false'));
    assert.deepEqual(byDirectory.violations, []);
    const excluded = listViolations(root, sparseStep(['tools/run.mjs', '/tools/lib/', '!/tools/lib/deep/'], 'sparse-checkout-cone-mode: false'));
    assert.deepEqual(excluded.violations.map(({ missing }) => missing), [['tools/lib/deep/c.mjs']]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('un import che non risolve a un file e\' una violazione, non un silenzio', () => {
  const root = fixtureTree();
  try {
    fs.rmSync(path.join(root, 'tools/lib/deep/c.mjs'));
    const { violations } = listViolations(root, sparseStep(['tools/run.mjs', '/tools/lib/'], 'sparse-checkout-cone-mode: false'));
    assert.deepEqual(violations.map(({ missing }) => missing), [['tools/lib/deep/c.mjs']]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('la modalita\' cone e\' quella dello step: cartelle, file di radice e file degli antenati', () => {
  const lists = sparseLists(sparseStep(['tools/lib']));
  assert.equal(lists.length, 1);
  assert.equal(lists[0].cone, true, 'senza `sparse-checkout-cone-mode: false` il blocco e\' in cone mode');
  const covers = sparseCoverage(lists[0].entries, true);
  assert.equal(covers('package.json'), true);
  assert.equal(covers('tools/run.mjs'), true, 'file diretto di un antenato della cartella nominata');
  assert.equal(covers('tools/lib/deep/c.mjs'), true);
  assert.equal(covers('other/x.mjs'), false);

  const other = sparseLists([
    'steps:',
    '  - uses: actions/checkout@v7',
    '    with:',
    '      sparse-checkout-cone-mode: false',
    '      sparse-checkout: |',
    '        tools/run.mjs',
    '  - uses: actions/checkout@v7',
    '    with:',
    '      sparse-checkout: |',
    '        tools',
  ].join('\n'));
  assert.deepEqual(other.map(({ cone }) => cone), [false, true], 'la chiave di uno step non vale per quello dopo');
});

test('i download si leggono dagli argomenti di download_and_check, non dal testo attorno', () => {
  const root = fixtureTree();
  try {
    const workflow = (sources) => [
      '      - run: |',
      '          download_and_check() { curl "$1" -o "$2"; }',
      "          # un commento che nomina 'tools/lib/deep/c.mjs' non scarica niente",
      ...sources,
    ].join('\n');
    const stale = listViolations(root, workflow([
      "          download_and_check \\",
      "            'tools/run.mjs' \"$dir/run.mjs\"",
      "          for spec in 'tools/lib/a.mjs|lib/a.mjs'; do :; done",
    ]));
    assert.equal(stale.lists, 1);
    assert.deepEqual(
      stale.violations.map(({ root: file, missing }) => [file, [...missing].sort()]),
      [['tools/run.mjs', ['tools/lib/b.mjs', 'tools/lib/deep/c.mjs']], ['tools/lib/a.mjs', ['tools/lib/deep/c.mjs']]],
    );
    const complete = listViolations(root, workflow([
      "          download_and_check 'tools/run.mjs' \"$dir/run.mjs\"",
      "          for spec in 'tools/lib/a.mjs|lib/a.mjs' 'tools/lib/b.mjs|lib/b.mjs' 'tools/lib/deep/c.mjs|lib/deep/c.mjs'; do :; done",
    ]));
    assert.deepEqual(complete.violations, []);
    assert.equal(downloadList('run: echo niente'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
