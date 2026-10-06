import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const bodySource = readFileSync(
  new URL('../../content/blog-body/it/nidi-extrascolastico-ticino-un-servizio.ts', import.meta.url),
  'utf8',
);

test('nidi article quote has no visible Markdown emphasis markers', () => {
  assert.match(
    bodySource,
    /La nuova lista d’attesa unica rappresenta un importante passo avanti nella gestione dei servizi per l’infanzia nel nostro cantone\./,
  );
  assert.doesNotMatch(
    bodySource,
    /_La nuova lista d’attesa unica rappresenta un importante passo avanti nella gestione dei servizi per l’infanzia nel nostro cantone_/,
  );
});
