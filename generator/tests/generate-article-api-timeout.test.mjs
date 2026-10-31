import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS = [
  '.github/workflows/generate-article-core.yml',
  '.github/workflows/generate-article.yml',
];

for (const relativePath of WORKFLOWS) {
  test(`${relativePath}: admission API bounded`, () => {
    const source = readFileSync(path.join(ROOT, relativePath), 'utf8');
    assert.match(source, /api_timeout_seconds=60/);
    assert.match(
      source,
      /timeout --kill-after=0s "\$\{remaining\}s" gh api "\$@"/,
    );
    assert.match(source, /admission_budget_seconds=240/);
    assert.match(source, /remaining=\$\(\(admission_deadline - SECONDS\)\)/);
    const wrapperDefinition = source.indexOf('gh_api_timeout() {');
    const firstWrapperUse = source.indexOf('gh_api_timeout --');
    assert.ok(
      wrapperDefinition >= 0 && firstWrapperUse > wrapperDefinition,
      'il confronto push deve usare il wrapper dopo la sua definizione',
    );
    assert.doesNotMatch(source, /^\s+gh api\b/m, 'nessuna chiamata deve bypassare il wrapper');
    assert.equal(
      (source.match(/gh_api_timeout(?:\s|\()/g) || []).length,
      4,
      'tre chiamate bounded piu\u0300 la definizione devono restare protette',
    );
    assert.match(
      source,
      /actions\/workflows\/(?:generate-article\.yml|\$CALLER_WORKFLOW)\/runs\?per_page=100&created=%3E%3D\$admission_since/,
      'le run devono essere lette in una snapshot bounded',
    );
    assert.match(
      source,
      /ALL_RUN_STATUSES='\["queued","in_progress","requested","waiting","pending","completed"\]'/,
      'la snapshot deve validare tutti gli stati restituiti dall\'API',
    );
    const linkGate = source.indexOf('if [ "$is_link" = "true" ]; then');
    const snapshot = source.indexOf('created=%3E%3D$admission_since');
    assert.ok(
      linkGate >= 0 && snapshot > source.indexOf('fail_closed_admission()'),
      'la snapshot bounded deve essere parte del gate di ammissione',
    );
    assert.doesNotMatch(
      source,
      /actions\/workflows\/(?:generate-article\.yml|\$CALLER_WORKFLOW)\/runs\?per_page=100"/,
      'il gate non deve piu\u0300 paginare tutta la cronologia',
    );
  });
}
