/**
 * faq-language-floor.test.mjs — il falso «lingua sbagliata» e il registro dei
 * rifiuti condiviso dai due scrittori FAQ.
 *
 * ## I DUE DIFETTI CHE QUESTO FILE PINNA
 *
 * Run 36297637209 di `batch-faq-articles.yml` (2026-09-27): Codex risponde
 * 20/20, ma 0/36 articoli riusciti con 43 × «traduzione rifiutata (lingua
 * sbagliata)», e gli stessi 36 articoli tornano ogni giorno.
 *
 * 1. Il ramo `lingua` di `wrongLocalePair` rifiutava sul solo rilevatore, che
 *    legge come italiano i nomi propri italiani conservati da una traduzione
 *    corretta. Sulle FAQ pubblicate: 88 rifiuti, 88 falsi. Le coppie qui sotto
 *    sono REALI, copiate dal corpus (i casi della run sono le stesse coppie).
 * 2. `batch-add-faq-to-articles.mjs` non consultava il registro dei rifiuti che
 *    `fix-faq-locales.mjs` gia' applica, quindi ritraduceva ogni giorno i locale
 *    parcheggiati.
 *
 * ## MUTAZIONI
 *
 * - Togliere `hasSourceLangFunctionWordSignal(...)` dal ramo `lingua`: i test
 *   «traduzione corretta» diventano rossi.
 * - Portare `SOURCE_LANG_MIN_FUNCTION_WORD_MARGIN` a 3: il test «italiano
 *   vero» sulla coppia corta del credito d'imposta diventa rosso.
 * - Togliere `partitionThrottledTranslations` da `main()` del batch: il test di
 *   cablaggio diventa rosso.
 * - Ignorare `written` in `recordFaqTranslationOutcome`: il test writer=false
 *   diventa rosso.
 * - Portare `WEAK_FUNCTION_WORD_WEIGHT` a 1: il caso del titolo inglese citato
 *   in una risposta francese diventa rosso.
 * - Togliere `belowFaqSourceCount` da `discoverArticles()`: il test della
 *   discovery sotto il conteggio sorgente diventa rosso.
 * - Togliere il registro da `checkpointCommitCommand()`: il test del checkpoint
 *   diventa rosso.
 * - Togliere il try/catch da `recordTranslation()`: il test del registro che
 *   lancia dopo una scrittura riuscita diventa rosso.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FAQ_REJECTION_LEDGER_GIT_PATH,
  FAQ_REJECTION_MAX_CONSECUTIVE,
  faqLocaleIssueKey,
  functionWordMargin,
  nextFaqRejection,
  shouldSkipFaqRejection,
  wrongLocalePair,
} from '../scripts/fix-faq-locales.mjs';
import {
  checkpointCommitCommand,
  discoverArticles,
  faqLedgerSaveFailures,
  writeTranslatedFaq,
  insertFaqIntoBodyFile,
  partitionThrottledTranslations,
  recordFaqTranslationOutcome,
} from '../scripts/batch-add-faq-to-articles.mjs';
import { detectLanguageWithConfidence } from '../scripts/lib/detect-language.mjs';

const QUI = path.dirname(fileURLToPath(import.meta.url));
const BATCH_SRC = fs.readFileSync(path.join(QUI, '..', 'scripts', 'batch-add-faq-to-articles.mjs'), 'utf8');

// ── Fix 1: traduzioni corrette che il rilevatore diceva `it` ─────────────

// content/blog-body/de/arcidiacono-curia-lugano-2026.ts, coppia 3: e' il caso
// della run (DE rifiutato, «3:it/lingua»): confidenza 0,43, it 369 vs de 210.
const DE_ARCIDIACONO = {
  q: 'Wer hat Andrea Arcidiacono als Pressesprecher der Diözese Lugano ernannt?',
  a: 'Andrea Arcidiacono wurde vom Apostolischen Administrator Alain de Raemy ernannt.',
};
// La sorgente italiana della stessa coppia.
const IT_ARCIDIACONO = {
  q: 'Chi ha nominato Andrea Arcidiacono come addetto stampa della Curia vescovile di Lugano?',
  a: "Andrea Arcidiacono è stato nominato dall'amministratore apostolico Alain de Raemy.",
};

// I falsi a confidenza piu' alta: una soglia sulla sola confidenza del
// rilevatore li lascerebbe rifiutati (0,59 / 0,67 / 0,79).
const CORRECT_TRANSLATIONS = [
  ['de', DE_ARCIDIACONO],
  ['en', { q: 'Why can Italian motorists save on petrol?', a: 'Italy has extended the excise duty cut until 1 May 2026, which means that Italian motorists can continue to save on petrol.' }],
  ['en', { q: 'When does Villa Visconti Borromeo Litta reopen?', a: 'Villa Visconti Borromeo Litta officially reopens on May 1st, 2026.' }],
  ['en', { q: 'What are Italian taxes?', a: "Italian taxes are IRPEF 23% up to €28'000, 33% €28'001–50'000, 43% over €50'000." }],
  ['fr', { q: 'Quand le programme DaziT prendra-t-il fin ?', a: 'Le programme DaziT prendra fin le 31 décembre 2026.' }],
  ['fr', { q: 'Quand rouvre la Villa Visconti Borromeo Litta ?', a: 'La Villa Visconti Borromeo Litta rouvre officiellement le 1er mai 2026.' }],
];

test('premessa: il rilevatore dice davvero `it` su queste traduzioni corrette', () => {
  for (const [locale, pair] of CORRECT_TRANSLATIONS) {
    assert.equal(detectLanguageWithConfidence(`${pair.q} ${pair.a}`, locale).lang, 'it',
      `la premessa del test non vale piu' per ${locale}: ${pair.q}`);
  }
});

test('una traduzione corretta con nomi propri italiani NON e\' rifiutata come italiano', () => {
  for (const [locale, pair] of CORRECT_TRANSLATIONS) {
    assert.equal(wrongLocalePair([pair], locale), null, `${locale}: ${pair.q}`);
  }
  // Anche con la sorgente: il ramo verbatim non la tocca, non e' uguale.
  assert.equal(wrongLocalePair([DE_ARCIDIACONO], 'de', [IT_ARCIDIACONO]), null);
});

test('l\'italiano vero sotto un locale tradotto resta rifiutato', () => {
  const realItalian = [
    IT_ARCIDIACONO,
    // content/blog-body/it/operatore-socio-sanitario-frontaliere.ts: la coppia
    // italiana piu' corta e piu' povera di parole funzionali misurata.
    { q: "Come funziona il credito d'imposta?", a: "Il credito d'imposta evita la doppia imposizione." },
  ];
  for (const pair of realItalian) {
    for (const locale of ['en', 'de', 'fr']) {
      assert.deepEqual(wrongLocalePair([pair], locale), [{ index: 0, detected: 'it', via: 'lingua' }],
        `${locale}: ${pair.q}`);
    }
  }
});

test('le parole funzionali ambigue fra le due lingue non sono evidenza', () => {
  // `la`, `le`, `un`, `se` stanno sia in it sia in fr: nel confronto it/fr si scartano.
  assert.equal(functionWordMargin('la le un se', 'it', 'fr'), 0);
  // Contro l'inglese le stesse parole sono italiane.
  assert.equal(functionWordMargin('la le un se', 'it', 'en'), 4);
  assert.ok(functionWordMargin(DE_ARCIDIACONO.q + ' ' + DE_ARCIDIACONO.a, 'it', 'de') < 1);
  // Lingue senza lista: nessuna evidenza contraria, il ramo resta quello di prima.
  assert.equal(functionWordMargin('qualunque testo', 'it', 'es'), Infinity);
});

test('`a`, `in`, `per` sono italiane ma pesano meta\': due bastano, una da sola no', () => {
  // Condivise con l'inglese: contro en non sono evidenza.
  assert.equal(functionWordMargin('a in per', 'it', 'en'), 0);
  // Contro fr/de contano, a meta' peso.
  assert.equal(functionWordMargin('per', 'it', 'fr'), 0.5);
  assert.equal(functionWordMargin('in per', 'it', 'fr'), 1);
  assert.equal(functionWordMargin('a per', 'it', 'de'), 1);
  // content/blog-body-ch/fr/come-si-diventa-ricchi-...: risposta francese
  // corretta con un titolo inglese citato. A peso pieno la sola `in` la
  // rifiutava (review di #1935, rimisura 1/88).
  const FR_TITLE = {
    q: 'Qui est Joseph Moore ?',
    a: "L'historien américain Joseph Moore a écrit un livre intitulé « How to Get Rich in American History ».",
  };
  assert.equal(detectLanguageWithConfidence(`${FR_TITLE.q} ${FR_TITLE.a}`, 'fr').lang, 'it');
  assert.equal(wrongLocalePair([FR_TITLE], 'fr'), null);
});

// ── Fix 2: il batch consulta e aggiorna lo stesso registro ──────────────

const SRC = [
  { q: 'Domanda uno della sorgente?', a: 'Risposta uno della sorgente, abbastanza lunga.' },
  { q: 'Domanda due della sorgente?', a: 'Risposta due della sorgente, abbastanza lunga.' },
  { q: 'Domanda tre della sorgente?', a: 'Risposta tre della sorgente, abbastanza lunga.' },
];
const SRC_CHANGED = [...SRC, { q: 'Domanda nuova?', a: 'Risposta nuova, abbastanza lunga.' }];
const REJECTED = { faq: null, rejected: true };

test('il batch registra ogni rifiuto e dopo N consecutivi il locale e\' parcheggiato', () => {
  const ledger = {};
  const key = faqLocaleIssueKey('art', 'de', 'frontaliere');
  for (let i = 1; i <= FAQ_REJECTION_MAX_CONSECUTIVE; i++) {
    assert.equal(recordFaqTranslationOutcome(ledger, key, SRC, REJECTED), true);
    assert.equal(ledger[key].consecutive, i);
  }
  assert.equal(shouldSkipFaqRejection(ledger[key], SRC), true);
  // Stesso formato di `fix-faq-locales.mjs`: la voce e' quella di nextFaqRejection.
  assert.deepEqual(ledger[key], nextFaqRejection(nextFaqRejection(undefined, SRC), SRC));
});

test('un fallimento del motore non e\' un rifiuto; una scrittura completa cancella la voce', () => {
  const key = faqLocaleIssueKey('art', 'en', 'frontaliere');
  const ledger = { [key]: nextFaqRejection(undefined, SRC) };
  const before = structuredClone(ledger);
  assert.equal(recordFaqTranslationOutcome(ledger, key, SRC, { faq: null, rejected: false }), false);
  assert.deepEqual(ledger, before);
  assert.equal(recordFaqTranslationOutcome(ledger, key, SRC, { faq: SRC, rejected: false }, { written: true }), true);
  assert.equal(key in ledger, false);
});

test('se lo scrittore fallisce (writer=false) il locale NON viene parcheggiato e resta ritentabile', () => {
  const key = faqLocaleIssueKey('art', 'de', 'frontaliere');
  const partial = { faq: SRC, rejected: false }; // potata: 3 coppie su 4
  const ledger = {};
  for (let run = 0; run < FAQ_REJECTION_MAX_CONSECUTIVE + 1; run++) {
    assert.equal(recordFaqTranslationOutcome(ledger, key, SRC_CHANGED, partial, { written: false }), false);
  }
  assert.deepEqual(ledger, {});
  assert.equal(shouldSkipFaqRejection(ledger[key], SRC_CHANGED), false);
  // Senza il flag esplicito vale lo stesso: il default e' «non scritto».
  assert.equal(recordFaqTranslationOutcome(ledger, key, SRC_CHANGED, partial), false);
  // Anche una scrittura completa fallita non cancella una voce esistente.
  const parked = { [key]: nextFaqRejection(undefined, SRC) };
  assert.equal(recordFaqTranslationOutcome(parked, key, SRC, { faq: SRC, rejected: false }, { written: false }), false);
  assert.ok(key in parked);
});

test('una scrittura potata sopra il pavimento e\' registrata come prunedWrite', () => {
  const ledger = {};
  const key = faqLocaleIssueKey('art', 'fr', 'frontaliere');
  assert.equal(recordFaqTranslationOutcome(ledger, key, SRC_CHANGED, { faq: SRC, rejected: false }, { written: true }), true);
  assert.equal(ledger[key].prunedWrite, true);
  assert.equal(ledger[key].keptPairs, SRC.length);
});

test('la coda di traduzione salta i locale parcheggiati sulla STESSA impronta della sorgente', () => {
  const parked = nextFaqRejection(nextFaqRejection(undefined, SRC), SRC);
  const ledger = {
    [faqLocaleIssueKey('a', 'de', 'frontaliere')]: parked,
    // Stessa storia, ma la sorgente italiana e' cambiata: si ritenta.
    [faqLocaleIssueKey('b', 'fr', 'frontaliere')]: parked,
    [faqLocaleIssueKey('c', 'en', 'frontaliere')]: parked,
    // Stessa chiave in un'altra sezione: non vale per questa.
    [faqLocaleIssueKey('d', 'de', 'svizzera')]: parked,
  };
  const queue = [
    { id: 'a', itFaq: SRC, missingLocales: ['de', 'en'] },
    { id: 'b', itFaq: SRC_CHANGED, missingLocales: ['fr'] },
    { id: 'c', itFaq: SRC, missingLocales: ['en'] },
    { id: 'd', itFaq: SRC, missingLocales: ['de'] },
  ];
  const { eligible, throttled } = partitionThrottledTranslations(queue, ledger, 'frontaliere');
  assert.deepEqual(eligible.map((a) => [a.id, a.missingLocales]), [['a', ['en']], ['b', ['fr']], ['d', ['de']]]);
  assert.deepEqual(throttled.map((i) => `${i.articleId}/${i.locale}`), ['a/de', 'c/en']);
  // Non muta la coda originale.
  assert.deepEqual(queue[0].missingLocales, ['de', 'en']);
});

test('cablaggio: main() filtra PRIMA del limite e i tre percorsi di traduzione registrano l\'esito', () => {
  const main = BATCH_SRC.slice(BATCH_SRC.indexOf('async function main('));
  const partition = main.indexOf('partitionThrottledTranslations(');
  const slice = main.indexOf('needsTranslation.slice(0, remaining)');
  assert.ok(partition > 0 && slice > partition, 'il filtro del registro deve precedere il --limit');
  assert.match(main, /loadFaqRejectionLedger\(\)/);
  for (const fn of ['processArticle', 'processTopUp', 'processTranslation']) {
    const start = BATCH_SRC.indexOf(`async function ${fn}(`);
    const end = BATCH_SRC.indexOf('\nasync function ', start + 1);
    const body = BATCH_SRC.slice(start, end);
    assert.match(body, /recordTranslation\(options, articleId, locale,/, `${fn} non registra il rifiuto`);
    // Una FAQ tradotta passa SOLO da writeTranslatedFaq: scrittore, poi registro
    // col vero esito (comportamento provato sotto, su file reale).
    assert.match(body, /writeTranslatedFaq\(options, \{ localePath, articleId, locale, sourceFaq:/, `${fn} scrive la traduzione fuori da writeTranslatedFaq`);
    assert.doesNotMatch(body, /insertFaqIntoBodyFile\([^)]*res\.faq\)/, `${fn} scrive res.faq senza aggiornare il registro`);
  }
  // processTopUp: il fallback italiano del catch vale solo se la traduzione non e' scritta.
  const topUp = BATCH_SRC.slice(BATCH_SRC.indexOf('async function processTopUp('), BATCH_SRC.indexOf('async function processTranslation('));
  assert.match(topUp, /\} catch \(err\) \{\s*if \(written\) \{/);
  // UNA sorgente per il registro: il batch non conosce il path del file.
  assert.doesNotMatch(BATCH_SRC, /faq-locale-rejections\.json/);
});

// ── Review di #1935: discovery sotto il conteggio sorgente e checkpoint ──

// content/blog-body/de/laivin-festival-cassano-valcuvia-2026.ts: tre coppie
// tedesche corrette, che `wrongLocalePair` non tocca.
const DE_LAIVIN = [
  { q: 'Wo findet das Festival LaivIn Plus statt?', a: 'Das Festival LaivIn Plus findet in Cassano Valcuvia und Mantua vom 26. bis 28. Mai 2026 statt.' },
  { q: 'Wer organisiert das Festival LaivIn Plus?', a: 'Das Festival LaivIn Plus wird von Teatro Periferico mit Alchemilla im Auftrag der Fondazione Cariplo organisiert.' },
  { q: 'Wer kann am Festival LaivIn Plus teilnehmen?', a: 'Das Festival ist offen für Schüler der weiterführenden Schulen in Lombardei und Piemont, unbegleitete ausländische Minderjährige und Jugendliche mit Behinderungen.' },
];
const IT_LAIVIN = [
  { q: 'Dove si svolge il festival LaivIn Plus?', a: 'Il festival LaivIn Plus si svolge a Cassano Valcuvia e a Mantova dal 26 al 28 maggio 2026.' },
  { q: 'Chi organizza il festival LaivIn Plus?', a: 'Il festival LaivIn Plus è organizzato dal Teatro Periferico con Alchemilla per conto della Fondazione Cariplo.' },
  { q: 'Chi può partecipare al festival LaivIn Plus?', a: 'Il festival è aperto agli studenti delle scuole superiori della Lombardia e del Piemonte e ai minori stranieri non accompagnati.' },
  { q: 'Quanti studenti partecipano al festival?', a: 'Al festival partecipano circa 300 studenti in tre giorni di spettacoli e laboratori teatrali.' },
];

function bodyDirWith(itFaq, deFaq) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-discovery-'));
  const id = 'laivin-festival-cassano-valcuvia-2026';
  for (const [locale, faq] of [['it', itFaq], ['de', deFaq]]) {
    fs.mkdirSync(path.join(dir, locale));
    const file = path.join(dir, locale, `${id}.ts`);
    fs.writeFileSync(file, `const body: Record<string, string> = {\n    'blog.article.${id}.body1': 'Testo.',\n};\n\nexport default body;\n`);
    assert.equal(insertFaqIntoBodyFile(file, id, faq), true);
  }
  return dir;
}

test('la discovery del batch riaccoda un locale pubblicato con MENO coppie della sorgente', () => {
  // Premessa: le coppie tedesche sono sane, quindi SOLO il conteggio le riaccoda.
  assert.equal(wrongLocalePair(DE_LAIVIN, 'de', IT_LAIVIN), null);
  const pruned = bodyDirWith(IT_LAIVIN, DE_LAIVIN);
  try {
    const { needsTranslation } = discoverArticles(pruned);
    assert.deepEqual(needsTranslation.map((a) => [a.id, a.missingLocales]),
      [['laivin-festival-cassano-valcuvia-2026', ['de']]]);
  } finally {
    fs.rmSync(pruned, { recursive: true, force: true });
  }
  // Controllo: stesso numero di coppie della sorgente -> niente da fare.
  const full = bodyDirWith(IT_LAIVIN.slice(0, 3), DE_LAIVIN);
  try {
    assert.deepEqual(discoverArticles(full).needsTranslation, []);
  } finally {
    fs.rmSync(full, { recursive: true, force: true });
  }
});

test('ogni checkpoint del batch mette in stage anche il registro dei rifiuti', () => {
  const cmd = checkpointCommitCommand({ bodyDirGitPath: 'content/blog-body/', progressFile: 'data/batch-faq-progress.json', label: 'step 1' });
  assert.match(cmd, new RegExp(`git add -f ${FAQ_REJECTION_LEDGER_GIT_PATH.replace(/[.]/g, '\\.')}`));
  // Lo step di commit finale del workflow usa lo STESSO path.
  const workflow = fs.readFileSync(path.join(QUI, '..', '..', '.github', 'workflows', 'batch-faq-articles.yml'), 'utf8');
  assert.ok(workflow.includes(`git add -f ${FAQ_REJECTION_LEDGER_GIT_PATH}`));

  // Eseguito davvero in un repo git temporaneo: il commit del checkpoint
  // contiene il registro (che .gitignore o no, e' `add -f`).
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-checkpoint-'));
  try {
    const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    fs.mkdirSync(path.join(repo, 'content', 'blog-body'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'content', 'blog-body', 'x.ts'), 'x');
    fs.writeFileSync(path.join(repo, 'data', 'batch-faq-progress.json'), '{}');
    fs.writeFileSync(path.join(repo, FAQ_REJECTION_LEDGER_GIT_PATH), '{"frontaliere/x/de":{"consecutive":1}}');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'data/\n');
    const run = spawnSync('sh', ['-c', cmd], { cwd: repo, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const files = git('show', '--name-only', '--format=', 'HEAD').stdout.trim().split('\n').sort();
    assert.deepEqual(files, ['content/blog-body/x.ts', 'data/batch-faq-progress.json', FAQ_REJECTION_LEDGER_GIT_PATH].sort());
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('un registro che lancia DOPO una scrittura riuscita non tocca la FAQ tradotta (niente fallback italiano)', () => {
  const dir = bodyDirWith(IT_LAIVIN, DE_LAIVIN.slice(0, 1));
  const id = 'laivin-festival-cassano-valcuvia-2026';
  const localePath = path.join(dir, 'de', `${id}.ts`);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const failuresBefore = faqLedgerSaveFailures();
    const options = {
      rejectionLedger: {},
      section: 'frontaliere',
      dryRun: false,
      saveLedger: () => { throw new Error('EACCES: registro non scrivibile'); },
    };
    // 3 coppie su 4: scrittura potata -> il registro va aggiornato e salvato.
    const res = { faq: DE_LAIVIN, rejected: false };
    let written;
    assert.doesNotThrow(() => {
      written = writeTranslatedFaq(options, { localePath, articleId: id, locale: 'de', sourceFaq: IT_LAIVIN, res });
    });
    assert.equal(written, true);
    assert.equal(faqLedgerSaveFailures(), failuresBefore + 1);
    const content = fs.readFileSync(localePath, 'utf8');
    assert.ok(content.includes('Wer organisiert das Festival LaivIn Plus?'), 'la traduzione tedesca deve restare');
    assert.ok(!content.includes('Chi organizza il festival'), 'nessun italiano sul body tedesco');
    assert.equal(options.rejectionLedger[faqLocaleIssueKey(id, 'de', 'frontaliere')].prunedWrite, true);
  } finally {
    console.warn = warn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
