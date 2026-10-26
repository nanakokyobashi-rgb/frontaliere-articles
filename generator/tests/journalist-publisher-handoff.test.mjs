import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const SOURCE = readFileSync(
  new URL('../scripts/publish-journalist-article.mjs', import.meta.url),
  'utf8',
);

test('journalist publisher exposes every successful id to the workflow guard', () => {
  assert.match(SOURCE, /const publishedIds = \[\];/u);
  assert.match(SOURCE, /if \(result\.ok\)[\s\S]*?publishedIds\.push\(id\);/u);
  assert.match(
    SOURCE,
    /fs\.appendFileSync\(githubOutput, `published_ids=\$\{JSON\.stringify\(publishedIds\)\}\\n`\);/u,
  );
});

test('journalist publisher drains queued documents sequentially', () => {
  const loopStart = SOURCE.indexOf('for (const docSnap of snap.docs)');
  assert.ok(loopStart >= 0, 'queued-document loop missing');
  const loopEnd = SOURCE.indexOf(
    'console.log(`[publish-journalist-article] done',
    loopStart,
  );
  assert.ok(loopEnd > loopStart, 'publisher completion marker missing');
  const loop = SOURCE.slice(loopStart, loopEnd);
  assert.match(loop, /await processDoc\(db, FieldValue, docSnap\)/u);
  assert.doesNotMatch(loop, /Promise\.all/u);
});

test('journalist publisher legge il body dell’immagine dal fetch con timeout condiviso', () => {
  const downloadStart = SOURCE.indexOf('const response = await fetchWithRefTimeout(rawImage');
  const sharpStart = SOURCE.indexOf("const sharpModule = await import('sharp')", downloadStart);
  assert.ok(downloadStart >= 0 && sharpStart > downloadStart, 'percorso download immagine mancante');
  const download = SOURCE.slice(downloadStart, sharpStart);
  assert.match(download, /Buffer\.from\(await response\.arrayBuffer\(\)\)/u);
  assert.doesNotMatch(download, /await fetch\(/u);
});
