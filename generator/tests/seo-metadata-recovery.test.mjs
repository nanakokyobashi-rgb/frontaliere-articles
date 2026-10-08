import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveSeoMetadata } from '../scripts/lib/seo-metadata-derivation.mjs';
import { appendSeoEntrySource, buildSeoEntry, insertSeoEntriesAtHead, toIsoWithTz } from '../scripts/lib/seo-entry-builder.mjs';
import { mergeQueueWithSnapshot } from '../scripts/lib/seo-recovery-queue.mjs';

function article() {
  return {
    id: 'demo-2026',
    date: '2026-03-03T14:39:51.004Z',
    content: {
      it: {
        title: 'Titolo deterministico per',
        excerpt: 'Una descrizione abbastanza lunga da verificare il percorso SEO senza generazione automatica e con una fine di frase completa per il limite.'
          + ' Dati locali del Ticino.',
      },
    },
    imageAlt: { it: 'Panorama del Ticino' },
    slugs: { it: 'titolo-deterministico', en: 'deterministic-title', de: 'deterministischer-titel', fr: 'titre-deterministe' },
    seo: {},
    _generatedImagePath: '/images/places/lugano-view.webp',
    author: { slug: 'redazione', name: 'Redazione Frontaliere Ticino' },
  };
}

test('la derivazione usa i meta esistenti e rimuove la coda funzionale con la regola condivisa', () => {
  const data = article();
  deriveSeoMetadata(data);
  assert.equal(data.seo.headline, 'Titolo deterministico');
  assert.equal(data.seo.ogTitle, 'Titolo deterministico');
  assert.match(data.seo.title, /^Titolo deterministico \| Frontaliere Ticino$/);
  assert.ok(data.seo.description.length <= 160);
  assert.match(data.seo.keywords, /^frontalieri, ticino, svizzera, italia,/);
});

test('il builder mantiene una sola forma JSON-LD e distingue Commons da fallback governato', () => {
  const commons = article();
  deriveSeoMetadata(commons);
  const commonsEntry = buildSeoEntry(commons, {
    provenance: { kind: 'wikimedia-commons', record: { width: 3712, height: 2088 } },
    publishedAt: toIsoWithTz(commons.date, { preserveExplicitOffset: false }),
    modifiedAt: toIsoWithTz(commons.date, { preserveExplicitOffset: false }),
  });
  assert.match(commonsEntry, /"@type": "NewsArticle"/);
  assert.match(commonsEntry, /"datePublished": "2026-03-03T15:39:51\+01:00"/);
  assert.doesNotMatch(commonsEntry, /acquireLicensePage|copyrightNotice|creditText/);

  const generated = article();
  deriveSeoMetadata(generated);
  const generatedEntry = buildSeoEntry(generated, {
    provenance: {
      kind: 'generated',
      record: { licenseUrl: 'https://openai.com/policies/terms-of-use/', credit: 'frontaliereticino.ch', width: 1200, height: 675 },
    },
    publishedAt: toIsoWithTz(generated.date, { preserveExplicitOffset: false }),
    modifiedAt: toIsoWithTz(generated.date, { preserveExplicitOffset: false }),
  });
  assert.match(generatedEntry, /"license": "https:\/\/openai\.com\/policies\/terms-of-use\/"/);
  assert.match(generatedEntry, /"url": `\$\{BASE_URL\}\/images\/places\/lugano-view\.webp`/);
});

test('le date senza orario usano mezzogiorno Europe/Zurich con il cambio DST dichiarato', () => {
  assert.equal(
    toIsoWithTz('2026-01-03', { preserveExplicitOffset: false }),
    '2026-01-03T12:00:00+01:00',
  );
  assert.equal(
    toIsoWithTz('2026-07-03', { preserveExplicitOffset: false }),
    '2026-07-03T12:00:00+02:00',
  );
});

test('appendSeoEntrySource usa il chunk scelto dal writer e non seo-blog.ts', () => {
  const data = article();
  deriveSeoMetadata(data);
  const entry = buildSeoEntry(data, {
    provenance: { kind: 'generated', record: { licenseUrl: 'https://openai.com/policies/terms-of-use/', credit: 'frontaliereticino.ch' } },
    publishedAt: data.date,
    modifiedAt: data.date,
  });
  const source = 'const BLOG_SEO_METADATA_5 = {\n  \'blog-existing\': {},\n};\nexport default BLOG_SEO_METADATA_5;\n';
  const updated = appendSeoEntrySource(source, entry, { seoConstName: 'BLOG_SEO_METADATA', updateRouterUnion: true });
  assert.match(updated, /blog-demo-2026/);
  assert.match(updated, /export default BLOG_SEO_METADATA_5;/);
});

// ── The recovery writes where the generator does not (issue 2453) ───────────
// The generator appends to the SEO chunk and to the cover queue all day long.
// A recovery that appended there too conflicted with every article generated
// while its pull request waited for review.

function builtEntry(id) {
  const data = { ...article(), id };
  deriveSeoMetadata(data);
  return buildSeoEntry(data, {
    provenance: { kind: 'generated', record: { licenseUrl: 'https://openai.com/policies/terms-of-use/', credit: 'frontaliereticino.ch' } },
    publishedAt: data.date,
    modifiedAt: data.date,
  });
}

const SEO_BASE = [
  '// Auto-generated',
  '',
  'const BLOG_SEO_METADATA_5: Record<string, SEOMetadata> = {',
  "  'blog-first': {",
  "    title: 'First',",
  '  },',
  "  'blog-second': {",
  "    title: 'Second',",
  '  },',
  "  'blog-last': {",
  "    title: 'Last',",
  '  },',
  '',
  '};',
  '',
  'export default BLOG_SEO_METADATA_5;',
  '',
].join('\n');

/** `git merge-file`: 0 when the two sides merge cleanly, the number of conflicts otherwise. */
function threeWayMerge(base, ours, theirs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'seo-recovery-merge-'));
  try {
    for (const [name, text] of [['base', base], ['ours', ours], ['theirs', theirs]]) fs.writeFileSync(path.join(directory, name), text);
    const result = spawnSync('git', ['merge-file', '-p', 'ours', 'base', 'theirs'], { cwd: directory, encoding: 'utf8' });
    return { conflicts: result.status, merged: result.stdout };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('insertSeoEntriesAtHead mette le voci subito dopo l\'apertura e lascia intatto il resto', () => {
  const entries = [builtEntry('recovered-one'), builtEntry('recovered-two')];
  const updated = insertSeoEntriesAtHead(SEO_BASE, entries, { seoConstName: 'BLOG_SEO_METADATA' });
  const opener = 'const BLOG_SEO_METADATA_5: Record<string, SEOMetadata> = {\n';
  const head = SEO_BASE.indexOf(opener) + opener.length;
  assert.equal(updated.slice(0, head), SEO_BASE.slice(0, head));
  assert.equal(updated.slice(head), `${entries.join('\n')}\n${SEO_BASE.slice(head)}`);
  assert.ok(updated.indexOf('blog-recovered-one') < updated.indexOf('blog-recovered-two'));
  assert.ok(updated.indexOf('blog-recovered-two') < updated.indexOf('blog-first'));
  assert.equal(insertSeoEntriesAtHead(SEO_BASE, [], { seoConstName: 'BLOG_SEO_METADATA' }), SEO_BASE);
  assert.throws(() => insertSeoEntriesAtHead('const OTHER = {\n};\n', entries, { seoConstName: 'BLOG_SEO_METADATA' }), /Cannot find the opener/);
  assert.throws(() => insertSeoEntriesAtHead(SEO_BASE, [''], { seoConstName: 'BLOG_SEO_METADATA' }), TypeError);
});

test('le voci recuperate si fondono senza conflitto con un articolo generato nel frattempo', () => {
  const generated = appendSeoEntrySource(SEO_BASE, builtEntry('generated-meanwhile'), { seoConstName: 'BLOG_SEO_METADATA', updateRouterUnion: true });
  const recoveredAtHead = insertSeoEntriesAtHead(SEO_BASE, [builtEntry('recovered-one')], { seoConstName: 'BLOG_SEO_METADATA' });
  const merge = threeWayMerge(SEO_BASE, recoveredAtHead, generated);
  assert.equal(merge.conflicts, 0);
  for (const id of ['blog-recovered-one', 'blog-first', 'blog-last', 'blog-generated-meanwhile']) assert.ok(merge.merged.includes(`'${id}'`), id);
  assert.match(merge.merged, /\n};\n\nexport default BLOG_SEO_METADATA_5;\n$/);

  // The control: two appends at the tail, which is what the recovery used to do.
  const recoveredAtTail = appendSeoEntrySource(SEO_BASE, builtEntry('recovered-one'), { seoConstName: 'BLOG_SEO_METADATA', updateRouterUnion: true });
  assert.ok(threeWayMerge(SEO_BASE, recoveredAtTail, generated).conflicts > 0);
});

const queueItem = (articleId, extra = {}) => ({
  articleId, title: `Title of ${articleId}`, fallbackImage: '/images/places/lugano-view.webp', reason: 'fixture', status: 'queued', failureCount: 0, ...extra,
});
const queueText = (items) => `${JSON.stringify({ schema: 1, items }, null, 2)}\n`;

test('mergeQueueWithSnapshot mette le voci nuove prima dell\'ultima che c\'era', () => {
  const snapshot = { schema: 1, items: [queueItem('a'), queueItem('b'), queueItem('c')] };
  // What the queue looks like after the recovery queued two covers: appended, and `b` updated meanwhile.
  const current = { schema: 1, items: [queueItem('a'), queueItem('b', { failureCount: 2 }), queueItem('c'), queueItem('new-1'), queueItem('new-2')] };
  const merged = mergeQueueWithSnapshot(snapshot, current);
  assert.deepEqual(merged.items.map((item) => item.articleId), ['a', 'b', 'new-1', 'new-2', 'c']);
  assert.equal(merged.items[1].failureCount, 2);
  assert.equal(merged.schema, 1);
  assert.deepEqual(mergeQueueWithSnapshot({ schema: 1, items: [] }, { schema: 1, items: [queueItem('only')] }).items.map((item) => item.articleId), ['only']);
  assert.deepEqual(mergeQueueWithSnapshot({ schema: 1, items: [queueItem('a')] }, { schema: 1, items: [queueItem('a'), queueItem('new-1')] }).items.map((item) => item.articleId), ['new-1', 'a']);
});

test('la coda del recupero si fonde senza conflitto con un fallimento accodato nel frattempo', () => {
  const baseItems = [queueItem('a'), queueItem('b'), queueItem('c')];
  const base = queueText(baseItems);
  const pipelineAppend = queueText([...baseItems, queueItem('failed-meanwhile')]);
  const recovered = mergeQueueWithSnapshot({ schema: 1, items: baseItems }, { schema: 1, items: [...baseItems, queueItem('new-1'), queueItem('new-2')] });
  const merge = threeWayMerge(base, queueText(recovered.items), pipelineAppend);
  assert.equal(merge.conflicts, 0);
  assert.deepEqual(JSON.parse(merge.merged).items.map((item) => item.articleId), ['a', 'b', 'new-1', 'new-2', 'c', 'failed-meanwhile']);

  // The control: both sides append after the last item.
  const appended = queueText([...baseItems, queueItem('new-1'), queueItem('new-2')]);
  assert.ok(threeWayMerge(base, appended, pipelineAppend).conflicts > 0);
});
