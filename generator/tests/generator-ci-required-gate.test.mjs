/**
 * generator-ci-required-gate.test.mjs — il gate #242: un `generator-ci` rosso
 * deve fermare l'auto-merge quando la PR tocca i path che lo attivano.
 *
 * Due cose potevano rompersi in silenzio, ed entrambe hanno un guard qui:
 *
 * - `GENERATOR_CI_TRIGGER_PATHS` (scripts/ci/lib/constants.mjs) è un MIRROR
 *   dei `pull_request.paths` di `.github/workflows/generator-ci.yml` — lo YAML
 *   non può importare una const JS. Se i due divergono, `touchesGeneratorCiPaths`
 *   smette di riconoscere un path che in realtà attiva il workflow (o il
 *   contrario): il gate #242 tornerebbe a essere silenziosamente non-bloccante
 *   per l'esatta classe di PR per cui è stato aperto (engine/host mirror).
 * - `touchesGeneratorCiPaths` è pura → coperta senza `gh`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATOR_CI_TRIGGER_PATHS, GENERATOR_CI_JOB_NAME } from '../../scripts/ci/lib/constants.mjs';
import { touchesGeneratorCiPaths } from '../../scripts/ci/auto-merge-eval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/generator-ci.yml');

/**
 * Estrae i `pull_request.paths` di generator-ci.yml senza un parser YAML
 * (stessa scelta di `ci-check-name.test.mjs`: il repo non ha dipendenze per le
 * gate). Cerca `pull_request:` sotto `on:`, poi `paths:` subito sotto, e
 * raccoglie le voci `- '...'` finché l'indentazione non torna a quella di
 * `pull_request:` o sopra.
 */
function pullRequestPathsFromWorkflow(yaml) {
  const lines = yaml.split('\n');
  const prAt = lines.findIndex((l) => /^  pull_request:\s*$/.test(l));
  assert.notEqual(prAt, -1, 'generator-ci.yml non ha un trigger `pull_request:` a indentazione 2');
  const pathsAt = lines.findIndex((l, i) => i > prAt && /^ {4}paths:\s*$/.test(l));
  assert.notEqual(pathsAt, -1, 'generator-ci.yml non ha `paths:` sotto `pull_request:`');
  const out = [];
  for (let i = pathsAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line) || line.trim() === '') continue; // commenti/righe vuote
    const m = line.match(/^ {6}- '([^']+)'\s*$/);
    if (m) { out.push(m[1]); continue; }
    break; // dedent: fine della lista `paths:`
  }
  assert.ok(out.length > 0, 'nessuna voce trovata sotto `pull_request.paths` di generator-ci.yml');
  return out;
}

test('GENERATOR_CI_TRIGGER_PATHS combacia coi pull_request.paths di generator-ci.yml', () => {
  const fromYaml = pullRequestPathsFromWorkflow(fs.readFileSync(WORKFLOW, 'utf8'));
  // Normalizza entrambi i lati alla stessa forma: 'x/**' e 'x/' sono lo stesso
  // prefisso di cartella; un file esatto resta com'è.
  const normalize = (p) => (p.endsWith('/**') ? p.slice(0, -2) : p);
  const yamlNormalized = fromYaml.map(normalize).sort();
  const constNormalized = [...GENERATOR_CI_TRIGGER_PATHS].sort();

  assert.deepEqual(
    constNormalized,
    yamlNormalized,
    `GENERATOR_CI_TRIGGER_PATHS (scripts/ci/lib/constants.mjs) = [${constNormalized.join(', ')}] ` +
      `ma generator-ci.yml pull_request.paths = [${yamlNormalized.join(', ')}]. ` +
      `Il gate #242 di auto-merge-eval.mjs userebbe path sbagliati per decidere se ` +
      `attendere il check '${GENERATOR_CI_JOB_NAME}' — allinea le due liste.`,
  );
});

test('touchesGeneratorCiPaths: riconosce i path di cartella (generator/, engine/, host/)', () => {
  assert.equal(touchesGeneratorCiPaths(['generator/tests/foo.test.mjs']), true);
  assert.equal(touchesGeneratorCiPaths(['engine/renderArticlePages.ts']), true);
  assert.equal(touchesGeneratorCiPaths(['host/siteShellBootstrap.ts']), true);
});

test('touchesGeneratorCiPaths: riconosce i match esatti di file', () => {
  assert.equal(touchesGeneratorCiPaths(['package.json']), true);
  assert.equal(touchesGeneratorCiPaths(['package-lock.json']), true);
  assert.equal(touchesGeneratorCiPaths(['.github/workflows/generator-ci.yml']), true);
});

test('touchesGeneratorCiPaths: un file dentro una cartella con un prefisso simile ma diverso NON matcha', () => {
  // 'hostess/' non deve matchare il prefisso 'host/' (bug classico di startsWith
  // senza slash finale) — le entry sono già scritte con lo slash, ma la guardia
  // resta utile se qualcuno lo togliesse per errore in futuro.
  assert.equal(touchesGeneratorCiPaths(['hostess/README.md']), false);
});

test('touchesGeneratorCiPaths: PR di solo contenuto/dati non tocca nulla → false', () => {
  assert.equal(touchesGeneratorCiPaths(['content/it/2026/08/some-article.mdx', 'dist/api/manifest.json']), false);
});

test('touchesGeneratorCiPaths: input non-array → false, non lancia', () => {
  assert.equal(touchesGeneratorCiPaths(undefined), false);
  assert.equal(touchesGeneratorCiPaths(null), false);
});
