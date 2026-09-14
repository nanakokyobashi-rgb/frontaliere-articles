import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  bumpDateModified,
  bumpUpdatedAt,
} from '../scripts/lib/evergreen-article-refresh.mjs';

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evergreen-article-refresh-'));
  fs.mkdirSync(path.join(root, 'content', 'seo'), { recursive: true });
  return root;
}

test('evergreen refresh: updatedAt non arretra davanti a uno snapshot vecchio', () => {
  const root = tempRepo();
  try {
    const registry = path.join(root, 'content', 'blog-articles-data.ts');
    const source =
      "const articles = [\n" +
      "  {\n" +
      "    id: 'demo-id',\n" +
      "    date: '2026-09-01T12:00:00Z',\n" +
      "    updatedAt: '2026-09-15',\n" +
      "  },\n" +
      "];\n";
    fs.writeFileSync(registry, source);
    let writes = 0;

    assert.equal(
      bumpUpdatedAt(
        'demo-id',
        '2026-09-14',
        root,
        'data/blog-articles-data.ts',
        () => { writes += 1; },
      ),
      true,
    );
    assert.equal(writes, 0, 'uno snapshot vecchio non deve riscrivere il marker');
    assert.equal(fs.readFileSync(registry, 'utf8'), source);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('evergreen refresh: dateModified non arretra davanti a uno snapshot vecchio', () => {
  const root = tempRepo();
  try {
    const seo = path.join(root, 'content', 'seo', 'seo-blog-5.ts');
    const source =
      "const seo = {\n" +
      "  'blog-demo-id': {\n" +
      '    "datePublished": "2026-09-01T12:00:00+00:00",\n' +
      '    "dateModified": "2026-09-15T12:00:00+00:00"\n' +
      '  },\n' +
      '};\n';
    fs.writeFileSync(seo, source);
    let writes = 0;

    assert.equal(
      bumpDateModified(
        'demo-id',
        '2026-09-14T12:00:00+00:00',
        root,
        'services/seo/seo-blog-5.ts',
        () => { writes += 1; },
      ),
      true,
    );
    assert.equal(writes, 0, 'uno snapshot vecchio non deve riscrivere il marker');
    assert.equal(fs.readFileSync(seo, 'utf8'), source);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
