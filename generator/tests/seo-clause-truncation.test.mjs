/**
 * seo-clause-truncation.test.mjs — il troncamento SEO del generatore deve
 * chiudere su una CLAUSOLA COMPLETA. (manifest: `corpus-only`)
 *
 * ## L'incidente
 *
 * `generator/scripts/create-article.mjs` e' un fork del generatore del sito.
 * Il sito ha sostituito la sua `truncateAtWordBoundary` con un thin wrapper su
 * `truncateToClause` (issue valerielinc-ops#4356/#4357/#4358, CTR sotto
 * obiettivo su tre famiglie di template); qui il fork e' rimasto sulla versione
 * vecchia, perche' NESSUNO DEI DUE MIRROR copre `generator/` — la stessa strada
 * per cui il cap sulla meta description (#5360) non era mai sceso e il difetto
 * era tornato identico il giorno dopo (issue #81).
 *
 * Due difetti, entrambi misurati su QUESTO corpus il 2026-08-09
 * (27.764 campi SEO in content/seo/seo-blog*.ts, 3.075 articoli):
 *
 *  1. taglio a META' PAROLA. `Math.max(cut.lastIndexOf(' '), maxLen - 12)`
 *     ripiegava su un taglio a carattere quando l'ultima parola superava i ~13
 *     caratteri. Nel dato memorizzato e' arrivato una volta sola
 *     ("...frontalieri che attraversano q"), ma dipende dall'input, non dalla
 *     frequenza: un composto tedesco a cavallo del limite lo riproduce sempre.
 *  2. PREPOSIZIONE APPESA. Strippando solo la punteggiatura, la parola
 *     funzionale restava: 3.544 campi su 1.137 articoli finiscono su una parola
 *     funzionale, 1.792 di essi sul letterale "Dati aggiornati <anno> per".
 *
 * ## Perche' la sandbox invece dell'import
 *
 * `create-article.mjs` non e' importabile senza node_modules: la sua closure
 * tira sharp, undici e altre dipendenze npm che la CI di questo repo non
 * installa di proposito. Il test ESTRAE il blocco sorgente di
 * `truncateAtWordBoundary` e lo valuta iniettandogli il `truncateToClause`
 * VERO, importato dal modulo condiviso — stessa tecnica di
 * `blog-title-casing.test.mjs`.
 *
 * La conseguenza che conta: le asserzioni sono COMPORTAMENTALI, non testuali.
 * Rimettere il corpo vecchio le fa fallire anche se l'import resta al suo posto,
 * perche' quel corpo semplicemente non chiama la funzione iniettata. E se
 * l'estrazione si rompe (funzione spostata, delimitatori cambiati) il test
 * lancia: non puo' passare a vuoto.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expect } from './lib/expect-shim.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Import DIRETTO: clauseTail.mjs e' puro e senza dipendenze, quindi qui
// l'import funziona dove su create-article.mjs no.
import {
  truncateToClause,
  truncateToClauseNonEmpty,
  peelDanglingClauseTail,
  TRAILING_STOPWORDS,
} from '../../host/shared/clauseTail.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREATE_ARTICLE = path.join(ROOT, 'generator', 'scripts', 'create-article.mjs');
const CLAUSE_TAIL = path.join(ROOT, 'host', 'shared', 'clauseTail.mjs');
const TITLE_SUFFIX = path.join(ROOT, 'host', 'shared', 'titleSuffix.ts');
const SEO_DIR = path.join(ROOT, 'content', 'seo');

// ── Estrazione in sandbox ──────────────────────────────────────────────────

function extractTruncateBlock() {
  const src = fs.readFileSync(CREATE_ARTICLE, 'utf-8');
  const start = src.indexOf('function truncateAtWordBoundary(text, maxLen) {');
  if (start === -1) {
    throw new Error('truncateAtWordBoundary non trovata in create-article.mjs — aggiornare i delimitatori di questo test');
  }
  // Chiusa dalla prima riga che e' esattamente '}' a colonna 0. `start` cade
  // sulla riga `function`, quindi il blocco esclude il commento sopra: cio' che
  // il guard testuale piu' sotto ispeziona e' CODICE, non prosa.
  const endRel = src.slice(start).search(/\n\}\n/);
  if (endRel === -1) throw new Error('graffa di chiusura di truncateAtWordBoundary non trovata');
  return src.slice(start, start + endRel + 2);
}

const TRUNCATE_BLOCK = extractTruncateBlock();
const truncateAtWordBoundary = new Function(
  'truncateToClause',
  `${TRUNCATE_BLOCK}\nreturn truncateAtWordBoundary;`,
)(truncateToClause);

// La vecchia implementazione, verbatim, come banco di confronto: ogni caso qui
// sotto e' scelto perche' le due divergono. Senza, il test non dimostrerebbe di
// stare misurando la fix invece di una tautologia.
function truncateAtWordBoundaryPreFix(text, maxLen) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen + 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), maxLen - 12)).trim().replace(/[,:;.\-–—\s]+$/, '');
}

// ── Difetto 1: taglio a meta' parola ───────────────────────────────────────

describe('truncateAtWordBoundary — mai a meta\' parola', () => {
  // Composto tedesco (29 caratteri) a cavallo del limite: l'ultimo spazio cade
  // a 136, cioe' prima di maxLen-12 = 148, che e' la condizione esatta per far
  // scattare il fallback a carattere.
  const DE = 'Grenzgaenger zwischen Italien und der Schweiz: Steuern, Bewilligung G, '
    + 'Krankenkasse und Loehne im Vergleich, sowie die taeglich aktuelle '
    + 'Grenzueberschreitungsstatistik fuer 2026';

  it('riproduce il difetto sulla versione pre-fix (banco di confronto)', () => {
    const before = truncateAtWordBoundaryPreFix(DE, 160);
    expect(before).toHaveLength(148);
    expect(before, 'la pre-fix taglia dentro Grenzueberschreitungsstatistik').toMatch(/Grenzuebers$/);
  });

  it('taglia su un confine di parola vero', () => {
    const after = truncateAtWordBoundary(DE, 160);
    expect(after.length).toBeLessThan(161);
    expect(after, 'nessun frammento di parola in coda').not.toContain('Grenzuebers');
    // Il confine e' reale: il carattere successivo nell'originale non e' una lettera.
    assert.ok(DE.startsWith(after), 'il risultato deve restare un prefisso dell\'originale');
    const next = DE.codePointAt(after.length);
    assert.ok(!/[\p{L}\p{N}]/u.test(String.fromCodePoint(next)), `il taglio cade dentro una parola (prossimo code point: ${JSON.stringify(String.fromCodePoint(next))})`);
  });
});

// ── Difetto 2: parola funzionale appesa ────────────────────────────────────

describe('truncateAtWordBoundary — mai su una parola funzionale', () => {
  // Il caso letterale piu' frequente del corpus: 1.792 campi finiscono cosi'.
  const IT = 'Le spese per il trasferimento di titoli in Svizzera sono tra i 60 e i 120 franchi, '
    + 'secondo la Sorveglianza dei prezzi. Dati aggiornati 2026 per frontalieri in Ticino';

  it('riproduce il difetto sulla versione pre-fix (banco di confronto)', () => {
    expect(truncateAtWordBoundaryPreFix(IT, 160), 'la pre-fix lascia appeso "in"').toMatch(/\bfrontalieri in$/);
  });

  it('spela la coda fino a una parola di contenuto', () => {
    const after = truncateAtWordBoundary(IT, 160);
    expect(after).toMatch(/frontalieri$/);
    const last = (/(\S+)$/.exec(after) || [])[1].toLowerCase();
    expect(TRAILING_STOPWORDS.has(last), `"${after}" finisce sulla parola funzionale "${last}"`).toBe(false);
  });

  it('vale anche sui titoli, dove il budget e\' 57', () => {
    const t = 'Confine Italia-Svizzera: 6 regole doganali per frontalieri';
    expect(truncateAtWordBoundaryPreFix(t, 57), 'la pre-fix lascia appeso "per"').toMatch(/doganali per$/);
    expect(truncateAtWordBoundary(t, 57)).toMatch(/doganali$/);
  });

  it('non tocca un testo gia\' entro il budget', () => {
    for (const s of ['Imposta alla Fonte Ticino 2026', 'Permesso G Svizzera: requisiti e costi.']) {
      expect(truncateAtWordBoundary(s, 160)).toBe(s);
    }
  });
});

// ── Cablaggio: la sandbox non deve mascherare un import mancante ────────────

describe('cablaggio del modulo condiviso', () => {
  const src = fs.readFileSync(CREATE_ARTICLE, 'utf-8');

  it('create-article.mjs importa truncateToClause da host/shared/clauseTail.mjs', () => {
    expect(src, 'senza questo import il modulo reale lancia a runtime, e la sandbox non se ne accorge')
      .toMatch(/^import\s*\{[^}]*\btruncateToClause\b[^}]*\}\s*from\s*'\.\.\/\.\.\/host\/shared\/clauseTail\.mjs';$/m);
    assert.ok(fs.existsSync(CLAUSE_TAIL), 'host/shared/clauseTail.mjs deve esistere');
  });

  // Sul BLOCCO della funzione, non sul file: il commento sopra la funzione cita
  // il ripiego per negarlo, ed e' esattamente la citazione contrastiva che
  // loop-references-exist.test.mjs documenta come falso positivo.
  it('il fallback a carattere non e\' piu\' nel corpo della funzione', () => {
    expect(TRUNCATE_BLOCK, 'il ripiego `maxLen - 12` e\' il difetto 1: se ricompare, e\' tornato il corpo vecchio')
      .not.toContain('lastIndexOf');
    expect(TRUNCATE_BLOCK, 'il corpo deve delegare, non reimplementare').toContain('truncateToClause(text, maxLen)');
  });

  // AGENTS.md #6: un valore condiviso ha UNA sorgente. La lista di stopword sta
  // in host/shared/clauseTail.mjs e si importa; una seconda copia sotto
  // generator/ tornerebbe a divergere per costruzione, che e' esattamente il
  // modo in cui il sito si era ritrovato cinque regole di troncamento diverse.
  it('nessuna seconda copia della lista di stopword sotto generator/', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!/\.(mjs|js|ts)$/.test(e.name)) continue;
        const t = fs.readFileSync(p, 'utf-8');
        if (/\b(TRAILING_STOPWORDS|CLAUSE_SEPARATOR_TAIL_RE)\s*=/.test(t)) offenders.push(path.relative(ROOT, p));
      }
    };
    walk(path.join(ROOT, 'generator'));
    expect(offenders.filter((f) => !f.endsWith('seo-clause-truncation.test.mjs')), 'importarla, non ricopiarla').toEqual([]);
  });
});

// ── Il rifiuto di truncateToClause, e i due call site che non lo tollerano ──

describe('titolo e breadcrumb: il RIFIUTO non deve arrivare fino al <title>', () => {
  // `truncateToClause` risolve il dilemma «mai a meta' parola, mai oltre il
  // budget» RIFIUTANDO: quando il primo token da solo sfora, nessun suo
  // prefisso soddisfa entrambe le condizioni, e la funzione torna ''. E' il
  // contratto giusto per un campo che puo' restare vuoto, ed e' sbagliato per
  // un titolo, che qui viene interpolato in un suffisso di brand: '' non
  // significa «nessun titolo», significa pubblicare " | Frontaliere Ticino"
  // come titolo intero, con ogTitle e headline vuoti.
  //
  // Non e' un caso limite su questo repo: il fallback dei due call site e'
  // `data.id`, cioe' uno SLUG, e uno slug non contiene spazi. Il ramo del
  // rifiuto e' la NORMA quando il titolo manca.
  // Slug reale del corpus, 65 caratteri: il budget del titolo e' 57.
  const SLUG = 'caldo-non-frene-consumi-carne-ma-siccia-potrebbe-far-salire-prezzi';

  it('lo slug nudo fa rifiutare truncateToClause (la premessa della fix)', () => {
    assert.ok(!SLUG.includes(' '), 'la premessa e\' che uno slug non abbia spazi');
    assert.ok(SLUG.length > 57, 'e che sia piu\' lungo del budget del titolo');
    expect(truncateToClause(SLUG, 57), 'se questo smette di essere \'\', il rifiuto e\' stato rimosso a monte').toBe('');
  });

  it('la versione non-vuota risponde qualcosa, e sta nel budget', () => {
    const out = truncateToClauseNonEmpty(SLUG, 57);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(58);
    assert.ok(SLUG.startsWith(out), 'deve restare un prefisso dell\'originale');
  });

  it('non tocca il caso normale: con uno spazio le due funzioni coincidono', () => {
    // Se divergessero anche qui, la fix avrebbe cambiato il taglio di ogni
    // titolo del corpus invece del solo ramo del rifiuto.
    for (const t of [
      'Confine Italia-Svizzera: 6 regole doganali per frontalieri',
      'Imposta alla Fonte Ticino 2026: aliquote, scaglioni e conguaglio',
    ]) {
      expect(truncateToClauseNonEmpty(t, 57)).toBe(truncateToClause(t, 57));
    }
  });

  // Guard testuale sui due call site: e' l'unica forma possibile, perche'
  // create-article.mjs non e' importabile da node:test (vedi l'intestazione).
  it('i due call site di titolo e breadcrumb usano la versione non-vuota', () => {
    const src = fs.readFileSync(CREATE_ARTICLE, 'utf-8');
    expect(src, 'il titolo del ramo «campo seo mancante» cade sullo slug: qui il rifiuto pubblicherebbe un title vuoto')
      .toMatch(/const title = truncateToClauseNonEmpty\(String\(it\.title \|\| data\.id\), 57\)/);
    expect(src, 'breadcrumbName finisce nel JSON-LD BreadcrumbList, dove una name vuota e\' un item invalido')
      .toMatch(/data\.seo\.breadcrumbName = truncateToClauseNonEmpty\(/);
    expect(src, 'senza l\'import il modulo lancia a runtime')
      .toMatch(/^import\s*\{[^}]*\btruncateToClauseNonEmpty\b[^}]*\}\s*from\s*'\.\.\/\.\.\/host\/shared\/clauseTail\.mjs';$/m);
  });
});

// ── Il contratto che non ha forma di import ────────────────────────────────

describe('guardia "gia\' completo" allineata a repairSerpSnippet', () => {
  // Lo scan piu' sotto deve saltare le stringhe che chiudono su punteggiatura
  // terminale, perche' e' cio' che fa `repairSerpSnippet` prima di spelare.
  //
  // RIALLINEATO: la primitiva e' MIGRATA da host/shared/titleSuffix.ts a
  // host/shared/clauseTail.mjs (PR #116), perche' scripts/build-api.mjs e' un
  // .mjs e non puo' importare un .ts. Questo guard aveva pinnato il letterale
  // nel file vecchio e ha fatto fallire la CI al primo tentativo di spostarlo.
  // E' il comportamento voluto, non un intralcio: un contratto senza forma di
  // import va legato per TESTO, e un legame per testo deve rompersi quando il
  // testo si sposta — altrimenti non stava legando niente.
  it('il letterale della guardia vive in clauseTail.mjs', () => {
    const mjs = fs.readFileSync(CLAUSE_TAIL, 'utf-8');
    expect(mjs, 'se repairSerpSnippet cambia guardia, lo scan sotto va riallineato')
      .toContain('.test(normalized)) return normalized;');
  });

  it('titleSuffix.ts la riesporta invece di ridefinirla (AGENTS.md #6)', () => {
    const ts = fs.readFileSync(TITLE_SUFFIX, 'utf-8');
    expect(ts, 'deve riesportare, non ridefinire')
      .toContain("export { repairSerpSnippet } from './clauseTail.mjs';");
    expect(ts, 'una seconda definizione sarebbe la duplicazione che la migrazione ha rimosso')
      .not.toContain('export function repairSerpSnippet');
  });
});

// ── Gate sull'output: il corpus pubblicato ─────────────────────────────────

const TERMINAL_RE = /[.!?…»"')\]]$/u;
const FIELD_RE = /^\s{2,8}(description|ogDescription|title|ogTitle|breadcrumbName|h1):\s*(.+?),?\s*$/;
const SLUG_RE = /^\s{2}['"]([^'"]+)['"]:\s*\{\s*$/;
const SD_RE = /^\s*"(description|headline|name)":\s*(".*?"),?\s*$/;
const DATE_RE = /^\s*"datePublished":\s*"(\d{4}-\d{2}-\d{2})/;

function scanCorpus() {
  const files = fs.readdirSync(SEO_DIR).filter((f) => /^seo-blog.*\.ts$/.test(f)).sort();
  const rows = [];
  const dateBySlug = new Map();
  for (const f of files) {
    let slug = null;
    for (const line of fs.readFileSync(path.join(SEO_DIR, f), 'utf-8').split('\n')) {
      const sm = SLUG_RE.exec(line);
      if (sm) { slug = sm[1]; continue; }
      const dm = DATE_RE.exec(line);
      if (dm && slug && !dateBySlug.has(slug)) { dateBySlug.set(slug, dm[1]); continue; }
      let m = FIELD_RE.exec(line), raw;
      if (m) raw = m[2];
      else { m = SD_RE.exec(line); if (!m) continue; raw = m[2]; }
      if (/^`/.test(raw)) continue;   // template literal su BASE_URL, non testo SEO
      let value;
      try { value = (0, eval)(raw); } catch { continue; }
      if (typeof value !== 'string' || !value) continue;
      rows.push({ file: f, slug, value });
    }
  }
  const offenders = rows.filter((r) => !TERMINAL_RE.test(r.value) && peelDanglingClauseTail(r.value) !== r.value);
  return { files, rows, offenders, dateBySlug };
}

describe('content/seo/** — code aperte su una parola funzionale', () => {
  const { files, rows, offenders, dateBySlug } = scanCorpus();

  // Anti-vacuita': in uno sparse checkout senza content/ questo scan
  // troverebbe zero campi e ogni asserzione sotto passerebbe a vuoto.
  it('lo scan ha davvero letto il corpus', () => {
    expect(files.length, 'gli 8 chunk seo-blog*.ts devono esserci').toBeGreaterThan(7);
    expect(rows.length, 'campi SEO estratti (27.764 al 2026-08-09)').toBeGreaterThan(20000);
    expect(dateBySlug.size, 'entry con datePublished (3.075 al 2026-08-09)').toBeGreaterThan(2500);
  });

  // Ratchet: il mucchio storico puo' solo calare. Dopo questa fix il generatore
  // non ne produce piu', quindi il conteggio e' monotono non crescente — un
  // bound assoluto qui non sfarfalla.
  //
  // 3.544 misurati a 2a7ec113 il 2026-08-09; il tetto tiene un margine per gli
  // articoli che il codice VECCHIO genera fra questa misura e il merge (~30-50
  // al giorno, 2-3 campi ciascuno nel caso peggiore).
  const OFFENDER_BASELINE = 3544;
  const OFFENDER_MAX = 3700;

  it(`non supera il baseline storico (${OFFENDER_BASELINE} al 2026-08-09)`, () => {
    const detail = offenders.slice(0, 5).map((o) => `${o.slug || '?'} — …${o.value.slice(-46)}`).join('\n  ');
    expect(offenders.length, `code aperte in content/seo/**\n  ${detail}`).toBeLessThan(OFFENDER_MAX + 1);
  });

  // Il gate vero: da CUTOFF in poi il generatore e' quello corretto, quindi un
  // articolo nuovo con la coda aperta e' una regressione, non un residuo.
  // Parte vuoto per costruzione (nessun articolo ha ancora quella data) e
  // acquista denti entro il giorno; nel frattempo il ratchet sopra copre.
  const CUTOFF = '2026-08-10';

  it(`nessun articolo pubblicato da ${CUTOFF} in poi ha una coda aperta`, () => {
    const recent = offenders.filter((o) => o.slug && (dateBySlug.get(o.slug) || '') >= CUTOFF);
    const detail = recent.slice(0, 10).map((o) => `${o.slug} (${dateBySlug.get(o.slug)}) — …${o.value.slice(-46)}`).join('\n  ');
    expect(recent.length, `articoli generati DOPO la fix con la coda aperta:\n  ${detail}`).toBe(0);
  });
});

// ── Il modulo condiviso, in diretta ────────────────────────────────────────

describe('clauseTail.mjs — la primitiva condivisa', () => {
  it('spela le parole funzionali finche\' non chiude su contenuto', () => {
    expect(peelDanglingClauseTail('Stipendio netto frontaliere 2026: come')).toBe('Stipendio netto frontaliere 2026');
    expect(peelDanglingClauseTail('alcol e sigarette. Dati aggiornati 2026 per')).toBe('alcol e sigarette. Dati aggiornati 2026');
  });

  it('copre i quattro locali del sito, non solo l\'italiano', () => {
    expect(peelDanglingClauseTail('Cross-border guide for')).toBe('Cross-border guide');
    expect(peelDanglingClauseTail('Grenzgaenger Ratgeber für')).toBe('Grenzgaenger Ratgeber');
    expect(peelDanglingClauseTail('Guide frontalier pour')).toBe('Guide frontalier');
  });
});
