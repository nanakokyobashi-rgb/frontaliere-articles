import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyRegistryUpdatedAt,
  enrichRegistriesFromHistory,
  parseChangedBodyPaths,
  parseContentHistory,
  stampChangedBodyFiles,
} from '../../scripts/lib/content-updated-at.mjs';
import { readTopLevelString, scanTopLevelArticleRecords } from '../../scripts/lib/article-registry-reader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXTRACTION = '046d940280245c0c587acb4872a74a6838c1b307c';

test('la storia body ignora l’estrazione e sceglie il commit più recente tra le locali', () => {
  const history = parseContentHistory([
    `${EXTRACTION}\t2026-07-30T12:27:48Z`,
    '',
    'content/blog-body/it/article.ts',
    'def4567\t2026-07-31T12:00:00Z',
    '',
    'content/blog-body/it/article.ts',
    'abc1234\t2026-10-20T10:00:00Z',
    '',
    'content/blog-body/en/article.ts',
  ].join('\n'));

  assert.deepEqual(history.get('content/blog-body/it/article.ts'), {
    commit: 'def4567',
    committedAt: '2026-07-31T12:00:00Z',
  });
  assert.deepEqual(history.get('content/blog-body/en/article.ts'), {
    commit: 'abc1234',
    committedAt: '2026-10-20T10:00:00Z',
  });
});

test('il backfill non scambia il commit di pubblicazione per una modifica successiva', () => {
  const sections = [{ section: 'frontaliere', bodyDir: 'content/blog-body' }];
  const history = new Map([
    ['content/blog-body/it/new.ts', { commit: 'new', committedAt: '2026-10-20T11:00:00Z' }],
    ['content/blog-body/en/new.ts', { commit: 'new', committedAt: '2026-10-20T11:00:00Z' }],
    ['content/blog-body/it/old.ts', { commit: 'old', committedAt: '2026-10-21T11:00:00Z' }],
  ]);
  const result = enrichRegistriesFromHistory({ frontaliere: [
    { id: 'new', date: '2026-10-20T10:00:00Z' },
    { id: 'old', date: '2026-10-01T10:00:00Z' },
  ] }, sections, history);

  assert.equal(result.registries.frontaliere[0].updatedAt, undefined);
  assert.equal(result.registries.frontaliere[1].updatedAt, '2026-10-21');
  assert.deepEqual(result.changed.map(({ id }) => id), ['old']);
});

test('lo stamp workflow aggiorna solo body esistenti e inserisce il campo nel registry', () => {
  const source = `const ARTICLES = [
  {
    id: 'changed',
    date: '2026-10-31T10:00:00Z',
    image: '/changed.webp',
  },
  {
    id: 'new',
    date: '2026-10-31T10:00:00Z',
    image: '/new.webp',
  },
];
`;
  const result = stampChangedBodyFiles({
    sections: [{ section: 'frontaliere', bodyDir: 'content/blog-body' }],
    statusText: [
      ' M content/blog-body/it/changed.ts',
      '?? content/blog-body/it/new.ts',
    ].join('\n'),
    registrySources: { frontaliere: source },
    stamp: '2026-10-31T12:00:00Z',
  });

  assert.equal(result.changed.length, 1);
  assert.match(result.sources.frontaliere, /id: 'changed',[\s\S]*updatedAt: '2026-10-31'/u);
  assert.doesNotMatch(result.sources.frontaliere, /id: 'new',[\s\S]*updatedAt:/u);
});

test('i parser di status riconoscono modifiche staged e unstaged senza contare un body nuovo', () => {
  assert.deepEqual(parseChangedBodyPaths(' M content/blog-body/it/a.ts\nA  content/blog-body/en/b.ts\n?? content/blog-body/fr/c.ts\n'), [
    { code: ' M', path: 'content/blog-body/it/a.ts' },
    { code: 'A ', path: 'content/blog-body/en/b.ts' },
    { code: '??', path: 'content/blog-body/fr/c.ts' },
  ]);
});

test('il backfill storico e i writer sono cablati a tutte le pipeline che modificano body', () => {
  const build = readFileSync(path.join(ROOT, 'scripts/build-api.mjs'), 'utf8');
  assert.match(build, /readContentHistory\(/u);
  assert.match(build, /enrichRegistriesFromHistory\(/u);

  const publish = readFileSync(path.join(ROOT, '.github/workflows/publish-api.yml'), 'utf8');
  assert.match(publish, /fetch-depth:\s*0/u);
  assert.match(publish, /scripts\/lib\/content-updated-at\.mjs/u);

  for (const file of [
    '.github/workflows/batch-faq-articles.yml',
    '.github/workflows/bonifica-blocking-bodies.yml',
    '.github/workflows/generate-article.yml',
    '.github/workflows/generate-article-core.yml',
    '.github/workflows/generate-border-wait-ranking-weekly.yml',
    '.github/workflows/generate-daily-brief.yml',
    '.github/workflows/publish-journalist-articles.yml',
    '.github/workflows/refresh-events-digest.yml',
  ]) {
    const workflow = readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(workflow, /node scripts\/ci\/stamp-content-updated-at\.mjs/u, `${file}: stamp mancante`);
  }
  const bonifica = readFileSync(path.join(ROOT, '.github/workflows/bonifica-blocking-bodies.yml'), 'utf8');
  assert.match(bonifica, /STAGED_BODY=/u);
  assert.match(bonifica, /content\/blog-body\/\*\*/u);
  assert.match(bonifica, /updatedAt sono addizionali/u);
});

test('gli esempi della issue hanno il giorno dell’ultima modifica nel registry', () => {
  const files = [
    path.join(ROOT, 'content/blog-articles-data.ts'),
    path.join(ROOT, 'content/swiss-articles-data.ts'),
  ];
  const rows = new Map();
  for (const file of files) {
    for (const record of scanTopLevelArticleRecords(readFileSync(file, 'utf8'))) rows.set(record.id, record);
  }
  for (const [id, day] of [
    ['vivere-svizzera-vs-italia-frontaliere', '2026-10-29'],
    ['eventi-weekend-ticino', '2026-10-31'],
  ]) {
    assert.match(readTopLevelString(rows.get(id), 'updatedAt') ?? '', new RegExp(`^${day}`, 'u'), id);
  }
});
