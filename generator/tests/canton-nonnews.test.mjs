/**
 * canton-nonnews.mjs — formati non-news per le sezioni cantonali dietro
 * CANTON_NONNEWS_SECTIONS (F4.2 del piano «cadenza 20 articoli per sezione»).
 * Run with `node --test generator/tests/canton-nonnews.test.mjs`.
 */
import '../../host/cantonSectionsBootstrap.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CANTON_NONNEWS_ENV,
  CANTON_NONNEWS_POOL_ID,
  COVERAGE_WINDOW_DAYS,
  MIN_POOL_TOPICS,
  MIN_VERIFIED_FACTS,
  buildNonNewsSourceContent,
  findCrossCantonTemplateClones,
  findTemplateClone,
  htmlToPlainText,
  isNonNewsSection,
  parseNonNewsSections,
  pickNonNewsTopic,
  rotationStart,
  sourceCoveredWithin,
  topicSkeleton,
  validateTopicPool,
  verifyTopicOnPage,
} from '../scripts/lib/canton-nonnews.mjs';
import { PILOT_SECTIONS, checkOffline, checkOnline, loadAllPools } from '../scripts/verify-canton-evergreen-topics.mjs';
import { buildCantonProfile } from '../scripts/lib/canton-section-profile.mjs';
import { EXPECTED_ABSENT_RC_KEYS, RC_TO_ENV } from '../scripts/load-rc-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CREATE_ARTICLE = readFileSync(path.join(ROOT, 'generator/scripts/create-article.mjs'), 'utf8');
const MANIFEST = JSON.parse(readFileSync(path.join(ROOT, 'scripts/ci/loop-sync-manifest.json'), 'utf8'));
const POOLS = loadAllPools();
const NOW = Date.parse('2026-11-28T12:00:00Z');
const DAY = 86_400_000;
/** Un `now` per cui la rotazione parte dal primo argomento del pool (ordine deterministico). */
const startAt = (size) => { let at = NOW; while (rotationStart('canton-vs', at, size) !== 0) at += DAY; return at; };

const fact = (evidence) => ({ claim: `claim ${evidence}`, evidence });
const topic = (id, keyword, extra = {}) => ({
  id,
  format: 'guida',
  keyword,
  angle: `angolo ${id}`,
  source: { url: `https://www.vs.ch/web/${id}`, publisher: 'Servizio X', language: 'fr' },
  facts: [fact(`alpha ${id} uno`), fact(`beta ${id} due`), fact(`gamma ${id} tre`)],
  ...extra,
});
const pageFor = (t) => `intro ${t.facts.map((f) => f.evidence).join(' ... ')} fine`;
const pool = (...topics) => ({ schemaVersion: 1, section: 'canton-vs', officialHosts: ['vs.ch'], topics });
const okFetch = (byUrl) => async (url) => (byUrl[url] ? { ok: true, status: 200, text: byUrl[url] } : { ok: false, status: 404, text: '', error: 'HTTP 404' });

// ── La manopola ──────────────────────────────────────────────────────────────

test('manopola: assente o vuota = nessuna sezione, come oggi', () => {
  for (const raw of [undefined, null, '', '  ', ',;']) {
    assert.deepEqual([...parseNonNewsSections(raw).sections], [], JSON.stringify(raw));
    assert.equal(isNonNewsSection('canton-vs', { [CANTON_NONNEWS_ENV]: raw }), false);
  }
  assert.equal(isNonNewsSection('canton-vs', {}), false);
});

test('manopola: stessa sintassi di CANTON_HIGH_CADENCE_SECTIONS (id, codice, all)', () => {
  assert.equal(isNonNewsSection('canton-vs', { [CANTON_NONNEWS_ENV]: 'canton-vs, BE' }), true);
  assert.equal(isNonNewsSection('canton-be', { [CANTON_NONNEWS_ENV]: 'canton-vs, BE' }), true);
  assert.equal(isNonNewsSection('canton-basilea', { [CANTON_NONNEWS_ENV]: 'canton-vs, BE' }), false);
  assert.equal(isNonNewsSection('canton-basilea', { [CANTON_NONNEWS_ENV]: 'all' }), true);
  assert.deepEqual(parseNonNewsSections('canton-xx').unknown, ['canton-xx']);
});

test('Remote Config: la chiave e\' mappata a se stessa e vuoto = assente', () => {
  assert.deepEqual(RC_TO_ENV.CANTON_NONNEWS_SECTIONS, ['CANTON_NONNEWS_SECTIONS']);
  assert.equal(EXPECTED_ABSENT_RC_KEYS.has('CANTON_NONNEWS_SECTIONS'), true);
});

test('profilo: lista vuota = evergreenPool null (exit 4 invariato); in lista = pool non-news', () => {
  assert.equal(buildCantonProfile('canton-vs', {}).evergreenPool, null);
  assert.equal(buildCantonProfile('canton-vs', { cantonNonNews: false }).evergreenPool, null);
  assert.equal(buildCantonProfile('canton-vs', { cantonNonNews: true }).evergreenPool, CANTON_NONNEWS_POOL_ID);
  // I rami discovery e ranker restano spenti: il non-news non li riapre.
  const p = buildCantonProfile('canton-vs', { cantonNonNews: true });
  assert.equal(p.discoveryPool, false);
  assert.equal(p.demandRanker, false);
});

test('create-article: l\'exit 4 resta per pool null, il non-news viene DOPO il pool news', () => {
  const guard = "} else if (!newsSuccess && !candidateSuccess && !SECTION_PROFILE.evergreenPool) {";
  const nonNews = '} else if (!newsSuccess && !candidateSuccess && IS_CANTON) {';
  const national = "} else if (!newsSuccess && !candidateSuccess) {\n      console.error('📚 Fase 2: Fallback evergreen";
  const iGuard = CREATE_ARTICLE.indexOf(guard);
  const iNonNews = CREATE_ARTICLE.indexOf(nonNews);
  const iNational = CREATE_ARTICLE.indexOf(national);
  assert.ok(iGuard > 0 && iNonNews > iGuard && iNational > iNonNews, 'ordine: exit 4, non-news cantonale, evergreen nazionale');
  assert.match(CREATE_ARTICLE, /CANTON_EVERGREEN_POOL_DISABLED section=/);
  assert.match(CREATE_ARTICLE, /cantonNonNews: isNonNewsSection\(sectionName\)/);
  // Priorita' alle notizie: ogni ramo news che pubblica esce con `return` prima di Fase 2.
  const news = CREATE_ARTICLE.slice(CREATE_ARTICLE.indexOf('await generateAndValidateArticle(url, chosen);'), iGuard);
  assert.match(news, /newsSuccess = true;[\s\S]*return; \/\/ Success/);
  // La guardia anti-template e la copertura a 90 giorni sono cablate nel run.
  const branch = CREATE_ARTICLE.slice(iNonNews, iNational);
  assert.match(branch, /otherCantonArticles: otherCantonRecentArticles/);
  assert.match(branch, /isCovered: \(topic\) => sourceCoveredWithin\(/);
  assert.match(branch, /windowDays: NONNEWS_COVERAGE_WINDOW_DAYS/);
  assert.match(branch, /generateAndValidateArticle\(topic\.source\.url, \{/);
});

// ── Il pool versionato ───────────────────────────────────────────────────────

test('pool pilota: almeno 15 argomenti per canton-basilea, canton-be, canton-vs', () => {
  assert.deepEqual([...PILOT_SECTIONS].sort(), ['canton-basilea', 'canton-be', 'canton-vs']);
  for (const section of PILOT_SECTIONS) {
    assert.ok(POOLS[section], `pool ${section}`);
    assert.ok(POOLS[section].topics.length >= MIN_POOL_TOPICS, `${section}: ${POOLS[section].topics.length} argomenti`);
    assert.deepEqual(validateTopicPool(POOLS[section], { section, minTopics: MIN_POOL_TOPICS }), []);
  }
});

test('pool pilota: ogni argomento ha >= 3 citazioni, fonte https sull\'host ufficiale e formato ammesso', () => {
  for (const [section, p] of Object.entries(POOLS)) {
    for (const t of p.topics) {
      assert.ok(t.facts.length >= MIN_VERIFIED_FACTS, `${section}/${t.id}`);
      assert.ok(t.source.url.startsWith('https://'), `${section}/${t.id}`);
      assert.ok(p.officialHosts.some((h) => new URL(t.source.url).hostname.endsWith(h)), `${section}/${t.id} host`);
    }
    const formats = new Set(p.topics.map((t) => t.format));
    assert.ok(formats.has('guida') && formats.has('dati'), `${section}: guide e dati datati`);
  }
});

test('pool pilota: nessun argomento-clone fra cantoni (stesso scheletro, solo il nome cambiato)', () => {
  assert.deepEqual(findCrossCantonTemplateClones(POOLS), []);
  assert.deepEqual(checkOffline(POOLS).errors, []);
});

test('pool: la validazione rifiuta pool incompleti', () => {
  const bad = pool(topic('a', 'uno due tre'), { ...topic('b', 'quattro cinque sei'), facts: [fact('solo una')] });
  const errors = validateTopicPool(bad, { section: 'canton-vs', minTopics: 3 });
  assert.ok(errors.some((e) => /argomenti 2 < 3/.test(e)));
  assert.ok(errors.some((e) => /1 fatti < 3/.test(e)));
  const offHost = pool({ ...topic('c', 'sette otto nove'), source: { url: 'https://example.com/x', publisher: 'X', language: 'fr' } });
  assert.ok(validateTopicPool(offHost, { section: 'canton-vs' }).some((e) => /fuori da officialHosts/.test(e)));
  assert.ok(validateTopicPool({ ...pool(topic('d', 'a b c')), officialHosts: [] }).some((e) => /officialHosts mancante/.test(e)));
});

// ── Fatti verificati nella fonte ─────────────────────────────────────────────

test('fatti: il confronto e\' verbatim ma tollera apostrofi tipografici, spazi e maiuscole', () => {
  const t = topic('x', 'kw');
  t.facts = [fact('l’aide sociale vise'), fact('Hotline (français)  027'), fact('PASS 13*')];
  const text = htmlToPlainText("<p>L'aide&nbsp;sociale vise</p><script>var x=1</script><b>hotline (français) 027</b> pass 13*");
  assert.equal(verifyTopicOnPage(t, text).ok, true);
  assert.deepEqual(verifyTopicOnPage(t, 'niente').found, []);
});

test('fatti: servono almeno 3 citazioni trovate', () => {
  const t = topic('x', 'kw');
  const two = `${t.facts[0].evidence} ${t.facts[1].evidence}`;
  const r = verifyTopicOnPage(t, two);
  assert.equal(r.ok, false);
  assert.equal(r.found.length, 2);
  assert.equal(r.missing.length, 1);
});

// ── La scelta ────────────────────────────────────────────────────────────────

test('senza notizie: sezione in lista -> candidato non-news del pool, con la pagina ufficiale', async () => {
  const a = topic('a', 'guida permessi lavoro stranieri');
  const pickedAll = await pickNonNewsTopic({
    section: 'canton-vs', pool: pool(a), now: NOW,
    fetchPage: okFetch({ [a.source.url]: pageFor(a) }),
  });
  assert.equal(pickedAll.topic.id, 'a');
  assert.equal(pickedAll.verified.length, 3);
  assert.deepEqual(pickedAll.skipped, []);
  const content = buildNonNewsSourceContent(pickedAll.topic, pickedAll.pageText, pickedAll.verified);
  assert.match(content, /FORMATO NON-NEWS CANTONALE/);
  assert.match(content, /Fonte ufficiale: Servizio X — https:\/\/www\.vs\.ch\/web\/a/);
  assert.match(content, /alpha a uno/);
});

test('pool vuoto = nessun candidato (il run dichiara exit 4 come prima)', async () => {
  assert.equal(await pickNonNewsTopic({ section: 'canton-vs', pool: pool(), now: NOW, fetchPage: okFetch({}) }), null);
});

test('copertura a 90 giorni: fonte registrata da meno di 90 giorni esclusa, oltre ammessa', async () => {
  const a = topic('a', 'guida permessi lavoro stranieri');
  const key = 'k-a';
  const ledger = (days) => ({ [key]: { articleId: 'x', ts: new Date(NOW - days * DAY).toISOString() } });
  assert.equal(sourceCoveredWithin(ledger(89), key, { now: NOW }), true);
  assert.equal(sourceCoveredWithin(ledger(91), key, { now: NOW }), false);
  assert.equal(sourceCoveredWithin({ [key]: 'storico-senza-data' }, key, { now: NOW }), true);
  assert.equal(sourceCoveredWithin({ [key]: { articleId: 'x', ts: 'rotto' } }, key, { now: NOW }), true);
  assert.equal(sourceCoveredWithin({}, key, { now: NOW }), false);
  assert.equal(COVERAGE_WINDOW_DAYS, 90);
  const run = (days) => pickNonNewsTopic({
    section: 'canton-vs', pool: pool(a), now: NOW,
    isCovered: () => sourceCoveredWithin(ledger(days), key, { now: NOW }),
    fetchPage: okFetch({ [a.source.url]: pageFor(a) }),
  });
  assert.equal(await run(10), null);
  assert.equal((await run(120)).topic.id, 'a');
});

test('argomento coperto negli ultimi 90 giorni: scartato e si passa al successivo', async () => {
  const a = topic('a', 'guida permessi lavoro stranieri');
  const b = topic('b', 'imposta successione donazione franchigia');
  const r = await pickNonNewsTopic({
    section: 'canton-vs', pool: pool(a, b), now: startAt(2),
    isCovered: (t) => t.id === 'a',
    fetchPage: okFetch({ [a.source.url]: pageFor(a), [b.source.url]: pageFor(b) }),
  });
  assert.equal(r.topic.id, 'b');
  assert.deepEqual(r.skipped, [{ id: 'a', reason: 'covered-90d' }]);
});

test('fonte non raggiungibile: argomento escluso', async () => {
  const a = topic('a', 'guida permessi lavoro stranieri');
  const b = topic('b', 'imposta successione donazione franchigia');
  const r = await pickNonNewsTopic({
    section: 'canton-vs', pool: pool(a, b), now: startAt(2),
    fetchPage: okFetch({ [b.source.url]: pageFor(b) }), // a risponde 404
  });
  assert.equal(r.topic.id, 'b');
  assert.deepEqual(r.skipped.map((x) => [x.id, x.reason]), [['a', 'source-unreachable']]);
  const none = await pickNonNewsTopic({ section: 'canton-vs', pool: pool(a), now: NOW, fetchPage: okFetch({}) });
  assert.equal(none, null);
});

test('fatti non verificati nella fonte: argomento escluso (pagina cambiata)', async () => {
  const a = topic('a', 'guida permessi lavoro stranieri');
  const stale = `solo ${a.facts[0].evidence} ${a.facts[1].evidence}`;
  const r = await pickNonNewsTopic({ section: 'canton-vs', pool: pool(a), now: NOW, fetchPage: okFetch({ [a.source.url]: stale }) });
  assert.equal(r, null);
  const withSkip = await pickNonNewsTopic({
    section: 'canton-vs', pool: pool(a, topic('b', 'altro tema diverso')), now: startAt(2),
    fetchPage: okFetch({ [a.source.url]: stale, 'https://www.vs.ch/web/b': pageFor(topic('b', 'x')) }),
  });
  assert.equal(withSkip.topic.id, 'b');
  assert.deepEqual(withSkip.skipped, [{ id: 'a', reason: 'facts-unverified', detail: '2/3' }]);
});

test('ban/strike del ledger evergreen e preflight di duplicato escludono l\'argomento', async () => {
  const a = topic('a', 'guida permessi lavoro stranieri');
  const b = topic('b', 'imposta successione donazione franchigia');
  const c = topic('c', 'asilo nido costi contributi famiglie');
  const r = await pickNonNewsTopic({
    section: 'canton-vs', pool: pool(a, b, c), now: startAt(3),
    isRejected: (t) => t.id === 'a',
    isPreflightDuplicate: (t) => t.id === 'b',
    fetchPage: okFetch({ [a.source.url]: pageFor(a), [b.source.url]: pageFor(b), [c.source.url]: pageFor(c) }),
  });
  assert.equal(r.topic.id, 'c');
  assert.deepEqual(r.skipped.map((x) => x.reason).sort(), ['preflight-duplicate', 'rejected']);
});

test('excludeIds: un argomento gia\' tentato nel run non si riprova', async () => {
  const a = topic('a', 'guida permessi lavoro stranieri');
  const r = await pickNonNewsTopic({
    section: 'canton-vs', pool: pool(a), now: NOW, excludeIds: new Set(['a']),
    fetchPage: okFetch({ [a.source.url]: pageFor(a) }),
  });
  assert.equal(r, null);
});

// ── Anti-template fra cantoni ────────────────────────────────────────────────

test('anti-template: lo scheletro ignora il nome del cantone', () => {
  const vs = topicSkeleton('Imposta alla fonte in Vallese: portale per i conteggi');
  const be = topicSkeleton('Imposta alla fonte nel Canton Berna: portale per i conteggi');
  assert.deepEqual([...vs].sort(), [...be].sort());
  assert.equal(vs.has('vallese'), false);
  assert.equal(be.has('berna'), false);
});

test('anti-template: stesso articolo col solo nome cambiato = clone; argomento specifico = no', async () => {
  const t = topic('vs-fonte', 'Imposta alla fonte in Vallese: portale per i conteggi di dipendenti e frontalieri');
  const clone = findTemplateClone(t, [{ id: 'imposta-alla-fonte-nel-canton-berna-portale-per-i-conteggi-di-dipendenti-e-frontalieri', section: 'canton-be' }]);
  assert.ok(clone && clone.sim >= 0.6);
  assert.equal(findTemplateClone(t, [{ id: 'alluvione-nel-canton-berna-strade-chiuse-oggi', section: 'canton-be' }]), null);
  const r = await pickNonNewsTopic({
    section: 'canton-vs', pool: pool(t), now: NOW,
    otherCantonArticles: [{ id: clone.id, section: 'canton-be' }],
    fetchPage: okFetch({ [t.source.url]: pageFor(t) }),
  });
  assert.equal(r, null);
});

test('anti-template: due pool con lo stesso argomento a nome cambiato sono rilevati', () => {
  const vs = { topics: [{ id: 'vs-1', keyword: 'Passaporto e carta d\'identità in Vallese: costi e validità' }] };
  const be = { topics: [{ id: 'be-1', keyword: 'Passaporto e carta d\'identità nel Canton Berna: costi e validità' }] };
  const clones = findCrossCantonTemplateClones({ 'canton-vs': vs, 'canton-be': be });
  assert.equal(clones.length, 1);
  assert.equal(findCrossCantonTemplateClones({ 'canton-vs': vs }).length, 0);
});

// ── Lo script di verifica ────────────────────────────────────────────────────

test('script --check --online: scarta fonti irraggiungibili o con fatti mancanti e non timbra', async () => {
  const a = topic('a', 'guida permessi lavoro stranieri');
  const b = topic('b', 'imposta successione donazione franchigia');
  const c = topic('c', 'asilo nido costi contributi famiglie');
  const pools = { 'canton-vs': pool(a, b, c) };
  const { errors, okSections } = await checkOnline(pools, {
    delayMs: 0,
    fetchPage: okFetch({ [a.source.url]: pageFor(a), [b.source.url]: 'pagina senza i fatti' }),
  });
  assert.equal(errors.length, 2);
  assert.match(errors.join('\n'), /canton-vs\/b: solo 0\/3 citazioni/);
  assert.match(errors.join('\n'), /canton-vs\/c: fonte non raggiungibile \(HTTP 404\)/);
  assert.equal(okSections.size, 0);
});

test('script: uso errato = exit 2; --check offline sui pool reali = exit 0', () => {
  const script = path.join(ROOT, 'generator/scripts/verify-canton-evergreen-topics.mjs');
  assert.equal(spawnSync('node', [script], { encoding: 'utf8' }).status, 2);
  const ok = spawnSync('node', [script, '--check'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
});

test('CLI has: exit 0 solo per le sezioni in lista', () => {
  const cli = path.join(ROOT, 'generator/scripts/lib/canton-nonnews.mjs');
  const run = (section, env) => spawnSync('node', [cli, 'has', section], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } }).status;
  assert.equal(run('canton-vs', {}), 1);
  assert.equal(run('canton-vs', { [CANTON_NONNEWS_ENV]: 'canton-vs' }), 0);
  assert.equal(run('canton-be', { [CANTON_NONNEWS_ENV]: 'canton-vs' }), 1);
});

// ── Manifest del mirror ──────────────────────────────────────────────────────

test('manifest: i file nuovi del corpus hanno la voce corpus-only', () => {
  const entries = new Map(MANIFEST.files.map((f) => [f.path, f]));
  for (const file of [
    'generator/scripts/lib/canton-nonnews.mjs',
    'generator/scripts/verify-canton-evergreen-topics.mjs',
    'generator/tests/canton-nonnews.test.mjs',
    ...PILOT_SECTIONS.map((s) => `generator/data/canton-evergreen-topics/${s}.json`),
  ]) {
    assert.equal(entries.get(file)?.mode, 'corpus-only', file);
  }
});
