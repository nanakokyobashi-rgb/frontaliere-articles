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
  planTitleMarkerRemoval,
  keyFactsGuardMode,
  templateHeadingIssue,
  TEMPLATE_HEADING_NOT_CANONICAL,
} from '../scripts/retranslate-blocking-bodies.mjs';
import { diffIsExactlyRemovedLines } from '../scripts/lib/strip-leaked-title-marker.mjs';
// Dal modulo corpus-only, NON da `lib/article-sanitizers.mjs`: quello e'
// `identical` nel manifest del ciclo e un export aggiunto dal corpus lo
// renderebbe `corpus-ahead`. Questo import pinna anche la collocazione.
import { sanitizeBodyText } from '../scripts/lib/sanitize-body-braces.mjs';
// L'ALTRO scrittore per-locale che gatta la scrittura sulla lingua: stessa
// classe, stesso rimedio — la verifica guarda l'unita' tradotta, non il testo
// concatenato.
import { filterWrongLocalePairs, wrongLocalePair } from '../scripts/fix-faq-locales.mjs';
import { detectLanguage, detectLanguageWithConfidence } from '../scripts/lib/detect-language.mjs';
import { translateFieldFreeMt } from '../scripts/lib/article-free-mt.mjs';
import { getKeyFactsHeading, getTldrHeading } from '../scripts/lib/ai-search-template.mjs';

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

// Lotto 1 della bonifica Codex (#2121, 20 coppie de): 6 rifiutate col motivo
// generico «sezione Fatti chiave riconosciuta» perche' la traduzione diceva
// `## Eckdaten`, e 8 delle 9 scritte con `## Kurz zusammengefasst` al posto di
// `## Auf einen Blick`, che nessuna guardia vedeva.
const IT_TEMPLATE_BODY1 = [
  '## In breve',
  '- Il permesso G si rinnova ogni cinque anni.',
  '',
  '## Fatti chiave',
  '- **Cosa**: rinnovo del permesso G.',
  '- **Dove**: Ufficio della migrazione, Bellinzona.',
  '',
  'Il frontaliere presenta la domanda prima della scadenza.',
].join('\n');
const deTemplateBody1 = (tldr, keyFacts) => [
  tldr,
  '- Die Grenzgängerbewilligung G wird alle fünf Jahre erneuert.',
  '',
  keyFacts,
  '- **Was**: Erneuerung der Bewilligung G.',
  '- **Wo**: Migrationsamt, Bellinzona.',
  '',
  'Der Grenzgänger reicht den Antrag vor Ablauf ein.',
].join('\n');

test('templateHeadingIssue: `## Eckdaten` e `## Kurz zusammengefasst` danno il codice esplicito, i canonici passano', () => {
  const italianSections = { body1: IT_TEMPLATE_BODY1, body2: 'Seconda parte.' };
  const check = (body1, locale = 'de') => templateHeadingIssue({
    italianSections,
    newSections: { body1, body2: 'Zweiter Teil.' },
    locale,
  });

  const eckdaten = check(deTemplateBody1('## Auf einen Blick', '## Eckdaten'));
  assert.match(eckdaten, new RegExp(`^\\[${TEMPLATE_HEADING_NOT_CANONICAL}\\]`));
  assert.match(eckdaten, /body1 «## Wichtige Fakten»/);
  assert.doesNotMatch(eckdaten, /Auf einen Blick/);

  const kurz = check(deTemplateBody1('## Kurz zusammengefasst', '## Wichtige Fakten'));
  assert.match(kurz, new RegExp(`^\\[${TEMPLATE_HEADING_NOT_CANONICAL}\\]`));
  assert.match(kurz, /body1 «## Auf einen Blick»/);

  assert.equal(check(deTemplateBody1('## Auf einen Blick', '## Wichtige Fakten')), null);
  // Stesso confronto di `isKeyFactsHeading`: maiuscole e spazi di bordo non contano.
  assert.equal(check(deTemplateBody1('## auf einen blick ', '## WICHTIGE FAKTEN')), null);
  // Gli altri locali col loro canonico.
  assert.equal(check('## TL;DR\n- x\n\n## Key facts\n- **What**: y', 'en'), null);
  assert.equal(check('## En bref\n- x\n\n## Faits clés\n- **Quoi**: y', 'fr'), null);
  assert.match(check('## In brief\n- x\n\n## Key facts\n- **What**: y', 'en'), /«## TL;DR»/);
  // Un titolo che la sorgente non ha non si pretende.
  assert.equal(templateHeadingIssue({
    italianSections: { body1: 'Solo prosa, senza template.' },
    newSections: { body1: 'Nur Text, ohne Vorlage.' },
    locale: 'de',
  }), null);
});

test('templateHeadingIssue: con `## Eckdaten` il motivo e\' il titolo, non il generico dei fatti chiave', () => {
  const newSections = { body1: deTemplateBody1('## Auf einen Blick', '## Eckdaten') };
  // La guardia dei fatti chiave da sola rifiuta col motivo generico...
  assert.match(guardTranslatedKeyFacts(newSections).issue, /sezione Fatti chiave riconosciuta/);
  // ...e processPair mette davanti il codice esplicito.
  const source = fs.readFileSync(new URL('../scripts/retranslate-blocking-bodies.mjs', import.meta.url), 'utf8');
  assert.match(source, /qualityIssue: titleMarkerPlan\?\.issue \|\| templateIssue \|\| keyFactsGuard\.issue,/);
  assert.match(source, /templateHeadingIssue\(\{ italianSections, newSections: checkedSections, locale: pair\.locale \}\)/);
  assert.match(
    templateHeadingIssue({ italianSections: { body1: IT_TEMPLATE_BODY1 }, newSections, locale: 'de' }),
    new RegExp(TEMPLATE_HEADING_NOT_CANONICAL),
  );
});

// Un titolo di template non arriva mai al motore: il campo viene diviso ai
// titoli, il motore traduce i blocchi di testo e la forma canonica della lingua
// di arrivo viene riscritta fra un blocco e l'altro. Qualunque cosa il motore
// faccia al testo che riceve, il titolo non puo' essere tradotto, fuso in una
// frase, spostato o perso.
const TEMPLATE_HEADING_LINE_RE = /^## (In breve|Fatti chiave)$/m;

test('translateFieldFreeMt non manda i titoli al motore, li canonizza in en/de/fr e supera la guardia', async () => {
  const source = IT_TEMPLATE_BODY1;

  for (const locale of ['en', 'de', 'fr']) {
    const inputs = [];
    const out = await translateFieldFreeMt({
      text: source,
      sourceLang: 'it',
      targetLang: locale,
      fieldType: 'description',
      fieldName: 'body1',
      translate: async ({ text }) => {
        inputs.push(text);
        // Il motore finto altera ogni riga che riceve.
        return text.split('\n').map((line) => (line ? `MT ${line}` : line)).join('\n');
      },
    });

    // Due blocchi di testo (dopo ciascun titolo), quindi due chiamate; nessuna
    // contiene un titolo di template ne' un segnaposto al suo posto.
    assert.equal(inputs.length, 2, locale);
    for (const input of inputs) {
      assert.doesNotMatch(input, TEMPLATE_HEADING_LINE_RE);
      assert.doesNotMatch(input, /0H0\d+Q0/);
    }
    assert.match(out, new RegExp(`^${getTldrHeading(locale)}$`, 'm'));
    assert.match(out, new RegExp(`^${getKeyFactsHeading(locale)}$`, 'm'));
    assert.equal(
      templateHeadingIssue({
        italianSections: { body1: source },
        newSections: { body1: out },
        locale,
      }),
      null,
    );
  }
});

test('un motore che appiattisce le righe non sposta i titoli ne\' le righe vuote attorno', async () => {
  // E' cio' che fa il ramo a pezzi della cascata per i testi lunghi
  // (`_chunkAtSentences` e `parts.join(' ')` in free-translate.mjs): unisce
  // segmenti e pezzi con uno spazio. Una sentinella «sola sulla sua riga» non
  // potrebbe sopravvivere; un titolo che il motore non vede si'.
  const out = await translateFieldFreeMt({
    text: IT_TEMPLATE_BODY1,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
    fieldName: 'body1',
    translate: async ({ text }) => `  MT ${text.replace(/\s*\n\s*/g, ' ')}  \r\n`,
  });

  const lines = out.split('\n');
  assert.equal(lines[0], getTldrHeading('de'));
  assert.equal(lines[1], 'MT - Il permesso G si rinnova ogni cinque anni.');
  assert.equal(lines[2], '');
  assert.equal(lines[3], getKeyFactsHeading('de'));
  assert.ok(lines[4].startsWith('MT - **Cosa**: rinnovo del permesso G.'));
  assert.equal(lines.length, 5, 'i titoli restano due righe intere, nell\'ordine della sorgente');
  assert.equal(
    templateHeadingIssue({
      italianSections: { body1: IT_TEMPLATE_BODY1 },
      newSections: { body1: out },
      locale: 'de',
    }),
    null,
  );
});

test('translateFieldFreeMt riscrive ogni occorrenza ripetuta dello stesso titolo', async () => {
  const source = ['## In breve', 'Primo testo.', '## In breve', 'Secondo testo.'].join('\n');
  const out = await translateFieldFreeMt({
    text: source,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'title',
    translate: async ({ text }) => `MT ${text}`,
  });

  assert.equal(out, [
    getTldrHeading('de'), 'MT Primo testo.', getTldrHeading('de'), 'MT Secondo testo.',
  ].join('\n'));
});

test('titoli adiacenti o in coda non generano chiamate a vuoto', async () => {
  const inputs = [];
  const out = await translateFieldFreeMt({
    text: ['Premessa.', '## In breve', '', '## Fatti chiave'].join('\n'),
    sourceLang: 'it',
    targetLang: 'fr',
    fieldType: 'description',
    fieldName: 'body1',
    translate: async ({ text }) => {
      inputs.push(text);
      return `MT ${text}`;
    },
  });

  assert.deepEqual(inputs, ['Premessa.']);
  assert.equal(out, ['MT Premessa.', getTldrHeading('fr'), '', getKeyFactsHeading('fr')].join('\n'));
});

test('titolo assente o presente solo dentro una riga di prosa resta nel testo tradotto', async () => {
  for (const source of [
    'Solo prosa, senza titoli di template.',
    'Nota: ## In breve è citato qui, ma la riga non è un titolo.',
  ]) {
    let received;
    const out = await translateFieldFreeMt({
      text: source,
      sourceLang: 'it',
      targetLang: 'en',
      fieldType: 'title',
      translate: async ({ text }) => {
        received = text;
        return `MT ${text}`;
      },
    });

    assert.equal(received, source);
    assert.equal(out, `MT ${source}`);
  }
});

test('senza titoli di template il campo va al motore in una chiamata e l\'uscita resta com\'e\'', async () => {
  const inputs = [];
  const out = await translateFieldFreeMt({
    text: 'Prima riga.\n\nSeconda riga.',
    sourceLang: 'it',
    targetLang: 'en',
    fieldType: 'description',
    fieldName: 'body2',
    translate: async ({ text }) => {
      inputs.push(text);
      return `MT ${text}\n`;
    },
  });

  assert.deepEqual(inputs, ['Prima riga.\n\nSeconda riga.']);
  assert.equal(out, 'MT Prima riga.\n\nSeconda riga.\n');
});

test('lingua senza forma canonica lascia il titolo al motore senza inventare una forma', async () => {
  const source = '## In breve\nTesto italiano.';
  for (const targetLang of ['es', 'de-CH']) {
    let received;
    const out = await translateFieldFreeMt({
      text: source,
      sourceLang: 'it',
      targetLang,
      fieldType: 'title',
      translate: async ({ text }) => {
        received = text;
        return `MT ${text}`;
      },
    });

    assert.equal(received, source);
    assert.equal(out, `MT ${source}`);
  }
});

test('un blocco che il motore non traduce fa fallire chiuso l\'intero campo, con un solo segnale', async () => {
  const source = ['## In breve', 'Sintesi italiana.', '## Fatti chiave', '- Un fatto italiano.'].join('\n');
  const casi = [
    ['uscita vuota sul secondo blocco', async ({ text }) => (text.startsWith('-') ? '' : `MT ${text}`), 'unusable-text'],
    ['uscita non stringa sul primo blocco', async () => null, 'non-string'],
    ['errore del motore sul secondo blocco', async ({ text }) => {
      if (text.startsWith('-')) throw new Error('quota');
      return `MT ${text}`;
    }, 'error'],
  ];

  for (const [nome, translate, reason] of casi) {
    const signals = [];
    const out = await translateFieldFreeMt({
      text: source,
      sourceLang: 'it',
      targetLang: 'fr',
      fieldType: 'description',
      fieldName: 'body1',
      translate,
      onUnusableOutput: (event) => signals.push(event),
    });

    // Mai un campo cucito a meta': o tutti i blocchi sono tradotti, o niente.
    assert.equal(out, '', nome);
    assert.deepEqual(signals, [{
      targetLang: 'fr',
      fieldType: 'description',
      fieldName: 'body1',
      reason,
    }], nome);
  }
});

test('i link interni restano protetti attraverso i blocchi', async () => {
  const source = [
    '## In breve',
    'Leggi la [guida](nav:guide) completa.',
    '## Fatti chiave',
    '- Usa il [calcolatore](nav:calculator).',
  ].join('\n');
  const inputs = [];
  const out = await translateFieldFreeMt({
    text: source,
    sourceLang: 'it',
    targetLang: 'en',
    fieldType: 'description',
    fieldName: 'body1',
    translate: async ({ text }) => {
      inputs.push(text);
      return `MT ${text}`;
    },
  });

  // Gli indici dei segnaposto sono globali al campo: ogni blocco ne porta una
  // parte e il ripristino avviene sul campo ricomposto.
  assert.deepEqual(inputs, ['Leggi la 0NAV00 completa.', '- Usa il 0NAV10.']);
  assert.equal(out, [
    getTldrHeading('en'),
    'MT Leggi la [guida](nav:guide) completa.',
    getKeyFactsHeading('en'),
    'MT - Usa il [calcolatore](nav:calculator).',
  ].join('\n'));
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
  // Albero completo per i locali di --count-only: de/fr vuoti ma presenti,
  // altrimenti la guardia di completezza (giustamente) rifiuta la conta.
  for (const tree of ['content/blog-body', 'content/blog-body-ch']) {
    for (const locale of ['de', 'fr']) fs.mkdirSync(path.join(root, tree, locale), { recursive: true });
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
  // Molti percorsi escono 2: ogni caso fissa anche il messaggio della SUA
  // guardia, cosi' una regressione che cade su un altro exit 2 resta visibile.
  for (const [args, expected] of [
    [['--scan', '--audit', '/dev/null'], /--scan non si combina/],
    [['--scan', '--slug', 'x'], /--scan non si combina/],
    [['--scan', '--missing'], /--scan non si combina/],
    [['--missing', '--count-only'], /valgono solo con --scan/],
    [['--audit', '/dev/null', '--list-out', '/tmp/x.jsonl'], /valgono solo con --scan/],
    [['--scan', '--count-only', '--apply'], /--count-only non si combina con --apply/],
    [['--scan', '--list-out='], /--list-out è vuoto/],
  ]) {
    const res = run(...args);
    assert.equal(res.status, 2, `${args.join(' ')} deve uscire 2 (stderr: ${res.stderr})`);
    assert.match(res.stderr, expected, `${args.join(' ')}: guardia sbagliata`);
  }
});

test('--scan fallisce chiuso su un albero incompleto o sparse invece di contare zero', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retranslate-scan-gaps-'));
  const count = (...extra) => spawnSync(process.execPath, [
    SCAN_SCRIPT, '--scan', '--count-only', '--content-root', tmp, ...extra,
  ], { encoding: 'utf8' });
  try {
    writeScanFixture(tmp);
    assert.equal(count().status, 0, 'la fixture completa si conta');

    // Un locale chiesto senza cartella: la conta sarebbe parziale.
    fs.rmSync(path.join(tmp, 'content/blog-body-ch/fr'), { recursive: true });
    const noLocale = count();
    assert.equal(noLocale.status, 2, noLocale.stdout);
    assert.match(noLocale.stderr, /incompleto.*content\/blog-body-ch\/fr/);
    assert.equal(noLocale.stdout, '', 'nessuna conta stampata');
    // Con --locale che lo esclude la conta e' di nuovo completa.
    assert.equal(count('--locale', 'it,en,de').status, 0);

    // Un albero intero assente (il caso del worktree sparse senza -ch).
    fs.rmSync(path.join(tmp, 'content/blog-body-ch'), { recursive: true });
    const noTree = count('--locale', 'it,en');
    assert.equal(noTree.status, 2, noTree.stdout);
    assert.match(noTree.stderr, /mancano: content\/blog-body-ch\b/);

    // Cartelle presenti ma file skip-worktree: il caso sparse vero.
    writeScanFixture(tmp);
    const git = (...args) => spawnSync('git', ['-C', tmp, ...args], { encoding: 'utf8' });
    assert.equal(git('init', '-q').status, 0);
    assert.equal(git('add', 'content').status, 0);
    assert.equal(count().status, 0, 'checkout git completo: nessun skip-worktree');
    assert.equal(git('update-index', '--skip-worktree', 'content/blog-body/en/ff.ts').status, 0);
    fs.rmSync(path.join(tmp, 'content/blog-body/en/ff.ts'));
    const sparse = count();
    assert.equal(sparse.status, 2, sparse.stdout);
    assert.match(sparse.stderr, /1 body tracciati ma non materializzati/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Review 2026-10-04T01:20Z su e3b8fd98ca: il bit `S` di `git ls-files -v` non
// basta. Un body tracciato e CANCELLATO dal worktree (senza skip-worktree)
// restava fuori da `readdirSync` e la conta usciva 0, piu' bassa. La guardia
// confronta i body tracciati con quelli presenti, per ogni ramo che legge
// `content/`: --scan, --missing, --slug e i file di un --audit.
test('un body tracciato ma assente dal worktree fa uscire 2 ogni ramo che legge content/', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retranslate-scan-tracked-'));
  const run = (...args) => spawnSync(process.execPath, [SCAN_SCRIPT, '--content-root', tmp, ...args], { encoding: 'utf8' });
  const git = (...args) => spawnSync('git', ['-C', tmp, ...args], { encoding: 'utf8' });
  try {
    writeScanFixture(tmp);
    assert.equal(git('init', '-q').status, 0);
    assert.equal(git('add', 'content').status, 0);

    // Caso sano: checkout git completo, la conta esce 0 con tutti i file.
    const sane = run('--scan', '--count-only');
    assert.equal(sane.status, 0, sane.stderr);
    assert.equal(JSON.parse(sane.stdout).scanned, 10);

    // Traduzione cancellata, non skip-worktree: prima usciva 0 con scanned 9.
    fs.rmSync(path.join(tmp, 'content/blog-body/en/ff.ts'));
    const deleted = run('--scan', '--count-only');
    assert.equal(deleted.status, 2, deleted.stdout);
    assert.match(deleted.stderr, /tracciati ma assenti.*content\/blog-body\/en\/ff\.ts/s);
    assert.equal(deleted.stdout, '', 'nessuna conta stampata');
    // Il locale escluso non e' richiesto: la stessa assenza non blocca.
    assert.equal(run('--scan', '--count-only', '--locale', 'it,de,fr').status, 0);
    // Gli altri rami che leggono content/ falliscono chiusi allo stesso modo.
    const missing = run('--missing', '--locale', 'en');
    assert.equal(missing.status, 2, missing.stdout);
    assert.match(missing.stderr, /tracciati ma assenti/);
    const slug = run('--slug', 'ff', '--locale', 'en');
    assert.equal(slug.status, 2, slug.stdout);
    assert.match(slug.stderr, /tracciati ma assenti.*en\/ff\.ts/s);
    git('checkout', '--', 'content/blog-body/en/ff.ts');

    // L'italiano di riferimento cancellato pesa anche se si contano solo gli en.
    fs.rmSync(path.join(tmp, 'content/blog-body-ch/it/ch-ff.ts'));
    const noRef = run('--scan', '--count-only', '--locale', 'en');
    assert.equal(noRef.status, 2, noRef.stdout);
    assert.match(noRef.stderr, /content\/blog-body-ch\/it\/ch-ff\.ts/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('una lista di locali vuota o un insieme senza file escono 2 prima della scansione', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retranslate-scan-empty-'));
  const run = (...args) => spawnSync(process.execPath, [SCAN_SCRIPT, '--content-root', tmp, ...args], { encoding: 'utf8' });
  try {
    writeScanFixture(tmp);
    // `--locale=` dava LOCALES=[]: nessun file letto e conta vuota con exit 0.
    for (const args of [
      ['--scan', '--count-only', '--locale='],
      ['--scan', '--count-only', '--locale', ' , '],
      ['--scan', '--locale='],
      ['--missing', '--locale='],
      ['--slug', 'ff', '--locale='],
      ['--audit', '/dev/null', '--locale='],
    ]) {
      const res = run(...args);
      assert.equal(res.status, 2, `${args.join(' ')} deve uscire 2 (stdout: ${res.stdout})`);
      assert.match(res.stderr, /--locale .*vuot/, `${args.join(' ')}: guardia sbagliata`);
      assert.equal(res.stdout, '', `${args.join(' ')}: nessun output`);
    }

    // Uno slug chiesto che non corrisponde a nessun body: era un no-op a exit 0.
    const ghost = run('--slug', 'non-esiste', '--json');
    assert.equal(ghost.status, 2, ghost.stdout);
    assert.match(ghost.stderr, /non-esiste/);

    // Caso sano: la fixture completa esce 0.
    assert.equal(run('--scan', '--count-only').status, 0);

    // Albero completo nelle cartelle ma senza un solo body: lo stock vuoto non
    // e' "zero bloccanti", e' una conta che non ha letto niente.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'retranslate-scan-nofiles-'));
    try {
      for (const tree of ['content/blog-body', 'content/blog-body-ch']) {
        for (const locale of ['it', 'en', 'de', 'fr']) fs.mkdirSync(path.join(empty, tree, locale), { recursive: true });
      }
      const none = spawnSync(process.execPath, [SCAN_SCRIPT, '--scan', '--count-only', '--content-root', empty], { encoding: 'utf8' });
      assert.equal(none.status, 2, none.stdout);
      assert.match(none.stderr, /nessun body/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
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

// ── Italiano con `TITOLO ARTICOLO`: la sola riga del prompt ────────────────
//
// Il ramo `it` di `processPair` ripassava il body da `sanitizeBodyText` e lo
// stock scaffolding (site 7682) non poteva mai uscire. Con l'approvazione del
// proprietario del 2026-10-04 si toglie SOLO la riga `TITOLO ARTICOLO: …`.
// Rosso se: la scrittura cambia altro oltre a quella riga, una forma non
// riconosciuta viene editata, si scrive con altri `critical` o senza --apply.

const IT_FACTS = [
  '## Fatti chiave',
  '- **Cosa**: dichiarazione dei redditi dei frontalieri.',
  '- **Dove**: Cantone Ticino.',
  '- **Chi**: lavoratori frontalieri residenti in Italia.',
  '',
].join('\n');
const IT_BODY1 = `${IT_FACTS}${IT_LONG}`;
const TITLE_LINE = 'TITOLO ARTICOLO: «Frontalieri e redditi» in Ticino';

function writeItFixture(root, files) {
  for (const tree of ['content/blog-body', 'content/blog-body-ch']) {
    fs.mkdirSync(path.join(root, tree, 'it'), { recursive: true });
  }
  for (const [rel, src] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, rel), src);
  }
  return Object.keys(files);
}

function runItScan(root, ...extra) {
  const run = spawnSync(process.execPath, [
    SCAN_SCRIPT, '--scan', '--locale', 'it', '--code', 'leaked-prompt-scaffolding',
    '--content-root', root, '--json', ...extra,
  ], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('it scaffolding: --apply toglie la sola riga TITOLO ARTICOLO e nient\'altro', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retranslate-it-title-'));
  try {
    const rel = 'content/blog-body/it/riga.ts';
    const original = fileFor('riga', {
      body1: `${IT_BODY1}\n\n${TITLE_LINE}`,
      body2: IT_LONG,
      body3: IT_LONG,
    });
    writeItFixture(tmp, { [rel]: original });

    const dry = runItScan(tmp);
    assert.deepEqual(dry.results.map((r) => [r.id, r.reason, r.written]), [['riga', 'pulita', false]]);
    assert.deepEqual(dry.results[0].removedLines, [TITLE_LINE]);
    assert.equal(fs.readFileSync(path.join(tmp, rel), 'utf8'), original, 'senza --apply il file resta byte per byte');

    const applied = runItScan(tmp, '--apply');
    assert.deepEqual(applied.results.map((r) => [r.id, r.reason, r.written]), [['riga', 'pulita', true]]);
    const after = fs.readFileSync(path.join(tmp, rel), 'utf8');
    // Il file e' l'originale meno la riga e il suo terminatore (`\n` escapato).
    assert.equal(after, original.replace(`\\n${TITLE_LINE}`, ''));
    assert.notEqual(after, original);
    assert.equal(readBodyField(after, 'riga', 'body1'), `${IT_BODY1}\n`);
    assert.equal(readBodyField(after, 'riga', 'body2'), IT_LONG);
    assert.equal(readBodyField(after, 'riga', 'body3'), IT_LONG);

    // La pagina esce dallo stock: un secondo giro non la trova piu'.
    assert.deepEqual(runItScan(tmp).results, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('it scaffolding: forme non riparabili e codici misti lasciano la pagina intatta', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retranslate-it-title-skip-'));
  try {
    const files = {
      // Forma B: intestazione con il titolo sulla riga sotto.
      'content/blog-body/it/forma-b.ts': fileFor('forma-b', {
        body1: IT_BODY1,
        body2: `## TITOLO ARTICOLO\nFrontalieri e redditi\n\n${IT_LONG}`,
        body3: IT_LONG,
      }),
      // Riga rimovibile E un'istituzione inventata: un altro `critical`.
      'content/blog-body/it/misti.ts': fileFor('misti', {
        body1: `${IT_BODY1}\n\n${TITLE_LINE}`,
        body2: `${IT_LONG}Secondo l'Ufficio federale delle imposte (UFI), circa 2.000 lavoratori sono coinvolti.`,
        body3: IT_LONG,
      }),
      // Diff piu' largo della riga: la graffa spaiata in body2 la toglierebbe
      // la sanificazione, cioe' un'altra modifica oltre alla riga del prompt.
      'content/blog-body-ch/it/largo.ts': fileFor('largo', {
        body1: `${IT_BODY1}\n\n${TITLE_LINE}`,
        body2: `${IT_LONG}Il permesso G resta valido. }`,
        body3: IT_LONG,
      }),
    };
    const rels = writeItFixture(tmp, files);
    // Campo in template literal: riscriverlo nella forma canonica cambierebbe
    // altri byte del file oltre alla riga.
    const tplRel = 'content/blog-body/it/tpl.ts';
    const tplSrc = `const b: Record<string, string> = {\n`
      + `  'blog.article.tpl.body1': \`${IT_BODY1}\n\n${TITLE_LINE}\`,\n`
      + `  'blog.article.tpl.body2': '${escapeForSingleQuoteTS(IT_LONG)}',\n`
      + `  'blog.article.tpl.body3': '${escapeForSingleQuoteTS(IT_LONG)}',\n`
      + `};\n\nexport default b;\n`;
    fs.writeFileSync(path.join(tmp, tplRel), tplSrc);
    rels.push(tplRel);
    const before = snapshotFiles(tmp, rels);

    const applied = runItScan(tmp, '--apply');
    const byId = Object.fromEntries(applied.results.map((r) => [r.id, r]));
    assert.deepEqual(Object.keys(byId).sort(), ['forma-b', 'largo', 'misti', 'tpl']);
    for (const r of applied.results) assert.equal(r.written, false, `${r.id}: ${r.reason}`);
    assert.match(byId['forma-b'].reason, /^forma-non-riparabile: body2 intestazione: ## TITOLO ARTICOLO/);
    assert.equal(byId.misti.reason, 'codici-misti');
    assert.equal(byId.largo.reason, 'forma-non-riparabile: diff-oltre-la-riga (body2)');
    assert.equal(byId.tpl.reason, 'forma-non-riparabile: file-oltre-la-riga');
    assert.deepEqual(snapshotFiles(tmp, rels), before, 'nessuna di queste pagine va riscritta');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('planTitleMarkerRemoval: niente da togliere non e\' una riparazione', () => {
  const src = fileFor('x', { body1: IT_BODY1 });
  assert.deepEqual(planTitleMarkerRemoval({
    src,
    id: 'x',
    oldCodes: ['leaked-prompt-scaffolding'],
    oldSections: { body1: IT_BODY1 },
    newSections: { body1: IT_BODY1 },
    removedByField: { body1: [] },
    skipped: [],
  }), { issue: 'forma-non-riparabile: nessuna-riga-marcatore', src: null });
});

test('it scaffolding: un campo fatto della sola riga TITOLO ARTICOLO resta intatto e il motivo non cita la cascata', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retranslate-it-title-only-'));
  try {
    const rels = writeItFixture(tmp, {
      'content/blog-body/it/solo.ts': fileFor('solo', {
        body1: IT_BODY1,
        body2: IT_LONG,
        body3: TITLE_LINE,
      }),
    });
    const before = snapshotFiles(tmp, rels);
    const applied = runItScan(tmp, '--apply');
    assert.deepEqual(applied.results.map((r) => [r.id, r.reason, r.written]), [
      ['solo', 'forma-non-riparabile: campo-solo-marcatore (body3)', false],
    ]);
    assert.deepEqual(snapshotFiles(tmp, rels), before, 'il file non va riscritto');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Casi limite della rimozione: decisioni del proprietario del 2026-10-04 ──
//
// 1. Fatti chiave con valori vuoti: nel solo ramo della rimozione la guardia
//    dei fatti chiave verifica e non riscrive (il diff prova gia' che i Fatti
//    chiave restano identici al pubblicato).
// 2. Nessuna sezione Fatti chiave riconosciuta: esentata dal requisito, per
//    la sola rimozione.
// 3. Riga in testa a un campo, seguita da una riga vuota: si toglie, il campo
//    comincia poi con la riga vuota.
// 4. Le righe vuote adiacenti restano: il diff e' esattamente la riga.
// Fuori da quel ramo la guardia resta com'era. Rosso se una di queste pagine
// non viene scritta, se la scrittura cambia piu' della riga, o se una
// riscrittura che non e' la rimozione passa con fatti vuoti.

const IT_VACUOUS_FACTS = IT_FACTS.replace(
  '- **Chi**',
  '- **Quando**: non specificato.\n- **Importo**: CHF 200 al mese.\n- **Chi**',
);

test('it scaffolding: fatti vuoti, nessuna sezione e riga in testa vengono scritti con diff = la sola riga', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retranslate-it-title-edge-'));
  try {
    const cases = {
      // Decisione 1: la guardia, se riscrivesse, toglierebbe «non specificato».
      vacuo: {
        rel: 'content/blog-body-ch/it/vacuo.ts',
        fields: { body1: `${IT_VACUOUS_FACTS}${IT_LONG}\n\n${TITLE_LINE}`, body2: IT_LONG, body3: IT_LONG },
        field: 'body1',
        expected: `${IT_VACUOUS_FACTS}${IT_LONG}\n`,
      },
      // Decisione 2: nessuna sezione Fatti chiave riconosciuta nel body1.
      'senza-sezione': {
        rel: 'content/blog-body/it/senza-sezione.ts',
        fields: { body1: `${IT_LONG}\n\n${TITLE_LINE}`, body2: IT_LONG, body3: IT_LONG },
        field: 'body1',
        expected: `${IT_LONG}\n`,
      },
      // Decisioni 3 e 4: prima riga di body3 seguita da una riga vuota.
      testa: {
        rel: 'content/blog-body/it/testa.ts',
        fields: { body1: IT_BODY1, body2: IT_LONG, body3: `${TITLE_LINE}\n\n${IT_LONG}` },
        field: 'body3',
        expected: `\n${IT_LONG}`,
      },
    };
    const originals = {};
    for (const [id, c] of Object.entries(cases)) originals[id] = fileFor(id, c.fields);
    writeItFixture(tmp, Object.fromEntries(Object.entries(cases).map(([id, c]) => [c.rel, originals[id]])));

    const applied = runItScan(tmp, '--apply');
    assert.deepEqual(
      applied.results.map((r) => [r.id, r.reason, r.written]).sort(),
      [['senza-sezione', 'pulita', true], ['testa', 'pulita', true], ['vacuo', 'pulita', true]],
    );
    for (const [id, c] of Object.entries(cases)) {
      const after = fs.readFileSync(path.join(tmp, c.rel), 'utf8');
      // A livello di file: l'originale meno la riga e UN terminatore escapato.
      const minusLine = c.field === 'body3'
        ? originals[id].replace(`${TITLE_LINE}\\n`, '')
        : originals[id].replace(`\\n${TITLE_LINE}`, '');
      assert.equal(after, minusLine, `${id}: il file cambia solo per la riga`);
      const value = readBodyField(after, id, c.field);
      assert.equal(value, c.expected, `${id}: ${c.field}`);
      assert.ok(diffIsExactlyRemovedLines(c.fields[c.field], value, [TITLE_LINE]), `${id}: diff = riga`);
      for (const other of ['body1', 'body2', 'body3'].filter((f) => f !== c.field)) {
        assert.equal(readBodyField(after, id, other), c.fields[other], `${id}: ${other} intatto`);
      }
    }
    // I Fatti chiave vuoti restano come pubblicati: la guardia non ha riscritto.
    assert.match(readBodyField(fs.readFileSync(path.join(tmp, cases.vacuo.rel), 'utf8'), 'vacuo', 'body1'), /non specificato/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('keyFactsGuardMode: sola verifica e niente sezione richiesta SOLO nel ramo della rimozione', () => {
  const removal = keyFactsGuardMode({ titleMarkerRemoval: true, sourceBody1: IT_BODY1 });
  assert.equal(removal.verifyOnly, true);
  assert.equal(removal.options.requireRecognizedSection, false);
  assert.equal(removal.options.maxSourceBackedResiduals, 0);

  // Fuori dal ramo: la guardia di sempre, con riscrittura e sezione richiesta.
  const rewrite = keyFactsGuardMode({ titleMarkerRemoval: false, sourceBody1: IT_BODY1 });
  assert.equal(rewrite.verifyOnly, false);
  assert.equal(rewrite.options.requireRecognizedSection, true);
  const structuralNoSource = keyFactsGuardMode({ structural: true, sourceBody1: IT_LONG });
  assert.equal(structuralNoSource.options.requireRecognizedSection, false, 'come prima: strutturale senza sezione nella fonte');

  // Una riscrittura NON di rimozione con fatti vuoti: rifiutata come prima.
  const belowThreshold = ['## Fatti chiave', '- **Cosa**: assegno.', '- **Quando**: non specificato.', '- **Dove**: Zugo.'].join('\n');
  assert.match(guardTranslatedKeyFacts({ body1: belowThreshold }, rewrite.options).issue, /key-facts-specificity/);
  assert.match(guardTranslatedKeyFacts({ body1: IT_LONG }, rewrite.options).issue, /sezione Fatti chiave riconosciuta/);
  // E con abbastanza superstiti la riscrittura toglie il fatto vuoto, come prima.
  const stripped = guardTranslatedKeyFacts({ body1: `${IT_VACUOUS_FACTS}${IT_LONG}` }, rewrite.options);
  assert.equal(stripped.issue, null);
  assert.doesNotMatch(stripped.sections.body1, /non specificato/);
});

test('it non-scaffolding: una riscrittura che non e\' la rimozione con fatti vuoti resta rifiutata dalla guardia', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retranslate-it-vacuous-'));
  try {
    const belowThreshold = ['## Fatti chiave', '- **Cosa**: assegno.', '- **Quando**: non specificato.', '- **Dove**: Zugo.', ''].join('\n');
    const rels = writeItFixture(tmp, {
      'content/blog-body/it/ufi.ts': fileFor('ufi', {
        body1: `${belowThreshold}${IT_LONG}`,
        body2: `${IT_LONG}Secondo l'Ufficio federale delle imposte (UFI), circa 2.000 lavoratori sono coinvolti.`,
        body3: IT_LONG,
      }),
    });
    const before = snapshotFiles(tmp, rels);
    const run = spawnSync(process.execPath, [
      SCAN_SCRIPT, '--scan', '--locale', 'it', '--code', 'fabricated-institution',
      '--content-root', tmp, '--json', '--apply',
    ], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const { results } = JSON.parse(run.stdout);
    assert.equal(results.length, 1);
    assert.equal(results[0].written, false);
    assert.match(results[0].reason, /^\[key-facts-specificity\]/);
    assert.equal(results[0].removedLines, undefined, 'non e\' il ramo della rimozione');
    assert.deepEqual(snapshotFiles(tmp, rels), before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Italiano con intestazioni-etichetta del prompt: solo il casing ─────────
//
// Decisione del proprietario del 2026-10-05 («Titoli normali»): nelle pagine
// `it` che la guardia segnala per «marcatore di sezione del prompt»
// (`## ESEMPIO CONCRETO`) le intestazioni che sono, per intero, un'etichetta
// del prompt in MAIUSCOLO diventano titoli normali, con un diff limitato a
// quelle righe e al loro casing. Caso reale: body2 di
// `frontaliere-piastrellista-ticino-stipendio-requisiti` (fixture con le sue
// intestazioni e prosa neutra). Rosso se la pagina resta nello stock, se la
// scrittura cambia altro oltre al casing di quelle righe, se una forma non
// riconosciuta viene editata o se il percorso non dichiara le conversioni.

const LABEL_HEADINGS = [
  ['## INTRODUZIONE', '## Introduzione'],
  ['## STIPENDIO E REQUISITI', '## Stipendio e requisiti'],
  ['## RICONOSCIMENTO DEL TITOLO', '## Riconoscimento del titolo'],
  ['## ESEMPIO CONCRETO', '## Esempio concreto'],
  ['## CHECKLIST OPERATIVE', '## Checklist operative'],
  ['## CONFRONTO TRA SCENARI PRATICI', '## Confronto tra scenari pratici'],
  ['## CONCLUSIONE', '## Conclusione'],
];
const labelBody = (pick) => LABEL_HEADINGS.map((pair) => `${pair[pick]}\n${IT_LONG}`).join('\n\n');

test('it scaffolding: --apply converte le intestazioni-etichetta del prompt nel solo casing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retranslate-it-headings-'));
  try {
    const rel = 'content/blog-body/it/piastre.ts';
    const fields = { body1: IT_BODY1, body2: labelBody(0), body3: IT_LONG };
    const original = fileFor('piastre', fields);
    writeItFixture(tmp, { [rel]: original });

    const dry = runItScan(tmp);
    assert.deepEqual(dry.results.map((r) => [r.id, r.reason, r.written]), [['piastre', 'pulita', false]]);
    assert.deepEqual(dry.results[0].convertedHeadings, LABEL_HEADINGS.map(([from, to]) => `${from} → ${to}`));
    assert.deepEqual(dry.results[0].removedLines, []);
    assert.equal(fs.readFileSync(path.join(tmp, rel), 'utf8'), original, 'senza --apply il file resta byte per byte');

    const applied = runItScan(tmp, '--apply');
    assert.deepEqual(applied.results.map((r) => [r.id, r.reason, r.written]), [['piastre', 'pulita', true]]);
    const after = fs.readFileSync(path.join(tmp, rel), 'utf8');
    let expected = original;
    for (const [from, to] of LABEL_HEADINGS) expected = expected.replace(from, to);
    assert.equal(after, expected, 'il file cambia solo nelle righe di intestazione');
    assert.equal(after.length, original.length, 'solo casing: stessa lunghezza');
    assert.equal(after.toLowerCase(), original.toLowerCase(), 'solo casing');
    assert.equal(readBodyField(after, 'piastre', 'body2'), labelBody(1));
    assert.equal(readBodyField(after, 'piastre', 'body1'), IT_BODY1);
    assert.equal(readBodyField(after, 'piastre', 'body3'), IT_LONG);

    // La pagina esce dallo stock: un secondo giro non la trova piu'.
    assert.deepEqual(runItScan(tmp).results, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('it scaffolding: riga TITOLO ARTICOLO e intestazioni-etichetta nella stessa pagina, entrambe e nient\'altro', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retranslate-it-headings-title-'));
  try {
    const rel = 'content/blog-body-ch/it/doppio.ts';
    const original = fileFor('doppio', { body1: `${IT_BODY1}\n\n${TITLE_LINE}`, body2: labelBody(0), body3: IT_LONG });
    writeItFixture(tmp, { [rel]: original });
    const applied = runItScan(tmp, '--apply');
    assert.deepEqual(applied.results.map((r) => [r.id, r.reason, r.written]), [['doppio', 'pulita', true]]);
    assert.deepEqual(applied.results[0].removedLines, [TITLE_LINE]);
    assert.equal(applied.results[0].convertedHeadings.length, LABEL_HEADINGS.length);
    let expected = original.replace(`\\n${TITLE_LINE}`, '');
    for (const [from, to] of LABEL_HEADINGS) expected = expected.replace(from, to);
    assert.equal(fs.readFileSync(path.join(tmp, rel), 'utf8'), expected);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('it scaffolding: etichette fuori forma, codici misti e diff piu\' largo lasciano la pagina intatta', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retranslate-it-headings-skip-'));
  try {
    const rels = writeItFixture(tmp, {
      // Etichetta senza `#`: il gate la segnala, ma non e' un'intestazione.
      'content/blog-body/it/nuda.ts': fileFor('nuda', {
        body1: IT_BODY1,
        body2: `## INTRODUZIONE\n${IT_LONG}\n\nESEMPIO CONCRETO:\n${IT_LONG}`,
        body3: IT_LONG,
      }),
      // Intestazioni convertibili E un'istituzione inventata.
      'content/blog-body/it/misti.ts': fileFor('misti', {
        body1: IT_BODY1,
        body2: `${labelBody(0)}\n\nSecondo l'Ufficio federale delle imposte (UFI), circa 2.000 lavoratori sono coinvolti.`,
        body3: IT_LONG,
      }),
      // La graffa spaiata la toglierebbe la sanificazione: un'altra modifica.
      'content/blog-body/it/largo.ts': fileFor('largo', {
        body1: IT_BODY1,
        body2: `${labelBody(0)}\n\nIl permesso G resta valido. }`,
        body3: IT_LONG,
      }),
    });
    const before = snapshotFiles(tmp, rels);
    const applied = runItScan(tmp, '--apply');
    const byId = Object.fromEntries(applied.results.map((r) => [r.id, r]));
    assert.deepEqual(Object.keys(byId).sort(), ['largo', 'misti', 'nuda']);
    for (const r of applied.results) assert.equal(r.written, false, `${r.id}: ${r.reason}`);
    assert.match(byId.nuda.reason, /^forma-non-riparabile: body2 etichetta-senza-intestazione: ESEMPIO CONCRETO:/);
    assert.equal(byId.misti.reason, 'codici-misti');
    assert.equal(byId.largo.reason, 'forma-non-riparabile: diff-oltre-la-riga (body2)');
    assert.deepEqual(snapshotFiles(tmp, rels), before, 'nessuna di queste pagine va riscritta');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('planTitleMarkerRemoval: una conversione che non e\' solo casing di un\'intestazione-etichetta e\' rifiutata', () => {
  const old = `## ESEMPIO CONCRETO\n${IT_LONG}`;
  const src = fileFor('x', { body1: IT_BODY1, body2: old });
  const base = {
    src,
    id: 'x',
    oldCodes: ['leaked-prompt-scaffolding'],
    oldSections: { body1: IT_BODY1, body2: old },
    removedByField: {},
    skipped: [],
  };
  const good = planTitleMarkerRemoval({
    ...base,
    newSections: { body1: IT_BODY1, body2: `## Esempio concreto\n${IT_LONG}` },
    convertedByField: { body2: [{ from: '## ESEMPIO CONCRETO', to: '## Esempio concreto' }] },
  });
  assert.equal(good.issue, null);
  assert.equal(readBodyField(good.src, 'x', 'body2'), `## Esempio concreto\n${IT_LONG}`);
  // Testo scritto diverso dalla conversione dichiarata.
  assert.deepEqual(planTitleMarkerRemoval({
    ...base,
    newSections: { body1: IT_BODY1, body2: `## Esempio pratico\n${IT_LONG}` },
    convertedByField: { body2: [{ from: '## ESEMPIO CONCRETO', to: '## Esempio concreto' }] },
  }), { issue: 'forma-non-riparabile: diff-oltre-la-riga (body2)', src: null });
  // Conversione dichiarata che non e' quella del modulo.
  assert.deepEqual(planTitleMarkerRemoval({
    ...base,
    newSections: { body1: IT_BODY1, body2: `## Esempio Concreto\n${IT_LONG}` },
    convertedByField: { body2: [{ from: '## ESEMPIO CONCRETO', to: '## Esempio Concreto' }] },
  }), { issue: 'forma-non-riparabile: diff-oltre-le-intestazioni (body2)', src: null });
});
