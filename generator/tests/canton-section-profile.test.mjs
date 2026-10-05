/**
 * canton-section-profile.test.mjs — le sezioni cantonali viste da
 * create-article.mjs (P6b del piano «sezioni articoli per cantone»). `node
 * --test`, offline.
 *
 * Cosa prova:
 *   - ARTICLE_SECTION_CONFIGS contiene le 24 sezioni cantonali del core (anche
 *     le inattive: il dedup fra sezioni le deve vedere), con i path del core e
 *     lo stato sotto data/sections/<id>/ (D18), senza toccare frontaliere e
 *     svizzera;
 *   - il gate D16: spento per default, acceso dal profilo `enabled` o
 *     dall'elenco CANTON_ARTICLE_SECTIONS_ENABLED (mappato in load-rc-env);
 *   - gli argomenti di rebase coprono OGNI file che create-article scrive per
 *     una sezione cantonale, con la strategia giusta;
 *   - gli scheletri dei file vuoti hanno la forma che gli scrittori di
 *     create-article riconoscono come «primo articolo»;
 *   - il profilo di ammissione e i testi di prompt del cantone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARTICLE_SECTION_CORE_ALL, isCantonSection } from '../../engine/shared/articleSectionCore.mjs';
import {
  CANTON_DISPLAY_NAMES,
  CANTON_SECTIONS_ENABLED_ENV,
  CANTON_STATE_ROOT,
  buildCantonProfile,
  cantonClassifierPrompt,
  cantonPromptLines,
  cantonSectionConfigs,
  cantonSectionIds,
  cantonSectionPaths,
  cantonSectionSkeletons,
  parseEnabledCantonSections,
  resolveCantonSectionGate,
  termHits,
} from '../scripts/lib/canton-section-profile.mjs';
import { corpusPath } from '../scripts/lib/corpus-paths.mjs';
import { sectionWriteSurfaces } from '../../scripts/lib/article-surfaces.mjs';
import { sectionRebaseArgs } from '../../scripts/ci/rebase-section-args.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CREATE_ARTICLE = fs.readFileSync(path.join(ROOT, 'generator', 'scripts', 'create-article.mjs'), 'utf8');
const PROFILES = JSON.parse(fs.readFileSync(path.join(ROOT, 'generator', 'data', 'canton-sections.json'), 'utf8'));
const SLUGS = JSON.parse(fs.readFileSync(path.join(ROOT, 'generator', 'data', 'canton-url-slugs.json'), 'utf8'));

const HISTORICAL_STATE = [
  'data/article-source-urls.json', 'data/swiss-article-source-urls.json',
  'data/article-source-quotas.json', 'data/swiss-article-source-quotas.json',
  'data/quota-state.json', 'data/topic-candidates-consumed.json',
  'data/topic-candidates-experimental-counter.json', 'data/topic-candidates-evergreen-counter.json',
  'data/topic-candidates-today-picks.json', 'data/topic-candidates-evergreen-rejected.json',
  'data/blog-articles', 'data/swiss-articles',
];

// ── Le voci di ARTICLE_SECTION_CONFIGS ──────────────────────────────────────

test('24 sezioni cantonali, quelle del core, con un nome per ogni gruppo', () => {
  const ids = cantonSectionIds();
  assert.equal(ids.length, 24);
  assert.deepEqual(ids, Object.keys(ARTICLE_SECTION_CORE_ALL).filter((id) => isCantonSection(id)));
  assert.deepEqual(Object.keys(CANTON_DISPLAY_NAMES).sort(), Object.keys(SLUGS.cantons).sort());
  const configs = cantonSectionConfigs();
  for (const id of ids) {
    const cfg = configs[id];
    const core = ARTICLE_SECTION_CORE_ALL[id];
    assert.equal(cfg.kind, 'canton');
    assert.equal(cfg.registryFile, core.registryFile, `${id}: registro fuori dal core`);
    assert.equal(cfg.slugDataFile, core.slugDataFile);
    assert.equal(cfg.metaPrefix, core.metaPrefix);
    assert.equal(cfg.bodyDir, core.bodyDir);
    assert.equal(cfg.hubSlug, core.indexSlug);
    assert.equal(cfg.updateRouterUnion, false, 'solo frontaliere mantiene la union BlogArticleId');
    assert.ok(cfg.newsSources.length > 0, `${id}: nessuna fonte news`);
    for (const src of cfg.newsSources) assert.equal(typeof src.url, 'string');
  }
});

test('lo stato di ogni sezione cantonale e\' suo: data/sections/<id>/, mai i file storici, mai un altro cantone', () => {
  const seen = new Map();
  for (const id of cantonSectionIds()) {
    const p = cantonSectionPaths(id);
    for (const key of ['sourceUrlsFile', 'sourceQuotaFile', 'quotaStateFile', 'experimentalCounterFile', 'evergreenCounterFile',
      'consumedFile', 'todayPicksFile', 'evergreenRejectedFile', 'sidecarDir', 'embeddingsBinPath', 'embeddingsMetaPath']) {
      assert.ok(p[key].startsWith(`${CANTON_STATE_ROOT}/${id}/`), `${id}.${key} fuori da ${CANTON_STATE_ROOT}/${id}/: ${p[key]}`);
      assert.ok(!HISTORICAL_STATE.includes(p[key]), `${id}.${key} riusa un file delle sezioni storiche`);
      assert.ok(!seen.has(p[key]), `${p[key]} condiviso fra ${seen.get(p[key])} e ${id}`);
      seen.set(p[key], id);
    }
    // I path sorgente si traducono nel layout del corpus (corpusPath non lancia).
    for (const rel of [p.registryFile, p.slugDataFile, ...p.metaFiles, p.seoFile, `services/locales/${p.bodyDir}`]) {
      assert.ok(corpusPath(rel).startsWith('content/'), `${rel} non finisce sotto content/`);
    }
  }
});

test('create-article: le storiche restano letterali, le cantonali arrivano dal modulo (anche le inattive)', () => {
  const start = CREATE_ARTICLE.indexOf('export const ARTICLE_SECTION_CONFIGS = {');
  const end = CREATE_ARTICLE.indexOf('\n};', start);
  const block = CREATE_ARTICLE.slice(start, end);
  assert.match(block, /\n {2}frontaliere: \{/);
  assert.match(block, /\n {2}svizzera: \{/);
  assert.match(block, /sourceUrlsFile: 'data\/article-source-urls\.json'/);
  assert.match(block, /sourceUrlsFile: 'data\/swiss-article-source-urls\.json'/);
  assert.match(block, /\n {2}\.\.\.cantonSectionConfigs\(\),/, 'le voci cantonali devono venire da cantonSectionConfigs()');
  // Il dedup fra sezioni legge i ledger di TUTTE le voci: le cantonali comprese.
  const dedup = CREATE_ARTICLE.slice(CREATE_ARTICLE.indexOf('function loadAllSectionSourceUrls() {'));
  assert.match(dedup.slice(0, 400), /Object\.entries\(ARTICLE_SECTION_CONFIGS\)/);
});

// ── D16: il gate ────────────────────────────────────────────────────────────

test('gate D16: spento per default, acceso dall\'elenco o dal profilo', () => {
  for (const id of cantonSectionIds()) {
    assert.equal(resolveCantonSectionGate(id, { env: {} }).enabled, false, `${id} acceso senza flag`);
    assert.equal(resolveCantonSectionGate(id, { env: { [CANTON_SECTIONS_ENABLED_ENV]: '' } }).enabled, false);
  }
  const env = { [CANTON_SECTIONS_ENABLED_ENV]: 'TI, canton-gr  be;zz' };
  assert.deepEqual(resolveCantonSectionGate('canton-ti', { env }), { enabled: true, via: 'env', unknown: ['zz'] });
  assert.equal(resolveCantonSectionGate('canton-gr', { env }).enabled, true);
  assert.equal(resolveCantonSectionGate('canton-be', { env }).enabled, true);
  assert.equal(resolveCantonSectionGate('canton-zh', { env }).enabled, false);
  assert.equal(parseEnabledCantonSections('all').sections.size, 24);
  assert.equal(parseEnabledCantonSections('basilea appenzello').sections.size, 2);

  const profiles = structuredClone(PROFILES);
  profiles.cantons.find((c) => c.code === 'UR').enabled = true;
  assert.deepEqual(resolveCantonSectionGate('canton-ur', { env: {}, profiles }), { enabled: true, via: 'profile', unknown: [] });
});

test('gate D16 cablato: Remote Config mappata, controllo in testa a main() prima di ogni scrittura', () => {
  const rc = fs.readFileSync(path.join(ROOT, 'generator', 'scripts', 'load-rc-env.mjs'), 'utf8');
  assert.match(rc, /CANTON_ARTICLE_SECTIONS_ENABLED: \['CANTON_ARTICLE_SECTIONS_ENABLED'\]/);
  const main = CREATE_ARTICLE.slice(CREATE_ARTICLE.indexOf('async function main() {'));
  const gate = main.indexOf('resolveCantonSectionGate(SECTION_NAME)');
  const lock = main.search(/^\s*resolveRegisterLockAtStartup\(\);/m);
  assert.ok(gate !== -1 && lock !== -1 && gate < lock, 'il gate deve precedere la risoluzione del lock');
  assert.match(main.slice(gate, gate + 1200), /\$\{CANTON_SECTION_DISABLED_MARKER\} section=\$\{SECTION_NAME\}/);
  assert.match(main.slice(gate, gate + 1200), /await exitAfterFlush\(0\);/);
});

// ── D18: rebase ─────────────────────────────────────────────────────────────

test('gli argomenti di rebase coprono ogni file scritto, con la strategia giusta', () => {
  // Le superfici del tipo `canton` di article-surfaces.mjs (P3) sono derivate
  // da cantonSectionPaths: e' da li' che --section-surfaces le passa al rebase
  // quando il cantone e' acceso nel core.
  const args = sectionRebaseArgs({ 'canton-ti': sectionWriteSurfaces('canton-ti') });
  const p = cantonSectionPaths('canton-ti');
  const after = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
  const bare = args.filter((a, i) => !a.startsWith('--') && !String(args[i - 1] || '').startsWith('--'));
  assert.deepEqual(after('--merge-counter').sort(), [
    `${p.evergreenCounterFile}:count`,
    `${p.experimentalCounterFile}:count`,
    `${p.quotaStateFile}:runCounter`,
  ].sort());
  assert.deepEqual(bare.sort(), [p.sourceUrlsFile, p.sourceQuotaFile, p.consumedFile, p.todayPicksFile, p.evergreenRejectedFile].sort());
  assert.deepEqual(after('--merge-registry').sort(), [
    'content/cantons/canton-ti/registry.ts',
    'content/cantons/canton-ti/slugs.ts',
    'content/cantons/canton-ti/seo.ts',
    'content/blog-meta-canton-ti-it.ts',
    'content/blog-meta-canton-ti-en.ts',
    'content/blog-meta-canton-ti-de.ts',
    'content/blog-meta-canton-ti-fr.ts',
  ].sort());
  assert.deepEqual(after('--take-theirs'), ['content/blog-body-canton-ti/', 'data/sections/canton-ti/articles/']);
  // I campi dei contatori sono quelli che i loro scrittori aggiornano davvero.
  const quota = fs.readFileSync(path.join(ROOT, 'generator', 'scripts', 'lib', 'scheduler', 'quotaController.mjs'), 'utf8');
  assert.match(quota, /runCounter/);
  const selector = fs.readFileSync(path.join(ROOT, 'generator', 'scripts', 'lib', 'article-topic-selector.mjs'), 'utf8');
  assert.match(selector, /export function persistExperimentalCounter\(state, opts = \{\}\)/);
});

test('create-article passa i path della sezione ai loader dello stato globale', () => {
  for (const [wrapper, key] of [
    ['_loadQuotaState', 'quotaState'], ['_saveQuotaState', 'quotaState'],
    ['_loadExperimentalCounter', 'experimentalCounter'], ['_persistExperimentalCounter', 'experimentalCounter'],
    ['_loadEvergreenCounter', 'evergreenCounter'], ['_persistEvergreenCounter', 'evergreenCounter'],
    ['_loadTodayPicksByCluster', 'todayPicks'], ['_persistTodayPicksByCluster', 'todayPicks'],
    ['_loadEvergreenRejectedTracker', 'evergreenRejected'], ['_persistEvergreenRejectedTracker', 'evergreenRejected'],
  ]) {
    const re = new RegExp(`function ${wrapper}\\([^)]*\\) \\{ return \\w+At\\([^;]*sectionStateOpts\\('${key}'\\)\\); \\}`);
    assert.match(CREATE_ARTICLE, re, `${wrapper} non legge lo stato della sezione`);
  }
  assert.doesNotMatch(CREATE_ARTICLE, /_topic(?:Load|Persist)ConsumedTracker\([^)]*CONSUMED_TRACKER_PATH\)/, 'il consumed tracker deve passare da SECTION_CONSUMED_PATH');
  // E lo stato partizionato entra nello stesso commit dell'articolo.
  const add = CREATE_ARTICLE.slice(CREATE_ARTICLE.indexOf('function gitAddAll(data) {'));
  assert.match(add.slice(0, 6000), /if \(SECTION_STATE_PATHS\) \{\n\s+for \(const \[key, rel\] of Object\.entries\(SECTION_STATE_PATHS\)\)/);
});

// ── File vuoti al primo articolo ────────────────────────────────────────────

test('gli scheletri hanno la forma «vuota» che gli scrittori di create-article riconoscono', () => {
  const sk = cantonSectionSkeletons('canton-gr');
  const cfg = cantonSectionConfigs()['canton-gr'];
  const slugs = sk[cfg.slugDataFile];
  const registry = sk[cfg.registryFile];
  const seo = sk[cfg.seoFile];
  const meta = sk['services/locales/blog-meta-canton-gr-it.ts'];
  // Le stesse ancore «primo articolo» degli scrittori (modifyRouterTs,
  // modifyBlogArticlesTsx, writeSectionLocale, modifySeoService), il cui
  // sorgente deve contenerle ancora: se cambiano li', questo test lo vede.
  const anchors = [
    ['`(export const ${SECTION.slugsConstName}\\\\s*:[^=]*=\\\\s*\\\\{)(\\\\s*\\\\n)`', new RegExp(`(export const ${cfg.slugsConstName}\\s*:[^=]*=\\s*\\{)(\\s*\\n)`), slugs],
    ['`(export const ${SECTION.fallbackReasonsConstName}\\\\s*:[^=]*=\\\\s*\\\\{)([\\\\s\\\\S]*?)(\\\\n\\\\};)`', new RegExp(`(export const ${cfg.fallbackReasonsConstName}\\s*:[^=]*=\\s*\\{)([\\s\\S]*?)(\\n\\};)`), slugs],
    ['`(export const ${SECTION.registryArrayName}\\\\s*:[^=]*=\\\\s*\\\\[)(\\\\s*)(\\\\])`', new RegExp(`(export const ${cfg.registryArrayName}\\s*:[^=]*=\\s*\\[)(\\s*)(\\])`), registry],
    ['/(:\\s*Record<string,\\s*string>\\s*=\\s*\\{)(\\s*\\n)/', /(:\s*Record<string,\s*string>\s*=\s*\{)(\s*\n)/, meta],
    ['`(const ${escapeRegex(seoConst)}[^=]*=\\\\s*\\\\{)(\\\\s*\\\\n)(\\\\};)`', new RegExp(`(const ${cfg.seoConstName}[^=]*=\\s*\\{)(\\s*\\n)(\\};)`), seo],
  ];
  for (const [literal, re, file] of anchors) {
    assert.ok(CREATE_ARTICLE.includes(literal), `ancora non piu' presente in create-article.mjs: ${literal}`);
    assert.match(file, re, `lo scheletro non ha la forma vuota attesa da ${literal}`);
  }
  // Nessuna voce, nessun id: il lock di registrazione li vede «assenti».
  assert.doesNotMatch(slugs, /^\s+(['"])([^'"]+)\1:\s*\{\s*it:/m);
  assert.doesNotMatch(slugs, /ALL_CANTON_ARTICLE_IDS: string\[\] = \[/, 'nessun elenco letterale di id (non dichiarato in article-surfaces)');
  assert.equal(Object.keys(sk).length, 7);
});

// ── Profilo e prompt ────────────────────────────────────────────────────────

test('profilo canton-gr: ammissione multilingue, cronaca solo con impatto pratico nel cantone', () => {
  const p = buildCantonProfile('canton-gr', { nationalTopicalKeywords: ['lavor', 'fisc'], nationalAdmissionKeywords: ['lavor', 'fisc'] });
  assert.equal(p.kind, 'canton');
  assert.equal(p.canton, 'GR');
  assert.equal(p.evergreenPool, null, 'nessun pool evergreen generico per le sezioni cantonali');
  assert.equal(p.discoveryPool, false);
  assert.equal(p.demandRanker, false);
  assert.equal(p.hasAdmission('Kanton Graubünden senkt die Steuern'), true);
  assert.equal(p.hasAdmission('Chur: Einbruch in Wohnung, Täter flüchtig'), false);
  assert.equal(p.hasAdmission('Chur: Kantonsstrasse nach Unfall gesperrt'), true, 'cronaca nel cantone con impatto pratico');
  assert.equal(p.hasAdmission('Zürich: Strasse nach Unfall gesperrt'), true, 'premessa: «gesperrt» e\' anche lessico di mobilita\'');
  assert.equal(p.localAdmits('Zürich: Strasse nach Unfall gesperrt'), false, 'ma non e\' cronaca del cantone');
  assert.equal(p.anchors('Zürich: Strasse nach Unfall gesperrt', 'https://www.example.ch/a'), false);
  assert.equal(p.anchors('Neue Regeln für Grenzgänger', 'https://www.valtellinanotizie.com/x'), true, 'fonte del lato estero: basta il segnale frontalieri');
  assert.equal(p.anchors('Neue Regeln', 'https://www.gr.ch/DE/Medien/x'), true, 'ente .ch del solo cantone');
  assert.equal(termHits('feststellen', ['stellen']), 0, 'gli stem si confrontano a inizio parola');
});

test('prompt cantonali: stesso formato di risposta delle storiche, cantone e contesto frontalieri dentro', () => {
  const p = buildCantonProfile('canton-ti', { nationalTopicalKeywords: [], nationalAdmissionKeywords: [] });
  const prompt = cantonClassifierPrompt(p, { headline: 'Chiasso: chiusa la dogana di Brogeda', sourceHint: 'www.ti.ch/x', summary: '' });
  assert.match(prompt, /Canton Ticino/);
  assert.match(prompt, /relevant=<yes\|no>; reason=<una frase di massimo 15 parole>/);
  assert.ok(prompt.includes(PROFILES.cantons.find((c) => c.code === 'TI').frontalieriContext.slice(0, 60)));
  const lines = cantonPromptLines(p);
  assert.match(lines.topicalRelevanceGate, /"abort_topical_relevance": true/);
  assert.match(lines.factCheckRelevance(false), /rilevanza_topica/);
  assert.equal(lines.factCheckRelevance(true).includes('NON sono nessi reali'), false, 'per un evergreen il paragrafo sulla cronaca sparisce, come nelle storiche');
  // L'espansione gira dopo il fact-check: la riga cantonale non chiede fatti
  // nuovi (ne' altri cantoni), a differenza di quella nazionale.
  assert.match(lines.expandEnrichmentLine, /NON aggiungere NESSUN fatto, numero, comune, altro cantone/);
  assert.match(CREATE_ARTICLE, /const enrichmentLine = IS_CANTON && !boundToText\n\s+\? CANTON_LINES\.expandEnrichmentLine/);
});

test('create-article: i rami cantonali leggono il profilo, e le storiche restano sui loro testi', () => {
  // Il tipo viene dal core, non dal nome.
  assert.match(CREATE_ARTICLE, /const IS_FRONTALIERE = SECTION_PROFILE\.kind === 'frontaliere';/);
  assert.match(CREATE_ARTICLE, /const IS_CANTON = SECTION_PROFILE\.kind === 'canton';/);
  for (const site of [
    /const prompt = IS_CANTON\n\s+\? cantonClassifierPrompt\(SECTION_PROFILE,/,
    /if \(IS_CANTON\) \{\n\s+return cantonHeadlineSelectionPrompt\(SECTION_PROFILE,/,
    /const topicalRelevanceGate = IS_CANTON\n\s+\? CANTON_LINES\.topicalRelevanceGate/,
    /const systemRoleLine = IS_CANTON\n\s+\? CANTON_LINES\.systemRoleLine/,
    /\$\{IS_CANTON \? CANTON_LINES\.factCheckRelevance\(isEvergreen\) : IS_FRONTALIERE \?/,
  ]) {
    assert.match(CREATE_ARTICLE, site);
  }
  // Pool evergreen, discovery e ranker: spenti per le cantonali dal profilo.
  assert.match(CREATE_ARTICLE, /else if \(!newsSuccess && !candidateSuccess && !SECTION_PROFILE\.evergreenPool\) \{/);
  assert.match(CREATE_ARTICLE, /const slotKind = forceEvergreen \|\| !SECTION_PROFILE\.discoveryPool \? 'proven' : slotDecision\.slotKind;/);
  assert.match(CREATE_ARTICLE, /if \(SECTION_PROFILE\.demandRanker && \(_demandVocabulary/);
});

test('--dry-run-scan: misura fino alla selezione ed esce prima di generare o scrivere', () => {
  assert.match(CREATE_ARTICLE, /const DRY_RUN_SCAN = process\.argv\.slice\(2\)\.includes\('--dry-run-scan'\);/);
  const main = CREATE_ARTICLE.slice(CREATE_ARTICLE.indexOf('async function main() {'));
  assert.match(main, /if \(DRY_RUN_SCAN\) \{\n[^\n]*\n\s+\} else \{\n\s+resolveRegisterLockAtStartup\(\);\n\s+\}/, 'in dry-run il lock non si tocca');
  const exitAt = main.indexOf('if (DRY_RUN_SCAN) await exitDryRunScan({ chosen,');
  const genAt = main.indexOf("if (chosen?.url?.startsWith('evergreen://')) {");
  assert.ok(exitAt !== -1 && genAt !== -1 && exitAt < genAt, 'l\'uscita del dry-run deve precedere ogni passo dopo la selezione');
  const fn = CREATE_ARTICLE.slice(CREATE_ARTICLE.indexOf('async function exitDryRunScan('), CREATE_ARTICLE.indexOf('async function exitDryRunScan(') + 2500);
  assert.match(fn, /DRY_RUN_SCAN_SUMMARY/);
  // Uscita SENZA il flush del ledger condiviso dei modelli (Firestore).
  assert.match(fn, /await exitAfterDrain\(0\);/);
  const fnCode = fn.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(fnCode, /exitAfterFlush|flushScores/, 'il dry-run non deve scrivere i punteggi dei modelli');
  assert.doesNotMatch(fn, /(?<!stdout\.)write\(|persist|_save|saveSource/, 'il riepilogo non scrive stato');
  // Con una URL esplicita non c'e' scansione: la modalita' manuale genererebbe
  // e scriverebbe. La combinazione si rifiuta prima di ogni altra cosa.
  const urlAt = main.indexOf('let url = process.argv.slice(2).find(');
  const reject = main.indexOf('if (DRY_RUN_SCAN && url) {');
  const manual = main.indexOf('// ── Manual URL mode ──');
  assert.ok(urlAt !== -1 && reject > urlAt && manual > reject, 'dry-run + URL va rifiutato subito dopo la lettura della URL');
  assert.match(main.slice(reject, reject + 600), /await exitAfterFlush\(2\);\n\s+return;/);
});

test('sezione cantonale senza voci recenti: niente ripiego su TUTTE le headline', () => {
  // Le storiche, senza voci recenti, mandano al ranker tutte le headline; una
  // cantonale (archivi istituzionali, navigazione) passa solo le senza data,
  // con la quota per fonte, e le datate stantie si scartano per fonte.
  assert.match(CREATE_ARTICLE, /if \(recent\.length === 0 && !IS_CANTON\) \{/);
  const helper = CREATE_ARTICLE.slice(CREATE_ARTICLE.indexOf('async function fetchCantonSourceHeadlines('));
  assert.match(helper.slice(0, 3000), /return recent\.length > 0 \? recent : raw\.filter\(\(h\) => !h\.date\);/);
});
