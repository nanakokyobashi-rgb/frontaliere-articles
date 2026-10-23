import test from 'node:test';
import assert from 'node:assert/strict';

import { readTsStringLiteral } from '../scripts/lib/ts-string-map.mjs';
import { readStaticStringLiteral } from '../../scripts/lib/ts-literals.mjs';
import { readArticleRegistry } from '../../scripts/lib/registry-image-reader.mjs';
import { readCanonicalPath } from '../../scripts/lib/seo-canonical-path.mjs';

const octalLookingValue = String.raw`bad\01`;

test('all corpus readers share the octal-looking escape contract', () => {
  const source = String.raw`const value = 'bad\01';`;
  const literalStart = source.indexOf("'");

  assert.equal(readTsStringLiteral(source, literalStart).value, octalLookingValue);
  assert.equal(
    readStaticStringLiteral(source, literalStart, 'fixture.ts').value,
    octalLookingValue,
  );

  const [registryEntry] = readArticleRegistry(
    String.raw`[{ id: 'octal', image: '/cover.webp', note: 'bad\01' }]`,
    'fixture.ts',
  );
  assert.equal(registryEntry.fields.note, octalLookingValue);

  const expression = "'" + String.raw`/articoli-frontaliere/\01/` + "'";
  assert.deepEqual(
    readCanonicalPath(`{\n    canonicalPath: ${expression},\n}`),
    { kind: 'unresolved', expression },
  );
});
