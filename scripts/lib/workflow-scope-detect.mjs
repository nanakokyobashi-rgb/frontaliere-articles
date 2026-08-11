/**
 * workflow-scope-detect.mjs — shared `.github/workflows/**`-scope detection.
 *
 * Extracted from followup-drainer.mjs (escalation #1724) so `check-workflows-scope.mjs`
 * (escalation #3887/#4227) shares the SAME regex + exclusion logic instead of a
 * hand-duplicated copy. The duplication was the direct cause of a false-positive
 * infinite loop (issue #4437, observed 2026-07-18→2026-07-27, 51 identical park
 * comments over 9 days): followup-drainer's `detectWorkflowScoped` correctly bails out
 * when the body ALSO cites non-workflow code paths (the fix might live there), but
 * check-workflows-scope.mjs's `extractWorkflowPaths` had no such exclusion — it blocked
 * on ANY `.github/workflows/*.yml` substring, even a passing reference inside an
 * unrelated "live-verification" checklist bullet. That asymmetry meant: the drainer
 * would happily re-promote the issue (its own check says "not scoped"), issue-fix.yml's
 * own pre-flight would immediately re-block it, and — because the block removed
 * `agent:fix` without adding any terminal label — issue-triage.yml's sweep would treat
 * it as unrouted and re-queue it, forever, ~4h cadence.
 *
 * CONSERVATIVE (bias to PROMOTE — a false park/block delays a real fix): a body is
 * "exclusively workflow-scoped" only when it cites ≥1 workflow path AND no non-workflow
 * code path (scripts/build-plugins/services/components/hooks/build/src/...). If it
 * cites both, the fix might live in the code file → let the fixer decide.
 */

// Matches `.github/workflows/<name>.yml` (or `.yaml`) ANYWHERE in body text — backticks,
// fenced code blocks, or bare markdown prose/bullets.
export const WORKFLOW_PATH_RE = /\.github\/workflows\/[A-Za-z0-9._/-]+\.ya?ml\b/g;

// Bare `<name>.yml` (a workflow is always .yml; in a follow-up a bare .yml that isn't a
// known config file indicates a workflow file almost every time).
export const BARE_YML_RE = /\b[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml\b/g;

// Non-workflow code paths: if cited, the fix might live there → not exclusively scoped.
// Must cover every top-level code dir in the repo (`ls -d */`), not just scripts/services/
// components/hooks/build/src — a PR review on #4778 caught this list missing `infra/`
// (infra/cloudflare-worker/locale-router.js — funnel-critical), `server/`
// (server/newsletterResendWebhook.js), and `functions/` (functions/index.js,
// functions/src/*.js): an issue citing a workflow path alongside one of those would be
// wrongly judged "exclusively workflow-scoped" and blocked, reproducing the #4437 bug
// class in a different directory. `engine`/`host`/`tests` added for #229: this repo's
// own top-level `engine/` and `host/` (AGENTS.md non-negotiables #3/#4) and
// `generator/tests/` weren't covered by any keyword at all — a body citing only
// `engine/ogPagesPlugin.ts` alongside a workflow path matched ZERO code refs and was
// misjudged "exclusively workflow-scoped".
//
// The leading `(?:[A-Za-z0-9_-]+\/)*` is the other half of #229: without it, a match
// starts AT the keyword, so `generator/scripts/create-article.mjs` (this repo's actual
// layout — `scripts/` lives under `generator/`, not at repo root) yielded the substring
// `scripts/create-article.mjs`. That's fine for the boolean "does a code path exist"
// check `detectWorkflowScoped` needs, but `extractCodePaths` below feeds
// `findOverlapFile`'s EXACT Set-membership test against real `gh pr diff --name-only`
// paths — `scripts/create-article.mjs` never equals `generator/scripts/create-article.mjs`,
// so the overlap-file pre-flight (escalation #3810) silently no-op'd for every nested
// path, which is the norm here (generator/scripts/**, generator/tests/**, …). Root cause
// of `fix-outcome:overlap-skip` recurring 9×/14gg despite the pre-flight already existing
// (#206/#202/#191 measured 2026-08-10): the Claude fixer burned a full run to find
// overlaps the pre-flight was built to catch for free, because the extracted path never
// matched the real one.
export const CODE_PATH_RE = /\b(?:[A-Za-z0-9_-]+\/)*(?:scripts|build-plugins|services|components|hooks|build|src|infra|server|functions|engine|host|tests)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+\b/g;

// `.yml` config files that are NOT workflows (don't imply the `workflows` scope).
export const NON_WORKFLOW_YML = new Set([
  'lighthouserc.yml', 'pnpm-workspace.yml', 'docker-compose.yml',
  '.prettierrc.yml', 'vitest.yml',
]);

/** True if `text` cites at least one non-workflow code path (scripts/, build-plugins/, ...). */
export function hasNonWorkflowCodeRefs(text) {
  return (String(text || '').match(CODE_PATH_RE) || []).length > 0;
}

/**
 * True if the fix is EXCLUSIVELY workflow-scoped (requires editing `.github/workflows/**`),
 * so promoting it would burn quota on a run the push would block anyway. Pure → testable.
 * @param {string} text  title + body of the issue
 */
export function detectWorkflowScoped(text) {
  const s = String(text || '');
  const wfFull = s.match(WORKFLOW_PATH_RE) || [];
  const bareYml = (s.match(BARE_YML_RE) || []).filter(
    (y) => !NON_WORKFLOW_YML.has(y.toLowerCase()),
  );
  const workflowRefs = [...new Set([...wfFull, ...bareYml])];
  if (workflowRefs.length === 0) return false; // no workflow reference → promote
  if (hasNonWorkflowCodeRefs(s)) return false; // also cites non-workflow code → might fix there → promote
  return true; // workflow-only → blocked-workflows-scope by construction
}
