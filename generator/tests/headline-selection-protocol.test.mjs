/**
 * headline-selection-protocol.test.mjs — le due liste del prompt di selezione
 * non possono tornare a condividere la sintassi, e il parsing non può tornare a
 * indovinare (issue #188).
 *
 * ## Cosa sorveglia, e perché è scritto su DUE strati
 *
 * Il difetto non stava in una funzione: stava nel fatto che due liste con
 * semantiche opposte erano rese con lo stesso marcatore `[n]` — le candidate
 * per POSIZIONE, gli articoli già pubblicati per ID — e che il parsing a valle
 * risolveva il riferimento ambiguo con un clamp a 0 invece di rigettarlo. Un
 * test su una funzione sola non lo avrebbe visto:
 *
 *  · **Strato 1 — comportamento.** Le funzioni pure di
 *    `headline-selection-protocol.mjs`: come si rendono le due liste e cosa fa
 *    il parser davanti a ogni forma di riferimento. Importate davvero, non
 *    replicate: la replica è come si diverge in silenzio.
 *  · **Strato 2 — cablaggio.** Che `create-article.mjs` USI quelle funzioni, e
 *    che il prompt che parte davvero (estratto dal sorgente e valutato, la
 *    tecnica di `news-prompt-token-budget.test.mjs`) chieda `selectedId` e non
 *    più `selectedIndex`. Un protocollo corretto che nessuno chiama è lo stesso
 *    difetto con un file in più.
 *
 * ## Perché il sorgente viene ESTRATTO invece che importato
 *
 * `create-article.mjs` non è importabile qui: questo repo non ha
 * `node_modules` (importa `jsdom`, `sharp`, …) e il file chiama `main()` al
 * caricamento. Le anchor dell'estrazione sono asserite: se spariscono il test
 * fallisce rumorosamente invece di misurare una stringa vuota.
 *
 * Lancia con:
 *   node --test generator/tests/headline-selection-protocol.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANDIDATE_KEY_PREFIX,
  SELECTION_REJECTION,
  candidateKey,
  formatCandidateList,
  formatPublishedDigest,
  parseHeadlineSelection,
  referenceSyntaxOverlap,
  selectionCorrectionNote,
} from '../scripts/lib/headline-selection-protocol.mjs';
import { JSON_QUOTE_SAFETY_RULE_IT } from '../scripts/lib/llm-json-repair.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = path.resolve(HERE, '../scripts/create-article.mjs');
const src = readFileSync(CREATE_ARTICLE, 'utf-8');

/** Ritaglia una dichiarazione top-level fino alla sua chiusura in colonna 0. */
function cutDecl(startAnchor, from = src) {
  const a = from.indexOf(startAnchor);
  assert.notEqual(a, -1, `dichiarazione non trovata — aggiornare questo test: ${startAnchor}`);
  const rel = from.slice(a).indexOf('\n}\n');
  assert.notEqual(rel, -1, `chiusura non trovata per: ${startAnchor}`);
  return from.slice(a, a + rel + 3);
}

/**
 * Solo il CODICE, senza le righe di commento.
 *
 * Serve alle asserzioni negative («questa forma vecchia non c'è più»): i
 * commenti di `create-article.mjs` CITANO la forma vecchia per spiegare perché
 * è stata tolta, e un guard che grep-passa sui commenti si accende sulla
 * propria documentazione. Il pavimento sotto impedisce l'errore opposto — se
 * lo strip mangiasse il file, ogni asserzione negativa passerebbe a vuoto.
 */
function codeOnly(text) {
  const out = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');
  assert.ok(out.length > text.length * 0.4, 'strip dei commenti troppo aggressivo: le asserzioni negative passerebbero a vuoto');
  return out;
}

const selectArticleSrc = cutDecl('async function selectArticle(headlines) {');
assert.ok(selectArticleSrc.length > 1000, 'estrazione di selectArticle sospettosamente corta');
const selectArticleCode = codeOnly(selectArticleSrc);

/** Il prompt VERO, valutato con le sole dipendenze iniettate. */
const makePrompt = new Function(
  '__d',
  `const { IS_FRONTALIERE, JSON_QUOTE_SAFETY_RULE_IT } = __d;\n`
  + `${cutDecl('function HEADLINE_SELECTION_PROMPT(headlineList, recentArticles) {')}\n`
  + 'return HEADLINE_SELECTION_PROMPT;',
);

const CANDIDATES = [
  { source: 'laregione.ch', headline: 'Errare humanum est' },
  { source: 'rsi.ch', headline: 'Ristorni, Berna deplora lo stop del Cantone', _frontalieriBoosted: true },
];
const PUBLISHED = [
  {
    title: 'Trasferirsi a Maccagno con Pino e Veddasca da frontaliere: pro e contro',
    excerpt: 'Guida pratica al trasferimento sul lago Maggiore per chi lavora in Ticino.',
  },
  { title: 'Cambio CHF EUR: come ottimizzare la conversione', excerpt: '' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Strato 1 — le due liste hanno sintassi DISGIUNTE
// ─────────────────────────────────────────────────────────────────────────────

test('le candidate usano una chiave nominata H<n>, 1-based, senza parentesi quadre', () => {
  const list = formatCandidateList(CANDIDATES);
  assert.match(list, /^H1 » \(laregione\.ch\) Errare humanum est$/m);
  assert.match(list, /^H2 » \(rsi\.ch ⭐FRONTALIERI\) Ristorni/m);
  assert.equal(candidateKey(0), 'H1');
  assert.ok(!/\[[^\]\n]*\]/.test(list), `la lista candidate è tornata alle parentesi quadre:\n${list}`);
});

test('il digest del corpus non porta più né id né parentesi quadre', () => {
  const digest = formatPublishedDigest(PUBLISHED);
  assert.match(digest, /^• Trasferirsi a Maccagno con Pino e Veddasca da frontaliere: pro e contro — Guida pratica/m);
  assert.match(digest, /^• Cambio CHF EUR: come ottimizzare la conversione$/m);
  assert.ok(
    !/\[[^\]\n]*\]/.test(digest),
    `il digest del corpus è tornato a marcare gli id fra quadre — è metà del difetto di #188:\n${digest}`,
  );
  assert.ok(
    !new RegExp(`(^|\\s)${CANDIDATE_KEY_PREFIX}\\d+(\\s|$)`, 'm').test(digest),
    'il digest del corpus usa la chiave delle candidate',
  );
});

test('referenceSyntaxOverlap: nessun marcatore in comune fra le due liste', () => {
  const overlap = referenceSyntaxOverlap(formatCandidateList(CANDIDATES), formatPublishedDigest(PUBLISHED));
  assert.deepEqual(overlap.problems, []);
  assert.equal(overlap.ok, true);
});

test('referenceSyntaxOverlap RILEVA il formato storico (la regressione che deve tornare rossa)', () => {
  const oldCandidates = CANDIDATES.map((h, i) => `[${i}] (${h.source}) ${h.headline}`).join('\n');
  const oldDigest = PUBLISHED.map((p, i) => `• [articolo-id-${i}] ${p.title}`).join('\n');
  const overlap = referenceSyntaxOverlap(oldCandidates, oldDigest);
  assert.equal(overlap.ok, false);
  assert.ok(overlap.problems.length >= 2, `atteso overlap su entrambe le liste, visto: ${JSON.stringify(overlap.problems)}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Strato 1 — il parsing RIFIUTA invece di indovinare
// ─────────────────────────────────────────────────────────────────────────────

test('accetta una chiave valida e la risolve a una posizione 0-based', () => {
  const r = parseHeadlineSelection('{"selectedId": "H2", "reason": "rilevante"}', 2);
  assert.equal(r.ok, true);
  assert.equal(r.index, 1);
  assert.equal(r.key, 'H2');
  assert.equal(r.reason, 'rilevante');
});

test('tollera code fence, minuscole e spazi nella chiave', () => {
  for (const raw of [
    '```json\n{"selectedId":"h1","reason":"x"}\n```',
    '{"selectedId":" H 1 ","reason":"x"}',
  ]) {
    const r = parseHeadlineSelection(raw, 2);
    assert.equal(r.ok, true, `atteso ok per ${raw}`);
    assert.equal(r.index, 0);
  }
});

test('un NUMERO NUDO è ambiguo e viene rigettato — è il difetto di #188', () => {
  // Il caso misurato: pool di 2 headline, risposta `3`. Con la lista del corpus
  // marcata `[id]` quel numero poteva nominare l'una o l'altra lista.
  for (const raw of [
    '{"selectedIndex": 3, "reason": "…"}',
    '{"selectedIndex": 0, "reason": "…"}',
    '{"selectedId": 1, "reason": "…"}',
    '{"selectedId": "1", "reason": "…"}',
  ]) {
    const r = parseHeadlineSelection(raw, 2);
    assert.equal(r.ok, false, `un riferimento numerico nudo non deve essere accettato: ${raw}`);
    assert.equal(r.rejection, SELECTION_REJECTION.AMBIGUOUS_REFERENCE, `su ${raw}`);
  }
});

test('una chiave fuori range viene RIGETTATA, non clampata a 0', () => {
  const r = parseHeadlineSelection('{"selectedId": "H3", "reason": "…"}', 2);
  assert.equal(r.ok, false);
  assert.equal(r.rejection, SELECTION_REJECTION.OUT_OF_RANGE);
  assert.equal(r.index, undefined, 'il rigetto non deve portare una posizione: sarebbe il clamp con un altro nome');
  const zero = parseHeadlineSelection('{"selectedId": "H0", "reason": "…"}', 2);
  assert.equal(zero.ok, false);
  assert.equal(zero.rejection, SELECTION_REJECTION.OUT_OF_RANGE);
});

test('lo slug di un articolo del corpus non è una chiave selezionabile', () => {
  const r = parseHeadlineSelection(
    '{"selectedId": "trasferirsi-a-maccagno-con-pino-e-veddasca-da-frontaliere-pro-e-contro", "reason": "…"}',
    2,
  );
  assert.equal(r.ok, false);
  assert.equal(r.rejection, SELECTION_REJECTION.UNKNOWN_KEY);
});

test('risposta senza riferimento, vuota o non parsabile: rigetto, mai posizione 0', () => {
  assert.equal(parseHeadlineSelection('{"reason": "…"}', 2).rejection, SELECTION_REJECTION.MISSING_REFERENCE);
  assert.equal(parseHeadlineSelection('', 2).rejection, SELECTION_REJECTION.UNPARSEABLE);
  assert.equal(parseHeadlineSelection('mi dispiace, non posso scegliere', 2).rejection, SELECTION_REJECTION.UNPARSEABLE);
  assert.equal(parseHeadlineSelection('{"selectedId": "H1"}', 0).rejection, SELECTION_REJECTION.OUT_OF_RANGE);
});

test('JSON troncato: si recupera solo la CHIAVE NOMINATA, mai un indice nudo', () => {
  const ok = parseHeadlineSelection('{"selectedId": "H2", "reason": "motivo tronc', 3);
  assert.equal(ok.ok, true);
  assert.equal(ok.index, 1);
  // Il vecchio recupero leggeva `"selectedIndex": (\d+)` da una risposta
  // troncata e lo trattava come scelta valida: era la porta secondaria da cui
  // rientrava lo stesso difetto.
  const bad = parseHeadlineSelection('{"selectedIndex": 2, "reason": "motivo tronc', 3);
  assert.equal(bad.ok, false);
  assert.equal(bad.rejection, SELECTION_REJECTION.AMBIGUOUS_REFERENCE);
});

test('il promemoria di correzione nomina la forma attesa e l’intervallo', () => {
  const note = selectionCorrectionNote(SELECTION_REJECTION.AMBIGUOUS_REFERENCE, 7);
  assert.match(note, /NUMERO NUDO/);
  assert.match(note, /"H<n>"/);
  assert.match(note, /fra 1 e 7/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Strato 2 — il cablaggio in create-article.mjs
// ─────────────────────────────────────────────────────────────────────────────

test('il prompt VERO chiede selectedId e non nomina più selectedIndex', () => {
  const HEADLINE_SELECTION_PROMPT = makePrompt({ IS_FRONTALIERE: true, JSON_QUOTE_SAFETY_RULE_IT });
  const HEADLINE_SELECTION_PROMPT_CH = makePrompt({ IS_FRONTALIERE: false, JSON_QUOTE_SAFETY_RULE_IT });
  for (const [label, build] of [['frontaliere', HEADLINE_SELECTION_PROMPT], ['svizzera', HEADLINE_SELECTION_PROMPT_CH]]) {
    const prompt = build(formatCandidateList(CANDIDATES), formatPublishedDigest(PUBLISHED));
    assert.match(prompt, /"selectedId"/, `ramo ${label}: il prompt non chiede selectedId`);
    assert.ok(!/selectedIndex/.test(prompt), `ramo ${label}: il prompt chiede ancora un indice nudo`);
    assert.match(prompt, /CHIAVE/, `ramo ${label}: il prompt non spiega che la chiave è l'unica cosa selezionabile`);
  }
});

test('nel prompt VERO le due liste restano distinguibili riga per riga', () => {
  const build = makePrompt({ IS_FRONTALIERE: true, JSON_QUOTE_SAFETY_RULE_IT });
  const prompt = build(formatCandidateList(CANDIDATES), formatPublishedDigest(PUBLISHED));
  const listed = prompt.split('\n').filter((l) => /^(H\d+ »|• )/.test(l));
  assert.equal(listed.length, CANDIDATES.length + PUBLISHED.length, 'righe di lista mancanti o rese in altro modo');
  for (const line of listed) {
    const isCandidate = line.startsWith('H');
    const isPublished = line.startsWith('•');
    assert.ok(isCandidate !== isPublished, `riga classificabile in due modi: ${line}`);
    if (isPublished) {
      assert.ok(!/\[[^\]\n]*\]/.test(line), `riga del corpus con un riferimento fra quadre: ${line}`);
    }
  }
});

test('selectArticle costruisce ENTRAMBE le liste con il protocollo condiviso', () => {
  assert.match(selectArticleCode, /formatCandidateList\(/, 'la lista candidate non passa più dal protocollo');
  assert.match(selectArticleCode, /formatPublishedDigest\(/, 'il digest del corpus non passa più dal protocollo');
  assert.ok(
    !/`\[\$\{i\}\]/.test(selectArticleCode),
    'selectArticle è tornato a indicizzare le candidate fra parentesi quadre',
  );
  assert.ok(
    !/\[\$\{m\[1\]\}\]/.test(selectArticleCode),
    'il digest del corpus è tornato a stampare l’id fra parentesi quadre',
  );
});

test('selectArticle non ha più nessun ripiego che sceglie in silenzio', () => {
  assert.ok(!/selectedIndex/.test(selectArticleCode), 'selectArticle legge ancora un indice nudo');
  assert.ok(!/clamp a 0/.test(selectArticleCode), 'il clamp è tornato');
  assert.ok(!/idx = 0;/.test(selectArticleCode), 'ripiego alla posizione 0 rimesso in selectArticle');
  assert.ok(!/fallback a indice 0/.test(selectArticleCode), 'ripiego alla posizione 0 rimesso in selectArticle');
  assert.match(selectArticleCode, /parseHeadlineSelection|requestHeadlineSelection/, 'selectArticle non usa più il parser del protocollo');
  assert.match(selectArticleCode, /SELEZIONE RIGETTATA/, 'la selezione finale non fallisce più: sta di nuovo indovinando');
});

test('il retry della selezione esiste, è limitato e passa dal parser', () => {
  const retrySrc = cutDecl('async function requestHeadlineSelection(');
  assert.match(retrySrc, /parseHeadlineSelection\(rawText, candidateCount\)/);
  assert.match(retrySrc, /selectionCorrectionNote\(/);
  assert.match(retrySrc, /attempt <= maxAttempts/);
  for (const name of ['HEADLINE_SELECTION_MAX_ATTEMPTS_BATCH', 'HEADLINE_SELECTION_MAX_ATTEMPTS_FINAL']) {
    const m = src.match(new RegExp(`^const ${name} = (\\d+);`, 'm'));
    assert.ok(m, `costante \`${name}\` assente: il tetto ai tentativi è tornato un letterale sparso`);
    const n = Number(m[1]);
    assert.ok(n >= 2 && n <= 4, `${name}=${n} fuori dall'intervallo sensato (2-4): il retry costa quota LLM`);
  }
});
