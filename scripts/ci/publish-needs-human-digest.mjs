/**
 * Strict publisher for the recycle-stale-prs needs-human digest.
 *
 * `github-issue-creator.mjs` keeps its CLI best-effort for the many failure
 * reporters that run after an upstream failure. This caller is different: a
 * successful step is the watchdog's evidence that the human digest was
 * persisted. `--fail-on-write` turns its `persisted: false`/null result into
 * a non-zero exit without changing the shared reporter's default contract.
 */
import { createGithubIssue } from '../lib/github-issue-creator.mjs';

const args = process.argv.slice(2);
const get = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
};
const collect = (flag) => {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && index + 1 < args.length) values.push(args[index + 1]);
  }
  return values;
};

const failOnWrite = args.includes('--fail-on-write');
const title = get('--title');

if (!title) {
  console.error('Usage: node publish-needs-human-digest.mjs --fail-on-write --title "..."');
  process.exit(1);
}

try {
  const labels = collect('--label');
  const result = await createGithubIssue({
    title,
    description: get('--description') || '',
    priority: Number(get('--priority') || 3),
    labels: labels.length > 0 ? labels : ['bug'],
    workflow: get('--workflow'),
  });

  if (failOnWrite && (!result || result.persisted === false)) {
    console.error('[publish-needs-human-digest] write not persisted; watchdog must keep the previous digest visible');
    process.exit(1);
  }
  const issueNumber = result && Number.isInteger(result.number) && result.number > 0
    ? result.number
    : null;
  if (failOnWrite && issueNumber === null) {
    console.error('[publish-needs-human-digest] write acknowledged without an issue number; watchdog cannot realign the digest body');
    process.exit(1);
  }
  if (issueNumber !== null) {
    // Machine-readable stdout lets the same workflow step reuse the number
    // returned by create/reopen without issuing a second paginated lookup.
    console.log(`[publish-needs-human-digest] issue_number=${issueNumber}`);
  }
  console.log('[publish-needs-human-digest] digest write acknowledged');
  process.exit(0);
} catch (error) {
  console.error(`[publish-needs-human-digest] Error: ${error.message}`);
  process.exit(failOnWrite ? 1 : 0);
}
