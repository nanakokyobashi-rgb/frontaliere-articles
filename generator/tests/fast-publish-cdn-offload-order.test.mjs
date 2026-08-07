/**
 * L'archivio va renderizzato PRIMA dell'offload CDN, non dopo. Run with `node --test`.
 *
 * IL DIFETTO (issue #5270). `scripts/publish-article-fast.mjs` chiamava
 * `renderArticleHubPages` DOPO aver lanciato `offload-generated-images-cdn.mjs`.
 * L'offload è l'unico passaggio che riscrive verso il CDN i `/assets/...` che
 * `articleHubPagesPlugin` emette come stringhe letterali (`src="/assets/${entryJs}"`),
 * invisibili a Rollup perché non sono riferimenti ad asset. Nessuna origin sul percorso
 * di servizio ospita `/assets`: `https://frontaliereticino.ch/assets/index-entry.js`
 * risponde 404. Ogni pagina archivio scritta dopo l'offload usciva quindi con 9
 * riferimenti garantiti 404 — niente CSS, niente bundle SPA, niente loader AdSense.
 *
 * PERCHÉ NESSUNO SE N'ERA ACCORTO. Una build piena è immune (lì l'offload gira dopo
 * tutta la build, archivio incluso), quindi il guasto compariva solo dopo una
 * pubblicazione veloce. E dal 2026-08-06 questo repo NON era più l'unico a pushare gli
 * shard degli articoli: `scripts/publish-article-fast.mjs` è una COPIA di quello del
 * repo del sito, nessun mirror trasporta `scripts/` (mirror-articles-engine.yml porta
 * `engine/` + `index.ts` + `articleSections.ts`), e il sito aveva già corretto l'ordine
 * in valerielinc-ops/frontaliere-si-o-no#5271. Misurato sullo shard
 * `frontaliere-articolifrontaliere-it`, file `articoli-frontaliere/tutti/index.html`:
 *
 *   07:07:18Z  push da questo repo   10 rif. /assets same-origin,  0 CDN
 *   05:53:17Z  push da questo repo   10 rif. /assets same-origin,  0 CDN
 *   05:13:17Z  push dal repo sito     1 rif. /assets same-origin,  9 CDN
 *   03:55:58Z  push da questo repo   10 rif. /assets same-origin,  0 CDN
 *   03:42:32Z  push dal repo sito     1 rif. /assets same-origin,  9 CDN
 *
 * L'archivio live alternava sano e rotto a seconda di chi aveva pubblicato per ultimo,
 * il che è esattamente ciò che fa sembrare un bug di ordine un problema di cache o di
 * deploy.
 *
 * PERCHÉ UN TEST E NON SOLO LA FIX. L'ordine è stato sbagliato per tutta la vita del
 * re-render dell'archivio e nulla lo ha mai segnalato: il commento accanto alla chiamata
 * giustificava esplicitamente il salto dei passaggi 2-6 («article-body specific»), il che
 * è vero per i passaggi per-articolo e falso per l'offload, che è una passata su tutto il
 * dist. La stessa buona fede può rimetterlo dov'era. Il gate a runtime nel workflow
 * (`Validate what was rendered`) difende i byte; questo difende l'ordine, e costa un
 * `readFileSync`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(here, '../../scripts/publish-article-fast.mjs'), 'utf8');
const WF = readFileSync(resolve(here, '../../.github/workflows/fast-publish-article.yml'), 'utf8');

test("l'archivio dell'hub è renderizzato prima dell'offload CDN", () => {
  const archivio = SRC.indexOf('await renderArticleHubPages(');
  const offload = SRC.indexOf("'offload-generated-images-cdn.mjs'");

  // Non-vacuità: se una delle due chiamate viene rinominata, il test deve fallire
  // rumorosamente invece di passare in silenzio confrontando due -1.
  assert.ok(archivio > -1, 'chiamata a renderArticleHubPages non trovata');
  assert.ok(offload > -1, 'spawn di offload-generated-images-cdn.mjs non trovato');

  assert.ok(
    archivio < offload,
    "l'archivio va renderizzato PRIMA dell'offload CDN, altrimenti i suoi /assets restano "
      + 'same-origin e rispondono 404 (issue #5270)',
  );
});

test("l'archivio finisce nello stesso dist che l'offload percorre", () => {
  // L'offload riscrive ciò che sta sotto `dist`: se il render dell'archivio puntasse
  // altrove, il riordino sopra non comprerebbe niente.
  const i = SRC.indexOf('await renderArticleHubPages(');
  assert.match(SRC.slice(i, i + 220), /distDir/);
});

test('il workflow rifiuta di pubblicare pagine con /assets/ same-origin', () => {
  // Solo le righe eseguibili: i commenti citano il difetto e lo descriverebbero come
  // presente.
  const attive = WF.split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

  assert.match(
    attive,
    /asset_rx='\(src\|href\)="\/assets\/\[\^"\]'/,
    'il gate a runtime su /assets/ same-origin è sparito dallo step di validazione',
  );
  assert.match(
    attive,
    /same-origin \/assets\/ refs[\s\S]{0,200}fail=1/,
    'il gate su /assets/ deve essere fatale, non un warning',
  );
});
