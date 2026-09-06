/**
 * CLUSTER «Null come valore pubblicabile» — issue #868, #869 (e #831 item 3).
 *
 * Un solo file perche' i difetti sono UNO: la stringa `Null`/`NULL` che
 * attraversa la catena come se fosse un titolo valido. Da #860 un `Null` `de`
 * SOPRAVVIVE invece di cadere sul fallback italiano, e quel valore arriva ora
 * dove prima non arrivava — slug, sitemap, canonical, cache, dedupe, meta.
 *
 * La regola che questo file pinna e' la discriminante di PROVENIENZA
 * documentata in `body2-payload-verdict.mjs` (blocco «QUALE DEI DUE
 * PREDICATI»):
 *
 *   - prosa di un MODELLO che ha letto la sorgente → `hasUsableTranslatedText`,
 *     e su `de` il `Null` maiuscolo e' la parola per «zero», si tiene (#831);
 *   - uscita di una MACCHINA con un sentinella di fallimento (cascata free-MT,
 *     export CSV/DB del feed eventi) → `hasUsableContentText`, tutte le
 *     grafie, si scarta (#868).
 *
 * Senza questo file la regola e' una convenzione: ogni call-site puo' scegliere
 * il predicato «piu' permissivo» e nessun gate se ne accorge, perche' l'esito
 * sbagliato — un marker pubblicato, o il testo italiano sotto `/de/` — e'
 * comunque un articolo che esce verde.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeLocaleTag,
  localeHasNullAsWord,
  hasUsableContentText,
  hasUsableTranslatedText,
  findUnreadableContentEvidence,
  isTopicGateAbortVerdict,
} from '../scripts/lib/body2-payload-verdict.mjs';
import { translateFieldFreeMt } from '../scripts/lib/article-free-mt.mjs';
import {
  localesNeedingTranslation,
  enrichEventsWithLocaleFallbackTranslations,
} from '../scripts/lib/events-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = readFileSync(path.join(__dirname, '..', 'scripts', 'create-article.mjs'), 'utf-8');

// ── #868 item 6 — il subtag di regione non fa ricadere sul predicato severo ──

describe('normalizeLocaleTag / localeHasNullAsWord', () => {
  test('taglia il subtag di regione e il caso: de-CH, de_DE, DE-ch sono tutti `de`', () => {
    for (const tag of ['de', 'de-CH', 'de_DE', 'DE-ch', ' de-AT ', 'de-Latn-CH']) {
      assert.equal(normalizeLocaleTag(tag), 'de', `normalizeLocaleTag(${JSON.stringify(tag)})`);
      assert.equal(localeHasNullAsWord(tag), true, `localeHasNullAsWord(${JSON.stringify(tag)})`);
    }
  });

  test('un locale regionato NON tedesco resta sul predicato severo', () => {
    for (const tag of ['en-GB', 'fr-CH', 'it-CH']) {
      assert.equal(localeHasNullAsWord(tag), false, tag);
    }
  });

  test('locale assente, vuoto o non stringa: si fallisce CHIUSI, predicato severo', () => {
    for (const tag of [undefined, null, '', '   ', 42, {}]) {
      assert.equal(localeHasNullAsWord(tag), false, String(tag));
    }
  });

  test('e’ il predicato dei campi tradotti a leggerlo: `Null` su de-CH resta usabile', () => {
    // Prima del taglio del subtag questo tornava `false` — cioe' il campo si
    // leggeva come mancante e la recovery pubblicava l'italiano sotto /de/.
    assert.equal(hasUsableTranslatedText('Null', 'de-CH'), true);
    assert.equal(hasUsableTranslatedText('Null', 'de'), true);
    assert.equal(hasUsableTranslatedText('null', 'de-CH'), false, 'la grafia SERIALIZZATA resta scartata ovunque');
    assert.equal(hasUsableTranslatedText('Null', 'en-GB'), false, 'en non ha `Null` come parola');
  });
});

// ── #868 item 4 — il motore MT free: `Null` e’ un marker, non «zero» ────────

describe('translateFieldFreeMt — l’uscita di un motore non e’ prosa', () => {
  const run = (out, targetLang = 'de') =>
    translateFieldFreeMt({
      text: 'Un titolo italiano qualunque',
      sourceLang: 'it',
      targetLang,
      fieldType: 'title',
      translate: async () => out,
    });

  test('ogni grafia di null e’ scartata, `de` compreso', async () => {
    for (const marker of ['null', 'Null', 'NULL', 'nUlL', '  NULL  ', '"Null"']) {
      assert.equal(await run(marker), '', `motore che risponde ${JSON.stringify(marker)}`);
    }
  });

  test('la stessa regola su en e fr — non e’ una deroga tolta solo a de', async () => {
    for (const lang of ['en', 'fr']) {
      assert.equal(await run('NULL', lang), '');
    }
  });

  test('una traduzione vera passa: il filtro non e’ un blocco sul testo tedesco', async () => {
    assert.equal(await run('Ein deutscher Titel'), 'Ein deutscher Titel');
    // `Null` come PAROLA dentro una frase non e' il marker: si scarta solo il
    // valore INTERO, e questo e' cio' che tiene il filtro non distruttivo.
    assert.equal(await run('Null Grad in Airolo'), 'Null Grad in Airolo');
  });
});

// ── #868 item 2/3/5 + #831 item 3 — la catena eventi ───────────────────────

describe('events-utils — il feed dell’organizzatore non parla tedesco', () => {
  test('#868 item 5 — `NULL` maiuscolo dalla sorgente conta come locale ASSENTE', () => {
    const byLocale = { it: 'Festa di paese', de: 'NULL', en: 'Village fair', fr: 'Fête' };
    assert.deepEqual(localesNeedingTranslation(byLocale), ['de']);
  });

  test('#868 item 2 — `Null` su de e `NULL` su fr non si contano a vicenda come duplicati', () => {
    // `normalizeText` abbassa il case: col predicato permissivo i due valori
    // collassavano sulla STESSA chiave normalizzata, si marcavano a vicenda
    // «untranslated per duplicazione» e venivano riscritti dal sourceLocale —
    // esito opposto a quello che la deroga voleva ottenere.
    const byLocale = { it: 'Concerto in piazza', en: 'Concert in the square', de: 'Null', fr: 'NULL' };
    const needing = localesNeedingTranslation(byLocale);
    assert.deepEqual(needing.sort(), ['de', 'fr']);
    // e it/en, che sono testo vero e distinto, NON sono trascinati dentro.
    assert.equal(needing.includes('it'), false);
    assert.equal(needing.includes('en'), false);
  });

  test('#868 item 3 — una entry `Null` gia’ in cache non viene riusata: si ritraduce', async () => {
    const events = [{ id: 'e1', titleByLocale: { it: 'Mercatino di Natale', en: 'Christmas market' } }];
    // La cache e' persistente fra le run: la chiave e' quella che
    // `fillLocaleGaps` compone (`fieldType::sourceLocale::testoNormalizzato`).
    const cache = { 'title::it::mercatino di natale': { de: 'Null', fr: 'NULL' } };
    const chiamate = [];
    const out = await enrichEventsWithLocaleFallbackTranslations(events, cache, {
      delayMs: 0,
      translateFn: async ({ targetLang }) => {
        chiamate.push(targetLang);
        return `titolo-${targetLang}`;
      },
    });
    assert.deepEqual(chiamate.sort(), ['de', 'fr'], 'entrambe le entry avvelenate devono essere ritradotte');
    assert.equal(out[0].titleByLocale.de, 'titolo-de');
    assert.equal(out[0].titleByLocale.fr, 'titolo-fr');
    assert.equal(cache['title::it::mercatino di natale'].de, 'titolo-de', 'la cache va anche RISCRITTA');
  });

  test('#831 item 3 — una traduzione inutilizzabile non scrive la chiave: il locale resta scoperto', async () => {
    const events = [{ id: 'e1', titleByLocale: { it: 'Sagra della castagna' } }];
    const out = await enrichEventsWithLocaleFallbackTranslations(events, {}, {
      delayMs: 0,
      translateFn: async ({ targetLang }) => (targetLang === 'de' ? 'NULL' : `titolo-${targetLang}`),
    });
    const t = out[0].titleByLocale;
    assert.equal('de' in t, false, 'meglio un locale assente che un `NULL` pubblicato come titolo');
    assert.equal(t.en, 'titolo-en');
    assert.equal(t.it, 'Sagra della castagna');
  });

  test('#868 item 5 — la chiave gia’ avvelenata dal feed sparisce anche se la traduzione fallisce', async () => {
    // Il caso che lo spread di `{ ...byLocale }` conservava: la chiave `de`
    // ESISTE e vale `NULL` dal feed, e la cascata gratuita fallisce (rate-limit,
    // motore giu', quota). Senza il `delete`, il marker del feed si pubblicava
    // come titolo `de`.
    const events = [{ id: 'e1', titleByLocale: { it: 'Sagra della castagna', de: 'NULL', fr: 'Null' } }];
    const out = await enrichEventsWithLocaleFallbackTranslations(events, {}, {
      delayMs: 0,
      translateFn: async ({ targetLang }) => (targetLang === 'en' ? 'titolo-en' : ''),
    });
    const t = out[0].titleByLocale;
    assert.equal('de' in t, false, 'meglio un locale assente che il `NULL` del feed pubblicato');
    assert.equal('fr' in t, false, 'vale per tutte le grafie del marker');
    assert.equal(t.en, 'titolo-en');
    assert.equal(t.it, 'Sagra della castagna');
  });

  test('la mappa TUTTA avvelenata non torna verbatim: nessun locale «presente», nessun loop', async () => {
    // La colonna vuota di un export CSV/DB dell'organizzatore: `NULL` su tutti
    // e quattro i locali. `present.length === 0`, quindi il loop non parte e i
    // due early-return di `fillLocaleGaps` restituivano la mappa in INGRESSO
    // verbatim — il marker pubblicato come titolo E come descrizione.
    const events = [{
      id: 'e1',
      titleByLocale: { it: 'NULL', de: 'NULL', en: 'NULL', fr: 'NULL' },
      descriptionByLocale: { it: 'NULL', de: 'Null', en: 'null', fr: '  NULL  ' },
    }];
    let chiamate = 0;
    const out = await enrichEventsWithLocaleFallbackTranslations(events, {}, {
      delayMs: 0,
      translateFn: async () => { chiamate += 1; return 'x'; },
    });
    assert.equal(chiamate, 0, 'senza una sorgente utilizzabile non c’e’ niente da tradurre');
    assert.deepEqual(out[0].titleByLocale, {}, 'nessun `NULL` sopravvive come titolo');
    assert.deepEqual(out[0].descriptionByLocale, {}, 'ne’ come descrizione, in nessuna grafia');
  });

  test('nessun gap da riempire ma una chiave fuori dai locali avvelenata: non torna verbatim', async () => {
    // L'altro early-return: `needing.length === 0` — ogni locale richiesto e'
    // testo vero — mentre una chiave in piu' portata dal feed vale `NULL`.
    const events = [{
      id: 'e1',
      titleByLocale: { it: 'Sagra', en: 'Fair', de: 'Fest', fr: 'Fete', rm: 'NULL' },
    }];
    const out = await enrichEventsWithLocaleFallbackTranslations(events, {}, {
      delayMs: 0,
      translateFn: async () => { throw new Error('non deve essere chiamata'); },
    });
    assert.equal('rm' in out[0].titleByLocale, false, 'il marker cade anche sul ramo senza gap');
    assert.equal(out[0].titleByLocale.de, 'Fest');
  });

  test('il pass-through di `deadline` spedisce l’evento senza il marker del feed', async () => {
    // Oltre il budget l'evento passa non tradotto: tiene il testo della
    // sorgente, che pero' non e' il `NULL` del feed. Quello va pubblicato ora,
    // non «ritentato alla run dopo».
    const events = [{
      id: 'e1',
      titleByLocale: { it: 'Sagra della castagna', de: 'NULL' },
      descriptionByLocale: { it: 'Castagne e vin brule', fr: 'Null' },
    }];
    const out = await enrichEventsWithLocaleFallbackTranslations(events, {}, {
      delayMs: 0,
      deadline: Date.now() - 1,
      translateFn: async () => { throw new Error('oltre il deadline non si traduce'); },
    });
    assert.equal('de' in out[0].titleByLocale, false, 'il marker non si pubblica sul tail scaduto');
    assert.equal('fr' in out[0].descriptionByLocale, false);
    assert.equal(out[0].titleByLocale.it, 'Sagra della castagna', 'il testo vero resta');
    assert.equal(out[0].descriptionByLocale.it, 'Castagne e vin brule');
    assert.notEqual(out[0], events[0], 'il contratto «mai mutare in place» tiene');
    assert.equal(events[0].titleByLocale.de, 'NULL', 'l’input non e’ toccato');
  });
});

// ── #868 item 1 — lo slug: la sola parte che non si corregge dopo ──────────

describe('slug: un titolo `Null` non produce /de/blog/null', () => {
  test('il cablaggio passa dal classificatore condiviso, non da slugifySlugPart nudo', () => {
    // Le quattro derivazioni di uno slug da un titolo LOCALIZZATO. Il test e'
    // sul testo perche' e' l'unico modo di provare che nessuna delle quattro
    // sia tornata a `slugifySlugPart(localizedTitle)` — la forma che produceva
    // `data.slugs.de = 'null'` senza un warning.
    //
    // Il vincolo e' sul VALORE letto, non sul nome della variabile: il ramo di
    // recupero del segnaposto in `deriveAndSanitizeArticleSlugs()` chiamava
    // `slugifySlugPart(title)` e restava verde finche' l'assertion era legata
    // al solo identificatore `localizedTitle`. Tutti e quattro i rami leggono
    // ora `data.content?.[locale]?.title` nella stessa variabile.
    //
    // Dal #798 il classificatore non e' piu' chiamato in linea dai quattro
    // rami: sta dentro `localizedTitleSlugCandidate()`, l'unico helper che
    // deriva uno slug da un titolo localizzato, che gli somma il floor di
    // plausibilita' del titolo. Il pin resta quindi doppio — i quattro rami
    // passano tutti dall'helper, e l'helper attraversa il classificatore — ed
    // e' altrettanto stretto: una regressione che salta l'uno o l'altro cade.
    const occorrenze = CREATE_ARTICLE.match(
      /= localizedTitleSlugCandidate\(\s*localizedTitle\s*\);/g,
    ) || [];
    assert.equal(
      occorrenze.length,
      4,
      'attese quattro derivazioni: validate(), deriveAndSanitizeArticleSlugs() (assegnazione e recupero del segnaposto) e relocalizeSlugsAfterTranslation()',
    );
    assert.match(
      CREATE_ARTICLE.slice(CREATE_ARTICLE.indexOf('function localizedTitleSlugCandidate(localizedTitle) {')),
      /^function localizedTitleSlugCandidate[\s\S]{0,400}?inspectSlugForPromptPlaceholder\(testo\)\.slug/,
      'l\u2019helper condiviso non attraversa piu\u2019 il classificatore: un titolo `Null` tornerebbe lo slug `null`',
    );
    const codice = CREATE_ARTICLE.replace(/^\s*(?:\/\/|\*).*$/gm, '');
    // Il vincolo NON e' sul nome dell'argomento: una regressione che scrive
    // `slugifySlugPart(data.content[locale].title)` o `slugifySlugPart(t)`
    // resterebbe verde su un'assertion legata a un elenco di identificatori,
    // ed e' la stessa forma di difetto che aveva lasciato passare il ramo di
    // recupero del segnaposto. Si conta ogni CALL-SITE, comunque si chiami
    // l'argomento: la definizione a parte, oggi sono tre e sono nominati.
    const tutte = [...codice.matchAll(/(function\s+)?\bslugifySlugPart\s*\(/g)];
    assert.equal(tutte.filter((m) => m[1]).length, 1, 'una sola definizione di slugifySlugPart');
    const nude = tutte.filter((m) => !m[1]);
    assert.equal(
      nude.length,
      3,
      'nessuna derivazione da titolo localizzato puo’ saltare il classificatore: '
        + 'le sole `slugifySlugPart()` nude ammesse sono la sintesi dell’`id` dal titolo IT '
        + 'e il ramo `for (const locale of [\'it\'])` di validate() — dove il titolo e’ la '
        + 'sorgente e non una traduzione — piu’ la normalizzazione interna a '
        + 'inspectSlugForPromptPlaceholder(), che E’ il classificatore',
    );
    // Ancorate alla funzione che le contiene, non a una finestra di righe: due
    // righe aggiunte nel mezzo non devono far fallire il test.
    const funzioneChiudente = (idx) => {
      const m = [...codice.slice(0, idx).matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)].pop();
      return m ? m[1] : null;
    };
    assert.deepEqual(
      nude.map((m) => funzioneChiudente(m.index)).sort(),
      ['inspectSlugForPromptPlaceholder', 'validate', 'validate'],
      'una `slugifySlugPart()` nuda fuori da validate()/inspectSlugForPromptPlaceholder() e’ una nuova derivazione',
    );
    // E una sola delle due in validate() sta dentro il loop IT-only: l'altra
    // sintetizza l'`id` dal titolo italiano, che e' la sorgente.
    const loopPiuVicino = (idx) => {
      const m = [...codice.slice(0, idx).matchAll(/for\s*\(\s*const\s+locale\s+of\s+(\[[^\]]*\])\s*\)/g)].pop();
      return m ? m[1].replace(/\s+/g, '') : null;
    };
    assert.equal(
      nude.filter((m) => loopPiuVicino(m.index) === "['it']").length,
      1,
      'la sola derivazione nuda da un titolo di `data.content` deve stare nel ramo IT-only',
    );
  });

  test('`null` e `undefined` sono gia’ segmenti riservati del classificatore condiviso', () => {
    // Non e' una lista nuova: e' `NON_SLUG_REMAINDER_RX`, misurata su 15.172
    // slug pubblicati. Qui si pinna solo che le due grafie ci siano ancora.
    const rx = CREATE_ARTICLE.match(/const NON_SLUG_REMAINDER_RX\s*=\s*\n?\s*(\/[^\n]+\/i);/);
    assert.ok(rx, 'NON_SLUG_REMAINDER_RX non trovata');
    // eslint-disable-next-line no-eval
    const re = eval(rx[1]);
    for (const parola of ['null', 'Null', 'NULL', 'undefined']) {
      assert.equal(re.test(parola.toLowerCase()), true, parola);
    }
  });
});

// ── #869 — l’evidenza di corpo non letto ───────────────────────────────────

const abortConforme = (extra = {}) => ({
  abort_topical_relevance: true,
  reason: 'la fonte non riguarda i frontalieri',
  ...extra,
});

describe('findUnreadableContentEvidence', () => {
  test('#869 item 1 — con primaryLocale != it il carve-out per-campo si applica lo stesso', () => {
    // Un rifiuto INTITOLATO in tedesco, su una generazione DE-primaria: il
    // `title` e' un campo META, un rifiuto puo' intitolarsi. Senza il locale,
    // `content.de` veniva percorso intero e il titolo del rifiuto diventava
    // evidenza → `reject`, cinque rigenerazioni contro un modello obbediente.
    const payload = abortConforme({
      content: { de: { title: 'Ablehnung: Quelle nicht relevant', excerpt: null, body1: null, body2: null, body3: null } },
    });
    assert.equal(findUnreadableContentEvidence(payload, 'de'), null);
    assert.equal(isTopicGateAbortVerdict(payload, { locale: 'de' }), true);
  });

  test('#869 item 3 — un secondo locale nel payload non trasforma un abort in reject', () => {
    // Lo schema rende `required` il solo locale primario ma non VIETA al
    // modello di emetterne un secondo.
    const payload = abortConforme({
      content: {
        it: { title: null, excerpt: null, body1: null, body2: null, body3: null },
        en: { title: 'Refusal: source not relevant', excerpt: 'Not about cross-border workers.' },
      },
    });
    assert.equal(findUnreadableContentEvidence(payload, 'it'), null);
    assert.equal(isTopicGateAbortVerdict(payload, { locale: 'it' }), true);
  });

  test('#869 item 2 — l’eco corta del rifiuto dentro content.* non e’ evidenza', () => {
    for (const eco of [
      { body: 'Nessun contenuto: la fonte non e’ pertinente ai frontalieri.' },
      { note: 'fuori tema' },
      { testo: 'La fonte parla di sport, non di lavoro frontaliero.' },
    ]) {
      const payload = abortConforme({ content: { it: { title: null, body1: null, ...eco } } });
      assert.equal(
        findUnreadableContentEvidence(payload, 'it'),
        null,
        `l’eco ${JSON.stringify(eco)} non e’ un articolo`,
      );
      assert.equal(isTopicGateAbortVerdict(payload, { locale: 'it' }), true);
    }
  });

  test('un corpo VERO su una chiave non dichiarata resta evidenza: la soglia non spegne il predicato', () => {
    const corpo = 'Il frontaliere che lavora in Ticino '.repeat(12); // > 200 char
    const payload = abortConforme({ content: { it: { title: null, body: corpo } } });
    assert.equal(findUnreadableContentEvidence(payload, 'it'), 'content.it.body');
    assert.equal(isTopicGateAbortVerdict(payload, { locale: 'it' }), false, 'rigetto RIGENERABILE, non abort terminale');
  });

  test('un corpo emesso come array di frasi corte conta per SOMMA, non per elemento', () => {
    // Nessun elemento arriva da solo alla soglia; insieme sono un articolo.
    const frasi = Array.from({ length: 20 }, (_, i) => `Frase numero ${i} del corpo generato.`);
    const payload = abortConforme({ content: { it: { title: null, body1: frasi } } });
    assert.equal(findUnreadableContentEvidence(payload, 'it'), 'content.it.body1');
  });

  test('#869 item 4 — il confine di profondita’, esercitato nei due versi', () => {
    const corpo = 'Testo del paragrafo generato dal modello. '.repeat(8); // > 200 char
    // Annida `corpo` a `n` livelli sotto il candidato `content.it`.
    const annida = (n) => (n === 0 ? corpo : { livello: annida(n - 1) });

    // Il caso che la PR #847 esisteva per togliere e che `depth >= 4` lasciava
    // TERMINALE: content.it.article.sections[0].paragraphs[0].text — cinque
    // livelli sotto il candidato.
    const reale = abortConforme({
      content: { it: { title: null, article: { sections: [{ paragraphs: [{ text: corpo }] }] } } },
    });
    assert.equal(findUnreadableContentEvidence(reale, 'it'), 'content.it.article');

    // Il boundary esatto: dentro il limite si vede, oltre no. E' una scelta
    // dichiarata (SUBSTANCE_MAX_DEPTH = 8), non un caso: se qualcuno muove la
    // costante, questi due assert cambiano insieme e lo dicono.
    assert.equal(
      findUnreadableContentEvidence(abortConforme({ content: { it: { title: null, x: annida(7) } } }), 'it'),
      'content.it.x',
      'sette livelli sono DENTRO il confine',
    );
    assert.equal(
      findUnreadableContentEvidence(abortConforme({ content: { it: { title: null, x: annida(9) } } }), 'it'),
      null,
      'nove livelli sono OLTRE il confine: resta abort terminale, per scelta',
    );
  });

  test('un abort puro resta un abort, byte per byte', () => {
    const puro = abortConforme({ content: { it: { title: null, excerpt: null, body1: null, body2: null, body3: null } } });
    assert.equal(findUnreadableContentEvidence(puro, 'it'), null);
    assert.equal(isTopicGateAbortVerdict(puro, { locale: 'it' }), true);
  });
});

// ── il cablaggio in create-article.mjs ─────────────────────────────────────

describe('cablaggio: il gate di valle non e’ piu’ cieco al locale', () => {
  test('tutti e quattro i lettori di payload del gate REGOLA #0 ricevono primaryLocale', () => {
    // Sono la stessa domanda fatta quattro volte; il default `'it'` le rendeva
    // cieche insieme. Il test e' sul testo perche' il ramo e' latente
    // (primaryLocale vale 'it' in produzione) e nessuna run lo eserciterebbe.
    for (const chiamata of [
      'isTopicGateAbortVerdict(itData, { locale: primaryLocale })',
      'normalizeItalianContentFromPayload(itData, primaryLocale)',
      'findUnreadableContentEvidence(itData, primaryLocale)',
    ]) {
      assert.ok(CREATE_ARTICLE.includes(chiamata), `manca: ${chiamata}`);
    }
    // Le forme di CODICE del default cieco (non le menzioni in prosa, che nei
    // commenti di questo file sono legittime e raccontano la storia).
    for (const cieco of [
      '? findUnreadableContentEvidence(itData)',
      '|| normalizeItalianContentFromPayload(itData)',
      '= isTopicGateAbortVerdict(itData)',
    ]) {
      assert.equal(CREATE_ARTICLE.includes(cieco), false, `torna al default cieco: ${cieco}`);
    }
  });
});

// ── la discriminante di provenienza, pinnata dove vive ─────────────────────

describe('quale predicato, dove', () => {
  const leggi = (p) => readFileSync(path.join(__dirname, '..', 'scripts', 'lib', p), 'utf-8');

  test('events-utils e la cascata free-MT usano il predicato SEVERO', () => {
    const events = leggi('events-utils.mjs');
    assert.equal(/hasUsableTranslatedText\s*\(/.test(events), false, 'events-utils non giudica prosa di un modello');
    assert.ok(/hasUsableContentText\s*\(/.test(events));

    const freeMt = leggi('article-free-mt.mjs');
    assert.ok(
      /if \(!hasUsableContentText\(out\)\) return '';/.test(freeMt),
      'l’uscita del motore MT deve passare dal predicato severo',
    );
  });

  test('la prosa di un modello resta sul predicato per-locale', () => {
    // `translatedStringOrNull` legge il JSON che il modello ha scritto nella
    // lingua target: li' `Null` puo' essere «zero» e la deroga #831 vale.
    const freeMt = leggi('article-free-mt.mjs');
    assert.ok(/return hasUsableTranslatedText\(value, targetLang\) \? value : null;/.test(freeMt));
    assert.equal(hasUsableContentText('Null'), false, 'il predicato severo scarta ogni grafia');
    assert.equal(hasUsableTranslatedText('Null', 'de'), true, 'quello per-locale no, su de');
  });
});
