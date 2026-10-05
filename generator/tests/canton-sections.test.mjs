/**
 * canton-sections.test.mjs — contratto del profilo editoriale delle 24 sezioni
 * cantonali (`generator/data/canton-sections.json`) e del suo validatore
 * (`scripts/ci/validate-canton-sections.mjs`). `node --test`, offline.
 *
 * Due famiglie di test:
 *
 *   - il profilo REALE passa il validatore, e i legami che il validatore
 *     legge dal testo di altri file (DEAD_NEWS_DOMAINS e le liste globali in
 *     create-article.mjs, i minuti di cron di generate-article.yml, i gruppi
 *     di canton-url-slugs.json) si leggono davvero: un parser che torna vuoto
 *     renderebbe vacuo il controllo corrispondente;
 *   - ogni regola, rotta apposta su una copia del profilo, produce la sua
 *     violazione. Senza questa meta' un validatore che non controlla niente
 *     passerebbe verde quanto uno che controlla tutto.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DAILY_BUDGET_TIERS,
  NEWS_KINDS,
  PROFILE_REL,
  loadContext,
  validateCantonSections,
} from '../../scripts/ci/validate-canton-sections.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROFILE = JSON.parse(fs.readFileSync(path.join(ROOT, PROFILE_REL), 'utf8'));
const CTX = loadContext(ROOT);

const clone = () => structuredClone(PROFILE);
const canton = (doc, code) => doc.cantons.find((c) => c.code === code);
const firstNews = (doc, code) => canton(doc, code).newsSources[0];
function expectViolation(doc, re) {
  const errors = validateCantonSections(doc, CTX);
  assert.ok(errors.some((e) => re.test(e)), `nessuna violazione ${re} fra:\n  ${errors.join('\n  ') || '(nessuna)'}`);
}

// ── Il profilo reale ────────────────────────────────────────────────────────

test('il profilo committato rispetta il contratto', () => {
  const errors = validateCantonSections(PROFILE, CTX);
  assert.deepEqual(errors, [], `violazioni nel profilo:\n  ${errors.join('\n  ')}`);
});

test('copre i 24 gruppi di canton-url-slugs.json, nello stesso ordine', () => {
  assert.deepEqual(PROFILE.cantons.map((c) => c.code), Object.keys(CTX.slugs.cantons));
  assert.equal(PROFILE.cantons.length, 24);
});

test('ogni cantone ha almeno una fonte news (un cantone vuoto non potrebbe mai essere acceso)', () => {
  const empty = PROFILE.cantons.filter((c) => c.newsSources.length === 0).map((c) => c.code);
  assert.deepEqual(empty, []);
});

test('le fonti news sono solo di tipo notizia; i dati di categoria non entrano nel generatore (D11)', () => {
  for (const c of PROFILE.cantons) {
    for (const s of c.newsSources) assert.ok(NEWS_KINDS.has(s.kind), `${c.code} ${s.url}: kind ${s.kind}`);
  }
  // Le categorie dati esistono e sono usate: senza almeno una fonte la separazione D11 sarebbe solo nominale.
  const dataCount = PROFILE.cantons.reduce((a, c) => a + Object.values(c.categoryDataSources).flat().length, 0);
  assert.ok(dataCount > 0);
});

// ── I legami letti dal testo di altri file ──────────────────────────────────

test('DEAD_NEWS_DOMAINS si legge dal sorgente di create-article.mjs', () => {
  assert.ok(CTX.deadDomains.length > 0, 'lista vuota: il controllo sui domini morti sarebbe vacuo');
  assert.ok(CTX.deadDomains.includes('santesuisse.ch'));
  assert.ok(CTX.deadDomains.includes('bag.admin.ch'));
});

test('NEWS_SOURCES e NEWS_SOURCES_SVIZZERA si leggono dal sorgente (D6/D12)', () => {
  assert.ok(CTX.globalNewsUrls.size > 20);
  assert.ok(CTX.globalNewsUrls.has('https://media.tio.ch/files/domains/tio.ch/rss/rss_ticino.xml'));
  assert.ok(CTX.globalNewsUrls.has('https://www.rsi.ch/info/economia/?f=rss'), 'voce della lista svizzera');
});

test('i minuti di cron riservati vengono da generate-article.yml (frontaliere :07, svizzera :37)', () => {
  assert.ok(CTX.reservedCronMinutes.has(7));
  assert.ok(CTX.reservedCronMinutes.has(37));
});

test('la tabella D19 copre esattamente i 24 gruppi, una volta sola', () => {
  const all = Object.values(DAILY_BUDGET_TIERS).flat();
  assert.equal(new Set(all).size, all.length, 'un cantone compare in due fasce');
  assert.deepEqual([...all].sort(), Object.keys(CTX.slugs.cantons).sort());
});

test('la policy robots ha host bloccati da far valere su tutti i cantoni', () => {
  // Se nessuna regola fosse riconosciuta come blocco dell'intero sito, il
  // controllo cross-cantone del validatore non vedrebbe mai niente.
  const wholeSite = PROFILE.cantons.flatMap((c) => c.ownerDecisionPending).filter((p) => /-> Disallow: \/(;|$)/.test(p.robotsRule));
  assert.ok(wholeSite.length > 0);
});

// ── Ogni regola, rotta apposta ──────────────────────────────────────────────

test('viola: gruppo mancante', () => {
  const doc = clone();
  doc.cantons = doc.cantons.filter((c) => c.code !== 'UR');
  expectViolation(doc, /gruppi mancanti.*UR/);
});

test('viola: section e members incoerenti con canton-url-slugs.json', () => {
  const doc = clone();
  canton(doc, 'BASILEA').section = 'canton-bs';
  canton(doc, 'APPENZELLO').members = ['AI'];
  expectViolation(doc, /BASILEA: section/);
  expectViolation(doc, /APPENZELLO: members/);
});

test('viola: URL non https', () => {
  const doc = clone();
  firstNews(doc, 'GE').url = firstNews(doc, 'GE').url.replace('https:', 'http:');
  expectViolation(doc, /GE: newsSources: URL non https/);
});

test('viola: URL duplicato dentro il cantone (anche fra news e dati)', () => {
  const doc = clone();
  const c = canton(doc, 'TI');
  c.categoryDataSources.servizi.push({ ...c.newsSources[0] });
  expectViolation(doc, /TI: categoryDataSources\.servizi: URL duplicato/);
});

test('viola: dominio in DEAD_NEWS_DOMAINS', () => {
  const doc = clone();
  canton(doc, 'ZH').newsSources.push({ ...firstNews(doc, 'ZH'), url: 'https://www.santesuisse.ch/it/news' });
  expectViolation(doc, /ZH: newsSources: dominio in DEAD_NEWS_DOMAINS \(santesuisse\.ch\)/);
});

test('viola: fonte gia\' nelle liste globali (D12 per il Ticino)', () => {
  const doc = clone();
  canton(doc, 'TI').newsSources.push({ ...firstNews(doc, 'TI'), url: 'https://media.tio.ch/files/domains/tio.ch/rss/rss_ticino.xml' });
  expectViolation(doc, /TI: newsSources .*rss_ticino\.xml: gia' in NEWS_SOURCES/);
});

test('viola: fonte in attesa di decisione robots rientrata fra le news dello stesso cantone', () => {
  const doc = clone();
  const c = canton(doc, 'AG');
  const p = c.ownerDecisionPending[0];
  c.newsSources.push({ ...c.newsSources[0], url: p.url });
  expectViolation(doc, /AG: ownerDecisionPending: URL duplicato/);
});

test('viola: host bloccato ai bot AI usato da un ALTRO cantone', () => {
  const doc = clone();
  const blocked = canton(doc, 'AG').ownerDecisionPending.find((p) => /-> Disallow: \/(;|$)/.test(p.robotsRule));
  const host = new URL(blocked.url).hostname;
  canton(doc, 'ZH').newsSources.push({ ...firstNews(doc, 'ZH'), url: `https://${host}/qualunque-altro-path.rss` });
  expectViolation(doc, new RegExp(`ZH: newsSources https://${host.replace(/\./g, '\\.')}/qualunque-altro-path\\.rss: host bloccato`));
});

test('viola: cronMinute duplicato o riservato a generate-article.yml', () => {
  const doc = clone();
  canton(doc, 'GR').cronMinute = canton(doc, 'TI').cronMinute;
  canton(doc, 'UR').cronMinute = 37;
  expectViolation(doc, /cronMinute \d+ gia' usato/);
  expectViolation(doc, /UR: cronMinute 37 collide/);
});

test('viola: dailyBudget fuori dalla tabella D19', () => {
  const doc = clone();
  canton(doc, 'SH').dailyBudget = 4;
  expectViolation(doc, /SH: dailyBudget 4 != 1 \(D19\)/);
});

test('viola: enum non validi e dato di categoria fra le news', () => {
  const doc = clone();
  const s = firstNews(doc, 'VD');
  s.parser = 'regex';
  s.kind = 'carburanti';
  s.topics = ['meteo'];
  s.quirks = { ...s.quirks, inventato: true };
  expectViolation(doc, /parser "regex" non valido/);
  expectViolation(doc, /kind "carburanti" e' un dato di categoria/);
  expectViolation(doc, /topics non validi/);
  expectViolation(doc, /quirk sconosciuto "inventato"/);
});

test('viola: articlePathPattern non ancorato, non compilabile o fuori da html-links (P5b)', () => {
  const htmlSource = (doc) => doc.cantons.flatMap((c) => c.newsSources.map((s) => [c, s])).find(([, s]) => s.parser === 'html-links');
  const rssSource = (doc) => doc.cantons.flatMap((c) => c.newsSources.map((s) => [c, s])).find(([, s]) => s.parser === 'rss');
  let doc = clone();
  htmlSource(doc)[1].quirks.articlePathPattern = 'news/';
  expectViolation(doc, /quirk articlePathPattern="news\/" non valido/);
  doc = clone();
  htmlSource(doc)[1].quirks.articlePathPattern = '^/news/(';
  expectViolation(doc, /quirk articlePathPattern=.* non valido/);
  doc = clone();
  rssSource(doc)[1].quirks.articlePathPattern = '^/news/';
  expectViolation(doc, /quirk articlePathPattern non si applica al parser "rss"/);
});

test('viola: urlReusedForDifferentStories diverso da true o da una regex di path, o su html-links (P5b)', () => {
  const find = (doc, parser) => doc.cantons.flatMap((c) => c.newsSources).find((s) => s.parser === parser);
  let doc = clone();
  find(doc, 'rss').quirks.urlReusedForDifferentStories = 'ticker';
  expectViolation(doc, /quirk urlReusedForDifferentStories="ticker" non valido/);
  doc = clone();
  find(doc, 'rss').quirks.urlReusedForDifferentStories = false;
  expectViolation(doc, /quirk urlReusedForDifferentStories=false non valido/);
  doc = clone();
  find(doc, 'html-links').quirks.urlReusedForDifferentStories = true;
  expectViolation(doc, /quirk urlReusedForDifferentStories non si applica al parser "html-links"/);
  doc = clone();
  find(doc, 'rss').quirks.urlReusedForDifferentStories = '^/ticker-';
  assert.deepEqual(validateCantonSections(doc, CTX), []);
});

test('viola: ai-input=no non puo\' stare in una fonte ammessa', () => {
  const doc = clone();
  firstNews(doc, 'NE').quirks.contentSignal = 'ai-train=no, ai-input=no';
  expectViolation(doc, /NE: newsSources .*quirk contentSignal=.* non valido/);
});

test('viola: cantone acceso senza fonti news', () => {
  const doc = clone();
  const c = canton(doc, 'OW');
  c.enabled = true;
  c.newsSources = [];
  expectViolation(doc, /OW: cantone enabled senza newsSources/);
});

test('viola: pendente senza la regola robots che lo giustifica', () => {
  const doc = clone();
  const p = canton(doc, 'SO').ownerDecisionPending[0];
  p.robotsRule = '';
  p.blockedAgents = [];
  expectViolation(doc, /SO: ownerDecisionPending .*: blockedAgents vuoto/);
  expectViolation(doc, /SO: ownerDecisionPending .*: robotsRule vuota/);
});
