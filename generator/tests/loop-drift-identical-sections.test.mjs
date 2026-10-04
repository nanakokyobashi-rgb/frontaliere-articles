/**
 * loop-drift-identical-sections.test.mjs — `section-drift`: una sezione
 * dichiarata byte-identica dentro un file `adapted` che diverge fra sito e
 * corpus.
 *
 * ## Il caso che l'ha resa necessaria
 *
 * La `reason` della voce `generator/scripts/lib/free-translate.mjs` diceva da
 * settimane che la sezione `Codex Luna Max` e' byte-identica nei due repo, per
 * decisione del proprietario. Era solo prosa: il 2026-10-04 corpus #2118 (date
 * localizzate, issue 2113) e #2119 (eco del prompt) l'hanno cambiata solo qui,
 * la PR gemella del sito non e' mai stata aperta, e `translate-pending.yml`
 * esegue la copia del SITO. Sul file intero il verdetto era `corpus-ahead`, lo
 * stesso di qualunque adattamento locale legittimo: niente distingueva una
 * sezione rotta da un adattamento voluto.
 *
 * ## Cosa pinna
 *
 *   - una differenza FUORI dalla sezione non conta (il file resta `adapted`);
 *   - una differenza DENTRO la sezione e' `section-drift`, actionable, anche
 *     quando il verdetto sul file intero era `stable` (una riattestazione non
 *     la spegne: il confronto e' sui byte attuali, non sulla baseline);
 *   - un marcatore sparito o una dichiarazione malformata fallisce chiuso;
 *   - la voce reale del manifest dichiara la sezione e i due marcatori esistono
 *     nel file del corpus: rinominarli qui rende rossa questa suite in PR, non
 *     il report del giorno dopo.
 *
 * Offline: i byte del sito sono fixture, nessuna rete.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  identicalSectionsVerdict,
  withIdenticalSections,
  SECTION_DRIFT_STATE,
} from '../../scripts/ci/loop-drift-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const START = '// ── Codex Luna Max (decisione del proprietario, 2026-09-25)';
const END = '// ── Google Cloud Translation';
const ENTRY = { path: 'generator/scripts/lib/free-translate.mjs', mode: 'adapted', identicalSections: [{ start: START, end: END }] };

const SECTION = `${START} ────\nconst rule = '- Localize dates using the target language\\'s customary format';\n\n`;
const file = ({ before = 'const prima = 1;\n', section = SECTION, after = 'export const dopo = 2;\n' } = {}) =>
  Buffer.from(`${before}${section}${END} (official API) ──\n${after}`, 'utf8');

const STABLE = { state: 'stable', actionable: false, headline: 'allineato', detail: '' };

test('sezione uguale e resto del file diverso: nessun section-drift (il file resta adapted)', () => {
  const verdict = identicalSectionsVerdict(ENTRY, {
    site: file({ before: 'const soloSito = true;\n', after: 'export const tierSito = 1;\n' }),
    corpus: file({ before: 'const soloCorpus = true;\n', after: 'export const tierCorpus = 2;\n' }),
  });
  assert.equal(verdict.checked, true);
  assert.equal(verdict.drift, false);
  assert.equal(verdict.sections[0].site, verdict.sections[0].corpus);
  assert.match(verdict.sections[0].site, /^[0-9a-f]{16}$/);
  assert.equal(withIdenticalSections(ENTRY, STABLE, { site: file(), corpus: file() }), STABLE);
});

test('una riga diversa DENTRO la sezione e\' section-drift, anche su un file stable', () => {
  const site = file({ section: SECTION.replace('Localize dates using the target language\\\'s customary format', 'Copy unchanged: URLs, numbers, amounts, dates') });
  const corpus = file();
  const sections = identicalSectionsVerdict(ENTRY, { site, corpus });
  assert.equal(sections.drift, true);
  assert.notEqual(sections.sections[0].site, sections.sections[0].corpus);
  assert.match(sections.detail, new RegExp(`sito ${sections.sections[0].site} ≠ corpus ${sections.sections[0].corpus}`));

  const verdict = withIdenticalSections(ENTRY, STABLE, { site, corpus });
  assert.equal(verdict.state, SECTION_DRIFT_STATE);
  assert.equal(verdict.state, 'section-drift');
  assert.equal(verdict.actionable, true);
  assert.equal(verdict.fileState, 'stable');
  assert.match(verdict.detail, /Verdetto sul file intero: `stable`/);
});

test('il verdetto sul file intero resta leggibile quando era gia\' actionable', () => {
  const corpusAhead = { state: 'corpus-ahead', actionable: true, headline: 'modificato qui, fermo sul sito', detail: '' };
  const verdict = withIdenticalSections(ENTRY, corpusAhead, { site: file({ section: `${START}\nvecchia\n` }), corpus: file() });
  assert.equal(verdict.state, 'section-drift');
  assert.equal(verdict.fileState, 'corpus-ahead');
  assert.match(verdict.detail, /`corpus-ahead` \(modificato qui, fermo sul sito\)/);
});

test('un byte di spazio in piu\' nella sezione conta: il confronto e\' sui byte, non sul testo normalizzato', () => {
  const verdict = identicalSectionsVerdict(ENTRY, { site: file({ section: `${SECTION} ` }), corpus: file() });
  assert.equal(verdict.drift, true);
});

test('la sezione finisce al PRIMO marcatore di fine dopo l\'inizio, escluso', () => {
  // Un secondo `END` piu' avanti nel file non allarga la sezione.
  const tail = `${END} (doppione piu' avanti)\n`;
  const site = file({ after: `export const x = 1;\n${tail}` });
  const corpus = file({ after: `export const y = 2;\n${tail}` });
  assert.equal(identicalSectionsVerdict(ENTRY, { site, corpus }).drift, false);
});

test('un marcatore sparito su un lato fallisce chiuso, col lato nominato', () => {
  const noStart = Buffer.from(file().toString('utf8').replace(START, '// ── Codex (rinominata)'), 'utf8');
  const noEnd = Buffer.from(file().toString('utf8').replace(END, '// ── Google (rinominata)'), 'utf8');
  for (const [site, corpus, missing] of [
    [noStart, file(), 'site: start'],
    [file(), noEnd, 'corpus: end'],
    [null, file(), 'site: file'],
  ]) {
    const verdict = identicalSectionsVerdict(ENTRY, { site, corpus });
    assert.equal(verdict.drift, true, missing);
    assert.deepEqual(verdict.sections[0].missing, [missing]);
    assert.match(verdict.detail, /marcatore assente/);
  }
});

test('una dichiarazione malformata e\' section-drift, non un silenzio', () => {
  for (const identicalSections of [[], [{ start: START }], [{ start: '', end: END }], 'sezione', null]) {
    const verdict = identicalSectionsVerdict({ ...ENTRY, identicalSections }, { site: file(), corpus: file() });
    assert.equal(verdict.drift, true, JSON.stringify(identicalSections));
    assert.match(verdict.detail, /malformata/);
  }
});

test('senza identicalSections la voce non e\' toccata', () => {
  const entry = { path: 'x.mjs', mode: 'adapted' };
  assert.deepEqual(identicalSectionsVerdict(entry, { site: file(), corpus: file({ section: 'altro' }) }), {
    checked: false, drift: false, sections: [], detail: '',
  });
  assert.equal(withIdenticalSections(entry, STABLE, { site: file(), corpus: file({ section: 'altro' }) }), STABLE);
});

test('la voce reale di free-translate.mjs dichiara la sezione Codex, e i marcatori esistono nel file del corpus', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/loop-sync-manifest.json'), 'utf8'));
  const declared = manifest.files.filter((f) => f.identicalSections !== undefined);
  const entry = declared.find((f) => f.path === 'generator/scripts/lib/free-translate.mjs');
  assert.ok(entry, 'la voce di free-translate.mjs deve dichiarare identicalSections');
  assert.equal(entry.mode, 'adapted');
  assert.deepEqual(entry.identicalSections, [{ start: START, end: END }]);
  for (const f of declared) {
    // Ogni sezione dichiarata deve esistere UNA volta nel file del corpus: con
    // il sito il confronto lo fa il cron, ma un marcatore rinominato qui si
    // vede gia' in PR.
    const source = fs.readFileSync(path.join(ROOT, f.path));
    const verdict = identicalSectionsVerdict(f, { site: source, corpus: source });
    assert.equal(verdict.drift, false, `${f.path}: ${verdict.detail}`);
    for (const { start } of f.identicalSections) {
      assert.equal(source.toString('utf8').split(start).length - 1, 1, `${f.path}: \`${start}\` deve comparire una volta sola`);
    }
  }
});
