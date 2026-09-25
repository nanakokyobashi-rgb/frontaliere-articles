// Gate evergreen del secondo scaglione IRPEF (corpus #1876, lotto 1).
//
// Dal periodo d'imposta 2026 il secondo scaglione IRPEF (28'001-50'000 euro)
// e' al 33% (Legge 199/2025, art. 1, c. 3). Fino a #1778 il generatore
// scriveva «23%/35%/43%» nei prompt, e 316 slug pubblicati presentavano ancora
// il 35% come aliquota vigente. Questo gate scandisce TUTTI i corpi
// `content/blog-body*/{it,en,de,fr}/*.ts` e fallisce su ogni 35% del secondo
// scaglione presentato come regola in vigore, fuori dalla lista dei residui.
//
// Cosa vede (lotto 1, le forme UNIVOCHE):
//   - la terna 23% ... 35% ... 43% nello stesso paragrafo, senza altre
//     percentuali in mezzo, e le varianti compatte 23/35/43, 23%/35%/43%,
//     23-35-43 (anche con «percento», «Prozent», «percent», «pour cent»);
//   - la terna scritta in lettere («il ventitré per cento ... il trentacinque
//     per cento ... il quarantatré per cento», e le altre tre lingue);
//   - il 35% attaccato alla soglia 28'001/28'000/50'000 nella stessa frase,
//     senza un'altra percentuale in mezzo («35% tra €28.001 e €50.000»).
// Cosa NON vede ancora: le parafrasi senza terna ne' soglia («35% su questa
// fascia», «scaglione del 35%»), gli intervalli «23–35%» e i calcoli che
// usano il 35% senza citare la soglia. Sono nel residuo della issue #1876 e il
// lotto successivo estende questo rilevatore invece di scriverne un altro.
//
// Una frase che lega il 35% ai redditi 2024-2025 («per i redditi 2024–2025»,
// «scaglioni 2025», «Tarifstufen 2025») e' STORICO-OK: nel 2026 si dichiarano
// ancora i redditi 2025, e per quelli il 35% e' giusto. Non conta come anno
// storico l'inizio del regime transitorio «2024–2033», la data d'entrata in
// vigore dell'accordo («1° gennaio 2024») ne' il numero della legge «199/2025».
//
// Le aliquote e le soglie vengono dalla sorgente unica
// `generator/scripts/lib/irpef-scaglioni.mjs` (#1778), non da costanti locali.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IRPEF_ANNO_CORRENTE,
  IRPEF_ANNO_PRECEDENTE,
  irpefScaglioniPer,
} from '../scripts/lib/irpef-scaglioni.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCALES = ['it', 'en', 'de', 'fr'];
const SECTIONS = ['blog-body', 'blog-body-ch'];

const CORRENTE = irpefScaglioniPer(IRPEF_ANNO_CORRENTE);
const PRECEDENTE = irpefScaglioniPer(IRPEF_ANNO_PRECEDENTE);
const PRIMA = CORRENTE[0].aliquota; // 23
const SUPERATA = PRECEDENTE[1].aliquota; // 35, regime 2024-2025
const VIGENTE = CORRENTE[1].aliquota; // 33, dal 2026
const TERZA = CORRENTE[2].aliquota; // 43
const SOGLIA_1 = CORRENTE[0].fino; // 28'000
const SOGLIA_2 = CORRENTE[1].fino; // 50'000

/**
 * RESIDUI (ratchet): gli slug che il lotto 1 lascia deliberatamente com'erano,
 * con il numero di occorrenze univoche per lingua. La lista puo' solo
 * scendere: un conteggio piu' alto e' una regressione, uno piu' basso (o uno
 * slug ripulito) va registrato abbassando il numero o togliendo la voce.
 * Alla chiusura di #1876 la lista e' vuota.
 */
const CALC = 'esempio di calcolo: gli importi derivati dal 35% vanno ricalcolati con il 33% insieme alla catena a valle (lotto calc di #1876)';
const DICH_730 = 'dichiarazione 2026 dei redditi 2025: il 35% e\' corretto per il 2025, va qualificato e affiancato dal 33% del 2026, non sostituito';
const RESIDUI = Object.freeze({
  // Flag `calc` nella tabella di #1876.
  'briosco-pendolare-ticino-lavoro': { motivo: CALC, it: 2, en: 2, de: 2, fr: 2 },
  'cadorago-frontaliere-pendolare-guida': { motivo: CALC, it: 1, en: 1, de: 1, fr: 1 },
  'cambio-euro-franco-conviene': { motivo: CALC, it: 3, en: 3, de: 3, fr: 3 },
  'costo-vita-lugano-milano-scelta': { motivo: CALC, it: 3, en: 3, de: 3, fr: 3 },
  'credito-imposta-2026-single': { motivo: CALC, it: 5, en: 3, de: 3, fr: 3 },
  'credito-imposta-frontalieri-2026': { motivo: CALC, it: 3, en: 3, de: 3, fr: 3 },
  'frontaliere-documenti-primo-giorno-lavoro-ticino-2026-famiglia-con-figli': { motivo: CALC, it: 1, en: 1, de: 1, fr: 1 },
  'frontaliere-tasse-single-2026': { motivo: CALC, it: 2, en: 2, de: 2, fr: 2 },
  'frontalieri-busta-paga-2026-simulazione': { motivo: CALC, it: 4, en: 4, de: 4, fr: 4 },
  'frontalieri-nuova-imposta-sostitutiva-2024': { motivo: CALC, it: 1, en: 1, de: 1, fr: 1 },
  'frontalieri-ticino-ergoterapista': { motivo: CALC, it: 2, en: 2, de: 2, fr: 2 },
  'imposte-frontalieri-20km-distanza': { motivo: CALC, it: 4, en: 4, de: 4, fr: 4 },
  'partita-iva-frontaliere-svizzera-2024': { motivo: CALC, it: 2, en: 1, de: 1, fr: 1 },
  'stipendio-frontaliere-single-2026': { motivo: CALC, it: 1, en: 1, de: 1, fr: 1 },
  'stipendio-gessatore-frontaliere-ticino': { motivo: CALC, it: 1, en: 1, de: 1, fr: 1 },
  'tasse-frontalieri-distanza-confine': { motivo: CALC, it: 4, en: 3, de: 3, fr: 3 },
  'trasferirsi-non-frontaliere-guida': { motivo: CALC, it: 1, en: 1 },
  'vivere-incudine-lavorare-grigioni-frontaliere': { motivo: CALC, it: 2, en: 1, de: 1, fr: 1 },
  'vivere-monvalle-lavorare-ticino-frontaliere': { motivo: CALC, it: 1, en: 1, de: 1, fr: 1 },
  'vivere-novedrate-lavorare-ticino-frontaliere': { motivo: CALC, it: 1, en: 1, de: 1, fr: 1 },
  'vivere-valbondione-lavorare-grigioni-frontaliere': { motivo: CALC, it: 1, en: 1, de: 1, fr: 1 },
  // Esempi di calcolo trovati nel lotto 1, senza flag nella tabella.
  'stipendio-muratore-frontaliere-ticino': {
    motivo: `${CALC}; l'esempio it deriva «quindi la retribuzione è di €45'825» dal 35%`,
    it: 4, en: 1, de: 1, fr: 1,
  },
  'vivere-martello-lavorare-grigioni-frontaliere': {
    motivo: `${CALC}; l'esempio it su €50'000 «risparmierebbe €17'350» usa il 35%`,
    it: 3, en: 2, de: 2, fr: 2,
  },
  // Flag `730` nella tabella di #1876 (frontaliere-730-ristorni-2026 e
  // frontaliere-dichiarazione-730-2026 hanno anche il flag `calc`).
  'credito-dichiarazione-redditi-2026': { motivo: DICH_730, it: 2, en: 2, de: 2, fr: 2 },
  'frontaliere-730-ristorni-2026': { motivo: DICH_730, it: 4, en: 3, de: 3, fr: 3 },
  'frontaliere-dichiarazione-730-2026': { motivo: DICH_730, it: 2, en: 2, de: 2, fr: 2 },
  // Contesto al passato: «Prima del Nuovo Accordo ... l'Italia poteva chiedere
  // l'IRPEF (23%, 35%, 43%)» non e' la regola in vigore; serve una scelta
  // editoriale (qualificare l'anno o riscrivere), non una sostituzione.
  'vivere-brezzo-bedero-lavorare-ticino': {
    motivo: 'terna in una frase al passato sul regime prima del Nuovo Accordo: va riscritta, non sostituita',
    it: 1, en: 1, de: 1, fr: 1,
  },
});

// ── Rilevatore ──────────────────────────────────────────────────────────────
// Il testo e' il sorgente TS: `\n` e' letterale (backslash + n) e l'apostrofo
// e' `\'`. Le posizioni sono quelle del sorgente, cosi' il messaggio di errore
// puo' citare la riga.

const SP = '[ \\u00a0\\u202f]';
const PCT = `(?:${SP}?%|${SP}(?:per${SP}?cento|percento|Prozent|percent|pour${SP}cent|por${SP}ciento))`;
const pct = (n) => new RegExp(`(?<![\\d.,'])${n}${PCT}`, 'g');
const P_SUPERATA = new RegExp(`(?<![\\d.,'])${SUPERATA}(?=${PCT})`, 'g');
const P_PRIMA = pct(PRIMA);
const P_TERZA = pct(TERZA);
const ANY_PCT = new RegExp(`(?<![\\d.,'])\\d+(?:[.,]\\d+)?${PCT}`, 'g');
const DASH = `${SP}?[/\\-–—]${SP}?`;
const COMPACT = new RegExp(
  `(?<![\\d.,])${PRIMA}(?:${SP}?%)?${DASH}(${SUPERATA})(?:${SP}?%)?${DASH}${TERZA}(?!\\d)`,
  'gd',
);
// Separatori delle migliaia usati nel corpus: . , \' ' ’ spazio, o nessuno.
const SEP = `(?:\\.|,|\\\\'|'|’|${SP}|)`;
const migliaia = (n) => `${Math.floor(n / 1000)}${SEP}`;
const THRESH = new RegExp(
  `(?<![\\d.,])(?:${migliaia(SOGLIA_1)}00[01]|${migliaia(SOGLIA_2)}000)(?!\\d)`,
  'g',
);
const YEAR_OLD = new RegExp(
  `(?<![\\d/])(?<!gennaio )(?<!January )(?<!January \\d{1,2}, )(?<!Januar )(?<!janvier )(?<!Jänner )`
  + `(?:${IRPEF_ANNO_PRECEDENTE - 1}|${IRPEF_ANNO_PRECEDENTE})(?!\\d)`
  + `(?!${SP}?[–\\-]${SP}?20[3-9]\\d)`,
);
const SENT_END = /(?<=[a-zà-ÿ0-9)\]%»"])[.!?](?=\s+[A-ZÀ-Ý«"*(])/g;
// La terna in lettere: le parole non si derivano dalla libreria, quindi il
// test «la terna in lettere resta allineata» fallisce se gli scaglioni cambiano.
const WORDS_33 = Object.freeze({
  trentacinque: 'trentatré',
  'trente-cinq': 'trente-trois',
  'thirty-five': 'thirty-three',
  fünfunddreissig: 'dreiunddreissig',
  fünfunddreißig: 'dreiunddreißig',
});
const WORD_TRIAD = new RegExp(
  '(?<a>ventitr[ée] per ?cento|vingt-trois pour cent|twenty-three percent|dreiundzwanzig Prozent)'
  + '[^%]{0,160}?(?<b>trentacinque|trente-cinq|thirty-five|fünfunddrei(?:ss|ß)ig)'
  + '(?: per ?cento| pour cent| percent| Prozent)'
  + '[^%]{0,200}?(?:quarantatr[ée] per ?cento|quarante-trois pour cent|forty-three percent|dreiundvierzig Prozent)',
  'gid',
);
const NL = '\\n';

/** Come `re.finditer(text, start, end)` di Python: il lookbehind vede prima di `start`, il lookahead non oltre `end`. */
function* matchesIn(re, text, start, end) {
  const sub = text.slice(0, end);
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  r.lastIndex = Math.max(0, start);
  for (let m = r.exec(sub); m; m = r.exec(sub)) {
    yield m;
    if (m[0].length === 0) r.lastIndex += 1;
  }
}
const firstIn = (re, text, start, end) => matchesIn(re, text, start, end).next().value || null;
const lastIndexOf = (text, needle, end) => text.lastIndexOf(needle, end - needle.length);
const indexFrom = (text, needle, from) => text.indexOf(needle, from);

/** Paragrafo: fra due righe vuote o fra i delimitatori di stringa/FAQ. */
function paraBounds(text, pos) {
  const start = Math.max(
    lastIndexOf(text, NL + NL, pos),
    lastIndexOf(text, "': '", pos),
    lastIndexOf(text, '","a":"', pos),
    lastIndexOf(text, '{"q":"', pos),
    lastIndexOf(text, '","q":"', pos),
    0,
  );
  const ends = [NL + NL, "',\n", '","a":"', '"}', '","q":"']
    .map((d) => indexFrom(text, d, pos))
    .filter((e) => e >= 0);
  return [start, ends.length ? Math.min(...ends) : text.length];
}

function lineBounds(text, pos) {
  const [s, e] = paraBounds(text, pos);
  let ls = text.lastIndexOf(NL, pos - NL.length);
  ls = ls < s ? s : ls + NL.length;
  let le = text.indexOf(NL, pos);
  le = le < 0 || le + NL.length > e ? e : le;
  return [ls, le];
}

function sentenceBounds(text, pos) {
  const [ls, le] = lineBounds(text, pos);
  let s = ls;
  for (const m of matchesIn(SENT_END, text, ls, pos)) s = m.index + m[0].length;
  const m = firstIn(SENT_END, text, pos, le);
  return [s, m ? m.index + m[0].length : le];
}

/** Classifica un 35% alla posizione di `m`: forma univoca o null, con la frase da qualificare. */
function classify(text, m) {
  const pos = m.index;
  const [ps, pe] = paraBounds(text, pos);
  const [ls, le] = lineBounds(text, pos);
  const [ss, se] = sentenceBounds(text, pos);
  for (const cm of matchesIn(COMPACT, text, Math.max(ps, pos - 12), Math.min(pe, pos + 12))) {
    if (cm.indices[1][0] === pos) return { kind: 'terna-compatta', sentence: text.slice(ss, se) };
  }
  const before = [...matchesIn(P_PRIMA, text, Math.max(ps, pos - 260), pos)];
  const after = firstIn(P_TERZA, text, pos, Math.min(pe, pos + 260));
  if (before.length && after) {
    const a = before[before.length - 1];
    const aEnd = a.index + a[0].length;
    const between = [...matchesIn(ANY_PCT, text, aEnd, after.index)].map((x) => x[0]);
    if (between.every((p) => p.startsWith(String(SUPERATA)))) {
      return {
        kind: 'terna',
        sentence: text.slice(Math.min(ss, a.index), Math.max(se, after.index + after[0].length)),
      };
    }
  }
  const mEnd = pos + String(SUPERATA).length;
  for (const t of matchesIn(THRESH, text, Math.max(ls, pos - 70), Math.min(le, pos + 70))) {
    const [lo, hi] = t.index < pos ? [t.index + t[0].length, pos] : [mEnd, t.index];
    const gap = text.slice(lo, hi);
    if (new RegExp(ANY_PCT.source).test(gap) || new RegExp(SENT_END.source).test(gap) || gap.includes(NL)) continue;
    if (t.index < pos && gap.length > 45) continue;
    return { kind: 'soglia', sentence: text.slice(ss, se) };
  }
  return null;
}

/**
 * Le occorrenze univoche del 35% del secondo scaglione in un sorgente.
 * `storico: true` quando la frase le lega ai redditi 2024-2025.
 */
export function secondoScaglioneSuperato(text) {
  const out = [];
  for (const m of matchesIn(P_SUPERATA, text, 0, text.length)) {
    const c = classify(text, m);
    if (!c) continue;
    out.push({ offset: m.index, kind: c.kind, storico: YEAR_OLD.test(c.sentence), sentence: c.sentence });
  }
  for (const m of matchesIn(WORD_TRIAD, text, 0, text.length)) {
    const pos = m.indices.groups.b[0];
    const [ss, se] = sentenceBounds(text, pos);
    const sentence = text.slice(ss, se);
    out.push({ offset: pos, kind: 'terna-in-lettere', storico: YEAR_OLD.test(sentence), sentence });
  }
  return out.sort((x, y) => x.offset - y.offset);
}

// ── Scansione del corpus ────────────────────────────────────────────────────

function scanCorpus() {
  const vigenti = [];
  const storici = [];
  let files = 0;
  for (const section of SECTIONS) {
    for (const locale of LOCALES) {
      const dir = path.join(ROOT, 'content', section, locale);
      for (const name of fs.readdirSync(dir).sort()) {
        if (!name.endsWith('.ts')) continue;
        files += 1;
        const rel = `content/${section}/${locale}/${name}`;
        const text = fs.readFileSync(path.join(dir, name), 'utf8');
        for (const hit of secondoScaglioneSuperato(text)) {
          const row = {
            slug: name.slice(0, -3),
            locale,
            rel,
            line: text.slice(0, hit.offset).split('\n').length,
            ...hit,
          };
          (hit.storico ? storici : vigenti).push(row);
        }
      }
    }
  }
  return { files, vigenti, storici };
}

let cached;
const corpus = () => (cached ??= scanCorpus());

const excerpt = (s) => s.replace(/\s+/g, ' ').trim().slice(0, 160);

test('la sorgente unica dà 23/35/43 per il 2024-2025 e 23/33/43 dal 2026', () => {
  assert.equal(IRPEF_ANNO_CORRENTE, 2026);
  assert.deepEqual(PRECEDENTE.map((s) => s.aliquota), [23, 35, 43]);
  assert.deepEqual(CORRENTE.map((s) => s.aliquota), [23, 33, 43]);
  assert.deepEqual([SOGLIA_1, SOGLIA_2], [28000, 50000]);
});

test('la terna in lettere resta allineata agli scaglioni della libreria', () => {
  // Le parole del rilevatore sono scritte a mano: se la libreria cambia gli
  // scaglioni, questo test lo dice prima che il rilevatore diventi cieco.
  assert.deepEqual([PRIMA, SUPERATA, VIGENTE, TERZA], [23, 35, 33, 43]);
  assert.equal(WORDS_33.trentacinque, 'trentatré');
});

test('il rilevatore riconosce le forme univoche nelle quattro lingue', () => {
  const positivi = [
    "L\\'IRPEF italiana è progressiva: 23% fino a €28.000, 35% tra €28.001 e €50.000, 43% oltre €50.000.",
    'Italian IRPEF is progressive: 23% up to €28,000, 35% between €28,001 and €50,000, 43% over €50,000.',
    'Der italienische IRPEF ist progressiv: 23% bis € 28.000, 35% zwischen € 28.001 und € 50.000, 43% über € 50.000.',
    "L\\'IRPEF italienne est progressive : 23 % jusqu\\'à 28 000 €, 35 % entre 28 001 € et 50 000 €, 43 % au-delà.",
    '- Aliquote IT: IRPEF 23%/35%/43% per scaglioni',
    '| Aliquota IRPEF sull\\\'eccedenza | Non dovuta | 23 % / 35 % / 43 % |',
    '23 Prozent bis 28.000 Euro, 35 Prozent für die Spanne zwischen 28.001 und 50.000 Euro und 43 Prozent darüber.',
    'le aliquote progressive prevedono il ventitré per cento fino a ventottomila euro, il trentacinque per cento per la fascia tra ventottomilauno e cinquantamila euro, e il quarantatré per cento oltre.',
    "- L\\'IRPEF italiana è del 35% per redditi tra 28\\'001 e 50\\'000 euro.",
    '| Da 28.001 € a 50.000 € | 35% |',
  ];
  for (const s of positivi) {
    const hits = secondoScaglioneSuperato(s);
    assert.equal(hits.length, 1, `non visto: ${s}`);
    assert.equal(hits[0].storico, false, `scambiato per storico: ${s}`);
  }
});

test('il rilevatore lascia passare il 35% storico e quello che non è IRPEF', () => {
  const storici = [
    'Per i redditi 2024–2025 sono indicate le aliquote 23%, 35% e 43%.',
    '- IRPEF lorda su 56.667 € con gli scaglioni 2025 (23%, 35%, 43%): 17.007 €',
    '- Brutto-IRPEF auf 56.667 € nach den Tarifstufen 2025 (23%, 35%, 43%): 17.007 €',
  ];
  for (const s of storici) {
    const hits = secondoScaglioneSuperato(s);
    assert.equal(hits.length, 1, `la frase storica deve essere vista: ${s}`);
    assert.equal(hits[0].storico, true, `non riconosciuta come 2024-2025: ${s}`);
  }
  const nonStorici = [
    // regime transitorio, data d'entrata in vigore e numero della legge non sono l'anno d'imposta
    'IRPEF per i vecchi frontalieri (regime transitorio 2024-2033): 23% fino €28.000, 35% €28.001–50.000, 43% oltre.',
    'IRPEF (Legge 199/2025): 23% fino a €28.000, 35% tra €28.001 e €50.000, 43% oltre €50.000.',
    "In vigore dal 1° gennaio 2024: l\\'IRPEF è del 23% fino a €28.000, del 35% tra €28.001 e €50.000 e del 43% oltre.",
    'Effective January 1, 2024, IRPEF applies 23% up to €28,000, 35% from €28,001 to €50,000 and 43% above.',
  ];
  for (const s of nonStorici) {
    const hits = secondoScaglioneSuperato(s);
    assert.equal(hits.length, 1, s);
    assert.equal(hits[0].storico, false, `scambiata per storica: ${s}`);
  }
  const fuori = [
    'Il 35% dei frontalieri sceglie la LAMal.',
    'La ritenuta sui capitali è del 35% in Svizzera.',
    'Il carico complessivo medio è del 30-35%.',
    // la terna corretta
    "L\\'IRPEF (Legge 199/2025, art. 1, c. 3): 23% fino a €28.000, 33% tra €28.001 e €50.000, 43% oltre €50.000.",
  ];
  for (const s of fuori) assert.deepEqual(secondoScaglioneSuperato(s), [], `falso positivo: ${s}`);
});

test('il gate guarda davvero il corpus: tutti i corpi e le frasi STORICO-OK', () => {
  const { files, storici } = corpus();
  // ~6'200 slug per 4 lingue: un gate che scandisce una cartella vuota passa
  // senza guardare, ed e' peggio di nessun gate.
  assert.ok(files > 20000, `scanditi solo ${files} corpi`);
  // Le frasi STORICO-OK di #1876: viste dal rilevatore e lasciate passare.
  for (const slug of ['gornate-olona-regime-fiscale', 'guida-dichiarazione-redditi-frontalieri']) {
    assert.ok(storici.some((h) => h.slug === slug), `${slug}: la frase 2024-2025 non è più vista`);
  }
});

test('nessun 35% vigente del secondo scaglione fuori dalla lista dei residui', () => {
  const offenders = corpus().vigenti.filter((h) => !Object.hasOwn(RESIDUI, h.slug));
  assert.deepEqual(
    offenders.map((h) => `IRPEF ${SUPERATA}% vigente riapparso nel corpus: ${h.slug} (${h.locale}) — `
      + `${h.rel}:${h.line} «${excerpt(h.sentence)}»; dal ${IRPEF_ANNO_CORRENTE} è ${VIGENTE}% (Legge 199/2025, art. 1, c. 3)`),
    [],
  );
});

test('la lista dei residui scende soltanto (ratchet)', () => {
  const found = {};
  for (const h of corpus().vigenti) {
    if (!Object.hasOwn(RESIDUI, h.slug)) continue;
    found[h.slug] ??= {};
    found[h.slug][h.locale] = (found[h.slug][h.locale] || 0) + 1;
  }
  const problems = [];
  for (const [slug, entry] of Object.entries(RESIDUI)) {
    assert.ok(entry.motivo && entry.motivo.length > 20, `${slug}: residuo senza motivo`);
    for (const locale of LOCALES) {
      const allowed = entry[locale] || 0;
      const seen = found[slug]?.[locale] || 0;
      const rel = `content/${fs.existsSync(path.join(ROOT, 'content', 'blog-body', locale, `${slug}.ts`)) ? 'blog-body' : 'blog-body-ch'}/${locale}/${slug}.ts`;
      if (seen > allowed) {
        problems.push(`IRPEF ${SUPERATA}% vigente riapparso nel corpus: ${slug} (${locale}) — ${rel}: ${seen} occorrenze, il residuo ne ammette ${allowed}`);
      } else if (seen < allowed) {
        problems.push(`${rel}: ${seen} occorrenze invece di ${allowed} — il residuo è sceso, abbassa ${slug}.${locale} a ${seen}${seen === 0 && Object.keys(entry).length === 2 ? ' (o togli la voce)' : ''}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
