/**
 * La pubblicazione deve arrivare al BROWSER, non solo a curl. Run with `node --test`.
 *
 * IL DIFETTO. Il 2026-08-08 la run 31241440018 ha pubblicato
 * `salario-medio-professioni-svizzera-2026-basilea` e ha chiuso verde: Pages
 * deployato, `blog-index-*.json` caricati su R2, purge riuscito, dispatch 204.
 * L'articolo era live al suo URL, nelle sitemap, nell'RSS e nell'indice appena
 * caricato — e invisibile in ogni lista del sito. Misurato sulla stessa URL
 * nello stesso secondo:
 *
 *   /data/blog-index-svizzera-it.json
 *     senza Origin (curl, i controlli di questo workflow) → 05:20:40Z, 647 articoli
 *     con Origin   (un browser dentro la pagina)         → 2026-08-07 16:04:02Z, 637 articoli
 *
 * Sei degli otto `blog-index-<sezione>-<locale>.json` erano divisi cosi', di 12-16 ore.
 *
 * DUE CAUSE, ENTRAMBE IN QUESTO REPO.
 *
 * 1. `cdn.frontaliereticino.ch` risponde con `Vary: Origin`, quindi l'edge tiene DUE
 *    voci per URL. Il purge `files: ['<url>']` ne pulisce una sola: quella senza
 *    `Origin`, cioe' quella che nessun visitatore legge mai. Il repo del sito aveva
 *    gia' corretto la stessa cosa da se' (valerielinc-ops#5273), ma una fix nel
 *    consumatore non copre i file che carica il PUBLISHER.
 *
 * 2. `upload-cdn-file.sh` ha come default `public, max-age=86400`. E' la classe
 *    images/: giusta per un hero scritto una volta, sbagliata per un file che questo
 *    job RISCRIVE a ogni pubblicazione. Lo stesso prefisso R2 `data/` e' gia' sincato
 *    dal deploy del sito con `public,max-age=600`, quindi il default scriveva un
 *    secondo contratto di freschezza, 144 volte piu' lasco, sullo stesso prefisso.
 *
 * PERCHE' UN TEST. Nessuna delle due si vede da una run: entrambe producono passi
 * verdi. La prima e' invisibile a qualunque sonda che non mandi `Origin` — cioe' a
 * tutte quelle che questo repo ha. La seconda e' un argomento OMESSO, e un argomento
 * omesso non si nota rileggendo il diff. Questo test costa due `readFileSync`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { purgeBodiesForUrls, VARY_ORIGINS } from '../../scripts/lib/cf-purge-variants.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, '../..', p), 'utf8');

const PURGE = read('scripts/cf-purge-cache.mjs');
const WF = read('.github/workflows/publish-api.yml');

test('purgeBodiesForUrls emette un body per variante di cache, non una lista raddoppiata', () => {
  const urls = ['https://cdn.frontaliereticino.ch/data/blog-index-svizzera-it.json'];
  const bodies = purgeBodiesForUrls(urls);

  assert.equal(bodies.length, 1 + VARY_ORIGINS.length, 'una variante senza Origin + una per origin');

  // La variante che curl e la CI creano.
  assert.deepEqual(bodies[0].files, urls);

  // La variante che il browser crea — l'unica che un visitatore legge davvero.
  const browser = bodies[1];
  assert.deepEqual(browser.files, [
    { url: urls[0], headers: { Origin: 'https://frontaliereticino.ch' } },
  ]);

  // Il cap free-plan conta le VOCI della lista: raddoppiarla dimezzerebbe in
  // silenzio quante URL un chiamante puo' passare. Ogni body resta lungo quanto
  // l'input.
  for (const b of bodies) assert.equal(b.files.length, urls.length);
});

test('cf-purge-cache.mjs usa le varianti in modalita` --files (e non un files: nudo)', () => {
  assert.match(PURGE, /from '\.\/lib\/cf-purge-variants\.mjs'/, 'deve importare il modulo condiviso');
  assert.match(PURGE, /purgeBodiesForUrls\(batch\)/, 'la modalita` targeted deve espandere le varianti');

  // Non-vacuita': il difetto era esattamente `{ files: batch }` passato diretto
  // all'API. Se torna, questo test deve fallire invece di passare perche' l'import
  // e' rimasto li' inutilizzato.
  assert.doesNotMatch(
    PURGE,
    /purge_cache`,\s*\{\s*files:/,
    'nessun purge deve mandare un files: nudo saltando le varianti',
  );
});

test('publish-api.yml non carica mai su CDN con il Cache-Control di default', () => {
  // Solo le INVOCAZIONI (`bash scripts/lib/…`), non le menzioni in prosa: il
  // commento sopra la chiamata nomina lo script per spiegare che toglie lo slash
  // iniziale, e una regex piu' lasca lo leggerebbe come una chiamata senza
  // Cache-Control.
  const calls = [...WF.matchAll(/bash scripts\/lib\/upload-cdn-file\.sh\s+(\S+)\s+(\S+)([^\n]*)/g)];

  // Non-vacuita': se le chiamate vengono rinominate o spostate, il test deve
  // rumoreggiare invece di validare una lista vuota.
  assert.ok(calls.length >= 2, `attese >= 2 chiamate a upload-cdn-file.sh, trovate ${calls.length}`);

  for (const [, src, key, rest] of calls) {
    assert.match(
      rest,
      /"public,max-age=\d+"/,
      `upload-cdn-file.sh ${src} ${key} non passa un Cache-Control esplicito: eredita il default `
        + 'images/ da 24h su un file che questo job riscrive a ogni pubblicazione',
    );
    const ttl = Number(rest.match(/max-age=(\d+)/)[1]);
    assert.ok(
      ttl <= 600,
      `${key}: max-age=${ttl} supera i 600s con cui il deploy del sito sincronizza lo stesso prefisso`,
    );
  }
});
