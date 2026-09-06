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
 * IL RAMO CHE MANCAVA (#974). Il gate confrontava dichiarato e ri-derivato, e
 * mappava l'artefatto ASSENTE su 0. Ma `counts` vale 0 per la stessa ragione —
 * i rami `not emitted` del writer lasciano il contatore a 0 — quindi su un
 * `border-wait-ranking.json`, `daily-brief.json` o `images-manifest.json` che
 * smette silenziosamente di essere emesso le due meta' concordano su 0 e il
 * gate resta VERDE: dimostra la coerenza interna del manifest, non che
 * l'artefatto dovesse esserci. La legittimita' dell'assenza si decide ora da
 * una sorgente TERZA — l'input del produttore su disco per gli artefatti
 * condizionali, niente affatto per quelli sempre emessi.
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
// La stessa funzione del gate: se questo test contasse col needle testuale
// verificherebbe una formula diversa da quella spedita.
import { countXmlTags } from '../../scripts/lib/count-xml-tags.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = readFileSync(resolve(ROOT, 'scripts/build-api.mjs'), 'utf-8');

// Ritagliare da `indexOf` senza controllarne il valore e' la stessa forma di
// leak che questo file va a caccia nel gate: con l'ancora sparita `indexOf` da'
// -1, `slice(-1)` restituisce UN carattere, e ogni «il gate non contiene X»
// passa proprio nel caso che deve prendere. L'ancora e' parte dell'asserzione.
const sliceFrom = (src, anchor) => {
  const at = src.indexOf(anchor);
  assert.ok(at >= 0, `ancora sparita dal sorgente, l'asserzione sarebbe vuota: ${anchor}`);
  return src.slice(at);
};

test('il gate finale ricontrolla manifest.counts contro gli artefatti su disco', () => {
  assert.match(SRC, /manifest counts gate/);
  assert.match(SRC, /manifest\.counts does not describe the set served/);
});

test('il confronto legge il manifest EMESSO, non l’oggetto counts in memoria', () => {
  // Un gate che rilegge le stesse variabili che hanno scritto il numero
  // verifica se stesso: e' verde per costruzione e non puo' mai fallire.
  assert.match(SRC, /const declared = jsonOut\('manifest\.json'\)\.counts;/);
  const gate = sliceFrom(SRC, 'manifest.counts descrive il set davvero servito');
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
  const gate = sliceFrom(SRC, 'const derived = {');
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

test('slugs.json e’ confrontato col manifest dal lato che pubblica, non solo da chi legge', () => {
  // `validateAnnouncedSurface()` (scripts/reconcile-article-shards.mjs) rifiuta
  // gia' la superficie se `slugs.blog` non combacia con `counts.articles`. Senza
  // la stessa asserzione nel producer, questo repo puo' PUBBLICARE un set che il
  // consumer rifiutera' a valle — e il sito non ribuilda, quindi il rifiuto
  // arriva in produzione invece che alla build che l'ha prodotto.
  assert.match(SRC, /slugs\.\$\{section\}: \$\{keys\.length\} ids/);
  const consumer = readFileSync(resolve(ROOT, 'scripts/reconcile-article-shards.mjs'), 'utf-8');
  assert.match(consumer, /slugs\.blog ha \$\{blogKeys\} id ma il manifest ne annuncia/);
});

test('slugs.json e’ confrontato per INSIEME, non per cardinalita’, da entrambi i lati', () => {
  // La cardinalita' da sola non vede l'id SOSTITUITO: un articolo rimosso e uno
  // nuovo nello stesso giro lasciano il conto identico da entrambi i lati, e
  // slugs.json e' la sorgente dei canonical — va live un canonical sbagliato
  // per quell'articolo senza che niente fallisca.
  for (const [file, src] of [
    ['scripts/build-api.mjs', SRC],
    ['scripts/reconcile-article-shards.mjs', readFileSync(resolve(ROOT, 'scripts/reconcile-article-shards.mjs'), 'utf-8')],
  ]) {
    assert.match(src, /indi[cx]/i);
    assert.ok(
      /slug senza articolo/.test(src) && /(id|ids) senza slug/.test(src),
      `${file} deve segnalare le due direzioni della differenza fra insiemi`,
    );
  }
});

test('dailyBriefBlocks e’ ri-derivato dai blocchi serviti, non dal numero che il payload dichiara', () => {
  // Era l'unico contatore confrontato contro `counts.availableBlocks` DEL
  // PAYLOAD: lo stesso «gate che ricontrolla chi ha scritto il numero» che
  // l'header del gate rifiuta, spostato di un livello. La formula e' quella del
  // produttore (generator/scripts/lib/daily-brief-data.mjs).
  const gate = sliceFrom(SRC, 'const derived = {');
  const derived = /dailyBriefBlocks: derivedOptional\(([\s\S]*?)\n    \),/.exec(gate);
  assert.ok(derived, 'dailyBriefBlocks deve restare cablato nel gate');
  assert.match(derived[1], /\.blocks/);
  assert.match(derived[1], /filter\(\(b\) => b\?\.available\)/);
  assert.ok(
    !/dailyBriefBlocks[\s\S]{0,200}counts\.availableBlocks/.test(gate),
    'ri-derivare da counts.availableBlocks significa richiedere al payload di confermare se stesso',
  );
  const producer = readFileSync(resolve(ROOT, 'generator/scripts/lib/daily-brief-data.mjs'), 'utf-8');
  assert.match(producer, /Object\.values\(blocks\)\.filter\(\(b\) => b\.available\)\.length/);
});

test('nessun contatore mappa l’ARTEFATTO ASSENTE su 0 in accordo col manifest', () => {
  // Il ramo che il gate non copriva. `derivedIfPresent` dava 0 su un artefatto
  // assente, e `counts` vale 0 per la stessa ragione (i rami `not emitted` del
  // writer lasciano il contatore a 0): le due meta' concordano su 0 e il gate
  // resta VERDE. Dimostra la coerenza interna del manifest, non che
  // l'artefatto dovesse esserci — cioe' esattamente il troncamento-a-zero che
  // AGENTS.md chiede a `counts` di rifiutare, su `dist/api/`.
  assert.ok(
    !SRC.includes('derivedIfPresent'),
    'derivedIfPresent mappa l’assenza su 0 senza chiedersi se l’artefatto dovesse esserci',
  );
  const gate = sliceFrom(SRC, 'const derived = {');
  const body = gate.slice(0, gate.indexOf('\n  };'));
  // Ogni voce di `derived` passa da uno dei due costruttori (o non legge un
  // artefatto per nome: `rssFeeds`/`rssItems` scandiscono la cartella, e una
  // cartella vuota non e' un file assente).
  const wired = ['derivedAlways', 'derivedOptional', 'sitemapUrls', 'feeds'];
  const entries = [...body.matchAll(/^    (\w+): ([\s\S]*?)(?=\n    \w+:|$)/gm)];
  // Guardia di vacuita': se il ritaglio smette di agganciare, il ciclo sotto
  // gira a vuoto e questo test diventa verde per assenza di casi.
  assert.ok(entries.length >= 11, `attese almeno 11 voci in \`derived\`, trovate ${entries.length}`);
  for (const [, key, rhs] of entries) {
    assert.ok(
      wired.some((fn) => rhs.includes(fn)),
      `il contatore '${key}' non dichiara come tratta l’artefatto assente: usa derivedAlways o derivedOptional`,
    );
  }
  // E la lista degli assenti deve confluire nel verdetto, o il gate li vede e
  // non li dice.
  assert.match(SRC, /const mismatches = \[\.\.\.absent\];/);
});

test('l’assenza legittima e’ decisa dall’INPUT del produttore, non dall’accordo fra le due meta’', () => {
  // La sorgente terza. Un artefatto opzionale puo' mancare solo se il suo
  // produttore non ha girato qui — condizione che sta su disco, fuori dal
  // manifest e fuori dal contatore.
  const gate = sliceFrom(SRC, 'const derived = {');
  for (const [counter, srcConst] of [
    ['images', 'IMAGE_SRC_DIR'],
    ['borderRankingEntries', 'BORDER_RANKING_SRC'],
    ['dailyBriefBlocks', 'DAILY_BRIEF_SRC'],
  ]) {
    const call = new RegExp(`${counter}: derivedOptional\\(([\\s\\S]*?)\\n    \\),`).exec(gate);
    assert.ok(call, `${counter} deve restare un artefatto opzionale cablato nel gate`);
    assert.ok(
      call[1].includes(srcConst),
      `${counter} deve decidere l’assenza da ${srcConst}, l’input del suo produttore`,
    );
  }
});

test('l’input del produttore ha UNA sorgente: writer e gate leggono la stessa costante', () => {
  // Se il ramo che decide di NON emettere e il gate che giudica l'assenza si
  // sfasano, il gate torna cieco proprio dove serve (AGENTS.md #6).
  for (const [srcConst, literal] of [
    ['IMAGE_SRC_DIR', "['public', 'images', 'blog']"],
    ['BORDER_RANKING_SRC', "['public', 'data', 'border-wait-ranking.json']"],
    ['DAILY_BRIEF_SRC', "['public', 'data', 'daily-brief.json']"],
  ]) {
    assert.ok(SRC.includes(`const ${srcConst} = ${literal};`), `${srcConst} deve dichiarare ${literal}`);
    // Due letture: il writer e il gate. Nessun path ri-scritto a mano accanto.
    const uses = [...SRC.matchAll(new RegExp(`\\b${srcConst}\\b`, 'g'))].length;
    assert.ok(uses >= 3, `${srcConst}: attese la dichiarazione + writer + gate, trovati ${uses} usi`);
  }
  const paths = ["'public', 'data', 'border-wait-ranking.json'", "'public', 'data', 'daily-brief.json'"];
  for (const p of paths) {
    assert.ok(
      !SRC.includes(`path.join(ROOT, ${p})`),
      `il path ${p} e’ ri-scritto a mano invece di passare dalla costante condivisa`,
    );
  }
});

test('slugs.json assente non e’ un caso da saltare', () => {
  // Stessa classe, stesso blocco: `if (exists('slugs.json'))` saltava in
  // silenzio l'intero confronto per insieme sulla sorgente dei canonical, che
  // e' scritta incondizionatamente. «Assente» non e' «d'accordo».
  const gate = sliceFrom(SRC, 'const derived = {');
  assert.ok(
    !/if \(exists\('slugs\.json'\)\) \{/.test(gate),
    'l’assenza di slugs.json non deve saltare il confronto: deve essere un mismatch',
  );
  assert.match(gate, /slugs\.json: assente da dist\/api/);
});

test('sul set pubblicato un artefatto opzionale manca solo se manca il suo input', { skip: !existsSync(join(ROOT, 'dist/api/manifest.json')) && 'dist/api non costruito in questo job' }, () => {
  // La meta' end-to-end delle asserzioni sul sorgente qui sopra: quando una
  // build reale c'e', l'artefatto assente viene confrontato con l'input che
  // avrebbe dovuto produrlo.
  const OUT = join(ROOT, 'dist/api');
  for (const [artifact, input] of [
    ['border-wait-ranking.json', 'public/data/border-wait-ranking.json'],
    ['daily-brief.json', 'public/data/daily-brief.json'],
  ]) {
    if (!existsSync(join(ROOT, input))) continue;
    assert.ok(
      existsSync(join(OUT, artifact)),
      `${input} esiste ma dist/api/${artifact} no: counts dichiara 0 e la ri-derivazione da’ 0, quindi il confronto per valore non lo vedrebbe`,
    );
  }
  const webpDir = join(ROOT, 'public/images/blog');
  const webp = existsSync(webpDir) ? readdirSync(webpDir).filter((f) => f.endsWith('.webp')).length : 0;
  if (webp > 0) {
    assert.ok(existsSync(join(OUT, 'images-manifest.json')), `${webp} .webp in public/images/blog ma nessun images-manifest.json`);
  }
});

test('sul set pubblicato ogni contatore combacia con gli artefatti', { skip: !existsSync(join(ROOT, 'dist/api/manifest.json')) && 'dist/api non costruito in questo job' }, () => {
  // `dist/` e' gitignored, quindi questo controllo gira solo dopo una build
  // reale (in CI: lo step `build-api` di publish-api.yml). Quando gira e'
  // l'unica prova end-to-end che le formule di ri-derivazione del gate
  // descrivono davvero gli artefatti, e non una forma immaginata.
  const OUT = join(ROOT, 'dist/api');
  const readOut = (name) => readFileSync(join(OUT, name), 'utf-8');
  const jsonOut = (name) => JSON.parse(readOut(name));
  const { counts } = jsonOut('manifest.json');

  assert.equal(counts.articles, jsonOut('articles.json').length);
  assert.equal(counts.swissArticles, jsonOut('swiss-articles.json').length);
  assert.equal(counts.sitemapBlogUrls, countXmlTags(readOut('sitemap-blog.xml'), 'url'));
  assert.equal(counts.sitemapBlogChUrls, countXmlTags(readOut('sitemap-blog-ch.xml'), 'url'));
  assert.equal(counts.tickerArticles, jsonOut('news-ticker-live.json').articles.length);

  const feeds = readdirSync(OUT)
    .filter((f) => f.endsWith('.xml'))
    .map((f) => readOut(f))
    .filter((xml) => xml.includes('<rss'));
  assert.equal(counts.rssFeeds, feeds.length);
  assert.equal(counts.rssItems, feeds.reduce((n, xml) => n + countXmlTags(xml, 'item'), 0));

  const slugs = jsonOut('slugs.json');
  assert.equal(Object.keys(slugs.blog).length, counts.articles);
  assert.equal(Object.keys(slugs.swiss).length, counts.swissArticles);
  assert.deepEqual(
    Object.keys(slugs.blog).sort(),
    jsonOut('articles.json').map((a) => a.id).sort(),
  );
  assert.deepEqual(
    Object.keys(slugs.swiss).sort(),
    jsonOut('swiss-articles.json').map((a) => a.id).sort(),
  );

  const brief = 'daily-brief.json';
  if (existsSync(join(OUT, brief))) {
    assert.equal(
      counts.dailyBriefBlocks,
      Object.values(jsonOut(brief).blocks ?? {}).filter((b) => b?.available).length,
    );
  }
});
