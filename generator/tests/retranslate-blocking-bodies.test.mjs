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
 *   1-bis. `translationSanityIssue()` — i due modi in cui una ri-traduzione e'
 *      inutilizzabile SENZA che la guardia lo veda: un taglio a 2000 caratteri
 *      della sorgente (il tier HuggingFace) che lascia marker bilanciati e zero
 *      `critical`, e un passthrough dell'italiano, che ha per costruzione gli
 *      stessi numeri e nessun falso amico.
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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shouldWrite,
  translationSanityIssue,
  LENGTH_FLOOR,
  replaceBodyField,
  readBodyField,
  escapeForSingleQuoteTS,
  stratify,
  blockingPairsFromAudit,
  criticalCodes,
} from '../scripts/retranslate-blocking-bodies.mjs';
// Dal modulo corpus-only, NON da `lib/article-sanitizers.mjs`: quello e'
// `identical` nel manifest del ciclo e un export aggiunto dal corpus lo
// renderebbe `corpus-ahead`. Questo import pinna anche la collocazione.
import { sanitizeBodyText } from '../scripts/lib/sanitize-body-braces.mjs';
// L'ALTRO scrittore per-locale che gatta la scrittura sulla lingua: stessa
// classe, stesso rimedio — la verifica guarda l'unita' tradotta, non il testo
// concatenato.
import { wrongLocalePair } from '../scripts/fix-faq-locales.mjs';
import { detectLanguage } from '../scripts/lib/detect-language.mjs';

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

test('translationSanityIssue rifiuta il passthrough dell italiano', () => {
  // Stessi numeri e nessun falso amico: la guardia lo accetta con zero
  // `critical`, ed e' esattamente il caso in cui si pubblicherebbe l'italiano
  // sulla pagina inglese.
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
  assert.equal(wrongLocalePair([EN_PAIR, EN_PAIR, EN_PAIR], 'en'), null);

  const wrong = wrongLocalePair([EN_PAIR, IT_PAIR, EN_PAIR], 'en');
  assert.ok(wrong, 'una coppia italiana su tre deve produrre un rifiuto');
  assert.equal(wrong.index, 1);
  assert.notEqual(wrong.detected, 'en');

  // E sul concatenato — cioe' col controllo di prima — non verrebbe rifiutata.
  assert.equal(
    detectLanguage([EN_PAIR, IT_PAIR, EN_PAIR].map((p) => `${p.q} ${p.a}`).join(' '), 'en'),
    'en',
  );
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
  assert.match(fn, /wrongLocalePair\(results, targetLang\)/,
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
