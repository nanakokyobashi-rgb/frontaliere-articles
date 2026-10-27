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
      5,
      'quattro chiamate bounded piu\u0300 la definizione devono restare protette',
    );
    assert.match(
      source,
      /actions\/workflows\/(?:generate-article\.yml|\$CALLER_WORKFLOW)\/runs\?per_page=100&status=\$status/,
      'le run in volo devono essere lette per status',
    );
    assert.match(
      source,
      /actions\/workflows\/(?:generate-article\.yml|\$CALLER_WORKFLOW)\/runs\?per_page=100&created=%3E%3D\$recent_since/,
      'il tetto orario deve leggere solo la finestra recente',
    );
    const linkGate = source.indexOf('if [ "$is_link" = "true" ]; then');
    const recentWindow = source.indexOf('created=%3E%3D$recent_since');
    assert.ok(
      linkGate >= 0 && recentWindow > linkGate,
      'la finestra oraria deve essere letta solo per gli anelli',
    );
    assert.doesNotMatch(
      source,
      /actions\/workflows\/(?:generate-article\.yml|\$CALLER_WORKFLOW)\/runs\?per_page=100"/,
      'il gate non deve piu\u0300 paginare tutta la cronologia',
    );
  });
}
