/**
 * Contratto del repository_dispatch emesso dal publisher.
 *
 * Il sito deve poter distinguere la run Publish article data API che ha
 * pubblicato la superficie da un repository_dispatch generico. Il payload è
 * volutamente bounded: event_type più il solo set di attestazione previsto,
 * senza credenziali, override o materiale del corpus.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = readFileSync(resolve(ROOT, '.github/workflows/publish-api.yml'), 'utf8');

function stepBlock(name) {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex((line) => line === `      - name: ${name}`);
  assert.notEqual(start, -1, `${name}: step assente`);
  const end = lines.findIndex((line, index) => index > start && /^      - (?:name:|uses:)/.test(line));
  return lines.slice(start, end === -1 ? lines.length : end).join('\n');
}

const NOTIFY_STEP = stepBlock('Notify the site');
const JQ_START = NOTIFY_STEP.indexOf('dispatch_payload=$(jq -cn');
const CURL_START = NOTIFY_STEP.indexOf('code=$(curl', JQ_START);
assert.ok(JQ_START >= 0, 'Notify the site: costruzione jq assente');
assert.ok(CURL_START > JQ_START, 'Notify the site: curl deve seguire la costruzione del payload');
const PAYLOAD_CONSTRUCTION = NOTIFY_STEP.slice(JQ_START, CURL_START);

const EXPECTED_FIELDS = [
  ['event_type', 'event_type'],
  ['schema_version', 'schema_version'],
  ['source_repository', 'source_repository'],
  ['source_workflow', 'source_workflow'],
  ['source_workflow_path', 'source_workflow_path'],
  ['source_run_id', 'source_run_id'],
  ['source_run_attempt', 'source_run_attempt'],
  ['source_sha', 'source_sha'],
  ['source_branch', 'source_branch'],
  ['source_event', 'source_event'],
];

test('Notify the site emette il payload bounded con il contratto completo', () => {
  assert.match(NOTIFY_STEP, /if: steps\.deploy\.outcome == 'success' && github\.event_name == 'push'/);
  assert.match(NOTIFY_STEP, /continue-on-error: true/);
  assert.match(PAYLOAD_CONSTRUCTION, /jq -cn/);
  assert.match(PAYLOAD_CONSTRUCTION, /--argjson schema_version 1/);
  assert.match(PAYLOAD_CONSTRUCTION, /--arg event_type "articles-published"/);

  for (const [field, envName] of [
    ['source_repository', 'GITHUB_REPOSITORY'],
    ['source_workflow', 'GITHUB_WORKFLOW'],
    ['source_workflow_path', ''],
    ['source_run_id', 'GITHUB_RUN_ID'],
    ['source_run_attempt', 'GITHUB_RUN_ATTEMPT'],
    ['source_sha', 'GITHUB_SHA'],
    ['source_branch', 'GITHUB_REF_NAME'],
    ['source_event', ''],
  ]) {
    if (envName) {
      assert.match(
        PAYLOAD_CONSTRUCTION,
        new RegExp(`--arg ${field} "\\$${envName}"`),
        `${field}: sorgente ${envName} assente`,
      );
    } else {
      assert.match(
        PAYLOAD_CONSTRUCTION,
        new RegExp(`--arg ${field} "${field === 'source_event' ? 'push' : '\\.github/workflows/publish-api\\.yml'}"`),
        `${field}: valore contrattuale assente`,
      );
    }
  }

  const objectFields = [...PAYLOAD_CONSTRUCTION.matchAll(/^\s+([a-z_]+):\s+\$([a-z_]+),?$/gm)]
    .map(([, field, variable]) => [field, variable]);
  assert.deepEqual(objectFields, EXPECTED_FIELDS, 'il payload deve contenere solo le chiavi contrattuali');
  assert.match(PAYLOAD_CONSTRUCTION, /client_payload:\s*\{/);
  assert.match(NOTIFY_STEP, /-d "\$dispatch_payload"/);
});

test('l’attestazione non include segreti, HMAC, dry-run o dati del corpus', () => {
  assert.doesNotMatch(
    PAYLOAD_CONSTRUCTION,
    /secrets\.|SITE_REPO_PAT|GITHUB_TOKEN|FIREBASE|REMOTE_CONFIG|\bPAT\b|HMAC|signature|dry[-_]run|toJson|GITHUB_ENV|GITHUB_OUTPUT/i,
  );
  assert.doesNotMatch(PAYLOAD_CONSTRUCTION, /github\.event\.(?!name)/);
  assert.doesNotMatch(PAYLOAD_CONSTRUCTION, /content\/|dist\/|articles\.json|env/);
});

test('PAT opzionale e dispatch non-204 conservano il fallback schedule', () => {
  assert.match(NOTIFY_STEP, /PAT: \$\{\{ secrets\.SITE_REPO_PAT \}\}/);
  assert.match(NOTIFY_STEP, /if \[ -z "\$\{PAT:-\}" \]; then/);
  assert.match(NOTIFY_STEP, /SITE_REPO_PAT unset — the site will pick this up on its schedule/);
  assert.match(NOTIFY_STEP, /exit 0/);
  assert.match(NOTIFY_STEP, /if \[ "\$code" != "204" \]; then/);
  assert.match(NOTIFY_STEP, /dispatch returned \$code — the site will pick this up on its schedule/);
});
