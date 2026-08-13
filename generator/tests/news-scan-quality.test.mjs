/**
 * Qualita' della scansione fonti in create-article.mjs. `node --test`. Issue #190.
 *
 * Tre difetti misurati durante la PR #187, tutti e tre invisibili nei log:
 *
 *  (a) il budget delle headline senza data era un cap GLOBALE
 *      (`undated.slice(0, 120)`) riempito nell'ordine dell'array delle fonti.
 *      swissinfo.ch stava per prima ed emette ~244 link undated, quasi tutti
 *      chrome: si prendeva **120 slot su 120**, e le 26 headline di economia
 *      svizzera di cdt.ch non venivano scartate da un gate — non arrivavano.
 *      La PR #187 ha riordinato la lista, cioe' ha aggirato il difetto: basta
 *      che una fonte prolifica torni in cima perche' il danno si ripeta.
 *
 *  (b) `extractDatesFromHtml` riconosceva DUE forme, `<time datetime>` e
 *      `DD.MM.YYYY` dentro l'anchor. Nessuna delle 9 fonti HTML usa l'una o
 *      l'altra, quindi nessuna produceva mai una data e tutte competevano per
 *      gli stessi slot: e' il moltiplicatore che rendeva costoso (a).
 *
 *  (c) `sources.{succeeded,failed}` ha due stati, e il terzo e' quello che
 *      conta: «ha risposto e non ha prodotto nulla». santesuisse.ch e' vissuto
 *      mesi in lista 301'ando ogni path su un altro sito, contato fra i
 *      successi in OGNI log.
 *
 * Il quarto punto della issue (due fonti morte rimaste nella lista frontaliere)
 * e' verificato in news-sources-svizzera.test.mjs, che e' dove vivono i
 * contratti statici sulle due liste.
 *
 * Niente rete, come per news-sources-svizzera.test.mjs: un test che scarica e'
 * un test che diventa rosso quando una redazione ha un pomeriggio storto.
 * Le funzioni pure sono ESTRATTE dal sorgente e valutate in sandbox — questo
 * repo non installa node_modules e create-article.mjs non e' importabile.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CREATE_ARTICLE = path.join(ROOT, 'generator', 'scripts', 'create-article.mjs');
const SRC = fs.readFileSync(CREATE_ARTICLE, 'utf-8');

function sliceBlock(startNeedle, fnNeedle) {
  const start = SRC.indexOf(startNeedle);
  const fnStart = SRC.indexOf(fnNeedle);
  assert.notEqual(start, -1, `delimitatore non trovato: ${startNeedle}`);
  assert.notEqual(fnStart, -1, `delimitatore non trovato: ${fnNeedle}`);
  assert.ok(fnStart >= start, 'delimitatori in ordine inverso');
  const endRel = SRC.slice(fnStart).search(/\n\}\n/);
  assert.notEqual(endRel, -1, `chiusura non trovata per ${fnNeedle}`);
  return SRC.slice(start, fnStart + endRel + 2);
}

function sandbox(code, returnExpr) {
  return new Function(`${code.replace(/^export /gm, '')}\nreturn ${returnExpr};`)();
}

const { selectUndatedBySourceQuota, UNDATED_TOTAL_BUDGET, UNDATED_PER_SOURCE_QUOTA } = sandbox(
  sliceBlock('export const UNDATED_TOTAL_BUDGET = 120;', 'export function selectUndatedBySourceQuota(undated, opts = {}) {'),
  '{ selectUndatedBySourceQuota, UNDATED_TOTAL_BUDGET, UNDATED_PER_SOURCE_QUOTA }',
);

const { parseHeadlineDate, RECOGNIZED_HEADLINE_DATE_FORMATS } = sandbox(
  sliceBlock('export const RECOGNIZED_HEADLINE_DATE_FORMATS = [', 'function monthFormatTag(name) {'),
  '{ parseHeadlineDate, RECOGNIZED_HEADLINE_DATE_FORMATS }',
);

const headlines = (source, n) => Array.from({ length: n }, (_, i) => ({ source, url: `https://${source}/${i}`, headline: `${source} ${i}` }));

// ── (a) Quota per fonte ────────────────────────────────────────────────────

describe('(a) budget undated: quota per fonte, non cap globale', () => {
  it('nessuna fonte supera la propria quota, per prolifica che sia', () => {
    const pool = [...headlines('swissinfo.ch', 244), ...headlines('cdt.ch', 26)];
    const { perSourceCounts } = selectUndatedBySourceQuota(pool);
    for (const [source, n] of perSourceCounts) {
      assert.ok(n <= UNDATED_PER_SOURCE_QUOTA, `${source} ha preso ${n} slot (quota ${UNDATED_PER_SOURCE_QUOTA})`);
    }
  });

  it('il caso reale: 244 undated di swissinfo NON svuotano il pool per cdt', () => {
    // Con `undated.slice(0, 120)` e swissinfo per prima, cdt prendeva 0 su 26.
    const pool = [...headlines('swissinfo.ch', 244), ...headlines('cdt.ch', 26)];
    const { picked, perSourceCounts } = selectUndatedBySourceQuota(pool);
    assert.ok(perSourceCounts.get('cdt.ch') > 0, 'cdt.ch non ha ottenuto un solo slot: e’ di nuovo il difetto');
    assert.equal(perSourceCounts.get('cdt.ch'), Math.min(26, UNDATED_PER_SOURCE_QUOTA));
    assert.ok(picked.length <= UNDATED_TOTAL_BUDGET);
  });

  it('l’ORDINE della lista non cambia quanto prende ciascuna fonte', () => {
    // E' l'invariante che #187 non ha ottenuto riordinando: la fix vale se il
    // riordino diventa irrilevante, non se ne serve uno migliore.
    const a = [...headlines('swissinfo.ch', 244), ...headlines('cdt.ch', 26), ...headlines('seco.admin.ch', 22)];
    const b = [...headlines('seco.admin.ch', 22), ...headlines('cdt.ch', 26), ...headlines('swissinfo.ch', 244)];
    const countsA = Object.fromEntries(selectUndatedBySourceQuota(a).perSourceCounts);
    const countsB = Object.fromEntries(selectUndatedBySourceQuota(b).perSourceCounts);
    assert.deepEqual(countsA, countsB, 'riordinare la lista cambia ancora chi entra nel pool');
  });

  it('rispetta il budget globale quando le fonti sono molte', () => {
    const pool = Array.from({ length: 30 }, (_, i) => headlines(`fonte${i}.ch`, 40)).flat();
    const { picked } = selectUndatedBySourceQuota(pool);
    assert.equal(picked.length, UNDATED_TOTAL_BUDGET);
    assert.equal(new Set(picked.map((h) => h.source)).size, 30, 'con budget capiente ogni fonte deve entrare');
  });

  it('le headline senza `source` non ereditano la quota di tutte le altre insieme', () => {
    const pool = [...headlines('cdt.ch', 5), ...Array.from({ length: 200 }, (_, i) => ({ url: `https://x/${i}` }))];
    const { perSourceCounts } = selectUndatedBySourceQuota(pool);
    assert.ok(perSourceCounts.get('(fonte sconosciuta)') <= UNDATED_PER_SOURCE_QUOTA);
    assert.equal(perSourceCounts.get('cdt.ch'), 5);
  });

  it('riporta chi e’ stato tagliato dalla quota', () => {
    // Informazione che il cap globale non poteva produrre: non sapeva di chi
    // fossero gli slot che stava dando via.
    const { capped } = selectUndatedBySourceQuota([...headlines('swissinfo.ch', 244)]);
    assert.equal(capped.length, 1);
    assert.deepEqual(capped[0], { source: 'swissinfo.ch', available: 244, taken: UNDATED_PER_SOURCE_QUOTA });
  });

  it('il cap globale non e’ piu’ nel sorgente e la quota e’ cablata', () => {
    assert.equal(SRC.includes('undated.slice(0, 120)'), false, 'il cap globale e’ tornato');
    assert.match(SRC, /const \{ picked, perSourceCounts, capped \} = selectUndatedBySourceQuota\(undated\);/);
  });
});

// ── (b) Formati data ───────────────────────────────────────────────────────

describe('(b) formati data riconosciuti nelle liste HTML', () => {
  const SAMPLES = {
    'time-datetime': '<time datetime="2026-08-12T09:30:00+02:00">12 agosto</time>',
    'dd.mm.yyyy': '<div class="data">12.08.2026</div>',
    'dd/mm/yyyy': 'Pubblicato il 12/08/2026',
    'iso-yyyy-mm-dd': '<span>2026-08-12</span>',
    'it-textual': 'Pubblicato il 12 agosto 2026',
    'de-textual': 'Publiziert am 12. August 2026',
    'fr-textual': 'Publié le 12 août 2026',
    'en-textual': 'Published August 12, 2026',
  };

  it('sono piu’ di due — il difetto era proprio che fossero due', () => {
    assert.ok(
      RECOGNIZED_HEADLINE_DATE_FORMATS.length > 2,
      `solo ${RECOGNIZED_HEADLINE_DATE_FORMATS.length} formati dichiarati`,
    );
  });

  it('ogni formato dichiarato ha un campione che lo produce davvero', () => {
    // Senza questo, l'elenco potrebbe crescere per documentazione mentre il
    // parser resta fermo: e' la forma di falso verde piu' facile da scrivere.
    for (const format of RECOGNIZED_HEADLINE_DATE_FORMATS) {
      const sample = SAMPLES[format];
      assert.ok(sample, `formato dichiarato senza campione nel test: ${format}`);
      const hit = parseHeadlineDate(sample);
      assert.ok(hit, `nessuna data estratta da "${sample}" (formato ${format})`);
      assert.equal(hit.format, format, `"${sample}" letto come ${hit.format} invece che ${format}`);
      assert.equal(hit.date.getFullYear(), 2026);
    }
  });

  it('ogni campione risolve al 12 agosto 2026, qualunque sia la forma', () => {
    for (const [format, sample] of Object.entries(SAMPLES)) {
      const { date } = parseHeadlineDate(sample);
      assert.equal(date.getUTCMonth(), 7, `${format}: mese sbagliato`);
      assert.ok([11, 12].includes(date.getUTCDate()), `${format}: giorno ${date.getUTCDate()}`);
    }
  });

  it('rifiuta le date calendarialmente impossibili, in TUTTE le forme', () => {
    // Il costruttore locale di Date accetta 31 aprile e lo sposta al 1 maggio
    // senza dirlo. La guardia esisteva solo per DD.MM.YYYY.
    for (const impossible of ['31.04.2026', '30/02/2026', '2026-02-30', '31 aprile 2026', 'February 30, 2026']) {
      assert.equal(parseHeadlineDate(impossible), null, `accettata una data impossibile: ${impossible}`);
    }
  });

  it('non inventa date dove non ce ne sono', () => {
    for (const noise of ['Aumento del 12% nel settore', 'Ticino 2026: il bilancio', '', null, undefined]) {
      assert.equal(parseHeadlineDate(noise), null, `falso positivo su: ${noise}`);
    }
  });

  it('extractDatesFromHtml usa il parser condiviso, non piu’ una regex propria', () => {
    const at = SRC.indexOf('function extractDatesFromHtml(html, baseUrl) {');
    assert.notEqual(at, -1);
    const body = SRC.slice(at, SRC.indexOf('\n}\n', at));
    assert.match(body, /parseHeadlineDate\(inner\)/, 'l’anchor non passa piu’ dal parser condiviso');
    assert.match(body, /parseHeadlineDate\(before\) \|\| parseHeadlineDate\(after\)/, 'manca il recupero dai frammenti adiacenti');
  });
});

// ── (c) Terzo stato della fonte ────────────────────────────────────────────

describe('(c) una fonte che risponde 200 e non produce nulla e’ «sterile», non «riuscita»', () => {
  it('RUN_REPORT dichiara i tre stati piu’ l’elenco delle sterili', () => {
    const at = SRC.indexOf('  sources: {');
    assert.notEqual(at, -1, 'blocco RUN_REPORT.sources non trovato');
    const block = SRC.slice(at, SRC.indexOf('\n  },', at));
    for (const field of ['succeeded: 0', 'sterile: 0', 'failed: 0', 'sterileDomains: []']) {
      assert.ok(block.includes(field), `RUN_REPORT.sources non dichiara ${field}`);
    }
  });

  it('`succeeded` viene incrementato UNA sola volta, e solo dopo aver escluso il caso sterile', () => {
    const incs = [...SRC.matchAll(/RUN_REPORT\.sources\.succeeded \+= 1;/g)];
    assert.equal(incs.length, 1, `${incs.length} incrementi di sources.succeeded: uno solo deve esistere`);
    const before = SRC.slice(Math.max(0, incs[0].index - 700), incs[0].index);
    assert.match(before, /if \(produced === 0\) \{/, 'l’incremento non e’ protetto dal ramo sterile');
    assert.match(before, /RUN_REPORT\.sources\.sterile \+= 1;/);
    assert.match(before, /return \[\];/, 'il ramo sterile deve uscire prima di contarsi fra i successi');
  });

  it('le tre classi finiscono a log, e le sterili per nome', () => {
    // Un dominio morto che risponde 200 restava invisibile in OGNI log: e' la
    // frase della issue, ed e' questa riga a smentirla.
    assert.match(SRC, /produttive, .*sterili, .*fallite/s);
    assert.match(SRC, /Sterili: \$\{RUN_REPORT\.sources\.sterileDomains\.join\(', '\)\}/);
  });
});
