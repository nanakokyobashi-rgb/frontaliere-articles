/**
 * ── LA BONIFICA NON DEVE POTER PEGGIORARE UNA PAGINA ───────────────────────
 *
 * `retranslate-blocking-bodies.mjs` riscrive body-locale GIA' PUBBLICATI. E'
 * la sola cosa in questo repo che lo faccia, ed e' esattamente la classe di
 * script che nel 2026-07 ha distrutto dei titoli: un detector al 33% di falsi
 * positivi che "riparava" il testo che aveva segnalato.
 *
 * La differenza qui non e' la buona intenzione, e' il verdetto: il testo nuovo
 * esce dalla cascata MT (`translateFieldFreeMt`) e viene scritto SOLO se la
 * guardia di factuality lo accetta con zero `critical`. Se la ri-traduzione
 * ri-fallisce, la pagina pubblicata resta com'e'.
 *
 * Questo test blinda quel verdetto e la meccanica di scrittura, cioe' i due
 * modi in cui lo script potrebbe fare danno:
 *
 *   1. `shouldWrite()` — scrivere una traduzione che la guardia rifiuta
 *      ancora, o cucita a meta' perche' un campo e' tornato vuoto dalla
 *      cascata. Sono i tre `return {write:false}`: senza di loro lo script
 *      pubblica esattamente il difetto che doveva togliere.
 *   1-bis. `translationSanityIssue()` — i modi in cui una ri-traduzione resta
 *      inutilizzabile dopo la guardia condivisa sul passthrough esatto: un
 *      taglio a 2000 caratteri della sorgente (il tier HuggingFace) che lascia
 *      marker bilanciati e zero `critical`, oppure un residuo italiano in un
 *      solo campo. Il controllo per-campo resta anche difesa indipendente per
 *      i chiamanti diretti della funzione.
 *   2. `replaceBodyField()` — sostituire il campo giusto ma corrompere il
 *      resto del file. Il round-trip verifica che riscrivere un campo col
 *      proprio valore sia un no-op byte per byte, e che un valore con
 *      apostrofi, backslash e newline (cioe' la prosa vera) sopravviva alla
 *      coppia escape/unescape senza spostare le altre chiavi.
 *
 * `stratify()` e' qui perche' il pilota che decide se bruciare wall-clock su
 * centinaia di coppie deve coprire piu' codici: prendere "i primi N" di una
 * lista ordinata per id misura UN difetto e lo dichiara rappresentativo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shouldWrite,
  translationSanityIssue,
  LENGTH_FLOOR,
  replaceBodyField,
  insertBodyField,
  readBodyField,
  escapeForSingleQuoteTS,
  stratify,
  blockingPairsFromAudit,
  criticalCodes,
  guardTranslatedKeyFacts,
  parseSlugList,
  parseLocaleList,
  pairsForSlugs,
  selectBlockingPairs,
  rewriteExistingLocaleBody,
  sanitizeTranslatedField,
  inlineBoolean,
  ITALIAN_RESIDUE_MIN_LINES,
  scanItalianResidue,
  hasItalianResidue,
  currentBlockingCodes,
  bodyFieldsForSource,
  blockingPairsFromContent,
  scanContentForBlockingPairs,
} from '../scripts/retranslate-blocking-bodies.mjs';
// Dal modulo corpus-only, NON da `lib/article-sanitizers.mjs`: quello e'
// `identical` nel manifest del ciclo e un export aggiunto dal corpus lo
// renderebbe `corpus-ahead`. Questo import pinna anche la collocazione.
import { sanitizeBodyText } from '../scripts/lib/sanitize-body-braces.mjs';
// L'ALTRO scrittore per-locale che gatta la scrittura sulla lingua: stessa
// classe, stesso rimedio — la verifica guarda l'unita' tradotta, non il testo
// concatenato.
import { filterWrongLocalePairs, wrongLocalePair } from '../scripts/fix-faq-locales.mjs';
import { detectLanguage, detectLanguageWithConfidence } from '../scripts/lib/detect-language.mjs';

const fileFor = (id, fields) => `const b: Record<string, string> = {\n`
  + Object.entries(fields).map(([k, v]) => `  'blog.article.${id}.${k}': '${escapeForSingleQuoteTS(v)}',`).join('\n')
  + `\n};\n\nexport default b;\n`;

test('shouldWrite rifiuta una ri-traduzione che la guardia boccia ancora', () => {
  const v = shouldWrite({ oldCodes: ['unbalanced-parentheses'], newCodes: ['unbalanced-parentheses'], missingField: null });
  assert.equal(v.write, false);
  assert.match(v.reason, /ri-fallita/);
});

test('shouldWrite rifiuta anche quando il codice nuovo e diverso dal vecchio', () => {
  // Un difetto SOSTITUITO da un altro difetto resta un difetto: la condizione
  // e' "zero critical", non "non gli stessi critical di prima".
  const v = shouldWrite({ oldCodes: ['truncated-bold'], newCodes: ['translation-false-friend'], missingField: null });
  assert.equal(v.write, false);
});

test('shouldWrite rifiuta se un campo e tornato vuoto dalla cascata', () => {
  // Mezza traduzione nuova cucita su mezza vecchia sarebbe testo che nessuna
  // pipeline ha mai prodotto: si salta l'articolo intero.
  const v = shouldWrite({ oldCodes: ['truncated-bold'], newCodes: [], missingField: 'body2' });
  assert.equal(v.write, false);
  assert.equal(v.reason, 'campo-vuoto-dalla-cascata');
});

test('shouldWrite non tocca una pagina che la guardia gia accetta', () => {
  const v = shouldWrite({ oldCodes: [], newCodes: [], missingField: null });
  assert.equal(v.write, false);
  assert.equal(v.reason, 'vecchia-gia-pulita');
});

test('shouldWrite scrive solo bloccante-prima e pulita-dopo', () => {
  const v = shouldWrite({ oldCodes: ['truncated-bold'], newCodes: [], missingField: null });
  assert.deepEqual(v, { write: true, reason: 'pulita' });
});

test('FU-009 — shouldWrite consente il backfill solo se il difetto strutturale è dichiarato', () => {
  assert.deepEqual(
    shouldWrite({ oldCodes: [], newCodes: [], missingField: null }),
    { write: false, reason: 'vecchia-gia-pulita' },
  );
  assert.deepEqual(
    shouldWrite({ oldCodes: ['missing-key'], newCodes: [], missingField: null, structuralDefect: true }),
    { write: true, reason: 'pulita' },
  );
});

test('la ri-traduzione rifiuta i fatti chiave vacui sotto soglia', () => {
  const body1 = [
    '## Fatti chiave',
    '- **Cosa**: assegno familiare.',
    '- **Quando**: non specificato.',
    '- **Dove**: Cantone di Zugo.',
  ].join('\n');
  const guarded = guardTranslatedKeyFacts({ body1, body2: 'testo' });
  assert.equal(guarded.changed, false);
  assert.equal(guarded.sections.body1, body1);
  assert.match(guarded.issue, /key-facts-specificity/);
  assert.equal(
    shouldWrite({ oldCodes: ['truncated-bold'], newCodes: [], missingField: null, qualityIssue: guarded.issue }).write,
    false,
  );
});

test('la ri-traduzione può togliere un fatto vuoto se restano tre superstiti', () => {
  const body1 = [
    '## Fatti chiave',
    '- **Cosa**: assegno familiare.',
    '- **Quando**: non specificato.',
    '- **Dove**: Cantone di Zugo.',
    '- **Chi**: cittadini residenti.',
    '- **Importo**: CHF 200-300 al mese.',
  ].join('\n');
  const guarded = guardTranslatedKeyFacts({ body1 });
  assert.equal(guarded.issue, null);
  assert.equal(guarded.changed, true);
  assert.doesNotMatch(guarded.sections.body1, /non specificato/i);
});

test('la riparazione strutturale conserva un residuo esplicito già presente nella fonte', () => {
  const body1 = [
    '## Key facts',
    '- **What**: family allowance.',
    '- Where: Canton of Jura.',
    '- Amount: Defined by cantonal scales (not yet specified in detail).',
  ].join('\n');
  const guarded = guardTranslatedKeyFacts({ body1 }, {
    maxSourceBackedResiduals: 1,
  });
  assert.equal(guarded.issue, null);
  assert.equal(guarded.changed, false);
});

test('la ri-traduzione rifiuta una sezione Fatti chiave eliminata o rinominata', () => {
  const guarded = guardTranslatedKeyFacts({
    body1: [
      '## Informazioni importanti',
      '- **Cosa**: assegno familiare.',
      '- **Quando**: 2026.',
      '- **Dove**: Cantone di Zugo.',
    ].join('\n'),
  });
  assert.equal(guarded.changed, false);
  assert.match(guarded.issue, /sezione Fatti chiave riconosciuta/);
  assert.equal(
    shouldWrite({ oldCodes: ['truncated-bold'], newCodes: [], missingField: null, qualityIssue: guarded.issue }).write,
    false,
  );
});

test('la ri-traduzione accetta una sezione riconosciuta con uno o due fatti non vacui', () => {
  for (const facts of [
    ['- **Cosa**: assegno familiare.'],
    [
      '- **Cosa**: assegno familiare.',
      '- **Dove**: Cantone di Zugo.',
    ],
  ]) {
    const body1 = ['## Fatti chiave', ...facts].join('\n');
    const guarded = guardTranslatedKeyFacts({ body1 });
    assert.equal(guarded.issue, null);
    assert.equal(guarded.changed, false);
    assert.equal(guarded.sections.body1, body1);
  }
});

test('la ri-traduzione rifiuta fatti vuoti, solo punteggiatura e prosa vacua residua', () => {
  for (const body1 of [
    ['## Fatti chiave', '- **Cosa**:'].join('\n'),
    ['## Fatti chiave', '- **Cosa**: —'].join('\n'),
    ['## Fatti chiave', '- **Importo**: Gli importi non sono ancora specificati.'].join('\n'),
  ]) {
    const guarded = guardTranslatedKeyFacts({ body1 });
    assert.equal(guarded.changed, false);
    assert.match(guarded.issue, /non vuoto\/non vacuo/);
  }
});

test('la guardia dei fatti chiave sta prima del gate e della scrittura atomica', () => {
  const source = fs.readFileSync(
    new URL('../scripts/retranslate-blocking-bodies.mjs', import.meta.url),
    'utf8',
  );
  const guard = source.indexOf('guardTranslatedKeyFacts(newSections,');
  const gate = source.indexOf('runFactualityGates({ sections: checkedSections');
  const filteredWrite = source.indexOf('rewriteExistingLocaleBody(trSrc, pair.id, checkedSections, {');
  const write = source.indexOf('writeAtomic(trPath, rewritten.src)');
  assert.ok(guard >= 0 && guard < gate, 'la factuality gate deve ricevere il payload gia\' guardato');
  assert.ok(gate < filteredWrite && filteredWrite < write, 'la scrittura deve persistere il payload gia\' guardato dopo tutti i gate');
});

test('replaceBodyField col valore attuale e un no-op byte per byte', () => {
  const src = fileFor('x', { body1: 'uno **grassetto**', body2: 'due (con parentesi)', body3: 'tre' });
  const current = readBodyField(src, 'x', 'body2');
  assert.equal(current, 'due (con parentesi)');
  assert.equal(replaceBodyField(src, 'x', 'body2', current), src);
});

test('replaceBodyField preserva prosa con apostrofi, backslash e newline', () => {
  const src = fileFor('x', { body1: 'uno', body2: 'due', body3: 'tre' });
  const tricky = "l'articolo dice \\ e poi\nva a capo con 'virgolette'";
  const out = replaceBodyField(src, 'x', 'body2', tricky);
  assert.equal(readBodyField(out, 'x', 'body2'), tricky);
  // Le altre chiavi non si spostano.
  assert.equal(readBodyField(out, 'x', 'body1'), 'uno');
  assert.equal(readBodyField(out, 'x', 'body3'), 'tre');
  assert.ok(out.endsWith('export default b;\n'));
});

test('replaceBodyField rende null su chiave assente invece di riscrivere a meta', () => {
  const src = fileFor('x', { body1: 'uno' });
  assert.equal(replaceBodyField(src, 'x', 'body9', 'niente'), null);
});

test('FU-009 — --missing deriva anche i body opzionali dalla sorgente italiana', () => {
  const src = fileFor('x', {
    body1: 'uno',
    body2: 'due',
    body3: 'tre',
    body4: 'quattro',
    body20: 'venti',
  });
  assert.deepEqual(bodyFieldsForSource(src, 'x'), ['body1', 'body2', 'body3', 'body4', 'body20']);
  assert.deepEqual(bodyFieldsForSource(src, 'altro'), []);
});

test('criticalCodes conta solo i critical, deduplicati', () => {
  const codes = criticalCodes({
    issues: [
      { severity: 'critical', code: 'truncated-bold' },
      { severity: 'critical', code: 'truncated-bold' },
      { severity: 'major', code: 'vague-attribution' },
    ],
  });
  assert.deepEqual(codes, ['truncated-bold']);
});

test('blockingPairsFromAudit tiene solo le coppie con almeno un critical', () => {
  const pairs = blockingPairsFromAudit({
    findings: [
      { id: 'a', locale: 'en', dir: 'services/locales/blog-body', criticalCount: 1, issues: [{ severity: 'critical', code: 'truncated-bold' }] },
      { id: 'b', locale: 'de', dir: 'services/locales/blog-body', criticalCount: 0, issues: [{ severity: 'major', code: 'x' }] },
    ],
  });
  assert.deepEqual(pairs.map((p) => p.id), ['a']);
  assert.deepEqual(pairs[0].codes, ['truncated-bold']);
});

test('blockingPairsFromAudit consuma il formato scan-v2 e crea il codice italian-residue', () => {
  const pairs = blockingPairsFromAudit({
    summary: { en: { slugs: 1, lines: 3, slugsGe3: 1 } },
    results: [
      {
        lang: 'en',
        slug: 'articolo-con-residuo',
        count: ITALIAN_RESIDUE_MIN_LINES,
        hits: Array.from({ length: ITALIAN_RESIDUE_MIN_LINES }, () => ({ field: 'body1' })),
      },
      { lang: 'de', slug: 'coda-troppo-corta', count: ITALIAN_RESIDUE_MIN_LINES - 1 },
      { lang: 'it', slug: 'sorgente', count: 20 },
    ],
  });

  assert.deepEqual(pairs, [{
    id: 'articolo-con-residuo',
    locale: 'en',
    dir: 'services/locales/blog-body',
    codes: ['italian-residue'],
  }]);
});

test('lo scan per riga vede il blocco italiano ma non una traduzione con gli stessi marker', () => {
  const residual = {
    body1: [
      '## Fatti chiave',
      '- **Cosa**: Convocazione dell’assemblea CUV per il 2026',
      '- **Dove**: Malpensa e comuni del territorio',
      '- **Problemi**: Aumento del traffico aereo e impatto ambientale',
    ].join('\n'),
  };
  const translated = {
    body1: [
      '## Key facts',
      '- **What**: The CUV assembly is planned for 2026',
      '- **Where**: Malpensa and nearby municipalities',
      '- **Issues**: Higher air traffic and environmental impact',
    ].join('\n'),
  };

  assert.equal(scanItalianResidue(residual, 'en').length, ITALIAN_RESIDUE_MIN_LINES + 1);
  assert.equal(hasItalianResidue(residual, 'en'), true);
  assert.deepEqual(scanItalianResidue(translated, 'en'), []);
  assert.equal(hasItalianResidue(translated, 'en'), false);
});

test('lo scan per riga riconosce prosa italiana comune senza segnalare il francese', () => {
  const italianBody = {
    body1: [
      'Le autorità hanno deciso nuove misure',
      'Il governo ha annunciato controlli nei cantoni',
      'L’economia locale ha bisogno di nuove strategie',
    ].join('\n'),
  };
  const italian = scanItalianResidue(italianBody, 'en');
  const french = scanItalianResidue({
    body1: 'Une frontalière du canton',
  }, 'fr');

  assert.equal(italian.length, ITALIAN_RESIDUE_MIN_LINES);
  assert.ok(italian.every((hit) => hit.reason === 'language'));
  assert.equal(hasItalianResidue(italianBody, 'en'), true);
  assert.equal(translationSanityIssue({
    oldSections: {},
    newSections: italianBody,
    italianSections: {},
    locale: 'en',
  }), 'italian-residue: 3 righe residue');
  assert.deepEqual(french, []);
});

test('lo scan ignora heading Markdown tradotti ma conserva quelli italiani canonici', () => {
  const translatedHeadings = {
    en: [
      '## In a nutshell',
      '### What to do to avoid future delays',
      '## Closure history by phase',
    ].join('\n'),
    de: [
      '## Ein Straßennetz unter Stress',
      '### Schritt 4: Digitale Tools nutzen',
      '## Praktische Analyse: Lebenslektionen von Alex Zanardi',
    ].join('\n'),
    fr: [
      '## Activités collatérales et village olympique',
      '### Délais et envoi',
      '## Contacter un avocat',
    ].join('\n'),
  };

  for (const [locale, body1] of Object.entries(translatedHeadings)) {
    assert.deepEqual(scanItalianResidue({ body1 }, locale), [], locale);
  }

  assert.deepEqual(scanItalianResidue({ body1: '## In breve' }, 'en'), [{
    field: 'body1',
    line: 1,
    reason: 'heading',
    text: 'In breve',
  }]);
});

test('lo scan conserva heading italiani non canonici anche dentro Markdown', () => {
  const body1 = [
    '## Titolo italiano non canonico',
    '> ### Nuove regole fiscali',
    '- #### Impatto sui lavoratori frontalieri',
  ].join('\n');
  const hits = scanItalianResidue({ body1 }, 'en');

  assert.equal(hits.length, ITALIAN_RESIDUE_MIN_LINES);
  assert.ok(hits.every((hit) => hit.reason === 'language'));
  assert.deepEqual(hits.map((hit) => hit.text), [
    'Titolo italiano non canonico',
    'Nuove regole fiscali',
    'Impatto sui lavoratori frontalieri',
  ]);
  assert.deepEqual(currentBlockingCodes({ italianResidue: hits }), ['italian-residue']);
  assert.equal(scanItalianResidue({ body1: '## Salari e contributi' }, 'en').length, 1);
});

test('lo scan conserva heading italiani brevi con flessioni comuni', () => {
  for (const title of ['Redditi', 'Pensioni', 'Tasse']) {
    assert.deepEqual(scanItalianResidue({ body1: `## ${title}` }, 'en'), [{
      field: 'body1',
      line: 1,
      reason: 'language',
      text: title,
    }]);
  }
});

test('lo scan conserva heading italiani brevi con segnali interrogativi comuni', () => {
  const body1 = [
    '## Come fare',
    '## Chi paga',
    '## Quando',
  ].join('\n');

  assert.deepEqual(scanItalianResidue({ body1 }, 'en'), [
    { field: 'body1', line: 1, reason: 'language', text: 'Come fare' },
    { field: 'body1', line: 2, reason: 'language', text: 'Chi paga' },
    { field: 'body1', line: 3, reason: 'language', text: 'Quando' },
  ]);
  assert.deepEqual(scanItalianResidue({ body1: '## Fiscale' }, 'en'), []);
});

test('lo scan risolve `qui` condiviso prima del fast-path francese', () => {
  const body1 = Array.from({ length: ITALIAN_RESIDUE_MIN_LINES }, () => '## Qui sono le novità').join('\n');
  const hits = scanItalianResidue({ body1 }, 'fr');
  assert.equal(hits.length, ITALIAN_RESIDUE_MIN_LINES);
  assert.ok(hits.every((hit) => hit.reason === 'language'));
  assert.equal(hasItalianResidue({ body1 }, 'fr'), true);
});

test('lo scan non conta `fiscale` come residuo nei titoli francesi', () => {
  const french = {
    body1: [
      '## Situation fiscale',
      '## Convention fiscale',
      '## Charge fiscale',
    ].join('\n'),
  };

  for (const locale of ['en', 'de', 'fr']) {
    assert.deepEqual(scanItalianResidue(french, locale), [], locale);
    assert.equal(hasItalianResidue(french, locale), false, locale);
  }
  for (const locale of ['en', 'de', 'fr']) {
    assert.deepEqual(scanItalianResidue({ body1: '## Situazione fiscale' }, locale).map((hit) => hit.text), [
      'Situazione fiscale',
    ], locale);
  }
});

test('lo scan ignora heading localizzati in blockquote, lista e forma Setext', () => {
  const body1 = [
    '> ## What to do',
    '- ## What to do to avoid future delays',
    'Closure history by phase',
    '===',
  ].join('\n');

  assert.deepEqual(scanItalianResidue({ body1 }, 'en'), []);
});

test('lo scan ignora ATX e Setext dentro fenced code con stato per campo', () => {
  const body1 = [
    '```markdown',
    '## Redditi',
    'Pensioni',
    '---',
    '```',
    '~~~markdown',
    '## Tasse',
    'Redditi',
    '---',
    '~~~',
    '## Redditi',
  ].join('\n');
  assert.deepEqual(scanItalianResidue({
    body1,
    body2: '```\n## Pensioni\n```',
  }, 'en'), [{
    field: 'body1',
    line: 11,
    reason: 'language',
    text: 'Redditi',
  }]);
});

test('lo scan non chiude un fence root con contenitori Markdown nel codice', () => {
  const body1 = [
    '```markdown',
    '- ```',
    '> ```',
    '1. ```',
    '## Redditi',
    'Pensioni',
    'Tasse',
    '```',
    '## Redditi',
  ].join('\n');

  assert.deepEqual(scanItalianResidue({ body1 }, 'en'), [{
    field: 'body1',
    line: 9,
    reason: 'language',
    text: 'Redditi',
  }]);
});

test('lo scan chiude le fence in lista sulla continuazione indentata', () => {
  const listFence = [
    '- ```markdown',
    '- ```',
    '## Redditi',
    'Pensioni',
    'Tasse',
    '  ```',
    '## Redditi',
  ].join('\n');
  const quotedListFence = [
    '> - ```markdown',
    '> - ```',
    '> ## Redditi',
    '> Pensioni',
    '> Tasse',
    '>   ```',
    '> ## Redditi',
  ].join('\n');
  const externalListFence = [
    '- > ```markdown',
    '  > codice',
    '  > ## Redditi',
    '  > Pensioni',
    '  > Tasse',
    '  > ```',
    '  > ## Redditi',
  ].join('\n');

  assert.deepEqual(scanItalianResidue({
    body1: listFence,
    body2: quotedListFence,
    body3: externalListFence,
  }, 'en'), [
    { field: 'body1', line: 7, reason: 'language', text: 'Redditi' },
    { field: 'body2', line: 7, reason: 'language', text: 'Redditi' },
    { field: 'body3', line: 7, reason: 'language', text: 'Redditi' },
  ]);
});

test('lo scan non tratta un info string backtick non valido come chiusura', () => {
  const body1 = [
    '```markdown',
    '```language`with-backtick',
    '## Redditi',
    'Pensioni',
    'Tasse',
    '```',
    '## Redditi',
  ].join('\n');

  assert.deepEqual(scanItalianResidue({ body1 }, 'en'), [{
    field: 'body1',
    line: 7,
    reason: 'language',
    text: 'Redditi',
  }]);
});

test('lo scan espande i tab prima di riconoscere fence e heading', () => {
  const body1 = [
    '\t```markdown',
    '\t## Redditi',
    '\tPensioni',
    '\tTasse',
    '\t```',
    '## Redditi',
  ].join('\n');

  assert.deepEqual(scanItalianResidue({ body1 }, 'en'), [{
    field: 'body1',
    line: 6,
    reason: 'language',
    text: 'Redditi',
  }]);
});

test('lo scan ignora anche il contenuto indentato della fence in lista', () => {
  const body1 = [
    '- ```markdown',
    '  ## Redditi',
    '  Pensioni',
    '  Tasse',
    '  ```',
    '## Redditi',
  ].join('\n');

  assert.deepEqual(scanItalianResidue({ body1 }, 'en'), [{
    field: 'body1',
    line: 6,
    reason: 'language',
    text: 'Redditi',
  }]);
});

test('lo scan richiede container compatibili tra titolo Setext e underline', () => {
  const mismatched = [
    '> Redditi italiani',
    '---',
    '- Redditi italiani',
    '---',
    '> - Redditi italiani',
    '---',
    '- > Redditi italiani',
    '> ---',
  ].join('\n');
  assert.deepEqual(scanItalianResidue({ body1: mismatched }, 'en'), []);

  assert.deepEqual(scanItalianResidue({
    body1: '- Redditi italiani\n  ---',
    body2: '> Redditi italiani\n> ---',
    body3: '- > Redditi italiani\n  > ---',
  }, 'en'), [
    { field: 'body1', line: 1, reason: 'language', text: 'Redditi italiani' },
    { field: 'body2', line: 1, reason: 'language', text: 'Redditi italiani' },
    { field: 'body3', line: 1, reason: 'language', text: 'Redditi italiani' },
  ]);
});

test('la soglia lascia fuori una riga italiana isolata e il locale sorgente', () => {
  const oneLine = { body1: '## Fatti chiave\n- **Cosa**: Convocazione dell’assemblea CUV.' };
  assert.equal(scanItalianResidue(oneLine, 'fr').length, 2);
  assert.equal(hasItalianResidue(oneLine, 'fr'), false);
  assert.deepEqual(scanItalianResidue(oneLine, 'it'), []);
});

test('un finding scan-v2 obsoleto non fa sovrascrivere un body locale gia pulito', () => {
  const [staleAuditPair] = blockingPairsFromAudit({
    results: [{
      lang: 'en',
      slug: 'traduzione-gia-pulita',
      count: ITALIAN_RESIDUE_MIN_LINES,
      hits: Array.from({ length: ITALIAN_RESIDUE_MIN_LINES }, () => ({ field: 'body1' })),
    }],
  });
  assert.deepEqual(staleAuditPair.codes, ['italian-residue']);

  const currentSections = {
    body1: [
      '## Key facts',
      '- **What**: The CUV assembly is planned for 2026',
      '- **Where**: Malpensa and nearby municipalities',
      '- **Issues**: Higher air traffic and environmental impact',
    ].join('\n'),
  };
  const oldCodes = currentBlockingCodes({
    factualityCodes: [],
    italianResidue: scanItalianResidue(currentSections, 'en'),
  });

  assert.deepEqual(oldCodes, []);
  assert.deepEqual(
    shouldWrite({ oldCodes, newCodes: [], missingField: null }),
    { write: false, reason: 'vecchia-gia-pulita' },
  );
});

test('shouldWrite tratta italian-residue come difetto bloccante della pagina vecchia', () => {
  assert.deepEqual(
    shouldWrite({ oldCodes: ['italian-residue'], newCodes: [], missingField: null }),
    { write: true, reason: 'pulita' },
  );
  assert.equal(
    shouldWrite({
      oldCodes: ['italian-residue'],
      newCodes: [],
      missingField: null,
      sanity: 'italian-residue: 3 righe residue',
    }).write,
    false,
  );
});

test('translationSanityIssue rifiuta una nuova traduzione che conserva tre righe italiane', () => {
  const sections = {
    body1: [
      '## Faits clés',
      '- **Cosa**: Convocazione dell’assemblea CUV per il 2026',
      '- **Dove**: Malpensa e comuni del territorio',
      '- **Problemi**: Aumento del traffico aereo e impatto ambientale',
    ].join('\n'),
  };
  const reason = translationSanityIssue({
    oldSections: sections,
    newSections: sections,
    italianSections: { body1: 'Testo italiano sorgente.' },
    locale: 'fr',
  });
  assert.equal(reason, 'italian-residue: 3 righe residue');
});

test('stratify copre piu codici invece di prendere i primi N dello stesso', () => {
  const pairs = [
    ...Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, codes: ['unbalanced-parentheses'] })),
    { id: 'ff', codes: ['translation-false-friend'] },
    { id: 'lp', codes: ['leaked-prompt-scaffolding'] },
  ];
  const picked = stratify(pairs, 3);
  assert.equal(picked.length, 3);
  assert.deepEqual(
    [...new Set(picked.map((p) => p.codes[0]))].sort(),
    ['leaked-prompt-scaffolding', 'translation-false-friend', 'unbalanced-parentheses'],
  );
});

test('stratify non inventa coppie quando ce ne sono meno del limite', () => {
  const picked = stratify([{ id: 'a', codes: ['x'] }], 10);
  assert.equal(picked.length, 1);
});

// ── I due difetti che la guardia non vede ──────────────────────────────────

const IT_LONG = 'Il frontaliere che lavora in Ticino deve dichiarare il reddito in Italia. '.repeat(12);
const EN_LONG = 'The cross-border worker employed in Ticino must declare the income in Italy. '.repeat(12);
const DE_LONG = 'Der Grenzgaenger der im Tessin arbeitet muss das Einkommen in Italien angeben. '.repeat(12);

test('translationSanityIssue accetta una ri-traduzione di lunghezza normale', () => {
  assert.equal(translationSanityIssue({
    oldSections: { body1: EN_LONG },
    newSections: { body1: EN_LONG.replace('must', 'has to') },
    italianSections: { body1: IT_LONG },
    locale: 'en',
  }), null);
});

test('translationSanityIssue rifiuta la ri-traduzione tagliata rispetto alla pubblicata', () => {
  // La forma del clip a 2000 caratteri: il testo finisce a fine frase, quindi
  // i marker sono bilanciati e `detectTruncation` non ha niente da dire.
  const r = translationSanityIssue({
    oldSections: { body1: EN_LONG },
    newSections: { body1: EN_LONG.slice(0, Math.floor(EN_LONG.length * 0.5)) },
    italianSections: { body1: IT_LONG },
    locale: 'en',
  });
  assert.match(r, /^troncata: body1 /);
  assert.match(r, /vs pubblicata/);
});

test('translationSanityIssue usa l italiano quando il campo pubblicato manca', () => {
  const r = translationSanityIssue({
    oldSections: {},
    newSections: { body1: EN_LONG.slice(0, Math.floor(IT_LONG.length * (LENGTH_FLOOR.VS_IT / 2))) },
    italianSections: { body1: IT_LONG },
    locale: 'en',
  });
  assert.match(r, /^troncata: body1 /);
  assert.match(r, /vs italiano/);
});

test('translationSanityIssue non giudica la lunghezza di un campo cortissimo', () => {
  // Sotto il pavimento la variazione naturale fra due traduzioni della stessa
  // frase supera qualunque soglia: un rifiuto li' sarebbe rumore.
  assert.equal(translationSanityIssue({
    oldSections: { body1: 'Cross-border commuters pay taxes in Italy too.' },
    newSections: { body1: 'Frontier workers also pay tax in Italy.' },
    italianSections: { body1: 'I frontalieri pagano le imposte anche in Italia.' },
    locale: 'en',
  }), null);
});

test('translationSanityIssue mantiene la difesa per-campo sull italiano', () => {
  // La cascata condivisa rifiuta gia' questo passthrough esatto. Il test blinda
  // anche il verdetto locale della funzione esportata: se riceve direttamente
  // le sezioni, l'italiano non diventa pubblicabile sulla pagina inglese.
  const r = translationSanityIssue({
    oldSections: { body1: EN_LONG },
    newSections: { body1: IT_LONG },
    italianSections: { body1: IT_LONG },
    locale: 'en',
  });
  // Il rilevatore dice 'de' su questo campione, non 'it': cio' che conta e' che
  // NON dica 'en', cioe' che il passthrough non venga scritto sulla pagina
  // inglese. Il verdetto e' un rifiuto in ogni caso.
  assert.match(r, /^lingua-sbagliata: /);
  assert.doesNotMatch(r, /^lingua-sbagliata: en /);
});

test('shouldWrite rifiuta quando la sanity check ha una ragione, anche con zero critical', () => {
  const v = shouldWrite({
    oldCodes: ['truncated-bold'],
    newCodes: [],
    missingField: null,
    sanity: 'troncata: body1 900/3000 car. (0.30 < 0.7 vs pubblicata)',
  });
  assert.equal(v.write, false);
  assert.match(v.reason, /^troncata: /);
});

test('sanitizeBodyText toglie le graffe spaiate e lascia le coppie', () => {
  // Il difetto reale che il percorso di generazione gia' sanificava e questo
  // script no: „virgoletta bassa tedesca chiusa con `}`. Nessun `critical` la
  // intercetta — le graffe non sono nel vocabolario di runFactualityGates.
  assert.equal(sanitizeBodyText('Der Grenzgänger sagte „ja} und ging.', () => {}),
    'Der Grenzgänger sagte „ja und ging.');
  // Le coppie bilanciate restano intatte (ancore, placeholder).
  assert.equal(sanitizeBodyText('vedi {link} qui', () => {}), 'vedi {link} qui');
  // Una `{` mai chiusa viene tolta: lascerebbe una graffa aperta nel .ts.
  assert.equal(sanitizeBodyText('resta {aperta', () => {}), 'resta aperta');
});

test('translationSanityIssue rifiuta UN campo su tre lasciato in italiano', () => {
  // Il caso che la concatenazione lasciava passare, ed e' il piu' probabile:
  // la cascata traduce un campo alla volta e `translateFieldFreeMt` non ha
  // nessuna guardia "uscita == sorgente", quindi il fallimento tipico e'
  // PARZIALE. Su `body1+body2+body3` uniti il campo italiano e' un terzo del
  // testo, il rilevatore vede due terzi di inglese e risponde `en`: nessun
  // rifiuto, e la pagina /en/ pubblicata si prende un paragrafo italiano.
  const r = translationSanityIssue({
    oldSections: { body1: EN_LONG, body2: EN_LONG, body3: EN_LONG },
    newSections: { body1: EN_LONG, body2: IT_LONG, body3: EN_LONG },
    italianSections: { body1: IT_LONG, body2: IT_LONG, body3: IT_LONG },
    locale: 'en',
  });
  assert.ok(r, 'un campo in italiano su tre deve produrre un rifiuto');
  assert.match(r, /^lingua-sbagliata: body2 /);

  // Falsificazione nell'altra direzione: gli stessi tre campi tradotti davvero
  // non devono essere rifiutati, altrimenti il controllo rifiuterebbe tutto.
  assert.equal(translationSanityIssue({
    oldSections: { body1: EN_LONG, body2: EN_LONG, body3: EN_LONG },
    newSections: { body1: EN_LONG, body2: EN_LONG, body3: EN_LONG },
    italianSections: { body1: IT_LONG, body2: IT_LONG, body3: IT_LONG },
    locale: 'en',
  }), null);
});

test('--limit negativo esce con errore invece di selezionare tutto meno uno', () => {
  // `Number('-1')` e' finito, quindi supera il controllo "e' un numero", e
  // `pairs.slice(0, -1)` NON prende una coppia: prende tutte meno l'ultima.
  // `--apply --limit -1` — la scrittura naturale di "nessun limite" per chi non
  // sa che il default e' gia' Infinity — avrebbe fatto la bonifica completa.
  const script = fileURLToPath(new URL('../scripts/retranslate-blocking-bodies.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [script, '--audit', '/dev/null', ...args], { encoding: 'utf8' });

  const neg = run('--limit', '-1');
  assert.equal(neg.status, 2, 'un --limit negativo deve uscire 2');
  assert.match(neg.stderr, /negativo/);
  assert.doesNotMatch(String(neg.stdout), /coppie trattate/, 'non deve selezionare né trattare nulla');

  // Falsificazione: un limite valido non viene rifiutato PER QUESTO motivo.
  // (Si ferma piu' avanti, sull'albero dei body assente, che e' un'altra uscita.)
  assert.doesNotMatch(String(run('--limit', '5').stderr), /negativo/);
});

test('--slug vuoto esce con errore invece di disabilitare il filtro dell audit', () => {
  const script = fileURLToPath(new URL('../scripts/retranslate-blocking-bodies.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, '--audit', '/dev/null', '--slug', ''], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--slug.*vuoto/);
  assert.doesNotMatch(String(run.stdout), /coppie trattate/);

  const inline = spawnSync(process.execPath, [script, '--audit', '/dev/null', '--slug='], { encoding: 'utf8' });
  assert.equal(inline.status, 2);
  assert.match(inline.stderr, /--slug.*vuoto/);
  assert.doesNotMatch(String(inline.stdout), /coppie trattate/);
});

test('--apply=false NON entra nel percorso di scrittura', () => {
  // Il parsing inline dei flag ha reso `--apply=false` indistinguibile da
  // `--apply`: il valore diceva "no" e il flag risultava presente, quindi una
  // negazione esplicita abilitava la riscrittura di body PUBBLICATI.
  assert.equal(inlineBoolean(['--apply'], 'apply'), true, '--apply nudo scrive');
  assert.equal(inlineBoolean(['--apply=true'], 'apply'), true);
  assert.equal(inlineBoolean(['--apply=1'], 'apply'), true);
  for (const negated of ['--apply=false', '--apply=0', '--apply=no', '--apply=off', '--apply=FALSE', '--apply= false ']) {
    assert.equal(inlineBoolean([negated], 'apply'), false, `${negated} deve restare dry-run`);
  }
  // Invocazione malformata: su un flag che riscrive, il valore assente cade sul
  // lato sicuro. E' la differenza deliberata con la presenza usata da --slug.
  assert.equal(inlineBoolean(['--apply='], 'apply'), false, '--apply= non abilita la scrittura');
  // Il flag assente resta assente, e un altro flag non lo attiva per prefisso.
  assert.equal(inlineBoolean([], 'apply'), false);
  assert.equal(inlineBoolean(['--apply-everything'], 'apply'), false, 'niente match per prefisso');
  assert.equal(inlineBoolean(['--json=false'], 'json'), false, 'stessa classe su --json');
  assert.equal(inlineBoolean(['--stratify=false'], 'stratify'), false, 'stessa classe su --stratify');
});

test('un valore mancante non viene rubato al flag successivo, e --out vuoto non cade su stdout', () => {
  const script = fileURLToPath(new URL('../scripts/retranslate-blocking-bodies.mjs', import.meta.url));
  // `--slug --audit a.json`: senza guardia `--audit` diventava lo slug
  // letterale, zero coppie selezionate ed exit 0 — un no-op che si legge come
  // "niente da fare".
  const stolen = spawnSync(process.execPath, [script, '--slug', '--audit', '/dev/null'], { encoding: 'utf8' });
  assert.equal(stolen.status, 2, 'il flag successivo non e un valore');
  assert.match(stolen.stderr, /--slug richiede un valore/);
  assert.doesNotMatch(String(stolen.stdout), /coppie trattate/);

  // Un valore mancante NON puo' ricadere sul default: e' il verso pericoloso.
  // `--limit --apply` darebbe LIMIT=Infinity e `--code --apply` toglierebbe il
  // filtro per codice, allargando la riscrittura all'audit intero.
  const noLimit = spawnSync(process.execPath, [script, '--audit', '/dev/null', '--limit', '--apply'], { encoding: 'utf8' });
  assert.equal(noLimit.status, 2, '--limit senza valore non diventa "nessun limite"');
  assert.match(noLimit.stderr, /--limit richiede un valore/);
  assert.doesNotMatch(String(noLimit.stdout), /coppie trattate/);

  const noCode = spawnSync(process.execPath, [script, '--audit', '/dev/null', '--code', '--apply'], { encoding: 'utf8' });
  assert.equal(noCode.status, 2, '--code senza valore non toglie il filtro');
  assert.match(noCode.stderr, /--code richiede un valore/);
  assert.doesNotMatch(String(noCode.stdout), /coppie trattate/);

  // L'ultimo argomento senza valore e' lo stesso errore, non un default.
  const dangling = spawnSync(process.execPath, [script, '--audit', '/dev/null', '--code'], { encoding: 'utf8' });
  assert.equal(dangling.status, 2);
  assert.match(dangling.stderr, /--code richiede un valore/);

  // Falsificazione: un flag ASSENTE resta il caso legittimo del default, e un
  // valore negativo o numerico non viene confuso con un flag.
  const present = spawnSync(process.execPath, [script, '--audit', '/dev/null', '--limit', '5'], { encoding: 'utf8' });
  assert.doesNotMatch(String(present.stderr), /richiede un valore/, 'un valore valido non e un errore');

  // `--out=` chiede un file e lo perderebbe su stdout, che non e' parsabile.
  const emptyOut = spawnSync(process.execPath, [script, '--audit', '/dev/null', '--slug', 'x', '--out='], { encoding: 'utf8' });
  assert.equal(emptyOut.status, 2);
  assert.match(emptyOut.stderr, /--out è vuoto/);
});

// ── La stessa classe sull'altro scrittore per-locale ───────────────────────
//
// `fix-faq-locales.mjs` verificava il locale sul testo CONCATENATO delle
// coppie, mentre `translateFaqArray()` traduce una coppia alla volta e sul
// fallimento del motore rimette dentro la coppia ITALIANA
// (`results.push(pair)`): li' il fallimento parziale non e' un'ipotesi, e' il
// fallback scritto nel codice.

const EN_PAIR = { q: 'Where does the cross-border worker pay tax?', a: EN_LONG };
const IT_PAIR = { q: 'Dove paga le imposte il frontaliere?', a: IT_LONG };

test('wrongLocalePair vede la singola coppia italiana rimasta dal fallback', () => {
  // Falsificazione nell'altra direzione per prima: tre coppie tradotte davvero
  // non devono essere rifiutate.
  assert.equal(wrongLocalePair([EN_PAIR, EN_PAIR, EN_PAIR], 'en', [IT_PAIR, IT_PAIR, IT_PAIR]), null);

  // La forma REALE del difetto: `translateFaqArray()` rimette dentro la coppia
  // ITALIANA quando il motore fallisce, quindi quella coppia e' byte-identica
  // alla sorgente. E' il ramo dell'uguaglianza a coglierla.
  const source = [IT_PAIR, IT_PAIR, IT_PAIR];
  const wrong = wrongLocalePair([EN_PAIR, IT_PAIR, EN_PAIR], 'en', source);
  assert.ok(wrong, 'una coppia italiana su tre deve produrre un rifiuto');
  assert.deepEqual(wrong, [{ index: 1, detected: 'it', via: 'verbatim' }]);

  // E sul concatenato — cioe' col controllo di prima — non verrebbe rifiutata.
  assert.equal(
    detectLanguage([EN_PAIR, IT_PAIR, EN_PAIR].map((p) => `${p.q} ${p.a}`).join(' '), 'en'),
    'en',
  );
});

test('wrongLocalePair confronta il contenuto anche quando le coppie sono riordinate e ne raccoglie piu di una', () => {
  const IT_PAIR_2 = {
    q: 'Quali documenti servono per il permesso G?',
    a: 'Per la domanda servono il contratto di lavoro e i documenti personali. '.repeat(3),
  };
  const DE_PAIR = { q: 'Wo zahlt der Grenzgaenger seine Steuern?', a: DE_LONG };
  const source = [IT_PAIR, IT_PAIR_2];
  const translated = [IT_PAIR_2, IT_PAIR, DE_PAIR];
  const wrong = wrongLocalePair(translated, 'en', source);

  assert.deepEqual(
    wrong,
    [
      { index: 0, detected: 'it', via: 'verbatim' },
      { index: 1, detected: 'it', via: 'verbatim' },
      { index: 2, detected: 'de', via: 'terza-lingua' },
    ],
    'il controllo deve usare il contenuto sorgente e non fermarsi alla prima coppia',
  );
  assert.deepEqual(filterWrongLocalePairs(translated, wrong), [], 'nessuna coppia sana in questo fixture');

  const oneHealthy = [IT_PAIR_2, EN_PAIR];
  const oneWrong = wrongLocalePair(oneHealthy, 'en', source);
  assert.deepEqual(oneWrong, [{ index: 0, detected: 'it', via: 'verbatim' }]);
  assert.deepEqual(filterWrongLocalePairs(oneHealthy, oneWrong), [EN_PAIR],
    'una coppia guasta non deve costare la coppia sana');
});

test('wrongLocalePair rifiuta la coppia con UN SOLO campo italiano verbatim (verifica per campo del sito #8574)', () => {
  // Coppia PRESA DAL CORPUS pubblicato (`blog-body/en/concierge-ticino-lonza-ch.ts`,
  // coppia 1): domanda italiana verbatim, risposta tradotta. La coppia intera
  // non e' uguale a nessuna coppia sorgente, e sul testo concatenato la
  // risposta inglese domina: senza il confronto per CAMPO la domanda
  // italiana resta pubblicata sotto `/en/`.
  const IT_SOURCE = {
    q: 'Quali sono i requisiti specifici per candidarsi?',
    a: 'I requisiti specifici non sono stati divulgati, ma si presume esperienza in ruoli simili, buone capacità comunicative e conoscenza delle procedure di sicurezza. Verificare i dettagli sul sito Lonza.',
  };
  const PUBLISHED = {
    q: IT_SOURCE.q,
    a: 'The specific requirements have not been disclosed, but it is presumed to require experience in similar roles, strong communication skills, and knowledge of safety procedures. Check the details on the Lonza website.',
  };
  assert.equal(detectLanguage(`${PUBLISHED.q} ${PUBLISHED.a}`, 'en'), 'en',
    'il fixture deve sfuggire al ramo di lingua, altrimenti non prova il ramo per campo');
  assert.deepEqual(wrongLocalePair([PUBLISHED], 'en', [IT_SOURCE]),
    [{ index: 0, detected: 'it', via: 'verbatim' }]);

  // La forma del test del sito: stessa coppia sorgente, un solo campo tradotto.
  assert.deepEqual(wrongLocalePair([{ q: IT_PAIR.q, a: EN_PAIR.a }], 'en', [IT_PAIR]),
    [{ index: 0, detected: 'it', via: 'verbatim' }]);

  // Il confronto e' per contenuto, non per indice come sul sito: una FAQ
  // potata (`filterWrongLocalePairs`) o riordinata sposta le coppie, e il
  // campo italiano va riconosciuto dovunque sia finito.
  assert.deepEqual(wrongLocalePair([EN_PAIR, PUBLISHED], 'en', [IT_SOURCE, IT_PAIR]),
    [{ index: 1, detected: 'it', via: 'verbatim' }]);

  // Falsificazione: la coppia tradotta per intero resta scrivibile.
  assert.equal(wrongLocalePair([EN_PAIR], 'en', [IT_PAIR]), null);
  assert.equal(wrongLocalePair([EN_PAIR, EN_PAIR], 'en', [IT_SOURCE, IT_PAIR]), null);
});

test('wrongLocalePair attiva il ramo terza-lingua anche con scores vuoto del rilevatore corto', () => {
  const shortGerman = {
    q: 'Und wo sind die Aufgaben?',
    a: 'Die Antwort steht im Merkblatt.',
  };
  const detected = detectLanguageWithConfidence(`${shortGerman.q} ${shortGerman.a}`, 'en');
  assert.equal(detected.lang, 'de');
  assert.equal(detected.confidence, 0.85);
  assert.deepEqual(detected.scores, {});

  const wrong = wrongLocalePair([shortGerman], 'en', [IT_PAIR]);
  assert.deepEqual(wrong, [{ index: 0, detected: 'de', via: 'terza-lingua' }],
    'scores vuoto non significa che il ramo strong-marker sia spento');
});

test('il ramo di LINGUA da solo non basta: su questo testo italiano il rilevatore dice `de`', () => {
  // Misura, non opinione. Su `IT_PAIR` il rilevatore risponde `de` con
  // confidenza 0,09 (punteggi it=1428, de=1573): un testo italiano che NON
  // viene riconosciuto come italiano.
  //
  // Il vecchio predicato (`detected !== expectedLocale`) lo rifiutava lo
  // stesso, ma per la ragione sbagliata — bastava che il rilevato non fosse
  // `en` — ed e' esattamente il meccanismo che su 16'885 articoli×locale
  // pubblicati produceva 421 falsi positivi (2,5%), di cui il 70% con lingua
  // rilevata diversa da `it`. Su una run reale del workflow FAQ ha buttato 8
  // traduzioni complete su 31 coppie rifiutate, e solo 8 di quelle 31 erano
  // davvero `it`.
  //
  // Da cui i DUE rami: senza l'uguaglianza con la sorgente, questo caso
  // sfuggirebbe.
  const detected = detectLanguage(`${IT_PAIR.q} ${IT_PAIR.a}`, 'en');
  assert.notEqual(detected, 'it', 'se un giorno il rilevatore dicesse `it`, questo test va riscritto');
  assert.equal(wrongLocalePair([IT_PAIR], 'en'), null,
    'senza la sorgente il solo ramo di lingua non coglie questa coppia');
  assert.ok(wrongLocalePair([IT_PAIR], 'en', [IT_PAIR]),
    'con la sorgente il ramo dell\'uguaglianza la coglie');
});

test('wrongLocalePair non rifiuta piu\' uno scarto INCERTO fra lingue NON sorgente', () => {
  // Il difetto che questa modifica chiude, con una coppia PRESA DAL CORPUS
  // pubblicato (`blog-body-ch/en/cifre-nere-grigioni.ts`, coppia 2): testo
  // inglese di 100 caratteri che il rilevatore da' `de` con confidenza 0,92 e
  // punteggio 145. Non e' un passthrough italiano, e' incertezza su testo
  // corto — e costava una traduzione intera, perche' UNA coppia scarta
  // l'articolo.
  const NOISY_EN_PAIR = {
    q: 'Which gray municipality has recorded a deficit?',
    a: 'Thusis recorded a deficit of just under CHF 310,000.',
  };
  const noisy = detectLanguageWithConfidence(`${NOISY_EN_PAIR.q} ${NOISY_EN_PAIR.a}`, 'en');
  assert.notEqual(noisy.lang, 'en',
    'il fixture deve essere mal rilevato, altrimenti non prova niente');
  assert.ok(noisy.confidence >= 0.6,
    'e mal rilevato con confidenza ALTA: e\' il motivo per cui la sola confidenza non basta');
  assert.ok((noisy.scores?.[noisy.lang] ?? 0) < 500,
    'cio\' che lo distingue e\' il punteggio assoluto, non il margine');
  assert.equal(wrongLocalePair([NOISY_EN_PAIR], 'en', [IT_PAIR]), null,
    'uno scarto INCERTO fra due lingue non-sorgente non e\' un passthrough e non va rifiutato');
});

test('wrongLocalePair rifiuta la terza lingua CONCLAMATA: `=== sourceLang` da solo e\' fail-open', () => {
  // Il rovescio del caso sopra, ed e' la classe che `detected === sourceLang`
  // da solo lascerebbe passare: una coppia chiesta in `en` e resa in tedesco
  // non e' un passthrough italiano, ma scritta sotto `/en/` e' contenuto nella
  // lingua sbagliata gia' pubblicato — e qui il sito non ribuilda.
  const DE_PAIR = { q: 'Wo zahlt der Grenzgaenger seine Steuern?', a: DE_LONG };
  const d = detectLanguageWithConfidence(`${DE_PAIR.q} ${DE_PAIR.a}`, 'en');
  assert.equal(d.lang, 'de');
  assert.ok(d.confidence >= 0.6 && d.scores.de >= 500,
    'il fixture deve avere il segnale FORTE, altrimenti prova il caso sbagliato');

  const wrong = wrongLocalePair([DE_PAIR], 'en', [IT_PAIR]);
  assert.ok(wrong, 'una terza lingua conclamata va rifiutata, non scritta sotto /en/');
  assert.deepEqual(wrong, [{ index: 0, detected: 'de', via: 'terza-lingua' }]);

  // Falsificazione: non e' il ramo dell'italiano travestito.
  assert.notEqual(wrong[0].detected, 'it');
});

test('wrongLocalePair salta le coppie sotto la soglia di segnale', () => {
  // Stessa soglia di 50 caratteri di `isWrongLocale()`: sotto, il rilevatore
  // non ha segnale e un rifiuto sarebbe rumore.
  assert.equal(wrongLocalePair([{ q: 'Quando?', a: 'Nel 2026.' }], 'en'), null);
});

test('translationSanityIssue rifiuta il troncamento CONDIVISO fra vecchio e nuovo', () => {
  // Il caso piu' probabile di questo lotto, e quello che il solo `VS_OLD` non
  // poteva vedere: il body pubblicato viene gia' dal tier che taglia la
  // sorgente a 2000 caratteri, la ri-traduzione riparte dalla stessa sorgente
  // italiana, ricade sullo stesso tier e esce troncata UGUALE. Rapporto
  // nuovo/pubblicata ~1,0: con `VS_OLD` da solo passerebbe, e si scriverebbe un
  // body ancora mutilato dichiarandolo riparato.
  const IT_HUGE = IT_LONG.repeat(4);              // sorgente intera
  const CUT = EN_LONG.slice(0, Math.floor(IT_HUGE.length * 0.25)); // ~1/4: entrambe tagliate
  const r = translationSanityIssue({
    oldSections: { body1: CUT },
    newSections: { body1: CUT },
    italianSections: { body1: IT_HUGE },
    locale: 'en',
  });
  assert.ok(r, 'un troncamento condiviso deve essere rifiutato');
  assert.match(r, /^troncata: body1 .* vs italiano\)$/);

  // Falsificazione: la stessa coppia con la ri-traduzione INTERA passa, quindi
  // il confronto con l'italiano non sta semplicemente rifiutando tutto.
  assert.equal(translationSanityIssue({
    oldSections: { body1: CUT },
    newSections: { body1: EN_LONG.repeat(4) },
    italianSections: { body1: IT_HUGE },
    locale: 'en',
  }), null);
});

test('il rilevatore di locale FAQ e per coppia in ENTRAMBI i punti che decidono', () => {
  // By-construction, come corpus-write-atomic: il difetto non era il predicato,
  // era il CALL-SITE. Un `wrongLocalePair` perfetto non serve a niente se chi
  // sceglie cosa riparare, o chi scrive, guarda ancora il testo concatenato.
  const root = path.resolve(import.meta.dirname, '..', '..');
  for (const rel of ['generator/scripts/fix-faq-locales.mjs',
    'generator/scripts/batch-add-faq-to-articles.mjs']) {
    const src = fs.readFileSync(path.join(root, rel), 'utf-8');
    // La forma del difetto: un predicato che concatena le coppie e poi rileva.
    assert.doesNotMatch(
      src,
      /function isWrongLocale\s*\(/,
      `${rel}: la versione sul testo concatenato e' tornata. Diluisce la coppia `
      + 'sbagliata nella media delle altre: usa wrongLocalePair().',
    );
    assert.match(src, /wrongLocalePair\(/, `${rel}: deve usare il predicato per coppia`);
  }
  // E la guardia del batch sta nella funzione CONDIVISA, non su un call-site.
  // `insertFaqIntoBodyFile(localePath, ...)` compare a quattro punti diversi
  // (generazione, top-up, traduzione): gattarne uno lascia gli altri tre a
  // pubblicare l'italiano. `translateFaq()` e' l'unico punto da cui esce una
  // FAQ tradotta, quindi il rifiuto vale per tutti e tre i chiamanti.
  const batch = fs.readFileSync(path.join(root, 'generator/scripts/batch-add-faq-to-articles.mjs'), 'utf-8');
  const fn = batch.slice(batch.indexOf('async function translateFaq('),
    batch.indexOf('function validateFaq('));
  assert.ok(fn.length > 0, 'translateFaq non trovata');
  assert.match(fn, /wrongLocalePair\(results, targetLang, faqArray\)/,
    'translateFaq deve rifiutare un array che contiene una coppia nella lingua sbagliata');
  // NON `null`: i tre chiamanti non trattano `null` allo stesso modo — due su
  // tre lo gestiscono scrivendo la FAQ italiana intera. Il rifiuto di lingua
  // deve essere distinguibile dal fallimento del motore, altrimenti il rimedio
  // pubblica piu' italiano della malattia.
  assert.match(fn, /rejected: true/,
    'il rifiuto di lingua deve essere un esito distinto dal fallimento del motore');
});

// ── Cosa viene SCRITTO quando la traduzione FAQ e' rifiutata ───────────────
//
// La differenza fra i tre chiamanti e' il punto: non basta che `translateFaq()`
// rifiuti. Su un fallimento, `processArticle` e `processTopUp` scrivono la FAQ
// ITALIANA INTERA sul body del locale, mentre `processTranslation` non scrive
// niente. Un rifiuto di lingua reso come semplice fallimento trasformava quindi
// UNA coppia italiana su otto in OTTO su otto, ogni giorno. Questi casi
// asseriscono il comportamento per chiamante, che il test sul solo valore di
// ritorno non puo' vedere.
test('il rifiuto di lingua non scrive, il fallimento del motore tiene il fallback', () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const src = fs.readFileSync(path.join(root, 'generator/scripts/batch-add-faq-to-articles.mjs'), 'utf-8');
  const slice = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));

  const bodies = {
    processArticle: slice('async function processArticle(', 'async function processTopUp('),
    processTopUp: slice('async function processTopUp(', 'async function processTranslation('),
    processTranslation: slice('async function processTranslation(', '// ── Concurrency control'),
  };

  for (const [name, body] of Object.entries(bodies)) {
    assert.ok(body.length > 0, `${name}: corpo non trovato`);
    // Ogni chiamante deve distinguere i due esiti.
    assert.match(body, /\.rejected/,
      `${name}: non distingue il rifiuto di lingua dal fallimento del motore. `
      + "Senza la distinzione il rifiuto ricade sul fallback italiano e PUBBLICA piu' italiano.");
    // E il ramo del rifiuto non deve scrivere.
    const rejIdx = body.indexOf('.rejected');
    const nextWrite = body.indexOf('insertFaqIntoBodyFile', rejIdx);
    const branchEnd = body.indexOf('} else', rejIdx);
    assert.ok(nextWrite === -1 || (branchEnd !== -1 && nextWrite > branchEnd),
      `${name}: il ramo \`rejected\` scrive nel file. Deve saltare: una FAQ assente si `
      + "recupera al giro dopo, una FAQ italiana su /en/ e' contenuto sbagliato pubblicato.");
  }

  // Falsificazione nell'altro verso: il fallback italiano sul FALLIMENTO DEL
  // MOTORE e' ancora li' nei due chiamanti che l'avevano. E' una scelta di
  // prodotto preesistente, e questa PR non doveva toccarla — se sparisse, il
  // test direbbe che ho cambiato in silenzio piu' di quanto dichiarato.
  assert.match(bodies.processArticle, /faqForLocale = validFaq;/,
    'processArticle: il fallback italiano sul fallimento del motore non va rimosso qui');
  assert.match(bodies.processTopUp, /insertFaqIntoBodyFile\(localePath, articleId, validMerged\)/,
    'processTopUp: il fallback italiano sul fallimento del motore non va rimosso qui');
});

// ── Entry point in-place per uno slug arbitrario, italiano compreso (#1084) ─
//
// `registerArticleFiles()` resta append-only: questo script riscrive i body
// gia' registrati. Fino a qui l'italiano veniva droppato in silenzio anche con
// `--locale it`, e non c'era un `--slug` per mirare un id senza l'audit intero.

test('parseSlugList spezza, trimma e ignora i vuoti', () => {
  assert.deepEqual(parseSlugList('a, b ,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseSlugList('a, b, a,,b'), ['a', 'b']);
  assert.deepEqual(parseSlugList(''), []);
  assert.deepEqual(parseSlugList(null), []);
});

test('parseLocaleList normalizza e deduplica i locali', () => {
  assert.deepEqual(parseLocaleList('en, de, en,,fr,de'), ['en', 'de', 'fr']);
});

test('pairsForSlugs non duplica il lavoro quando slug o locale sono ripetuti', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retranslate-dedupe-'));
  try {
    const dir = path.join(tmp, 'content', 'blog-body', 'en');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'slug-arbitrario.ts'), fileFor('slug-arbitrario', { body1: 'x' }));
    const pairs = pairsForSlugs(
      ['slug-arbitrario', 'slug-arbitrario'],
      ['en', 'en'],
      tmp,
    );
    assert.deepEqual(
      pairs.map((p) => p.locale + '/' + p.id),
      ['en/slug-arbitrario'],
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('una sanitizzazione che svuota l uscita MT diventa un campo mancante', () => {
  assert.equal(sanitizeTranslatedField('}'), null);
  assert.equal(sanitizeTranslatedField('testo }'), 'testo ');
});

test('selectBlockingPairs include it solo se richiesto, e filtra per slug', () => {
  const pairs = [
    { id: 'alpha', locale: 'it', codes: ['leaked-prompt-scaffolding'] },
    { id: 'alpha', locale: 'en', codes: ['truncated-bold'] },
    { id: 'beta', locale: 'de', codes: ['translation-false-friend'] },
  ];
  assert.deepEqual(
    selectBlockingPairs(pairs, { locales: ['en', 'de', 'fr'] }).map((p) => `${p.locale}/${p.id}`),
    ['en/alpha', 'de/beta'],
    'il default en,de,fr continua a escludere l\'italiano',
  );
  assert.deepEqual(
    selectBlockingPairs(pairs, { locales: ['it'] }).map((p) => `${p.locale}/${p.id}`),
    ['it/alpha'],
    '--locale it non deve droppare l\'italiano',
  );
  assert.deepEqual(
    selectBlockingPairs(pairs, { locales: ['it', 'en'], slugs: ['alpha'] }).map((p) => `${p.locale}/${p.id}`),
    ['it/alpha', 'en/alpha'],
    '--slug mira l\'id, non il primo della lista',
  );
  assert.deepEqual(
    selectBlockingPairs(pairs, { locales: ['en'], slugs: [] }),
    [],
    'un --slug esplicitamente vuoto è un filtro attivo, non il filtro assente',
  );
});

test('rewriteExistingLocaleBody riscrive i campi senza toccare le altre chiavi', () => {
  const src = fileFor('slug-arbitrario', { body1: 'uno', body2: 'due', body3: 'tre' });
  const out = rewriteExistingLocaleBody(src, 'slug-arbitrario', { body2: "l'articolo nuovo" });
  assert.equal(out.missing, null);
  assert.equal(readBodyField(out.src, 'slug-arbitrario', 'body1'), 'uno');
  assert.equal(readBodyField(out.src, 'slug-arbitrario', 'body2'), "l'articolo nuovo");
  assert.equal(readBodyField(out.src, 'slug-arbitrario', 'body3'), 'tre');
  assert.equal(rewriteExistingLocaleBody(src, 'slug-arbitrario', { body9: 'x' }).missing, 'body9');
});

test('FU-009 — rewriteExistingLocaleBody può aggiungere solo le chiavi mancanti', () => {
  const src = `const b = {\n    'blog.article.slug.faq': 'faq',\n};\n`;
  const inserted = insertBodyField(src, 'slug', 'body1', "testo con l'apostrofo");
  assert.match(inserted, /blog\.article\.slug\.body1/);
  assert.match(inserted, /testo con l\\'apostrofo/);
  assert.match(inserted, /blog\.article\.slug\.faq/);

  const rewritten = rewriteExistingLocaleBody(
    src,
    'slug',
    { body1: 'uno', body2: 'due' },
    { allowMissing: true },
  );
  assert.equal(rewritten.missing, null);
  assert.match(rewritten.src, /blog\.article\.slug\.body1/);
  assert.match(rewritten.src, /blog\.article\.slug\.body2/);
  assert.match(rewritten.src, /blog\.article\.slug\.faq/);
});

test('lo script non importa registerArticleFiles: la riscrittura resta in-place', () => {
  const src = fs.readFileSync(
    new URL('../scripts/retranslate-blocking-bodies.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(src, /^import .*registerArticleFiles/m,
    'un import del registrar append-only romperebbe la riscrittura di uno slug esistente');
  assert.doesNotMatch(src, /from ['"].*create-article/,
    'create-article.mjs esegue main() all\'import: non deve entrare in questo script');
  assert.match(src, /rewriteExistingLocaleBody/,
    'la scrittura deve passare dalla funzione in-place, non da un writeFile diretto');
  assert.doesNotMatch(src, /p\.locale !== 'it'/,
    'il drop silenzioso dell\'italiano e\' il buco: --locale it deve poterlo selezionare');
});

test('--locale it e --slug trattano la coppia italiana invece di dropparla', () => {
  const script = fileURLToPath(new URL('../scripts/retranslate-blocking-bodies.mjs', import.meta.url));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retranslate-slug-'));
  try {
    const bodyDir = path.join(tmp, 'content', 'blog-body');
    for (const loc of ['it', 'en']) {
      fs.mkdirSync(path.join(bodyDir, loc), { recursive: true });
      fs.writeFileSync(
        path.join(bodyDir, loc, 'slug-arbitrario.ts'),
        fileFor('slug-arbitrario', {
          body1: loc === 'it' ? IT_LONG : EN_LONG,
          body2: loc === 'it' ? IT_LONG : EN_LONG,
          body3: loc === 'it' ? IT_LONG : EN_LONG,
        }),
      );
    }
    const audit = path.join(tmp, 'audit.json');
    fs.writeFileSync(audit, JSON.stringify({
      findings: [
        {
          id: 'slug-arbitrario',
          locale: 'it',
          dir: 'services/locales/blog-body',
          criticalCount: 1,
          issues: [{ severity: 'critical', code: 'leaked-prompt-scaffolding' }],
        },
        {
          id: 'slug-arbitrario',
          locale: 'en',
          dir: 'services/locales/blog-body',
          criticalCount: 1,
          issues: [{ severity: 'critical', code: 'truncated-bold' }],
        },
      ],
    }));

    const dropped = spawnSync(process.execPath, [
      script, '--audit', audit, '--content-root', tmp, '--json',
      '--code', 'leaked-prompt-scaffolding',
    ], { encoding: 'utf8' });
    assert.equal(dropped.status, 0, dropped.stderr);
    const droppedReport = JSON.parse(dropped.stdout);
    assert.equal(droppedReport.results.length, 0,
      'senza --locale it il default en,de,fr continua a escludere l\'italiano');

    const itRun = spawnSync(process.execPath, [
      script, '--audit', audit, '--content-root', tmp, '--locale', 'it',
      '--slug', 'slug-arbitrario', '--json',
    ], { encoding: 'utf8' });
    assert.equal(itRun.status, 0, itRun.stderr);
    const itReport = JSON.parse(itRun.stdout);
    assert.equal(itReport.results.length, 1);
    assert.equal(itReport.results[0].id, 'slug-arbitrario');
    assert.equal(itReport.results[0].locale, 'it');
    assert.equal(itReport.results[0].written, false,
      'dry-run: l\'italiano passa da shouldWrite, non da registerArticleFiles');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── --scan: il selettore dal contenuto ─────────────────────────────────────
//
// Lo stock (site#7682, site#7683) restava fermo perche' lo strumento non
// sapeva TROVARE le coppie senza il file `--audit`, che solo il sito produce
// (con ~6 GB di heap). `--scan` le trova con la stessa guardia di
// `processPair`, un file alla volta. Il test diventa rosso se il selettore
// dimentica `blog-body-ch`, se scrive senza `--apply`, o se un body gia'
// pulito entra nella lista.

const SCAN_SCRIPT = fileURLToPath(new URL('../scripts/retranslate-blocking-bodies.mjs', import.meta.url));
const EN_FALSE_FRIEND = `${EN_LONG}Many border guards commute to Ticino every day. `;
const IT_WITH_CUSTOMS = `${IT_LONG}Al valico la dogana controlla i documenti. `;

/** Fixture minima: una coppia per ogni ramo del selettore. */
function writeScanFixture(root) {
  const files = {
    // Scaffolding sull'italiano: la riga-marcatore del prompt di generazione.
    'content/blog-body/it/scaf.ts': fileFor('scaf', { body1: `TITOLO ARTICOLO: x\n${IT_LONG}`, body2: IT_LONG, body3: IT_LONG }),
    'content/blog-body/en/scaf.ts': fileFor('scaf', { body1: EN_LONG, body2: EN_LONG, body3: EN_LONG }),
    // Falso amico: «border guards» e un italiano che non nomina guardie o dogane.
    'content/blog-body/it/ff.ts': fileFor('ff', { body1: IT_LONG, body2: IT_LONG, body3: IT_LONG }),
    'content/blog-body/en/ff.ts': fileFor('ff', { body1: EN_LONG, body2: EN_FALSE_FRIEND, body3: EN_LONG }),
    // Ancora del gate: l'italiano nomina la dogana, quindi «border guards» e' legittimo.
    'content/blog-body/it/anchor.ts': fileFor('anchor', { body1: IT_LONG, body2: IT_WITH_CUSTOMS, body3: IT_LONG }),
    'content/blog-body/en/anchor.ts': fileFor('anchor', { body1: EN_LONG, body2: EN_FALSE_FRIEND, body3: EN_LONG }),
    // Coppia pulita: non deve entrare nella lista.
    'content/blog-body/it/clean.ts': fileFor('clean', { body1: IT_LONG, body2: IT_LONG, body3: IT_LONG }),
    'content/blog-body/en/clean.ts': fileFor('clean', { body1: EN_LONG, body2: EN_LONG, body3: EN_LONG }),
    // La sezione Svizzera: un selettore che guardasse solo blog-body la perderebbe.
    'content/blog-body-ch/it/ch-ff.ts': fileFor('ch-ff', { body1: IT_LONG, body2: IT_LONG, body3: IT_LONG }),
    'content/blog-body-ch/en/ch-ff.ts': fileFor('ch-ff', { body1: EN_FALSE_FRIEND, body2: EN_LONG, body3: EN_LONG }),
  };
  for (const [rel, src] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, src);
  }
  return Object.keys(files);
}

const snapshotFiles = (root, rels) => Object.fromEntries(
  rels.map((rel) => [rel, fs.readFileSync(path.join(root, rel)).toString('base64')]),
);

test('blockingPairsFromContent trova le coppie bloccanti, ch compreso, e lascia fuori le pulite', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retranslate-scan-'));
  try {
    writeScanFixture(tmp);
    const pairs = blockingPairsFromContent(tmp, { locales: ['it', 'en'] });
    // Ordinate per key (dir/locale/id): '-' precede '/', quindi blog-body-ch viene prima.
    assert.deepEqual(pairs, [
      { id: 'ch-ff', locale: 'en', dir: 'services/locales/blog-body-ch', codes: ['translation-false-friend'] },
      { id: 'ff', locale: 'en', dir: 'services/locales/blog-body', codes: ['translation-false-friend'] },
      { id: 'scaf', locale: 'it', dir: 'services/locales/blog-body', codes: ['leaked-prompt-scaffolding'] },
    ],'stesso formato di blockingPairsFromAudit, dir con il path dell\'audit');

    // Il default resta en,de,fr: l'italiano e' opt-in anche per --scan.
    const defaults = blockingPairsFromContent(tmp);
    assert.deepEqual(defaults.map((p) => `${p.locale}/${p.id}`).sort(), ['en/ch-ff', 'en/ff']);

    const scan = scanContentForBlockingPairs(tmp, { locales: ['it', 'en'] });
    assert.equal(scan.scanned, 10, 'ogni file it/en della fixture viene letto');
    const ff = scan.pairs.find((p) => p.id === 'ff');
    assert.match(ff.evidence[0].excerpt, /border guards/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('--scan rifiuta un secondo sorgente di coppie e i flag fuori contesto', () => {
  const run = (...args) => spawnSync(process.execPath, [SCAN_SCRIPT, ...args], { encoding: 'utf8' });
  for (const args of [
    ['--scan', '--audit', '/dev/null'],
    ['--scan', '--slug', 'x'],
    ['--scan', '--missing'],
    ['--count-only'],
    ['--audit', '/dev/null', '--list-out', '/tmp/x.jsonl'],
    ['--scan', '--count-only', '--apply'],
    ['--scan', '--list-out='],
  ]) {
    const res = run(...args);
    assert.equal(res.status, 2, `${args.join(' ')} deve uscire 2 (stderr: ${res.stderr})`);
  }
});

test('--scan senza --apply non tocca la fixture; --count-only e --list-out riportano lo stock', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retranslate-scan-cli-'));
  try {
    const rels = writeScanFixture(tmp);
    const before = snapshotFiles(tmp, rels);

    // Percorso completo in dry-run sulla sola coppia italiana: niente MT, ma
    // la coppia passa davvero da processPair.
    const dry = spawnSync(process.execPath, [
      SCAN_SCRIPT, '--scan', '--locale', 'it', '--content-root', tmp, '--json',
    ], { encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    const dryReport = JSON.parse(dry.stdout);
    assert.equal(dryReport.mode, 'dry-run');
    assert.deepEqual(dryReport.results.map((r) => `${r.locale}/${r.id}`), ['it/scaf']);
    assert.equal(dryReport.results[0].written, false);

    const out = path.join(tmp, 'stock.json');
    const listOut = path.join(tmp, 'stock.jsonl');
    const counted = spawnSync(process.execPath, [
      SCAN_SCRIPT, '--scan', '--count-only', '--content-root', tmp, '--out', out, '--list-out', listOut,
    ], { encoding: 'utf8' });
    assert.equal(counted.status, 0, counted.stderr);

    assert.deepEqual(snapshotFiles(tmp, rels), before, '--scan senza --apply non deve scrivere nessun body');

    const stdoutCounts = JSON.parse(counted.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), stdoutCounts, '--out e stdout portano la stessa conta');
    assert.ok(stdoutCounts.byCode && typeof stdoutCounts.byCode === 'object');
    // --count-only include l'italiano di default.
    assert.equal(stdoutCounts.byCode['leaked-prompt-scaffolding'].it, 1);
    assert.equal(stdoutCounts.byCode['translation-false-friend'].en, 2);
    assert.equal(stdoutCounts.byCode['translation-false-friend'].total, 2);
    assert.equal(stdoutCounts.scanned, 10);

    const rows = fs.readFileSync(listOut, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const keys = rows.map((r) => r.key);
    assert.deepEqual(keys, [...keys].sort(), 'JSONL ordinato per key');
    assert.deepEqual(keys, [
      'services/locales/blog-body-ch/en/ch-ff',
      'services/locales/blog-body/en/ff',
      'services/locales/blog-body/it/scaf',
    ]);
    const ff = rows.find((r) => r.key.endsWith('/en/ff'));
    assert.deepEqual(ff.codes, ['translation-false-friend']);
    assert.equal(ff.evidence[0].code, 'translation-false-friend');
    assert.match(ff.evidence[0].excerpt, /border guards/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
