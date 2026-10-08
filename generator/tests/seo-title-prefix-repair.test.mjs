/**
 * The SEO title-field gate and its source-level contract.
 *
 * `content.it.title` is the canonical H1. The three stored fields derived from
 * it — `title`, `ogTitle`, the JSON-LD `headline` — may differ from it, but
 * must never be a BROKEN derivative: a tail that stops on a function word, a
 * prefix cut inside a clause or a word. `ogTitle` is not only the social card:
 * the engine prints it as the link text of «articoli correlati» on every other
 * article page, so a cut title is a visible defect far from its own page.
 *
 * ## What this file had missed (issue #2281, measured 2026-10-08)
 *
 * The first version read `content/seo/` against `content/blog-meta-it.ts`
 * only: one section out of 26. The 2.637 `svizzera` entries and the cantons
 * were never judged, and 38 `ogTitle` there were cut mid-clause or mid-word
 * («…in Svizze», «…Vaud e Neuchâte»). It also knew one shape only, the strict
 * prefix, so 124 fields of `frontaliere` that stop on a function word WITHOUT
 * being a prefix of the real title passed («Massima Allerta a Chiasso-Brogeda:
 * Cosa Significa per i»). In all, 193 broken fields on 6.931 entries: 117
 * `ogTitle`, 46 `headline`, 30 `title`.
 *
 * The scan now comes from the repair script (`scanSeoTitleFields`), which
 * walks every active section of `scripts/lib/article-surfaces.mjs`: the gate
 * and the backfill cannot read two different corpora.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECTIONS } from '../../scripts/lib/article-surfaces.mjs';
import {
  SEO_COMPLETE_SENTENCE_RE,
  SEO_TITLE_FIELDS,
  hasExemptProperNounTail,
  isClauseBoundarySeoTitlePrefix,
  isDanglingSeoTitle,
  repairSeoTitleFields,
  repairSeoTitleValue,
  seoTitleFieldDefect,
  seoTitleFromCanonical,
} from '../scripts/lib/seo-title-repair.mjs';
import {
  fieldMatch,
  planSeoTitleRepairs,
  repairFile,
  scanSeoTitleFields,
} from '../scripts/repair-truncated-seo-titles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('coda monca — il valore si ferma su una parola funzionale o su un separatore', () => {
  test('ogTitle che non è un prefisso del titolo vero: torna il titolo vero', () => {
    const canonical = 'Controlli Rafforzati a Chiasso-Brogeda: La Sicurezza al Confine Ticinese';
    const stored = 'Massima Allerta a Chiasso-Brogeda: Cosa Significa per i';
    assert.equal(seoTitleFieldDefect('ogTitle', stored, canonical), 'dangling');
    assert.equal(repairSeoTitleValue('ogTitle', stored, canonical), canonical);
  });

  test('ogTitle con la sola barra del marchio rimasta: resta il testo del modello', () => {
    const canonical = "Nuove chiusure sull'autostrada A9 Lainate-Como-Chiasso: cosa cambia per i frontalieri";
    assert.equal(
      repairSeoTitleValue('ogTitle', 'Chiusure autostrada A9: cosa cambia per i frontalieri |', canonical),
      'Chiusure autostrada A9: cosa cambia per i frontalieri',
    );
  });

  test('togliere la barra non toglie il punto di domanda', () => {
    assert.equal(
      repairSeoTitleValue(
        'ogTitle',
        'Crans-Montana: chi paga le cure per gli italiani? |',
        'Crans-Montana: chi paga le cure per gli italiani?',
      ),
      'Crans-Montana: chi paga le cure per gli italiani?',
    );
  });

  test('barra tolta ma coda ancora monca: torna il titolo vero', () => {
    const canonical = 'Capre alla dogana di Gandria: rischio incidente e intervento delle autorità';
    assert.equal(repairSeoTitleValue('ogTitle', 'Capre alla dogana di Gandria: rischio per |', canonical), canonical);
  });

  test('title con la coda nascosta dal marchio', () => {
    const stored = 'Malpensa senza carburante: cosa | Frontaliere Ticino';
    const canonical = 'Malpensa senza carburante: cosa rischiano i frontalieri ticinesi';
    assert.equal(isDanglingSeoTitle(stored), true);
    assert.equal(seoTitleFieldDefect('title', stored, canonical), 'dangling');
    // 64 caratteri: con il marchio supererebbe i 66, quindi esce senza.
    assert.equal(repairSeoTitleValue('title', stored, canonical), canonical);
  });

  test('title riparato tiene il marchio quando il totale resta entro 66 caratteri', () => {
    assert.equal(
      repairSeoTitleValue(
        'title',
        'Ora legale permanente in Ticino: cosa | Frontaliere Ticino',
        'Ora legale permanente in Ticino: cosa cambia',
      ),
      'Ora legale permanente in Ticino: cosa cambia | Frontaliere Ticino',
    );
    assert.equal(seoTitleFromCanonical('Ora legale permanente in Ticino: cosa cambia').length, 65);
  });

  test('headline con il JSON-LD annidato e troncato dal modello', () => {
    const stored = '{"@context":"https://schema.org","@type":"NewsArticle","headline":"Varese riceve 35.000 euro per';
    const canonical = 'Varese riceve 35.000 euro per valorizzare le sue bellezze';
    assert.equal(seoTitleFieldDefect('headline', stored, canonical), 'dangling');
    assert.equal(repairSeoTitleValue('headline', stored, canonical), canonical);
  });

  test('una maiuscola a inizio frase non è un nome proprio', () => {
    for (const stored of [
      'Salario Minimo Sociale in Ticino: Accordo vicino? Le',
      'Mercato immobiliare Ticino: -33% di alloggi in 5 anni. Cosa',
      'Salario Minimo Sociale in Ticino: Cosa',
      'ATTENZIONE FRONTALIERI: COSA CAMBIA PER I',
    ]) {
      assert.equal(isDanglingSeoTitle(stored), true, stored);
      assert.equal(hasExemptProperNounTail(stored), false, stored);
    }
  });

  test('una lettera sola dopo una preposizione è un taglio, non un\'etichetta', () => {
    for (const stored of [
      'attività formative nelle scuole primarie e secondarie di I',
      'Conoscenza della lingua italiana e laurea in I',
    ]) {
      assert.equal(isDanglingSeoTitle(stored), true, stored);
    }
  });
});

describe('nomi propri e sigle — la lista condivisa confronta in minuscolo', () => {
  // Valori pubblicati e integri: chiuderli come «monchi» obbligherebbe a
  // riscrivere un titolo giusto. Sono contati dal gate più sotto.
  const whole = [
    'Public Eye denuncia salari da fame in azienda del marchio On',
    'Peggiorano le prospettive finanziarie di AVS e AI',
    'Spital Grabs: radiologia e oncologia nel nuovo Haus O',
    'Uboldo: estate 2026 con tributo a Lucio Dalla',
    'Busta Paga Svizzera 2026: AVS, LPP, LAINF e AD',
    "1° Maggio a Varese: lavoro e diritti nell'era AI | Frontaliere Ticino",
  ];

  for (const stored of whole) {
    test(`«${stored}» non è monco`, () => {
      assert.equal(isDanglingSeoTitle(stored), false);
      assert.equal(hasExemptProperNounTail(stored), true);
      assert.equal(repairSeoTitleValue('ogTitle', stored, 'Un titolo vero del tutto diverso'), stored);
    });
  }
});

describe('prefisso del titolo vero — intenzionale solo su un confine di clausola', () => {
  test('taglio dentro una parola', () => {
    const canonical = 'Come Calcolare il Salario Netto per Frontaliere in Svizzera';
    const stored = 'Come Calcolare il Salario Netto per Frontaliere in Svizze';
    assert.equal(seoTitleFieldDefect('ogTitle', stored, canonical), 'mid-clause-prefix');
    assert.equal(repairSeoTitleValue('ogTitle', stored, canonical), canonical);
  });

  test('taglio dentro una clausola', () => {
    const canonical = 'Tassa salute frontalieri: sindacati italiani e svizzeri attaccano la norma';
    const stored = 'Tassa salute frontalieri: sindacati italiani e svizzeri attaccano';
    assert.equal(seoTitleFieldDefect('ogTitle', stored, canonical), 'mid-clause-prefix');
    assert.equal(repairSeoTitleValue('ogTitle', stored, canonical), canonical);
  });

  test('variante breve che si ferma dove il titolo vero apre una clausola: resta', () => {
    const canonical = 'Assegni familiari nel Cantone di Svitto: importi mensili e condizioni di diritto';
    const stored = 'Assegni familiari nel Cantone di Svitto';
    assert.equal(isClauseBoundarySeoTitlePrefix(stored, canonical), true);
    assert.equal(seoTitleFieldDefect('ogTitle', stored, canonical), null);
    assert.equal(repairSeoTitleValue('ogTitle', stored, canonical), stored);
  });

  // Le riparazioni della prima bonifica (PR 2287) hanno scritto il taglio
  // clause-safe a 60 caratteri. Restano valide: riscriverle sarebbe solo
  // rumore su pagine già lette dal vivo.
  const storedByEarlierRepair = [
    [
      'Confine tesissimo: stop agli assegni familiari',
      'Confine tesissimo: stop agli assegni familiari ai frontalieri',
    ],
    [
      'Il paradosso del Ticino: 600 candidature per 3 posti',
      'Il paradosso del Ticino: 600 candidature per 3 posti di lavoro',
    ],
    [
      'Chiasso: il Tribunale Federale impone la riscrittura',
      'Chiasso: il Tribunale Federale impone la riscrittura del Piano Regolatore per la telefonia',
    ],
  ];

  for (const [stored, canonical] of storedByEarlierRepair) {
    test(`il taglio già pubblicato «${stored}» resta valido`, () => {
      assert.equal(seoTitleFieldDefect('ogTitle', stored, canonical), null);
      assert.equal(repairSeoTitleValue('ogTitle', stored, canonical), stored);
    });
  }

  // I casi della issue #2281. La prima versione li riparava con un nuovo
  // taglio a 60 caratteri; misurato sul corpus, quel taglio lascia code che la
  // lista non vede («…per la guerra, ma», «…di dimora: nuove», «…quali spese
  // si»). `og:title` non ha un limite di pubblicazione: la riparazione è il
  // titolo vero.
  const casesFromTheIssue = [
    [
      'Risparmio Casa arriva al Centro Breggia di Balerna: cosa',
      'Risparmio Casa arriva al Centro Breggia di Balerna: cosa cambia per i frontalieri',
    ],
    [
      'Confine tesissimo: stop agli assegni familiari ai',
      'Confine tesissimo: stop agli assegni familiari ai frontalieri',
    ],
    [
      'Il paradosso del Ticino: 600 candidature per 3 posti di',
      'Il paradosso del Ticino: 600 candidature per 3 posti di lavoro',
    ],
    [
      'Chiasso: il Tribunale Federale impone la riscrittura del',
      'Chiasso: il Tribunale Federale impone la riscrittura del Piano Regolatore per la telefonia',
    ],
  ];

  for (const [stored, canonical] of casesFromTheIssue) {
    test(`ripara «${stored}» con il titolo vero`, () => {
      assert.equal(repairSeoTitleValue('ogTitle', stored, canonical), canonical);
      assert.equal(repairSeoTitleValue('headline', stored, canonical), canonical);
    });
  }

  test('non indovina un valore che non deriva dal titolo', () => {
    const stored = 'Titolo editoriale diverso';
    const canonical = 'Risparmio Casa arriva al Centro Breggia di Balerna';
    for (const field of SEO_TITLE_FIELDS) {
      assert.equal(seoTitleFieldDefect(field, stored, canonical), null);
      assert.equal(repairSeoTitleValue(field, stored, canonical), stored);
    }
  });

  test('il title SEO è giudicato solo sulla coda, non sulla forma di prefisso', () => {
    // Per scelta: molti `title` storici sono varianti brevi del titolo vero, e
    // la pagina italiana non li pubblica più (sito, PR 12239).
    assert.equal(
      seoTitleFieldDefect(
        'title',
        'Parmelin firma accordo con Bahrein per proteggere',
        'Parmelin firma accordo con Bahrein per proteggere gli investimenti',
      ),
      null,
    );
  });
});

describe('un titolo vero rotto non viene copiato in giro', () => {
  test('titolo vero monco: il difetto resta segnalato, il campo resta com\'è', () => {
    const canonical = 'Gamberetti avariati al torneo di Madrid: intossicazioni e';
    const stored = 'Gamberetti avariati al torneo di Madrid: intossicazioni e';
    assert.equal(seoTitleFieldDefect('ogTitle', stored, canonical), 'dangling');
    assert.equal(repairSeoTitleValue('ogTitle', stored, canonical), stored);
  });

  test('titolo vero assente: nessuna riparazione', () => {
    const stored = 'Di più Cassis a Düdingen:';
    assert.equal(seoTitleFieldDefect('ogTitle', stored, ''), 'dangling');
    assert.equal(repairSeoTitleValue('ogTitle', stored, ''), stored);
  });
});

describe('repairSeoTitleFields — il punto d\'ingresso del generatore', () => {
  test('ripara i due campi scritti dal modello e lascia il title', () => {
    const canonical = 'Roche investe miliardi sui farmaci anti-obesità: cosa cambia per i frontalieri';
    const seo = {
      title: 'Roche investe miliardi sui farmaci anti-obesità: cosa',
      ogTitle: 'Roche investe su farmaci anti-obesità: cosa cambia per i',
      headline: 'Roche investe miliardi sui farmaci anti-obesità: cosa cambia per i',
    };
    const changes = repairSeoTitleFields(seo, canonical);
    assert.deepEqual(changes.map((change) => change.field), ['ogTitle', 'headline']);
    assert.equal(seo.ogTitle, canonical);
    assert.equal(seo.headline, canonical);
    assert.equal(seo.title, 'Roche investe miliardi sui farmaci anti-obesità: cosa');
  });

  test('un ogTitle integro scritto dal modello non viene toccato', () => {
    const canonical = 'Roche investe miliardi sui farmaci anti-obesità: cosa cambia';
    const seo = { ogTitle: 'Roche punta sui farmaci anti-obesità', headline: canonical };
    assert.deepEqual(repairSeoTitleFields(seo, canonical), []);
    assert.equal(seo.ogTitle, 'Roche punta sui farmaci anti-obesità');
  });
});

test('la guardia «già completo» è la stessa di repairSerpSnippet', () => {
  // clauseTail.mjs non la esporta: il legame è per testo. Se il gemello del
  // sito cambia la guardia, questo caso cade e nomina i due file da allineare.
  const source = fs.readFileSync(path.join(ROOT, 'host', 'shared', 'clauseTail.mjs'), 'utf8');
  const literal = /if \(\/(.+?)\/u\.test\(normalized\)\) return normalized;/.exec(source);
  assert.ok(literal, 'guardia di repairSerpSnippet non trovata in host/shared/clauseTail.mjs');
  const decode = (text) => text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  assert.equal(
    decode(SEO_COMPLETE_SENTENCE_RE.source),
    decode(literal[1]),
    'SEO_COMPLETE_SENTENCE_RE (generator/scripts/lib/seo-title-repair.mjs) non coincide con la guardia di clauseTail.mjs',
  );
});

test('il generatore usa la stessa sorgente di riparazione per entrambi i campi', () => {
  const source = fs.readFileSync(path.join(ROOT, 'generator', 'scripts', 'create-article.mjs'), 'utf8');
  assert.match(source, /import \{ repairSeoTitleFields \} from '\.\/lib\/seo-title-repair\.mjs';/);
  assert.match(source, /repairSeoTitleFields\(data\.seo, seoTitleCore\)/);
  assert.match(source, /data\.seo\.ogTitle = data\.seo\.ogTitle \? String\(data\.seo\.ogTitle\)\.trim\(\) : seoTitleCore/);
  assert.match(source, /data\.seo\.headline = data\.seo\.headline \? String\(data\.seo\.headline\)\.trim\(\) : seoTitleCore/);
});

test('gli offset del valore non possono collidere con il nome della proprieta\'', () => {
  const source = `const seo = { title: 'title', ogTitle: 'ogTitle', jsonLd: { "headline": "headline" } };`;
  const title = fieldMatch(source, 'title');
  const ogTitle = fieldMatch(source, 'ogTitle');
  const headline = fieldMatch(source, 'headline');
  assert.equal(source.slice(title.start, title.end), 'title');
  assert.equal(source.slice(ogTitle.start, ogTitle.end), 'ogTitle');
  assert.equal(source.slice(headline.start, headline.end), 'headline');
  assert.equal(
    repairFile(source, [
      { ...title, encoded: 'riparato title' },
      { ...ogTitle, encoded: 'riparato og' },
      { ...headline, encoded: 'riparato jsonld' },
    ]),
    `const seo = { title: 'riparato title', ogTitle: 'riparato og', jsonLd: { "headline": "riparato jsonld" } };`,
  );
});

test('il campo title non viene cercato dentro ogTitle', () => {
  const block = `{ ogTitle: 'solo il social', description: 'x' }`;
  assert.equal(fieldMatch(block, 'title'), null);
  assert.throws(() => fieldMatch(block, 'breadcrumbName'), /campo titolo SEO sconosciuto/);
});

describe('corpus — nessun campo titolo SEO è un derivato rotto del titolo vero', () => {
  const scan = scanSeoTitleFields();
  const sections = Object.keys(SECTIONS);

  test('lo scan non è vacuo e copre ogni sezione attiva', () => {
    assert.deepEqual(scan.sections, sections);
    assert.ok(sections.includes('svizzera') && sections.some((name) => name.startsWith('canton-')),
      `sezioni lette: ${sections.join(', ')}`);
    assert.ok(scan.files.length >= 8, `file SEO letti: ${scan.files.length}`);
    assert.ok(scan.entries > 6000, `voci SEO lette: ${scan.entries} (6.931 al 2026-10-08)`);
    assert.ok(scan.titles > 6000, `titoli IT letti: ${scan.titles}`);
    // Tre campi per voce; qualche voce storica non ha ogTitle o headline.
    assert.ok(scan.rows.length > scan.entries * 2.9, `campi titolo letti: ${scan.rows.length} su ${scan.entries} voci`);
    for (const field of SEO_TITLE_FIELDS) {
      const seen = scan.rows.filter((row) => row.field === field).length;
      assert.ok(seen > scan.entries * 0.95, `campo ${field} letto in ${seen} voci su ${scan.entries}`);
    }
    for (const section of ['frontaliere', 'svizzera']) {
      assert.ok(scan.rows.some((row) => row.section === section), `nessun campo letto per la sezione ${section}`);
    }
  });

  test('ogni voce ha il suo titolo vero nella propria sezione', () => {
    // Senza titolo vero la forma di prefisso non è giudicabile: una sezione
    // letta contro il meta sbagliato passerebbe questo gate a vuoto.
    const orphans = [...new Set(scan.rows.filter((row) => !row.canonical).map((row) => `${row.file}: ${row.id}`))];
    assert.deepEqual(orphans, [], `voci SEO senza titolo italiano:\n${orphans.slice(0, 20).join('\n')}`);
  });

  test('nessun title, ogTitle o headline è monco o tagliato a metà clausola', () => {
    const offenders = scan.rows
      .filter((row) => row.defect)
      .map((row) => `${row.file}: ${row.id}.${row.field} (${row.defect}) = ${JSON.stringify(row.value)}`);
    assert.deepEqual(
      offenders,
      [],
      'campi titolo SEO rotti. Riparazione: node generator/scripts/repair-truncated-seo-titles.mjs --apply '
        + `(se resta «non riparabile» va corretto a mano il titolo in blog-meta-…-it.ts):\n${offenders.slice(0, 20).join('\n')}`,
    );
  });

  test('la bonifica non ha niente da fare e niente che non sa fare', () => {
    const { plans, unrepairable } = planSeoTitleRepairs();
    assert.equal(plans.length, 0, `sostituzioni pendenti: ${plans.length}`);
    assert.equal(unrepairable.length, 0, `campi non riparabili: ${unrepairable.length}`);
  });

  // L'esenzione per nome proprio o sigla è un giudizio sulla FORMA dell'ultima
  // parola. Il suo limite dichiarato: in un titolo scritto con ogni parola in
  // maiuscola («Cosa Cambia Per I») scambierebbe una preposizione per un nome.
  // Il generatore scrive i titoli italiani in minuscolo di frase, quindi oggi
  // le esenzioni sono poche e tutte lette: 14 il 2026-10-08. Il tetto lascia
  // spazio ai titoli che finiscono davvero su un nome e cade se la classe
  // cresce, cioè se uno scrittore ha cambiato maiuscole.
  const EXEMPT_TAILS_MAX = 40;

  test(`le esenzioni per nome proprio restano poche (${EXEMPT_TAILS_MAX} al massimo)`, () => {
    const exempt = scan.rows
      .filter((row) => hasExemptProperNounTail(row.value))
      .map((row) => `${row.id}.${row.field} = ${JSON.stringify(row.value)}`);
    assert.ok(exempt.length > 0, 'nessuna esenzione: «…AVS e AI» è stato ritirato o il predicato non la riconosce più');
    assert.ok(
      exempt.length <= EXEMPT_TAILS_MAX,
      `${exempt.length} campi titolo passano solo come nome proprio o sigla:\n${exempt.join('\n')}`,
    );
  });
});
