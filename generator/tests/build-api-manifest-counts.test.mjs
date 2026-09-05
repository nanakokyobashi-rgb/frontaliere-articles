/**
 * `manifest.counts` deve descrivere il set DAVVERO servito. Run with `node --test`.
 *
 * IL DIFETTO. `dist/api/manifest.json` ha due meta': `files` (byte per
 * artefatto) e `counts` (cardinalita' del set). AGENTS.md nomina `counts` per
 * prima — «permette di rifiutare un set troncato *prima* di usarlo» — perche'
 * il set troncato e' il caso peggiore proprio in quanto non fallisce da solo,
 * e il sito non ribuilda quando questo repo pubblica.
 *
 * `files` ha il suo gate dal 2026-09-05 (#905, byte contro disco). `counts`
 * non ne aveva nessuno: ogni numero veniva da una variabile catturata a meta'
 * pipeline (`imageCount`, `rssItemTotal`, `sitemapCounts.blog`, ...) e non
 * veniva mai riletto dai byte scritti in `dist/api/`. Un filtro applicato alla
 * serializzazione ma non al contatore lascia il manifest internamente
 * coerente e il set servito diverso: nessun errore, nessuna build rossa.
 *
 * MISURATO il 2026-09-05 su `main` (HEAD ac34d9163, 3781 articoli): tutti e
 * dodici i contatori combaciano oggi. Il gate non nasce da una divergenza in
 * corso — nasce, come i due che lo precedono nello stesso file, per il writer
 * che ancora non esiste, e per questo il controllo di esaustivita' conta
 * quanto il confronto: un contatore aggiunto a `counts` e non cablato nel gate
 * fa fallire la build invece di scivolare dentro non verificato.
 *
 * PERCHE' UN TEST E NON SOLO LA FIX. Il gate e' silenzioso quando tutto e'
 * sano — cioe' sempre, finche' non serve. Un gate che si ricontrolla addosso
 * (rileggendo le variabili in memoria invece del disco) sarebbe altrettanto
 * silenzioso e completamente inutile, e la differenza fra i due non si vede
 * rileggendo l'output di una build verde. Qui si asserisce sui sorgenti che la
 * rilettura e' dal disco e che l'esaustivita' c'e'.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(resolve(ROOT, 'scripts/build-api.mjs'), 'utf-8');

test('il gate finale ricontrolla manifest.counts contro gli artefatti su disco', () => {
  assert.match(SRC, /manifest counts gate/);
  assert.match(SRC, /manifest\.counts does not describe the set served/);
});

test('il confronto legge il manifest EMESSO, non l’oggetto counts in memoria', () => {
  // Un gate che rilegge le stesse variabili che hanno scritto il numero
  // verifica se stesso: e' verde per costruzione e non puo' mai fallire.
  assert.match(SRC, /const declared = jsonOut\('manifest\.json'\)\.counts;/);
  const gate = SRC.slice(SRC.indexOf('manifest.counts descrive il set davvero servito'));
  assert.ok(gate.length > 0, 'il gate deve esistere');
  for (const inMemory of ['ARTICLES.length', 'rssItemTotal', 'imageCount', 'sitemapCounts.']) {
    assert.ok(
      !gate.includes(inMemory),
      `il gate non deve ri-derivare da ${inMemory}: e' la variabile che ha scritto il manifest`,
    );
  }
});

test('ogni contatore di manifest.counts e’ ri-derivato o dichiarato non ri-derivabile', () => {
  // La parte che protegge dal contatore FUTURO: senza questa, un contatore
  // aggiunto a `counts` entra nel manifest senza che nulla lo verifichi, ed e'
  // esattamente cosi' che `files` era rimasto sbagliato su 24 voci su 29.
  assert.match(SRC, /carries counters this gate does not re-derive/);
  const counts = /counts: \{([\s\S]*?)\n  \},/.exec(SRC);
  assert.ok(counts, 'scripts/build-api.mjs deve costruire manifest.counts');
  const keys = [...counts[1].matchAll(/^\s{4}(\w+)[,:]/gm)].map((m) => m[1]);
  assert.ok(keys.length >= 12, `attesi almeno 12 contatori, trovati ${keys.length}`);
  const gate = SRC.slice(SRC.indexOf('const derived = {'));
  for (const key of keys) {
    assert.ok(
      new RegExp(`\\b${key}\\b`).test(gate),
      `il contatore '${key}' non compare nel gate: cablalo in \`derived\` o in NOT_ON_DISK`,
    );
  }
});

test('la cartella delle immagini e’ confrontata con l’indice che la dichiara', () => {
  // L'immagine e' l'unico artefatto che il consumer non puo' ri-derivare:
  // una copia interrotta a meta' lascia l'indice pieno e la cartella corta.
  assert.match(SRC, /images\/blog holds/);
});

test('sul set pubblicato ogni contatore combacia con gli artefatti', { skip: !existsSync(join(ROOT, 'dist/api/manifest.json')) && 'dist/api non costruito in questo job' }, () => {
  // `dist/` e' gitignored, quindi questo controllo gira solo dopo una build
  // reale (in CI: lo step `build-api` di publish-api.yml). Quando gira e'
  // l'unica prova end-to-end che le formule di ri-derivazione del gate
  // descrivono davvero gli artefatti, e non una forma immaginata.
  const OUT = join(ROOT, 'dist/api');
  const readOut = (name) => readFileSync(join(OUT, name), 'utf-8');
  const jsonOut = (name) => JSON.parse(readOut(name));
  const occurrences = (text, needle) => text.split(needle).length - 1;
  const { counts } = jsonOut('manifest.json');

  assert.equal(counts.articles, jsonOut('articles.json').length);
  assert.equal(counts.swissArticles, jsonOut('swiss-articles.json').length);
  assert.equal(counts.sitemapBlogUrls, occurrences(readOut('sitemap-blog.xml'), '<url>'));
  assert.equal(counts.sitemapBlogChUrls, occurrences(readOut('sitemap-blog-ch.xml'), '<url>'));
  assert.equal(counts.tickerArticles, jsonOut('news-ticker-live.json').articles.length);

  const feeds = readdirSync(OUT)
    .filter((f) => f.endsWith('.xml'))
    .map((f) => readOut(f))
    .filter((xml) => xml.includes('<rss'));
  assert.equal(counts.rssFeeds, feeds.length);
  assert.equal(counts.rssItems, feeds.reduce((n, xml) => n + occurrences(xml, '<item>'), 0));
});
