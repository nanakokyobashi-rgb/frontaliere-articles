import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COVER = '/images/blog/article-cantello-teatro-dialettale-ottobre-2026.webp';

function filesBelow(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(target) : [target];
  });
}

test('article body fields never embed a following body payload', () => {
  const offenders = filesBelow(path.join(ROOT, 'content'))
    .filter((file) => /blog-body/.test(file) && file.endsWith('.ts'))
    .flatMap((file) => fs.readFileSync(file, 'utf8').split('\n').flatMap((line, index) => (
      /\.body1'/.test(line) && /\\n\\nbody2:/.test(line)
        ? [`${path.relative(ROOT, file)}:${index + 1}`]
        : []
    )));

  assert.deepEqual(offenders, []);
});

test('Cantello registry, SEO metadata and public asset use the dedicated cover', () => {
  const registry = fs.readFileSync(path.join(ROOT, 'content/blog-articles-data.ts'), 'utf8');
  const seo = fs.readFileSync(path.join(ROOT, 'content/seo/seo-blog-5.ts'), 'utf8');
  const article = registry.match(/id: 'cantello-teatro-dialettale-ottobre-2026',[\s\S]*?\n\s*\},?/)?.[0];
  const metadata = seo.match(/'blog-cantello-teatro-dialettale-ottobre-2026': \{[\s\S]*?\n\s*\},\n\n/)?.[0];

  assert.ok(article, 'Cantello article record is missing');
  assert.match(article, new RegExp(`image: '${COVER.replaceAll('/', '\\/')}'`));
  assert.ok(metadata, 'Cantello SEO metadata is missing');
  assert.ok(metadata.includes('${BASE_URL}' + COVER));
  assert.ok(fs.existsSync(path.join(ROOT, `public${COVER}`)), 'Cantello cover blob is missing');
});
