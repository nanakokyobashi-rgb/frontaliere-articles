/**
 * Il review gate gira da `main`, non dal branch della PR: `tests.yml` scarica
 * `scripts/ci/review-gate.mjs` e i suoi moduli UNO PER UNO con `download_main`
 * e poi lo esegue da una directory isolata. Quella lista e' scritta a mano.
 *
 * Il modo in cui si rompe e' silenzioso fino al momento peggiore: `node --check`
 * passa, i test passano, la PR e' verde — e poi il gate muore con
 * ERR_MODULE_NOT_FOUND su OGNI PR, perche' un import nuovo (anche transitivo,
 * anche aggiunto in un file che nessuno ha toccato in quella PR) non e' nella
 * lista. Nessun test del repo copriva questa lista: `loop-scripts-closure`
 * verifica che gli import risolvano nel CHECKOUT, dove tutto c'e'.
 *
 * Questo test cammina il grafo reale degli import relativi a partire dal gate
 * e pretende che ogni file che ne fa parte sia scaricato. E' un gate sulla
 * DIFFERENZA fra due insiemi, quindi non va aggiornato quando la lista cresce
 * per ragioni legittime: si aggiorna da solo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = '.github/workflows/tests.yml';
const ENTRY = 'scripts/ci/review-gate.mjs';

const MANIFEST = 'scripts/ci/review-gate-bootstrap-manifest.json';

/**
 * I moduli che il bootstrap porta accanto al gate.
 *
 * La lista NON vive piu' nello YAML: vive nel manifest, che viene letto dallo
 * stesso `policy_ref` pinnato dei moduli. Era necessario perche' pinnare solo
 * il ref lasciava aperta la stessa rottura da un'altra porta — una PR aperta
 * prima che un modulo entrasse nel grafo scaricava l'entrypoint nuovo con la
 * lista vecchia e il gate moriva con ERR_MODULE_NOT_FOUND.
 */
function downloadedPaths() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST), 'utf8'));
  assert.ok(Array.isArray(manifest.modules) && manifest.modules.length > 0,
    `${MANIFEST}: lista modules mancante o vuota`);
  return new Set(manifest.modules);
}

/**
 * Specificatori relativi di un modulo: `import` statici, `export ... from` e
 * `import(...)` DINAMICI. I dinamici contano quanto gli statici — anzi, di
 * piu': `mergePreviewCheck.mjs` carica `duplicateDeclarations.mjs` cosi', e un
 * modulo assente li' fallisce a meta' esecuzione invece che all'avvio, quindi
 * uno scanner che li ignora li dichiara «scaricati per sicurezza» e invita a
 * toglierli.
 */
function relativeSpecifiers(source) {
  const out = [];
  const patterns = [
    /^\s*import\s[^;]*?\sfrom\s*['"](\.[^'"]+)['"]/gmu,
    /^\s*import\s*['"](\.[^'"]+)['"]/gmu,
    /^\s*export\s[^;]*?\sfrom\s*['"](\.[^'"]+)['"]/gmu,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/gmu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) out.push(match[1]);
  }
  return out;
}

function resolveFrom(fromRepoPath, specifier) {
  const candidate = path.normalize(path.join(path.dirname(fromRepoPath), specifier));
  return fs.existsSync(path.join(ROOT, candidate)) ? candidate : null;
}

/** Chiusura transitiva degli import relativi a partire da `entry`. */
function importClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    let source;
    try {
      source = fs.readFileSync(path.join(ROOT, current), 'utf8');
    } catch {
      continue;
    }
    for (const specifier of relativeSpecifiers(source)) {
      const resolved = resolveFrom(current, specifier);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

test('ogni modulo del grafo del review gate e\' scaricato dal bootstrap di tests.yml', () => {
  const downloaded = downloadedPaths();
  assert.ok(downloaded.has(ENTRY), `${MANIFEST}: il bootstrap non scarica nemmeno ${ENTRY}`);

  const closure = importClosure(ENTRY);
  const missing = [...closure].filter((file) => !downloaded.has(file)).sort();
  assert.deepEqual(missing, [],
    'Questi moduli fanno parte del grafo di review-gate.mjs ma tests.yml non li scarica: '
    + 'il gate morirebbe con ERR_MODULE_NOT_FOUND su OGNI PR, dopo essere passato '
    + `indenne da node --check e dai test.\n    ${missing.join('\n    ')}`);
});

test('il bootstrap non scarica moduli che nessuno del grafo importa', () => {
  const downloaded = downloadedPaths();
  const closure = importClosure(ENTRY);
  // `auto-merge-eval.mjs` non e' nel grafo del gate: lo scarica perche' altri
  // step della stessa famiglia lo eseguono dalla stessa directory isolata.
  // Dichiararlo qui e' il punto: un file scaricato «per sicurezza» e mai
  // importato da nessuno dei due grafi e' peso che nessuno ricorda di togliere.
  const secondEntry = 'scripts/ci/auto-merge-eval.mjs';
  const secondClosure = importClosure(secondEntry);
  const extras = [...downloaded]
    .filter((file) => file !== secondEntry && !closure.has(file) && !secondClosure.has(file))
    .sort();
  assert.deepEqual(extras, [],
    `Moduli scaricati dal bootstrap che nessuno importa:\n    ${extras.join('\n    ')}`);
});

test('lo YAML non tiene una copia della lista', () => {
  // La lista la dice il ref trusted. Tenerne una copia qui la rendeva la lista
  // della PR, e questo rompeva in DUE direzioni opposte: una PR aperta prima
  // che un modulo entrasse nel grafo scaricava l'entrypoint nuovo con la lista
  // vecchia (#1599), e una PR che AGGIUNGE un modulo chiedeva alla punta di
  // main un file che solo lei introduce, quindi non poteva girare affatto
  // (#1640, #1641).
  const workflow = fs.readFileSync(path.join(ROOT, WORKFLOW), 'utf8');
  assert.match(workflow, new RegExp(`download_main ${MANIFEST.replace(/[./]/gu, '\\$&')}`, 'u'),
    `${WORKFLOW}: il bootstrap non scarica il manifest dal ref trusted`);
  const hardcoded = [...workflow.matchAll(/^\s*download_main\s+(\S+)\s+\S+\s*$/gmu)]
    .map((match) => match[1])
    .filter((entry) => entry !== MANIFEST && !entry.startsWith('"'));
  assert.deepEqual(hardcoded, [],
    `${WORKFLOW}: moduli ancora elencati a mano: tornerebbero dalla lista della PR invece che da main — ${hardcoded.join(', ')}`);
});
