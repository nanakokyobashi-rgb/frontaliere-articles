import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../../.github/workflows/publish-api.yml', import.meta.url), 'utf8');
const marker = '      - name: Publish governed blog cover bytes before Pages deploy';
const start = workflow.indexOf(marker);
const end = workflow.indexOf('\n      - name:', start + marker.length);
const step = start >= 0 && end >= 0 ? workflow.slice(start, end) : '';

test('publish-api uploads changed hero and thumbnail bytes from public-only cover PRs', () => {
  assert.notEqual(start, -1, 'cover sync step is present');
  assert.match(step, /git diff --name-only --diff-filter=AMRC --find-renames --find-copies/);
  assert.match(step, /git cat-file -e "\$\{BEFORE\}\^\{commit\}"/);
  assert.match(step, /REF: \$\{\{ github\.ref \}\}/);
  assert.match(step, /refs\/heads\/main/);
  assert.match(step, /public\/images\/blog\/\*\.webp/);
  assert.match(step, /public\/images\/blog\/thumbnails\/\*\.webp/);
  assert.match(step, /data\/blog-cover-cdn-sync-queue\.json/);
  assert.match(step, /scripts\/lib\/upload-cdn-file\.sh/);
  assert.match(step, /https:\/\/cdn\.frontaliereticino\.ch\/\$key/);
  assert.match(step, /scripts\/cf-purge-cache\.mjs/);
  assert.match(step, /push origin HEAD:main/);
  assert.match(step, /GITHUB_PAT_NANAKO is required to persist the cover sync queue/);
  assert.match(step, /rebuild_manifest_from_queue/);
  assert.match(step, /rebase conflict/);
  assert.match(step, /github\.event_name == 'schedule'/);
  assert.match(step, /github\.event_name == 'workflow_dispatch'/);
  assert.doesNotMatch(step, /continue-on-error/);
});

// Fra il 7 e l'8 ottobre 2026 questo passo e' fallito 16 volte: il push della
// coda partiva come bot di Actions e la regola di `main` lo respingeva. Il test
// qui sopra era verde, perche' verificava che ci fosse la riga `--unset-all
// http.https://github.com/.extraheader`, che con actions/checkout v6+ non
// trova piu' niente. Quello che conta e' che il checkout del job non persista
// il proprio token: la regola generale e' in workflow-push-identity.test.mjs.
test('publish-api pushes the cover queue as the owner PAT, and names a rule rejection', () => {
  const beforeStep = workflow.slice(0, start);
  const checkout = beforeStep.lastIndexOf('- uses: actions/checkout@');
  assert.notEqual(checkout, -1, 'the publish job checks out the repository before the cover step');
  const nextStep = beforeStep.indexOf('\n      - ', checkout + 1);
  const checkoutBlock = beforeStep.slice(checkout, nextStep === -1 ? undefined : nextStep);
  assert.match(checkoutBlock, /^\s*persist-credentials:\s*false\s*$/m);
  // The dead mitigation must not come back as the only one.
  assert.doesNotMatch(step, /--unset-all http\.https:\/\/github\.com\/\.extraheader/);
  assert.match(step, /git -c "http\.extraheader=AUTHORIZATION: basic \$auth_header" push origin HEAD:main/);
  // A rule rejection is reported as such and stops the retries: the old loop
  // printed «main advanced … rebasing» for it, three times, on every failure.
  assert.match(step, /GH013\|repository rule violations/);
  assert.match(step, /cover queue push rejected by a repository rule on main/);
});
