// Standing gate on the FUNCTION half of SiteShellContract.
//
// shell-contract-fingerprint.test.mjs pins the 21 scalar fields — the strings
// and numbers that render into every <head>. It cannot pin the functions:
// `esc`, `rootShell`, `railGutters`, `WriteCollector`, `titleSuffix`,
// `inlineScriptJson`, … are code, and a SHA over their source would fire on
// every comment reflow while still missing a behavioural change made through a
// dependency.
//
// Until now those functions were pinned only by a point-in-time comparison —
// 43 pages rendered through both repos' bootstraps on the day of the
// transport. That is not a gate: nothing re-runs it, so a change to
// build-plugins/htmlTemplate.ts in the main repo would silently diverge this
// repo's output from the full build's, and the first symptom would be a
// fast-published page differing from the build that later overwrites it.
//
// This test pins them by BEHAVIOUR instead: each function is called with fixed
// inputs and its output compared against a recorded expectation. The
// expectations were captured from the main repo's own bootstrap
// (build-plugins/articlesSiteShellBootstrap.ts) at transport time, so a drift
// on either side fails here.
//
// When a change on the main side is intentional, re-record with:
//   node host/tests/shell-contract-functions.test.mjs --record
// and commit the updated JSON in BOTH repos in the same change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'shell-contract-functions.golden.json');

/**
 * Fixed inputs chosen to exercise the branches the article path actually
 * takes, including the escaping and truncation edges that a careless
 * "simplification" upstream would flatten.
 */
async function probe() {
  const { contract: c } = await import('../siteShellBootstrap.ts');
  const out = {};

  out.esc = c.esc('a & b < c > d " e \' f');
  out.escEmpty = c.esc('');

  out.stripLiteralMarkdown = c.stripLiteralMarkdown('**Onkologie___Ärzte** ~~x~~ ==y==');

  out.clampMetaDescription = c.clampMetaDescription('x'.repeat(400));
  out.clampMetaDescriptionShort = c.clampMetaDescription('breve');

  out.truncateHeadline = c.truncateHeadline('Un titolo molto lungo che deve essere troncato', 20);
  out.buildTitleWithBrand = c.buildTitleWithBrand('Titolo');
  out.truncateCodeUnits = c.truncateCodeUnits('abcdefghij', 4);

  out.inlineScriptJson = c.inlineScriptJson({ a: 1, b: '</script>', c: ['x'] });

  out.railGuttersOn = c.railGutters(true);
  out.railGuttersOff = c.railGutters(false);

  out.rootShellWithBundle = c.rootShell(true);
  out.rootShellNoBundle = c.rootShell(false);

  out.asyncCssHeadBlockWith = c.asyncCssHeadBlock('main-abc123.css');
  out.asyncCssHeadBlockWithout = c.asyncCssHeadBlock(undefined);
  out.asyncCssLink = c.asyncCssLink('/assets/x.css');

  out.differentiateH1FromTitle = c.differentiateH1FromTitle('Stesso testo', 'Stesso testo', 'it');

  out.stableChunkFile = c.stableChunkFile('blog');
  out.stableChunkFiles = c.stableChunkFiles(['blog', 'jobs']);

  // WriteCollector is a constructor: pin its observable surface, not its guts.
  const wc = new c.WriteCollector({ distDir: '/tmp/nonexistent-probe', pluginName: 'probe' });
  out.writeCollectorShape = {
    hasAdd: typeof wc.add === 'function',
    hasFlush: typeof wc.flush === 'function',
    skippedByHashInitial: wc.skippedByHash,
  };

  out.imageObjectLd = c.imageObjectLd({ contentUrl: 'https://x/y.webp', caption: 'c', width: 1200 });
  out.getAuthorBySlugKnown = c.getAuthorBySlug('marco-ferrari') ?? null;
  out.getAuthorBySlugUnknown = c.getAuthorBySlug('nessuno-esiste') ?? null;

  return out;
}

if (process.argv.includes('--record')) {
  const actual = await probe();
  writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
  console.log(`recorded ${Object.keys(actual).length} probes -> ${GOLDEN}`);
  process.exit(0);
}

test('transported SiteShellContract functions behave as the main repo\'s do', async () => {
  const expected = JSON.parse(readFileSync(GOLDEN, 'utf-8'));
  const actual = await probe();

  // Compare key by key so a failure names the function that drifted rather
  // than dumping two large objects.
  for (const key of Object.keys(expected)) {
    assert.deepEqual(
      actual[key],
      expected[key],
      `contract.${key} drifted from the recorded main-repo behaviour — ` +
        're-record in BOTH repos if the change was intentional',
    );
  }
  assert.deepEqual(
    Object.keys(actual).sort(),
    Object.keys(expected).sort(),
    'probe set changed — re-record',
  );
});
