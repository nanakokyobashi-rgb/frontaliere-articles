/**
 * Il classificatore deterministico del campo `canton` (D13 sezioni cantonali)
 * e il suo backfill.
 *
 * Diventa rosso quando:
 *   - un omonimo torna a contare («Berna» governo federale, «Zug» treno,
 *     «giura» verbo, «Basilea III», «Friburgo in Brisgovia», un comune di piu'
 *     cantoni, la residenza di una persona, una squadra, una persona);
 *   - un gruppo URL di canton-url-slugs.json non e' riconosciuto per nome;
 *   - il corpo da solo, o la cornice «frontalieri che lavorano in Ticino»,
 *     assegnano un cantone;
 *   - il dato `canton-classifier-places.json` diverge dallo snapshot BFS;
 *   - una testata ticinese supplementare non e' piu' fra le NEWS_SOURCES;
 *   - la riga `canton:` del registry non si scrive/rilegge in modo idempotente,
 *     o `canton` entra nell'API pubblica;
 *   - `create-article.mjs` smette di popolare `canton` prima del lock.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FRONTALIERE_TICINO_SOURCE_HOSTS,
  buildSourceDomainMap,
  cantonInputFromArticle,
  classifyCantons,
  defaultCantonClassifier,
  isInCantonArea,
  registrableHost,
  registryCantonsForArticle,
} from '../scripts/lib/canton-classifier.mjs';
import {
  applyRegistryCantons,
  readRegistryCantons,
  renderCantonLine,
  setEntryCanton,
} from '../scripts/lib/registry-canton-field.mjs';
import { renderRegistryEntry } from '../scripts/lib/registry-article-type.mjs';
import { toPublicRegistryEntry } from '../../scripts/lib/registry-api-entry.mjs';
import {
  classifyCorpus,
  invertSourceLedger,
  readTsStringMap,
  renderReport,
  writeRegistries,
} from '../scripts/backfill-article-cantons.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const codes = (input) => classifyCantons(input).map((c) => c.canton);

describe('nomi dei 24 gruppi URL', () => {
  const slugs = readJson('generator/data/canton-url-slugs.json');
  for (const [code, entry] of Object.entries(slugs.cantons)) {
    test(`«Cantone ${entry.it}» nel titolo -> ${code}`, () => {
      const name = entry.it.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const got = codes({
        title: `Permesso B nel Cantone di ${name}: requisiti e rinnovo`,
        excerpt: `Come ottenere il permesso B nel Cantone di ${name}.`,
        body: `Nel Cantone di ${name} la domanda va presentata all'ufficio della migrazione. Il Cantone di ${name} risponde entro 30 giorni.`,
      });
      assert.deepEqual(got, [code]);
    });
  }

  test('i codici membro dei semicantoni si raggruppano', () => {
    assert.equal(isInCantonArea('BL', 'Un incendio a Liestal nella notte.'), true);
    assert.equal(isInCantonArea('AI', 'La Landsgemeinde di Appenzello Interno.'), true);
    assert.equal(isInCantonArea('BASILEA', 'Un incendio a Liestal nella notte.'), true);
  });
});

describe('omonimi e falsi amici', () => {
  test('«Berna» da sola e\' il governo federale', () => {
    assert.deepEqual(codes({
      title: 'Berna non vuole creare attriti con l\'Italia',
      excerpt: 'Berna ribadisce la sua posizione sugli accordi fiscali.',
      body: 'Berna ha risposto a Roma. Secondo Berna i ristorni restano dovuti.',
    }), []);
  });

  test('«Canton Berna» e «citta\' di Berna» contano', () => {
    assert.deepEqual(codes({
      title: 'Premi cassa malati Cantone Berna e riduzione premi',
      excerpt: 'Le riduzioni dei premi nel Cantone di Berna per il 2026.',
      body: 'Nel Cantone di Berna i premi salgono. La citta\' di Berna offre sportelli.',
    }), ['BE']);
  });

  test('un nome guardato nel titolo conta se l\'excerpt conferma il cantone', () => {
    assert.deepEqual(codes({
      title: 'Asilo nido Berna: tariffe e sussidi',
      excerpt: 'Le tariffe degli asili nido nel Cantone di Berna.',
      body: 'Nel Cantone di Berna i sussidi dipendono dal reddito.',
    }), ['BE']);
    assert.deepEqual(codes({
      title: 'La BNS promuove Berna sul too big to fail',
      excerpt: 'Le misure del Consiglio federale accolte dalla Banca nazionale.',
      body: `${'Testo sulle banche. '.repeat(100)}La citta' di Berna potrebbe contribuire.`,
    }), []);
  });

  test('«Zug» tedesco e «giura» verbo non sono cantoni', () => {
    assert.equal(isInCantonArea('ZG', 'Der Zug nach Lugano hat Verspätung.'), false);
    assert.equal(isInCantonArea('ZG', 'Im Kanton Zug sinken die Steuern.'), true);
    assert.equal(isInCantonArea('JU', 'Giura di non aver visto nulla, dice il testimone.'), false);
    assert.equal(isInCantonArea('JU', 'Il governo del Canton Giura approva il budget.'), true);
    assert.equal(isInCantonArea('JU', 'Il massiccio del Giura francese.'), false);
  });

  test('frasi che nominano un luogo senza parlarne', () => {
    assert.equal(isInCantonArea('BASILEA', 'Le regole di Basilea III per le banche.'), false);
    assert.equal(isInCantonArea('BASILEA', 'Il Comitato di Basilea pubblica nuove norme.'), false);
    assert.equal(isInCantonArea('GE', 'Il rispetto della Convenzione di Ginevra.'), false);
    assert.equal(isInCantonArea('FR', 'Lavora a Friburgo in Brisgovia da anni.'), false);
    assert.equal(isInCantonArea('AG', 'Pendolari dal Baden-Württemberg.'), false);
    assert.equal(isInCantonArea('TI', 'Il Parco del Ticino in Lombardia.'), false);
    assert.equal(isInCantonArea('TI', 'Boffalora sopra Ticino festeggia.'), false);
    assert.equal(isInCantonArea('TI', 'Fiume Ticino in secca a Sesto Calende.'), false);
    assert.equal(isInCantonArea('TI', 'Gli argini del Ticino cedono a Pavia.'), false);
    assert.equal(isInCantonArea('BE', 'Un bovaro bernese in canile.'), false);
    assert.equal(isInCantonArea('ZH', 'Uno studio dell\'ETH di Zurigo sul Bedretto.'), false);
    assert.equal(isInCantonArea('GR', 'Il WEF di Davos apre con Trump. A Davos neve.'), false);
    assert.equal(isInCantonArea('GR', 'Nuova pista da sci a Davos.'), true);
  });

  test('un comune di piu\' cantoni non dice quale', () => {
    // Buchs esiste in AG, SG e ZH.
    const c = defaultCantonClassifier();
    assert.deepEqual(c.mentionsIn('Un incendio a Buchs nella notte.'), []);
  });

  test('i comuni minori contano solo in forma locativa o come dateline', () => {
    assert.equal(isInCantonArea('TI', 'Tamponamento sull\'A2 a Coldrerio.'), true);
    assert.equal(isInCantonArea('TI', 'Gordola: revocato l\'avviso di scomparsa.'), true);
    // «Sessa Aurunca»: il nome e' seguito da un'altra parola maiuscola.
    assert.equal(isInCantonArea('TI', 'Un incidente a Sessa Aurunca.'), false);
    // Omonimi esterni con complemento: non il comune ticinese.
    assert.equal(isInCantonArea('TI', 'Un incidente a Sant\'Antonino di Susa.'), false);
    assert.equal(isInCantonArea('TI', 'Festa a Castel San Pietro Terme.'), false);
    assert.equal(isInCantonArea('TI', 'Un cantiere a Sant\'Antonino, vicino a Bellinzona.'), true);
  });

  test('la residenza di una persona non e\' il luogo della notizia', () => {
    assert.deepEqual(codes({
      title: 'Tamponamento sull\'A2 a Coldrerio: 73enne grave',
      excerpt: 'Auto contro camion fermo sull\'A2 a Coldrerio: passeggero 73enne in pericolo di vita.',
      body: 'Nel pomeriggio, sull\'autostrada in territorio di Coldrerio, un\'auto ha tamponato un camion. '
        + 'Alla guida c\'era una 68enne svizzera residente nel canton Zurigo. '
        + 'Il passeggero, anch\'egli residente nel canton Zurigo, e\' grave. '
        + 'Una donna domiciliata nel canton Zurigo. Un uomo originario del canton Zurigo.',
    }), ['TI']);
  });

  test('squadre, persone e parentesi', () => {
    const c = defaultCantonClassifier();
    assert.deepEqual(c.mentionsIn('Il Lugano batte il San Gallo 2-1.').map((m) => m.group), []);
    assert.deepEqual(c.mentionsIn('Filippo, un ticinese alla guida del festival.').map((m) => m.group), []);
    assert.deepEqual(
      [...new Set(c.mentionsIn('Pfäffikon (Kanton Schwyz): tre arresti.').map((m) => m.group))],
      ['SZ'],
    );
    assert.equal(isInCantonArea('UR', 'Uri Geller arriva a Milano.'), false);
  });
});

describe('regole di assegnazione', () => {
  test('il titolo decide: il confronto nel corpo non aggiunge cantoni', () => {
    assert.deepEqual(codes({
      title: 'Permesso B nel Canton Uri: requisiti e rinnovo',
      excerpt: 'Il permesso B ad Altdorf e nel Canton Uri.',
      body: 'A differenza del Ticino, in Ticino e a Lugano e Bellinzona i tempi sono diversi. '
        + 'Nel Canton Uri si va ad Altdorf.',
    }), ['UR']);
  });

  test('il corpo da solo non assegna, neppure con molte menzioni', () => {
    assert.deepEqual(codes({
      title: 'Trump valuta riduzione truppe in Europa',
      excerpt: 'Il Pentagono studia il ritiro di parte dei contingenti.',
      body: 'Cosa cambia per il Ticino? Lugano, Bellinzona, Chiasso e Mendrisio. '.repeat(5),
    }), []);
  });

  test('un titolo su un luogo italiano senza cantone resta italiano', () => {
    assert.deepEqual(codes({
      title: 'Spaccio di droga a Busto: sequestrati 18mila euro',
      excerpt: 'Operazione dei carabinieri. Molti clienti lavoravano a Lugano e Chiasso.',
      body: 'Lugano, Chiasso, Ticino. '.repeat(5),
    }), []);
  });

  test('la cornice «frontalieri che lavorano in Ticino» non conta fuori dal titolo', () => {
    assert.deepEqual(codes({
      title: 'Precompilata 2026: guida a accesso e invio',
      excerpt: 'La guida per i frontalieri che lavorano in Ticino.',
      body: 'Per i frontalieri del Ticino. I lavoratori frontalieri in Ticino. Ticino. Ticino.',
    }), []);
    // Nel titolo si': «Vivere a X e lavorare in Ticino» e' una guida sul lavoro in Ticino.
    assert.deepEqual(codes({
      title: 'Vivere a Porlezza e lavorare in Ticino da frontaliere',
      excerpt: 'Guida per chi vive a Porlezza.',
      body: 'Il Ticino offre salari alti. A Lugano. Il Ticino. Il Ticino.',
    }), ['TI']);
  });

  test('excerpt con un solo cantone e prove nel corpo: assegnato', () => {
    assert.deepEqual(codes({
      title: 'Crisi per il colosso dell\'auto: 110 posti a rischio',
      excerpt: 'Lo stabilimento di Flawil, nel canton San Gallo, riduce il personale.',
      body: 'A Flawil lavorano 300 persone. San Gallo chiede un piano sociale. A Flawil il sindaco. A Flawil.',
    }), ['SG']);
  });

  test('excerpt con piu\' cantoni senza titolo: rassegna, nessuno', () => {
    assert.deepEqual(codes({
      title: 'È tempo di tornare a scuola',
      excerpt: 'Si comincia nei Grigioni, a Zurigo e ad Appenzello Interno.',
      body: 'Grigioni. Zurigo. Appenzello Interno. '.repeat(4),
    }), []);
  });

  test('portata nazionale dichiarata: nessuno senza un cantone nel titolo', () => {
    assert.deepEqual(codes({
      title: 'Estate 2026: oltre 2 miliardi di produttivita\' persi',
      excerpt: 'Perdite record, con Birsfelden in testa. Lo studio sui comuni svizzeri.',
      body: 'A Birsfelden, nel canton Basilea Campagna, il picco. A Birsfelden. Basilea Campagna.',
    }), []);
  });

  test('piu\' di MAX_CANTONS cantoni nel titolo: elenco nazionale', () => {
    assert.deepEqual(codes({
      title: 'Premi 2027: Ticino, Ginevra, Basilea, Vaud e Zurigo i piu\' cari',
      excerpt: 'La classifica.',
      body: 'Ticino. Ginevra. Basilea. Vaud. Zurigo.',
    }), []);
  });

  test('due cantoni nel titolo: multi-label ordinato per punteggio', () => {
    const got = classifyCantons({
      title: 'Frontalieri: rallentano in Ticino, aumentano nei Grigioni',
      excerpt: 'I dati dell\'UST per il Ticino e i Grigioni.',
      body: 'Nei Grigioni crescono. A Coira e Davos. In Ticino calano a Lugano.',
    });
    assert.deepEqual(got.map((c) => c.canton).sort(), ['GR', 'TI']);
    assert.ok(got[0].score >= got[1].score);
    for (const c of got) assert.ok(c.evidence.some((e) => e.field === 'title'));
  });
});

describe('dominio della fonte', () => {
  test('dominio registrabile', () => {
    assert.equal(registrableHost('https://media.tio.ch/files/rss.xml'), 'tio.ch');
    assert.equal(registrableHost('www3.ti.ch'), 'ti.ch');
    assert.equal(registrableHost(''), '');
  });

  test('solo .ch locali di un solo cantone, piu\' le testate TI di NEWS_SOURCES', () => {
    const map = buildSourceDomainMap(readJson('generator/data/canton-sections.json'));
    assert.equal(map.get('tio.ch'), 'TI');
    assert.equal(map.get('ticinonews.ch'), 'TI');
    assert.equal(map.get('vs.ch'), 'VS');
    for (const multi of ['nau.ch', '20min.ch', 'watson.ch', 'laregione.ch']) assert.equal(map.has(multi), false, multi);
    for (const host of map.keys()) assert.ok(host.endsWith('.ch'), host);
  });

  test('ogni host supplementare e\' davvero fra le NEWS_SOURCES di create-article.mjs', () => {
    const src = fs.readFileSync(path.join(ROOT, 'generator/scripts/create-article.mjs'), 'utf8');
    const start = src.indexOf('const NEWS_SOURCES = [');
    assert.ok(start > 0);
    const block = src.slice(start, src.indexOf('\n];', start));
    const hosts = new Set([...block.matchAll(/^\s*'(https?:\/\/[^']+)'/gmu)].map((m) => registrableHost(m[1])));
    for (const host of FRONTALIERE_TICINO_SOURCE_HOSTS) assert.ok(hosts.has(host), `${host} non e' fra le NEWS_SOURCES`);
  });

  test('il dominio aggiunge punti ma non assegna da solo', () => {
    assert.deepEqual(codes({
      title: 'Disoccupazione stabile al 3,2%',
      excerpt: 'I dati della SECO di agosto.',
      body: 'Il tasso resta stabile.',
      sourceUrl: 'https://www.tio.ch/svizzera/economia/1',
    }), []);
  });
});

describe('dati', () => {
  const places = readJson('generator/data/canton-classifier-places.json');
  const slugs = readJson('generator/data/canton-url-slugs.json');

  test('ogni comune sopra soglia e\' nello snapshot BFS sotto il suo cantone', () => {
    assert.ok(places.towns.length >= 150);
    for (const t of places.towns) {
      assert.ok(t.population >= places.townMinPopulation, t.name);
      assert.ok((places.municipalities[t.canton] || []).includes(t.name), `${t.name} (${t.canton})`);
    }
  });

  test('lo snapshot BFS copre tutti i cantoni e i membri dei gruppi', () => {
    const groups = new Set(Object.keys(slugs.cantons));
    const members = Object.values(slugs.cantonGroups).flatMap((g) => g.members);
    for (const code of Object.keys(places.municipalities)) {
      assert.ok(groups.has(code) || members.includes(code), code);
    }
    const total = Object.values(places.municipalities).reduce((n, l) => n + l.length, 0);
    assert.equal(total, places.municipalitiesSource.total);
  });

  test('il file non si chiama canton-municipalities.json (domainAnchor lo caricherebbe)', () => {
    assert.equal(fs.existsSync(path.join(ROOT, 'generator/data/canton-municipalities.json')), false);
  });
});

describe('campo canton nel registry', () => {
  const ENTRY = [
    '  {',
    "    id: 'a',",
    "    category: 'novita',",
    "    date: '2026-10-05',",
    "    image: '/images/a.webp',",
    '    hasCalculator: false,',
    "    articleType: 'news',",
    "    authorSlug: 'redazione',",
    '  },',
  ].join('\n');

  test('inserisce dopo articleType, sostituisce, toglie', () => {
    const one = setEntryCanton(ENTRY, ['TI', 'GR']);
    assert.match(one, /articleType: 'news',\n {4}canton: \['TI', 'GR'\],\n {4}authorSlug/u);
    const two = setEntryCanton(one, ['VS']);
    assert.match(two, /canton: \['VS'\],/u);
    assert.doesNotMatch(two, /'TI'/u);
    assert.equal(setEntryCanton(two, []), ENTRY);
  });

  test('senza articleType va dopo hasCalculator', () => {
    const legacy = ENTRY.replace("    articleType: 'news',\n", '');
    assert.match(setEntryCanton(legacy, ['TI']), /hasCalculator: false,\n {4}canton: \['TI'\],/u);
  });

  test('codici validati', () => {
    assert.throws(() => renderCantonLine(['ticino'], ''), /non valido/u);
    assert.throws(() => renderCantonLine(["TI'"], ''), /non valido/u);
    assert.throws(() => renderCantonLine(['XX'], ''), /non valido/u);
    assert.throws(() => renderCantonLine(['BL'], ''), /non valido/u);
    assert.equal(renderCantonLine(['BASILEA', 'APPENZELLO'], ' '), " canton: ['BASILEA', 'APPENZELLO'],");
  });

  test('applyRegistryCantons e\' idempotente e tocca solo le voci in mappa', () => {
    const src = `const RAW_ARTICLES = [\n${ENTRY}\n${ENTRY.replace("'a'", "'b'")}\n];\n`;
    const map = new Map([['a', ['TI']]]);
    const first = applyRegistryCantons(src, map);
    assert.equal(first.changed, 1);
    assert.deepEqual([...readRegistryCantons(first.source)], [['a', ['TI']]]);
    const second = applyRegistryCantons(first.source, map);
    assert.equal(second.changed, 0);
    assert.equal(second.source, first.source);
  });

  test('renderRegistryEntry scrive canton solo se non vuoto', () => {
    const LAYOUT = { objIndent: '  ', propIndent: '    ', today: '2026-10-05', imagePath: '/i.webp' };
    const base = { id: 'x', category: 'novita', articleType: 'news' };
    assert.ok(!renderRegistryEntry({ ...base, canton: [] }, LAYOUT).some((l) => l.includes('canton')));
    const lines = renderRegistryEntry({ ...base, canton: ['TI'] }, LAYOUT);
    assert.equal(lines[lines.indexOf("    articleType: 'news',") + 1], "    canton: ['TI'],");
  });

  test('canton non entra nell\'API pubblica', () => {
    const pub = toPublicRegistryEntry({ id: 'x', category: 'novita', canton: ['TI'] }, 'abc');
    assert.equal('canton' in pub, false);
  });

  test('create-article.mjs popola canton prima del lock, nei due percorsi', () => {
    const src = fs.readFileSync(path.join(ROOT, 'generator/scripts/create-article.mjs'), 'utf8');
    const hits = [...src.matchAll(/data\.canton = registryCantonsOrNone\([^)]*\);\n\s*beginRegisterLock\(data\.id\);/gu)];
    assert.equal(hits.length, 2);
    assert.match(src, /import \{ registryCantonsForArticle \} from '\.\/lib\/canton-classifier\.mjs';/u);
  });

  test('registryCantonsForArticle legge data.content.it', () => {
    const data = {
      content: {
        it: {
          title: 'Incendio a Chiasso: due operai ricoverati',
          excerpt: 'Rogo su un tetto a Chiasso.',
          body2: 'A Chiasso i pompieri. Il Mendrisiotto.',
          body1: 'Intervento a Chiasso.',
        },
      },
    };
    assert.equal(cantonInputFromArticle(data).body, 'Intervento a Chiasso.\n\nA Chiasso i pompieri. Il Mendrisiotto.');
    assert.deepEqual(registryCantonsForArticle(data), ['TI']);
  });
});

describe('backfill', () => {
  test('letterali TS: apici, backtick, escape', () => {
    const map = readTsStringMap([
      "const m = {",
      "  'blog.article.a.title': 'L\\'A2 a Coldrerio',",
      "  'blog.article.a.body1': `## In breve\\n- riga`,",
      "  'blog.article.a.excerpt': 'Caff\\u00e8',",
      '};',
    ].join('\n'));
    assert.equal(map.get('blog.article.a.title'), "L'A2 a Coldrerio");
    assert.equal(map.get('blog.article.a.body1'), '## In breve\n- riga');
    assert.equal(map.get('blog.article.a.excerpt'), 'Caffè');
  });

  test('ledger delle fonti nei due formati', () => {
    const inv = invertSourceLedger({ 'https://www.tio.ch/1': 'a', 'https://x.ch/2': { articleId: 'b' } });
    assert.equal(inv.get('a'), 'https://www.tio.ch/1');
    assert.equal(inv.get('b'), 'https://x.ch/2');
  });

  test('mini-corpus: --write riempie i registry ed e\' idempotente', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canton-backfill-'));
    const w = (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    const entry = (id) => `  {\n    id: '${id}',\n    category: 'novita',\n    date: '2026-10-05',\n    image: '/i.webp',\n    hasCalculator: false,\n    articleType: 'news',\n  },`;
    w('content/blog-articles-data.ts', `const RAW_ARTICLES = [\n${entry('chiasso')}\n${entry('roma')}\n];\n`);
    w('content/swiss-articles-data.ts', `const RAW_SWISS_ARTICLES: Article[] = [\n${entry('uri')}\n];\n`);
    w('content/blog-meta-it.ts', [
      'const m = {',
      "  'blog.article.chiasso.title': 'Incendio a Chiasso: due operai ricoverati',",
      "  'blog.article.chiasso.excerpt': 'Rogo a Chiasso.',",
      "  'blog.article.roma.title': 'Il governo italiano approva la manovra',",
      "  'blog.article.roma.excerpt': 'Le misure.',",
      '};',
    ].join('\n'));
    w('content/blog-meta-ch-it.ts', [
      'const m = {',
      "  'blog.article.uri.title': 'Permesso B nel Canton Uri: requisiti',",
      "  'blog.article.uri.excerpt': 'Il permesso B nel Canton Uri.',",
      '};',
    ].join('\n'));
    w('content/blog-body/it/chiasso.ts', "const b = {\n  'blog.article.chiasso.body1': 'I pompieri a Chiasso. Il Mendrisiotto.',\n};\n");
    w('content/blog-body-ch/it/uri.ts', "const b = {\n  'blog.article.uri.body1': 'Ad Altdorf, nel Canton Uri.',\n};\n");

    const results = classifyCorpus(dir);
    const report = renderReport(results, { sampleSize: 5 });
    assert.match(report, /Articoli: 3 \(con cantone: 2/u);
    assert.deepEqual(writeRegistries(results, dir), { frontaliere: 1, svizzera: 1 });
    const blog = fs.readFileSync(path.join(dir, 'content/blog-articles-data.ts'), 'utf8');
    assert.deepEqual([...readRegistryCantons(blog)], [['chiasso', ['TI']]]);
    const swiss = fs.readFileSync(path.join(dir, 'content/swiss-articles-data.ts'), 'utf8');
    assert.deepEqual([...readRegistryCantons(swiss)], [['uri', ['UR']]]);
    assert.deepEqual(writeRegistries(classifyCorpus(dir), dir), { frontaliere: 0, svizzera: 0 });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
