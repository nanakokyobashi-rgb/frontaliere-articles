/**
 * Slug localizzati: il ripiego sull'italiano non puo' tornare silenzioso.
 * `node --test`. Issue #191.
 *
 * ## Il difetto che questo banco impedisce di ripetere
 *
 * Quando il modello ometteva lo slug en/de/fr, `validate()` lo derivava da
 * `data.content[locale]?.title || data.content.it?.title` — e quel secondo ramo
 * scattava quasi sempre, perche' `validate()` gira sulla chiamata di
 * generazione ITALIANA, prima che `translateArticle()` esista. Lo slug
 * "localizzato" era quindi l'italiano, e a valle era indistinguibile da uno
 * slug scelto: nessun log, nessun contatore, nessun campo.
 *
 * Misurato il 2026-08-13 su 4.114 voci di registro: **169 articoli servono
 * l'URL italiano in TUTTI E TRE** i locali tradotti (126 blog + 43 svizzera),
 * 217 in almeno uno. Erano 121 su 3.173 quando la issue e' stata aperta: il
 * difetto cresce in proporzione al corpus, ed e' per questo che il gate qui
 * sotto e' un ratchet a conteggio e non una soglia relativa — una percentuale
 * resterebbe verde mentre il numero assoluto raddoppia.
 *
 * ## Tre strati, perche' due non bastano
 *
 *  1. UNIT sulla funzione pura. L'invariante e' letterale: uno slug di un
 *     locale != it non e' MAI byte-identico all'italiano quando esiste un
 *     titolo tradotto da cui ricavarlo.
 *  2. WIRING sul sorgente. La funzione puo' essere corretta e non essere
 *     chiamata: e' esattamente come `normalizeTitleCasing` ha lasciato passare
 *     un titolo tutto maiuscolo (vedi blog-title-casing.test.mjs). Qui i
 *     call-site che contano sono due, perche' il flusso AI primario NON passa
 *     da `registerArticleFiles()`.
 *  3. RATCHET sul corpus pubblicato. E' il solo strato che si accorge di un
 *     percorso di scrittura che nessuno dei due sopra conosce.
 *
 * ## Perche' non importa create-article.mjs
 *
 * Questo repo non installa node_modules di proposito: la closure di
 * create-article.mjs tira dipendenze npm che la CI non ha. Le funzioni sotto
 * esame sono pure e autocontenute, quindi il test ne ESTRAE il sorgente e lo
 * valuta in sandbox — stessa tecnica di blog-title-casing.test.mjs. Se
 * l'estrazione si rompe (funzioni spostate, delimitatori cambiati) il test
 * fallisce rumorosamente: non puo' passare a vuoto.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { truncateSlugAtWordBoundary } from '../scripts/lib/slug-truncate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREATE_ARTICLE = path.join(ROOT, 'generator', 'scripts', 'create-article.mjs');
const SRC = fs.readFileSync(CREATE_ARTICLE, 'utf-8');

// ── Estrazione in sandbox ──────────────────────────────────────────────────

/** Dal delimitatore iniziale alla prima riga che e' esattamente `}` a colonna 0. */
function sliceBlock(startNeedle, fnNeedle) {
  const start = SRC.indexOf(startNeedle);
  const fnStart = SRC.indexOf(fnNeedle);
  assert.notEqual(start, -1, `delimitatore non trovato in create-article.mjs: ${startNeedle}`);
  assert.notEqual(fnStart, -1, `delimitatore non trovato in create-article.mjs: ${fnNeedle}`);
  assert.ok(fnStart >= start, `delimitatori in ordine inverso: ${startNeedle} / ${fnNeedle}`);
  const endRel = SRC.slice(fnStart).search(/\n\}\n/);
  assert.notEqual(endRel, -1, `chiusura non trovata per ${fnNeedle}`);
  return SRC.slice(start, fnStart + endRel + 2);
}

function loadSlugSandbox() {
  const slugify = sliceBlock('const SLUG_MAX_LENGTH = 80;', 'function slugifySlugPart(input) {');
  const relocalize = sliceBlock(
    "export const PROVISIONAL_IT_SLUG_FIELD = '_slugsProvisionalFromIt';",
    'export function relocalizeSlugsAfterTranslation(data, opts = {}) {',
  );
  const code = `${slugify}\n${relocalize}`.replace(/^export /gm, '');
  return new Function(
    'truncateSlugAtWordBoundary',
    `${code}\nreturn { slugifySlugPart, relocalizeSlugsAfterTranslation, markProvisionalItSlug, PROVISIONAL_IT_SLUG_FIELD };`,
  )(truncateSlugAtWordBoundary);
}

const { slugifySlugPart, relocalizeSlugsAfterTranslation, markProvisionalItSlug, PROVISIONAL_IT_SLUG_FIELD } =
  loadSlugSandbox();

const LOCALIZED_TITLES = {
  it: 'Ristorni frontalieri: Berna deplora lo stop del Cantone',
  en: 'Cross-border rebates: Bern deplores the Canton’s halt',
  de: 'Grenzgänger-Rückerstattungen: Bern bedauert den Stopp des Kantons',
  fr: 'Ristournes frontalières : Berne déplore l’arrêt du Canton',
};

function articleFixture(overrides = {}) {
  const data = {
    id: 'ristorni-frontalieri-berna-deplora-lo-stop',
    slugs: { it: 'ristorni-frontalieri-berna-deplora-lo-stop' },
    content: {
      it: { title: LOCALIZED_TITLES.it },
      en: { title: LOCALIZED_TITLES.en },
      de: { title: LOCALIZED_TITLES.de },
      fr: { title: LOCALIZED_TITLES.fr },
    },
  };
  return { ...data, ...overrides };
}

// ── 1. UNIT: l'invariante letterale ────────────────────────────────────────

describe('relocalizeSlugsAfterTranslation — lo slug di un locale non e’ l’URL italiano', () => {
  it('rilocalizza i tre slug provvisori appena i titoli tradotti esistono', () => {
    const data = articleFixture();
    // Lo stato che `validate()` lascia quando il modello omette gli slug: tutti
    // e tre uguali all'italiano e marcati provvisori.
    for (const locale of ['en', 'de', 'fr']) {
      data.slugs[locale] = data.slugs.it;
      markProvisionalItSlug(data, locale);
    }

    const out = relocalizeSlugsAfterTranslation(data);

    assert.equal(out.stillItalian.length, 0, `ripieghi residui: ${JSON.stringify(out.stillItalian)}`);
    assert.equal(out.relocalized.length, 3);
    for (const locale of ['en', 'de', 'fr']) {
      assert.notEqual(
        data.slugs[locale],
        data.slugs.it,
        `lo slug ${locale} e' ancora byte-identico all'italiano: "${data.slugs[locale]}"`,
      );
    }
    assert.equal(data.slugs.en, slugifySlugPart(LOCALIZED_TITLES.en));
    assert.deepEqual(data[PROVISIONAL_IT_SLUG_FIELD], [], 'il marchio provvisorio va tolto quando il ripiego finisce');
  });

  it('corregge anche uno slug italiano NON marcato — i produttori che saltano validate() non marcano nulla', () => {
    // publish-journalist-article.mjs e i tre generate-*.mjs arrivano a
    // deriveAndSanitizeArticleSlugs() senza passare da validate(): il campo
    // provvisorio non esiste, ma il difetto e' lo stesso. Se il gate guardasse
    // solo il marchio, questi quattro percorsi resterebbero scoperti.
    const data = articleFixture();
    data.slugs.en = data.slugs.it;
    data.slugs.de = 'grenzgaenger-rueckerstattungen-bern';
    data.slugs.fr = data.slugs.it;

    relocalizeSlugsAfterTranslation(data);

    assert.notEqual(data.slugs.en, data.slugs.it);
    assert.notEqual(data.slugs.fr, data.slugs.it);
    assert.equal(data.slugs.de, 'grenzgaenger-rueckerstattungen-bern', 'uno slug gia’ localizzato non va toccato');
  });

  it('NON deriva mai lo slug di un locale dal titolo italiano', () => {
    // E' il ramo `|| data.content.it?.title` rimosso: produceva l'URL italiano
    // sotto un altro locale e lo faceva passare per uno slug localizzato.
    const data = articleFixture();
    data.content.en = {};
    data.content.de = {};
    data.content.fr = {};
    for (const locale of ['en', 'de', 'fr']) {
      data.slugs[locale] = data.slugs.it;
      markProvisionalItSlug(data, locale);
    }

    const out = relocalizeSlugsAfterTranslation(data);

    // Non potendo localizzare, l'italiano resta — ma ogni locale porta la causa.
    assert.equal(out.relocalized.length, 0);
    assert.equal(out.stillItalian.length, 3);
    for (const entry of out.stillItalian) {
      assert.equal(entry.reason, 'titolo tradotto assente');
      assert.notEqual(entry.slug, undefined);
    }
  });

  it('ogni ripiego sull’italiano emette un evento con la causa: nessuna uscita e’ muta', () => {
    // E' LA proprieta' che la issue chiede. Un fallback che non lascia traccia
    // e' la causa del difetto, non il difetto.
    const cases = [
      { mutate: (d) => { d.content.en = {}; }, reason: 'titolo tradotto assente' },
      { mutate: (d) => { d.content.en = { title: '— — —' }; }, reason: 'titolo tradotto non slugificabile' },
      // Il titolo tradotto che slugifica esattamente sull'italiano: succede con
      // i titoli fatti di soli nomi propri ("Gaggiolo", "Chiasso").
      { mutate: (d) => { d.content.en = { title: d.slugs.it.replace(/-/g, ' ') }; }, reason: 'titolo tradotto identico all\'italiano' },
      { mutate: () => {}, reason: 'slug localizzato gia\' occupato nella sezione', isTaken: () => true },
    ];
    for (const { mutate, reason, isTaken } of cases) {
      const data = articleFixture();
      data.content.de = {};
      data.content.fr = {};
      data.slugs.en = data.slugs.it;
      mutate(data);
      const events = [];
      relocalizeSlugsAfterTranslation(data, { isTaken, onEvent: (e) => events.push(e) });
      const en = events.find((e) => e.locale === 'en');
      assert.ok(en, `nessun evento emesso per en (causa attesa: ${reason})`);
      assert.equal(en.kind, 'it-fallback');
      assert.equal(en.reason.normalize('NFC'), reason.normalize('NFC'));
    }
  });

  it('non promuove uno slug che collide con un articolo gia’ pubblicato nella sezione', () => {
    const data = articleFixture();
    data.slugs.en = data.slugs.it;
    markProvisionalItSlug(data, 'en');
    const taken = slugifySlugPart(LOCALIZED_TITLES.en);
    relocalizeSlugsAfterTranslation(data, { isTaken: (locale, slug) => locale === 'en' && slug === taken });
    assert.equal(data.slugs.en, data.slugs.it, 'meglio l’URL italiano dichiarato che due articoli sullo stesso URL');
  });
});

describe('slugifySlugPart — il cap non spezza l’ultima parola', () => {
  it('arretra al trattino invece di troncare a meta’ token', () => {
    const long = 'vivre a tronzano lago maggiore et travailler en ticino en tant que travailleur frontalier';
    const slug = slugifySlugPart(long);
    assert.ok(slug.length <= 80, `slug di ${slug.length} caratteri`);
    assert.ok(!slug.endsWith('-'), 'trattino finale');
    // Il caso reale a log: "...-en-tant-que-travailleur-f".
    assert.ok(
      !/-[a-z]$/.test(slug) || slug.split('-').pop().length > 1,
      `ultimo token spezzato: "${slug}"`,
    );
  });
});

// ── 2. WIRING: la funzione giusta chiamata dove serve ──────────────────────

describe('cablaggio in create-article.mjs', () => {
  it('e’ invocata dopo translateArticle() nel flusso AI primario', () => {
    // Il flusso primario scrive i file da se' (modifyRouterTs /
    // modifyBlogArticlesTsx) e non chiama registerArticleFiles(): la
    // rilocalizzazione dentro deriveAndSanitizeArticleSlugs() NON lo copre.
    const at = SRC.indexOf('await translateArticle(data);');
    assert.notEqual(at, -1, 'call-site di translateArticle non trovato');
    const window = SRC.slice(at, at + 1400);
    assert.match(window, /relocalizeSlugsAfterTranslation\(data, \{/);
  });

  it('e’ invocata anche in deriveAndSanitizeArticleSlugs(), il write path condiviso', () => {
    const at = SRC.indexOf('export function deriveAndSanitizeArticleSlugs(data) {');
    assert.notEqual(at, -1);
    const end = SRC.indexOf('\n}\n', at);
    const body = SRC.slice(at, end);
    assert.match(body, /relocalizeSlugsAfterTranslation\(data, \{/);
  });

  it('nessuno dei due percorsi deriva piu’ uno slug en/de/fr dal titolo italiano', () => {
    // La forma esatta rimossa. Se ricompare, ricompare il difetto.
    const offenders = [...SRC.matchAll(/data\.content(\?)?\.\[?locale\]?(\?)?\.title \|\| data\.content(\?)?\.it(\?)?\.title/g)];
    assert.deepEqual(
      offenders.map((m) => m[0]),
      [],
      'il titolo italiano e’ tornato a fare da sorgente per uno slug localizzato',
    );
  });

  it('il ripiego finale passa da un reporter, non da un assegnamento muto', () => {
    assert.match(SRC, /function reportSlugI18nEvent\(event\)/);
    assert.match(SRC, /RUN_REPORT\.slugs\.itFallback \+= 1;/);
    assert.match(SRC, /slugs: \{[\s\S]{0,600}?itFallbackDetail: \[\],/);
  });
});

// ── 3. RATCHET sul corpus pubblicato ───────────────────────────────────────

// Registro slug delle due sezioni. `,?` finale non e' pedanteria: 2 delle 686
// voci svizzere hanno la virgola dopo `fr` e senza di essa sfuggivano al conteggio.
const SLUG_ENTRY_RE =
  /(['"])([A-Za-z0-9._-]+)\1\s*:\s*\{\s*it\s*:\s*(['"])([^'"]*)\3\s*,\s*en\s*:\s*(['"])([^'"]*)\5\s*,\s*de\s*:\s*(['"])([^'"]*)\7\s*,\s*fr\s*:\s*(['"])([^'"]*)\9\s*,?\s*\}/g;

function readSlugRegistries() {
  const out = [];
  for (const file of ['routerBlogData.ts', 'routerSwissData.ts']) {
    const full = path.join(ROOT, 'content', file);
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, 'utf-8');
    SLUG_ENTRY_RE.lastIndex = 0;
    let m;
    while ((m = SLUG_ENTRY_RE.exec(src)) !== null) {
      out.push({ file, id: m[2], it: m[4], en: m[6], de: m[8], fr: m[10] });
    }
  }
  return out;
}

describe('corpus pubblicato — ratchet sugli slug non localizzati', () => {
  const entries = readSlugRegistries();

  it('i registri sono leggibili e non vuoti', () => {
    // Un worktree sparse non materializza content/: un gate che passa su zero
    // voci scandite e' un falso verde, non un successo.
    assert.ok(entries.length > 3000, `solo ${entries.length} voci di slug lette dai due registri`);
  });

  // Misurato il 2026-08-13 su 4.114 voci: 217 articoli con almeno un locale
  // sull'URL italiano, 169 con tutti e tre. Gli storici RESTANO — rinominare
  // uno slug pubblicato richiede il redirect (data/article-redirects.json) ed
  // e' lavoro separato e coordinato, che la issue stessa chiede di NON fare
  // senza il bridge. Cio' che questo numero difende e' la DERIVATA: la fix di
  // #191 vale se non ne nascono di nuovi.
  const IT_URL_ACROSS_LOCALES_BASELINE = 217;
  const ALL_THREE_IDENTICAL_BASELINE = 169;
  const LONG_SLUG_BASELINE = 55;

  it(`gli articoli che servono l'URL italiano su en/de/fr non superano ${IT_URL_ACROSS_LOCALES_BASELINE}`, () => {
    const offenders = entries.filter((e) => e.en === e.it || e.de === e.it || e.fr === e.it);
    assert.ok(
      offenders.length <= IT_URL_ACROSS_LOCALES_BASELINE,
      `${offenders.length} articoli servono l'URL italiano in almeno un locale (baseline ${IT_URL_ACROSS_LOCALES_BASELINE}).\n` +
        `Nuovi rispetto alla baseline: ${offenders.length - IT_URL_ACROSS_LOCALES_BASELINE}.\n` +
        `Primi dieci: ${offenders.slice(0, 10).map((e) => e.id).join(', ')}\n` +
        'Se la fix di #191 e’ in piedi questo numero non puo’ salire: un articolo nuovo ricava lo slug dal titolo tradotto.',
    );
  });

  it(`gli articoli con TUTTI E TRE i locali sull'URL italiano non superano ${ALL_THREE_IDENTICAL_BASELINE}`, () => {
    // E' il numero della issue (169 su 4.114, blog 126 + swiss 43): un articolo
    // che serve lo stesso indirizzo in quattro lingue non ha localizzazione
    // affatto, ed e' il caso peggiore della famiglia.
    const offenders = entries.filter((e) => e.en === e.it && e.de === e.it && e.fr === e.it);
    assert.ok(
      offenders.length <= ALL_THREE_IDENTICAL_BASELINE,
      `${offenders.length} articoli servono l'URL italiano su en, de E fr (baseline ${ALL_THREE_IDENTICAL_BASELINE}).\n` +
        `Primi dieci: ${offenders.slice(0, 10).map((e) => e.id).join(', ')}`,
    );
  });

  it(`gli slug lunghi >= 80 caratteri non superano ${LONG_SLUG_BASELINE}`, () => {
    const long = [];
    for (const e of entries) {
      for (const locale of ['it', 'en', 'de', 'fr']) {
        if (e[locale].length >= 80) long.push(`${e.id}/${locale}`);
      }
    }
    assert.ok(
      long.length <= LONG_SLUG_BASELINE,
      `${long.length} slug >= 80 caratteri (baseline ${LONG_SLUG_BASELINE}): ${long.slice(0, 10).join(', ')}`,
    );
  });
});
