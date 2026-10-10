import '../../host/cantonSectionsBootstrap.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveSeoMetadata } from '../scripts/lib/seo-metadata-derivation.mjs';
import { findSeoEntryMatches, removeSeoEntriesFromSource } from '../../engine/shared/seo-entry.mjs';
import {
  appendSeoEntrySource,
  buildSeoEntry,
  insertSeoEntriesAtHead,
  removeSeoEntriesWithSeparator,
  toIsoWithTz,
} from '../scripts/lib/seo-entry-builder.mjs';
import { mergeQueueWithSnapshot } from '../scripts/lib/seo-recovery-queue.mjs';
import { createWriteLedger, restoreWrittenFiles } from '../scripts/lib/seo-recovery-rollback.mjs';
import { seoEntryCountAcrossChunks } from '../scripts/recover-seo-orphans.mjs';
import { queueArticleCoverRegeneration } from '../scripts/lib/article-cover-fallback.mjs';
import { SEO_BACKFILL_LOCK_REL, beginSeoBackfillLock, endSeoBackfillLock } from '../scripts/lib/seo-backfill-lock.mjs';
import {
  IMAGE_REGENERATION_QUEUE_LOCK_REL,
  IMAGE_REGENERATION_QUEUE_PENDING_REL,
  appendImageRegenerationQueue,
  readImageRegenerationQueue,
  withImageRegenerationQueueLock,
} from '../scripts/lib/image-regeneration-queue.mjs';

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

test('la derivazione mantiene il titolo dei meta e usa la regola di troncamento solo per le descrizioni', () => {
  const data = article();
  deriveSeoMetadata(data);
  assert.equal(data.seo.headline, data.content.it.title);
  assert.equal(data.seo.ogTitle, data.content.it.title);
  assert.match(data.seo.title, /^Titolo deterministico per \| Frontaliere Ticino$/);
  const entry = buildSeoEntry(data, {
    provenance: { kind: 'wikimedia-commons', record: { width: 1200, height: 675 } },
    publishedAt: data.date,
    modifiedAt: data.date,
  });
  assert.match(entry, /"headline": "Titolo deterministico per"/);
  assert.ok(data.seo.description.length <= 160);
  assert.match(data.seo.keywords, /^frontalieri, ticino, svizzera, italia,/);
});

test('la recovery usa il fallback italiano quando una description persistita inizia con un token oltre il cap', () => {
  const data = article();
  data.seo = { description: 'X'.repeat(220) };

  deriveSeoMetadata(data);

  assert.equal(
    data.seo.description,
    'Una descrizione abbastanza lunga da verificare il percorso SEO senza generazione automatica e con una fine di frase completa per il limite. Dati locali',
  );
  assert.ok(data.seo.description.length >= 80);
  assert.ok(data.seo.description.length <= 160);
  assert.ok(!data.seo.description.includes('X'));
});

test('la recovery rifiuta un excerpt che non può essere troncato senza tagliare il primo token', () => {
  const data = article();
  data.content.it.excerpt = 'X'.repeat(220);
  assert.throws(() => deriveSeoMetadata(data), /must contain at least 80 characters/);
});

test('la recovery conserva seoDescription e ogDescription persistiti invece di derivarli dall excerpt', () => {
  const data = article();
  data.content.it.seoDescription = 'Descrizione SERP già pubblicata, distinta dall’estratto editoriale e sufficientemente lunga per il contratto pubblico.';
  data.content.it.ogDescription = 'Descrizione social già pubblicata, più estesa e mantenuta per RSS e card.';
  data.seo = {
    description: data.content.it.seoDescription,
    ogDescription: data.content.it.ogDescription,
  };

  deriveSeoMetadata(data);

  assert.equal(data.seo.description, data.content.it.seoDescription);
  assert.equal(data.seo.ogDescription, data.content.it.ogDescription);
});

test('la recovery riapre il fallback italiano se il cap porta la descrizione persistita sotto il floor', () => {
  const data = article();
  const fallbackExcerpt = 'Il corpo italiano riporta i valichi aperti, i prezzi dei carburanti e i nuovi annunci di lavoro in Svizzera per l’aggiornamento quotidiano del 2026.';
  data.content.it.excerpt = fallbackExcerpt;
  data.seo = { description: `${'A'.repeat(70)}. ${'B'.repeat(100)}` };

  deriveSeoMetadata(data);

  assert.equal(data.seo.description, fallbackExcerpt);
  assert.ok(data.seo.description.length >= 80);
});

test('la recovery sostituisce una seoDescription persistita sotto il minimo con il fallback italiano', () => {
  const data = article();
  data.content.it.seoDescription = 'Troppo breve.';
  data.seo = { description: data.content.it.seoDescription };

  deriveSeoMetadata(data);

  assert.notEqual(data.seo.description, data.content.it.seoDescription);
  assert.ok(data.seo.description.length >= 80);
  assert.ok(data.seo.description.startsWith('Una descrizione abbastanza lunga'));
});

test('la recovery usa il fallback italiano se il cap accorcia una descrizione persistita sotto il minimo', () => {
  const data = article();
  const firstClause = 'Descrizione persistita valida per il tema dei frontalieri nel Ticino.';
  assert.ok(firstClause.length < 80);
  data.seo = { description: `${firstClause} ${'X'.repeat(100)}` };

  deriveSeoMetadata(data);

  assert.ok(data.seo.description.length >= 80);
  assert.ok(data.seo.description.length <= 160);
  assert.ok(data.seo.description.startsWith('Una descrizione abbastanza lunga'));
});

test('il builder SEO rifiuta Markdown anche nel percorso di recovery diretto', () => {
  const data = article();
  data.seo = {
    title: 'Titolo',
    description: '[testo][ref]',
    keywords: 'frontalieri, ticino',
    ogTitle: 'Titolo',
    ogDescription: 'Descrizione social semplice.',
    headline: 'Titolo',
    breadcrumbName: 'Titolo',
  };
  assert.throws(
    () => buildSeoEntry(data, {
      provenance: { kind: 'wikimedia-commons', record: { width: 1200, height: 675 } },
      publishedAt: data.date,
      modifiedAt: data.date,
    }),
    /excerpt-plain.*seo\.description.*reference-link/,
  );
});

test('il builder SEO rifiuta una description breve prima che la recovery possa scriverla', () => {
  const data = article();
  data.seo = {
    title: 'Titolo',
    description: 'Descrizione troppo breve.',
    keywords: 'frontalieri, ticino',
    ogTitle: 'Titolo',
    ogDescription: 'Descrizione social semplice.',
    headline: 'Titolo',
    breadcrumbName: 'Titolo',
  };

  assert.throws(
    () => buildSeoEntry(data, {
      provenance: { kind: 'wikimedia-commons', record: { width: 1200, height: 675 } },
      publishedAt: data.date,
      modifiedAt: data.date,
    }),
    /must contain at least 80 characters/,
  );
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

  const deterministic = article();
  deriveSeoMetadata(deterministic);
  const deterministicEntry = buildSeoEntry(deterministic, {
    provenance: {
      kind: 'deterministic-card',
      record: { credit: 'frontaliereticino.ch', width: 1200, height: 675 },
    },
    publishedAt: toIsoWithTz(deterministic.date, { preserveExplicitOffset: false }),
    modifiedAt: toIsoWithTz(deterministic.date, { preserveExplicitOffset: false }),
  });
  assert.match(
    deterministicEntry,
    /"license": "https:\/\/frontaliereticino\.ch\/termini-di-servizio\/#licenza-immagini"/,
  );
  assert.match(deterministicEntry, /Deterministic media produced by frontaliereticino\.ch\./);
  assert.match(deterministicEntry, /"creditText": "frontaliereticino\.ch"/);

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

test('queueArticleCoverRegeneration può usare l append già protetto dal lock esterno', () => {
  const request = queueItem('held-queue-item');
  const data = { _imageRegenerationRequest: request };
  const calls = [];
  const queued = queueArticleCoverRegeneration('/unused', data, {
    append(item) {
      calls.push(item);
      return true;
    },
  });

  assert.equal(queued, true);
  assert.deepEqual(calls, [request]);
  assert.equal(data._imageRegenerationRequest, undefined, 'la richiesta deve essere consumata anche nel percorso sotto lock');
});

test('la recovery detiene il lock coda mentre registra le mutazioni della transazione', () => {
  const source = fs.readFileSync(
    new URL('../scripts/recover-seo-orphans.mjs', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /const queue = withImageRegenerationQueueLock\(ROOT, \(\{ read, write, append \}\) => \{/,
  );
  assert.match(source, /queueArticleCoverRegeneration\(ROOT, data, \{ append \}\)/);
  const successPath = source.slice(
    source.indexOf('const missingQueueItems'),
    source.indexOf('    } catch (error)', source.indexOf('const missingQueueItems')),
  );
  const seoReleaseAt = successPath.indexOf('endSeoBackfillLock(ROOT);');
  const registrationReleaseAt = successPath.indexOf("endRegisterLock(ROOT, 'frontaliere');");
  assert.ok(
    seoReleaseAt > -1 && seoReleaseAt < registrationReleaseAt,
    'il marker SEO deve essere rimosso prima del lock di sezione condiviso',
  );

  const catchPath = source.slice(source.indexOf('    } catch (error)'), source.indexOf('\n  });\n\n  console.log'));
  const catchSeoReleaseAt = catchPath.indexOf('endSeoBackfillLock(ROOT);');
  const catchRegistrationReleaseAt = catchPath.indexOf("endRegisterLock(ROOT, 'frontaliere');");
  assert.ok(
    catchSeoReleaseAt > -1 && catchSeoReleaseAt < catchRegistrationReleaseAt,
    'anche il rollback deve conservare il lock di sezione fino alla rimozione del marker SEO',
  );
});

test('la recovery legge e valida la provenienza solo dopo i lock condivisi', () => {
  const source = fs.readFileSync(
    new URL('../scripts/recover-seo-orphans.mjs', import.meta.url),
    'utf8',
  );
  const queueStart = source.indexOf('const queue = withImageRegenerationQueueLock');
  const registrationLock = source.indexOf('beginRegisterLock(ROOT, `seo-orphan-recovery:${ids[0]}`', queueStart);
  const entriesBuild = source.indexOf('const entries = buildEntries(ids);', registrationLock);
  assert.ok(queueStart > -1 && registrationLock > queueStart && entriesBuild > registrationLock);
  assert.doesNotMatch(source, /credits\.get\(registryEntry\.image\)/);
  assert.match(source, /imageRecordForPath\(ROOT, registryEntry\.image, \{ strict: true \}\)/);
});

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

test('la recovery conta l ID SEO su tutti i chunk prima di pubblicare', () => {
  const root = tempDir('seo-chunk-census-');
  try {
    const seoDir = path.join(root, 'content/seo');
    fs.mkdirSync(seoDir, { recursive: true });
    const id = 'historical-duplicate';
    const source = `const BLOG_SEO_METADATA = {\n  'blog-${id}': {},\n};\n`;
    fs.writeFileSync(path.join(seoDir, 'seo-blog.ts'), source);
    fs.writeFileSync(path.join(seoDir, 'seo-blog-2.ts'), 'const BLOG_SEO_METADATA = {};\n');
    const target = path.join(seoDir, 'seo-blog-5.ts');
    fs.writeFileSync(target, 'const BLOG_SEO_METADATA = {};\n');

    assert.equal(seoEntryCountAcrossChunks(root, id, {
      replacementPath: target,
      replacementSource: source,
    }), 2, 'un ID già storico non può essere ripubblicato nel chunk corrente');
    assert.equal(seoEntryCountAcrossChunks(root, id, {
      replacementPath: target,
      replacementSource: 'const BLOG_SEO_METADATA = {};\n',
    }), 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rieseguire il recupero su voci già presenti lascia il chunk identico', () => {
  const ids = ['recovered-one', 'recovered-two'];
  const recover = (source, remove) => {
    let next = source;
    for (const id of ids) next = remove(next, id).src;
    return insertSeoEntriesAtHead(next, ids.map(builtEntry), { seoConstName: 'BLOG_SEO_METADATA' });
  };
  const withSeparator = (source, id) => removeSeoEntriesWithSeparator(source, id, {
    findSeoEntryMatches,
    removeSeoEntriesFromSource,
    fileLabel: 'fixture',
  });
  const once = recover(SEO_BASE, withSeparator);
  assert.equal(recover(once, withSeparator), once);
  assert.equal(recover(recover(once, withSeparator), withSeparator), once);

  // The control: the engine's remover leaves the separator line of each entry.
  const engineOnly = (source, id) => removeSeoEntriesFromSource(source, id, 'fixture');
  const again = recover(once, engineOnly);
  assert.equal(again.split('\n').length - once.split('\n').length, ids.length);
});

// ── Concurrent producers (review of PR 2458) ─────────────────────────────────

test('mergeQueueWithSnapshot non riporta in coda una voce che il drenaggio ha tolto', () => {
  const snapshot = { schema: 1, items: [queueItem('a'), queueItem('b'), queueItem('c')] };
  // `b` was drained after the snapshot; the recovery queued `new-1`.
  const current = { schema: 1, items: [queueItem('a'), queueItem('c'), queueItem('new-1')] };
  assert.deepEqual(mergeQueueWithSnapshot(snapshot, current).items.map((item) => item.articleId), ['a', 'new-1', 'c']);

  // Whatever the input, the result holds the items of the current queue and no other.
  const byJson = (left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right));
  const duplicated = { schema: 1, items: [queueItem('a'), queueItem('a', { failureCount: 3 }), queueItem('new-1')] };
  const merged = mergeQueueWithSnapshot({ schema: 1, items: [queueItem('a'), queueItem('gone')] }, duplicated);
  assert.deepEqual([...merged.items].sort(byJson), [...duplicated.items].sort(byJson));
});

test('i writer della coda condividono un lock e non scrivono durante il drenaggio', () => {
  const root = tempDir('image-regeneration-queue-lock-');
  const request = {
    articleId: 'busy-queue-item',
    title: 'Busy queue item',
    fallbackImage: '/images/places/lugano-view.webp',
    reason: 'fixture',
    requestedAt: '2026-03-03T14:39:51.004Z',
  };
  try {
    const nestedAppend = withImageRegenerationQueueLock(root, () => appendImageRegenerationQueue(root, request));
    assert.equal(nestedAppend, true, 'un append concorrente deve finire nel pending log');
    const pendingDir = path.dirname(path.join(root, IMAGE_REGENERATION_QUEUE_PENDING_REL));
    const pendingBase = path.basename(IMAGE_REGENERATION_QUEUE_PENDING_REL);
    assert.equal(
      fs.readdirSync(pendingDir).filter((name) => name.startsWith(`${pendingBase}.`) && name.endsWith('.pending')).length,
      1,
      'il pending deve essere pubblicato come record completo per-request',
    );
    assert.equal(fs.existsSync(path.join(root, IMAGE_REGENERATION_QUEUE_PENDING_REL)), false);
    assert.equal(fs.existsSync(path.join(root, IMAGE_REGENERATION_QUEUE_LOCK_REL)), false, 'il lock non resta orfano');
    assert.equal(appendImageRegenerationQueue(root, request), true);
    assert.equal(fs.existsSync(path.join(root, IMAGE_REGENERATION_QUEUE_PENDING_REL)), false);
    assert.deepEqual(readImageRegenerationQueue(root).items.map((item) => item.articleId), ['busy-queue-item']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('il lock del recupero non sovrascrive un marker che trova', () => {
  const root = tempDir('seo-backfill-lock-');
  try {
    const marker = path.join(root, SEO_BACKFILL_LOCK_REL);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, 'left by a previous run\n');
    assert.throws(() => beginSeoBackfillLock(root, ['article-a']), /already exists/);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'left by a previous run\n');

    fs.rmSync(marker);
    beginSeoBackfillLock(root, ['article-a']);
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).ids, ['article-a']);
    assert.throws(() => beginSeoBackfillLock(root, ['article-b']), /already exists/);
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).ids, ['article-a']);
    endSeoBackfillLock(root);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fra più recuperi avviati insieme uno solo ottiene il lock', async () => {
  const root = tempDir('seo-backfill-race-');
  try {
    const go = path.join(root, 'go');
    const lockModule = new URL('../scripts/lib/seo-backfill-lock.mjs', import.meta.url).href;
    // Each process waits for the same signal, then tries once.
    const contender = `
      import fs from 'node:fs';
      // An inline script has no script path: the arguments start at index 1.
      const [lockModule, root, go, name] = process.argv.slice(1);
      const { beginSeoBackfillLock } = await import(lockModule);
      const until = Date.now() + 20000;
      while (!fs.existsSync(go)) {
        if (Date.now() > until) process.exit(2);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
      try { beginSeoBackfillLock(root, [name]); process.exit(0); }
      catch (error) { process.exit(/already exists/.test(error.message) ? 3 : 1); }
    `;
    const names = Array.from({ length: 8 }, (_, index) => `contender-${index}`);
    const exits = names.map((name) => new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', contender, lockModule, root, go, name], { stdio: 'ignore' });
      child.on('close', (code) => resolve(code));
    }));
    await new Promise((resolve) => { setTimeout(resolve, 400); });
    fs.writeFileSync(go, '');
    const codes = await Promise.all(exits);
    assert.equal(codes.filter((code) => code === 0).length, 1, `exit codes: ${codes.join(',')}`);
    assert.equal(codes.filter((code) => code === 3).length, names.length - 1, `exit codes: ${codes.join(',')}`);
    const marker = JSON.parse(fs.readFileSync(path.join(root, SEO_BACKFILL_LOCK_REL), 'utf8'));
    assert.equal(marker.ids.length, 1);
    assert.ok(names.includes(marker.ids[0]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('il rollback ripristina solo i file che contengono ancora ciò che la run ha scritto', () => {
  const dir = tempDir('seo-recovery-rollback-');
  try {
    const file = (name) => path.join(dir, name);
    const ledger = createWriteLedger();

    // Written by the run and untouched since: goes back to its snapshot.
    fs.writeFileSync(file('seo.ts'), 'run seo');
    ledger.record(file('seo.ts'), 'before seo', 'run seo');
    // Written twice by the run: the snapshot is the one before the first write.
    ledger.record(file('registry.ts'), 'before registry', 'run registry 1');
    fs.writeFileSync(file('registry.ts'), 'run registry 2');
    ledger.record(file('registry.ts'), 'run registry 1', 'run registry 2');
    // Written by the run, then by another producer: left alone.
    fs.writeFileSync(file('queue.json'), 'run queue + a request queued by the cover pipeline');
    ledger.record(file('queue.json'), 'before queue', 'run queue');
    // Created by the run and untouched since: removed.
    fs.writeFileSync(file('created.json'), 'run created');
    ledger.record(file('created.json'), null, 'run created');
    // Created by the run, then extended by another producer: left alone.
    fs.writeFileSync(file('created-then-used.json'), 'run created + another request');
    ledger.record(file('created-then-used.json'), null, 'run created');

    const { restored, diverged } = restoreWrittenFiles(ledger.entries());
    assert.deepEqual(restored.map((item) => path.basename(item)), ['seo.ts', 'registry.ts', 'created.json']);
    assert.deepEqual(diverged.map((item) => path.basename(item)), ['queue.json', 'created-then-used.json']);
    assert.equal(fs.readFileSync(file('seo.ts'), 'utf8'), 'before seo');
    assert.equal(fs.readFileSync(file('registry.ts'), 'utf8'), 'before registry');
    assert.equal(fs.readFileSync(file('queue.json'), 'utf8'), 'run queue + a request queued by the cover pipeline');
    assert.equal(fs.existsSync(file('created.json')), false);
    assert.equal(fs.readFileSync(file('created-then-used.json'), 'utf8'), 'run created + another request');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
