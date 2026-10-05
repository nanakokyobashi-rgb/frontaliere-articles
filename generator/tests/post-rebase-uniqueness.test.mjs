/**
 * scripts/ci/check-post-rebase-uniqueness.mjs — il ricontrollo di id e fonte
 * DOPO il rebase e prima del push (D18).
 *
 * Le due invarianti — id unico in tutte le sezioni, una fonte = una sezione —
 * il generatore le verifica sul tree di inizio run, quindi reggono solo con
 * scrittori seriali. Questi test costruiscono lo stato post-rebase che il
 * rebase produce quando due scrittori partono dalla stessa base, e chiedono
 * allo script di accorgersene. Le sezioni sono quelle del core: niente qui
 * elenca «frontaliere» e «svizzera» come lista da controllare.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rmTempTree } from './rm-temp-tree.mjs';
import { sliceBetween } from './lib/anchored-slice.mjs';
import { ARTICLE_SECTION_CORE_LIST } from '../../engine/shared/articleSectionCore.mjs';
import {
  ERROR_MARKER,
  OK_MARKER,
  VIOLATION_MARKER,
  findPostRebaseViolations,
  registryIdsOf,
  sectionSurfaces,
  slugIdsOf,
} from '../../scripts/ci/check-post-rebase-uniqueness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '../../scripts/ci/check-post-rebase-uniqueness.mjs');
const WORKFLOW = path.resolve(HERE, '../../.github/workflows/generate-article.yml');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  NODE_TEST_CONTEXT: '',
};

const SURFACES = sectionSurfaces();
const [FIRST, SECOND] = SURFACES;

// ── Fixture: le superfici nella forma reale ────────────────────────────────

function registrySrc(ids) {
  const entries = ids.map((id) => `  {\n   id: '${id}',\n   category: 'pratico',\n   date: '2026-10-05',\n  },\n`).join('');
  return `export interface Article {\n id: string;\n}\n\nconst RAW = [\n${entries}];\n`;
}

function slugSrc(ids) {
  const rows = ids.map((id) => ` '${id}': { it: '${id}-it', en: '${id}-en', de: '${id}-de', fr: '${id}-fr' },\n`).join('');
  return `export const SLUGS: Record<string, Record<string, string>> = {\n${rows}};\n`;
}

function ledgerSrc(map) {
  return `${JSON.stringify(map, null, 2)}\n`;
}

/** Stato di una sezione: ids (registro + slug) e ledger URL→voce. */
function sectionFiles(surface, { ids = [], ledger = {} } = {}) {
  return {
    [surface.registryFile]: registrySrc(ids),
    [surface.slugDataFile]: slugSrc(ids),
    [surface.sourceLedger]: ledgerSrc(ledger),
  };
}

/** Lo snapshot che lo script costruirebbe, senza passare da git. */
function snapshot(stateBySection) {
  const out = {};
  for (const s of SURFACES) {
    const st = stateBySection[s.section] ?? {};
    out[s.section] = {
      slugIds: slugIdsOf(slugSrc(st.ids ?? [])),
      registryIds: registryIdsOf(registrySrc(st.registryIds ?? st.ids ?? [])),
      ledger: st.ledger ?? {},
    };
  }
  return out;
}

const entry = (articleId) => ({ articleId, ts: '2026-10-05T06:00:00.000Z', keyForm: 2 });
const URL_A = 'https://www.tio.ch/ticino/attualita/1999999/stessa-fonte';

// ── Le sezioni vengono dal core ────────────────────────────────────────────

test('le superfici controllate sono TUTTE le sezioni del core, ognuna col suo ledger', () => {
  assert.ok(SURFACES.length >= 2, 'servono almeno due sezioni perche\' «cross-sezione» significhi qualcosa');
  assert.deepEqual(SURFACES.map((s) => s.section), ARTICLE_SECTION_CORE_LIST.map((c) => c.section));
  for (const s of SURFACES) {
    assert.ok(s.registryFile.startsWith('content/'), `${s.section}: registro fuori dal corpus (${s.registryFile})`);
    assert.ok(s.slugDataFile.startsWith('content/'), `${s.section}: mappa slug fuori dal corpus (${s.slugDataFile})`);
    assert.match(s.sourceLedger, /\.json$/);
  }
  assert.equal(new Set(SURFACES.map((s) => s.sourceLedger)).size, SURFACES.length, 'un ledger per sezione');
});

test('una sezione nel core senza ledger dichiarato e\' un errore, non una sezione saltata', () => {
  const core = [...ARTICLE_SECTION_CORE_LIST, {
    section: 'canton-xx',
    registryFile: 'packages/articles/content/cantons/canton-xx/registry.ts',
    slugDataFile: 'packages/articles/content/cantons/canton-xx/slugs.ts',
  }];
  assert.throws(() => sectionSurfaces(core), /canton-xx.*ledger URL→id/);
});

// ── La logica, sugli snapshot ──────────────────────────────────────────────

test('ok: id nuovo e fonte nuova, nessuna collisione nello stato post-rebase', () => {
  const producedBase = snapshot({ [FIRST.section]: { ids: ['vecchio'] } });
  const produced = snapshot({
    [FIRST.section]: { ids: ['vecchio', 'nuovo'], ledger: { [URL_A]: entry('nuovo') } },
  });
  // Upstream ha intanto pubblicato un articolo DIVERSO, da una fonte diversa,
  // nell'altra sezione: e' il caso normale e deve passare.
  const against = snapshot({
    [FIRST.section]: { ids: ['vecchio', 'nuovo'], ledger: { [URL_A]: entry('nuovo') } },
    [SECOND.section]: { ids: ['altro'], ledger: { 'https://www.rsi.ch/s/1': entry('altro') } },
  });
  const r = findPostRebaseViolations({ producedBase, produced, against });
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.newIds, [{ section: FIRST.section, id: 'nuovo' }]);
  assert.equal(r.newSourceUrls.length, 1);
});

test('id duplicato: lo stesso id appena registrato da un altro scrittore in un\'altra sezione', () => {
  const producedBase = snapshot({});
  const produced = snapshot({ [SECOND.section]: { ids: ['stesso-id'] } });
  // `--merge-registry` ha unito i due registri senza obiezioni: sono file diversi.
  const against = snapshot({
    [FIRST.section]: { ids: ['stesso-id'] },
    [SECOND.section]: { ids: ['stesso-id'] },
  });
  const { violations } = findPostRebaseViolations({ producedBase, produced, against });
  assert.deepEqual(violations, [
    { kind: 'duplicate-id-cross-section', section: SECOND.section, id: 'stesso-id', other: FIRST.section },
    { kind: 'duplicate-id-registry', section: SECOND.section, id: 'stesso-id', occurrences: 2 },
  ]);
});

test('id duplicato DENTRO un registro (due record con lo stesso id) e\' una violazione', () => {
  const produced = snapshot({ [FIRST.section]: { ids: ['doppio'] } });
  const against = snapshot({ [FIRST.section]: { ids: ['doppio'], registryIds: ['doppio', 'doppio'] } });
  const { violations } = findPostRebaseViolations({ producedBase: snapshot({}), produced, against });
  assert.deepEqual(violations, [{ kind: 'duplicate-id-registry', section: FIRST.section, id: 'doppio', occurrences: 2 }]);
});

test('URL fonte gia\' registrata in un\'altra sezione, anche se il rebase ha perso la nostra voce del ledger', () => {
  const producedBase = snapshot({});
  const produced = snapshot({ [SECOND.section]: { ids: ['mio'], ledger: { [URL_A]: entry('mio') } } });
  // Il ledger e' bookkeeping: al conflitto vince upstream, quindi nello stato
  // post-rebase la NOSTRA voce non c'e' piu'. Lo script deve vederla lo stesso,
  // perche' la legge dal commit prodotto.
  const against = snapshot({
    [FIRST.section]: { ids: ['suo'], ledger: { [URL_A]: entry('suo') } },
    [SECOND.section]: { ids: ['mio'], ledger: {} },
  });
  const { violations } = findPostRebaseViolations({ producedBase, produced, against });
  assert.deepEqual(violations, [{
    kind: 'source-url-cross-section',
    section: SECOND.section,
    id: 'mio',
    url: URL_A,
    other: FIRST.section,
    otherId: 'suo',
  }]);
});

test('la sorella registrata col path nudo (forma 1) viene trovata dal ponte, come nel generatore', () => {
  const withQuery = 'https://www.ti.ch/comunicati/dettaglio?news_id=42';
  const produced = snapshot({ [FIRST.section]: { ids: ['mio'], ledger: { [withQuery]: entry('mio') } } });
  const against = snapshot({
    [FIRST.section]: { ids: ['mio'], ledger: { [withQuery]: entry('mio') } },
    // Voce storica: stringa nuda, chiave senza query.
    [SECOND.section]: { ids: ['suo'], ledger: { 'https://www.ti.ch/comunicati/dettaglio': 'suo' } },
  });
  const { violations } = findPostRebaseViolations({ producedBase: snapshot({}), produced, against });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].kind, 'source-url-cross-section');
  assert.equal(violations[0].otherId, 'suo');
});

test('solo cio\' che il run ha aggiunto conta: un duplicato storico non fa scattare niente', () => {
  // I duplicati cross-sezione gia' nel corpus (cross-section-duplicate-ratchet)
  // stanno nella BASE del commit prodotto: non sono «nuovi».
  const old = { [URL_A]: 'vecchio-uno' };
  const producedBase = snapshot({
    [FIRST.section]: { ids: ['vecchio-uno'], ledger: old },
    [SECOND.section]: { ids: ['vecchio-due'], ledger: { [URL_A]: 'vecchio-due' } },
  });
  const produced = snapshot({
    [FIRST.section]: { ids: ['vecchio-uno', 'nuovo'], ledger: { ...old, 'https://www.rsi.ch/s/2': entry('nuovo') } },
    [SECOND.section]: { ids: ['vecchio-due'], ledger: { [URL_A]: 'vecchio-due' } },
  });
  const { violations } = findPostRebaseViolations({ producedBase, produced, against: produced });
  assert.deepEqual(violations, []);
});

// ── Lo script vero, su un repo git vero ────────────────────────────────────

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeFiles(root, files) {
  for (const [rel, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), contents);
  }
}

function commit(root, files, message) {
  writeFiles(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '--allow-empty', '-m', message);
  return git(root, 'rev-parse', 'HEAD').trim();
}

function runScript(cwd, ...args) {
  try {
    const out = execFileSync('node', [SCRIPT, ...args], { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/**
 * Base comune → `produced` (il nostro run, figlio della base) e `against` (lo
 * stato post-rebase: upstream + il nostro commit rigiocato sopra).
 */
function world({ upstream, mine, rebased }) {
  const root = mkdtempSync(path.join(tmpdir(), 'post-rebase-uniqueness-'));
  git(root, 'init', '-q', '-b', 'main');
  const empty = Object.assign({}, ...SURFACES.map((s) => sectionFiles(s, {})));
  const base = commit(root, empty, 'base');
  const produced = commit(root, mine, 'Generate blog article (mine)');
  git(root, 'checkout', '-q', '-b', 'upstream', base);
  commit(root, upstream, 'Generate blog article (theirs)');
  const against = commit(root, rebased, 'Generate blog article (mine, rebased)');
  return { root, base, produced, against, cleanup: () => rmTempTree(root) };
}

test('CLI ok: exit 0 e marcatore OK quando lo stato post-rebase e\' pulito', () => {
  const mine = sectionFiles(FIRST, { ids: ['nuovo'], ledger: { [URL_A]: entry('nuovo') } });
  const upstream = sectionFiles(SECOND, { ids: ['altro'], ledger: { 'https://www.rsi.ch/s/3': entry('altro') } });
  const w = world({ upstream, mine, rebased: mine });
  try {
    const { code, out } = runScript(w.root, '--produced', w.produced, '--against', w.against);
    assert.equal(code, 0, out);
    assert.match(out, new RegExp(`${OK_MARKER} .*new_ids=${FIRST.section}/nuovo`));
  } finally {
    w.cleanup();
  }
});

test('CLI id duplicato: exit 1 e POST_REBASE_UNIQUENESS_VIOLATION nel log', () => {
  const mine = sectionFiles(SECOND, { ids: ['stesso-id'] });
  const upstream = sectionFiles(FIRST, { ids: ['stesso-id'] });
  const w = world({ upstream, mine, rebased: mine });
  try {
    const { code, out } = runScript(w.root, '--produced', w.produced, '--against', w.against);
    assert.equal(code, 1, out);
    assert.match(out, new RegExp(`::error::${VIOLATION_MARKER} kind=duplicate-id-cross-section section=${SECOND.section} id=stesso-id other=${FIRST.section}`));
  } finally {
    w.cleanup();
  }
});

test('CLI URL fonte in un\'altra sezione: exit 1 anche se il ledger post-rebase e\' quello di upstream', () => {
  const mine = sectionFiles(SECOND, { ids: ['mio'], ledger: { [URL_A]: entry('mio') } });
  const upstream = sectionFiles(FIRST, { ids: ['suo'], ledger: { [URL_A]: entry('suo') } });
  // Rigiocato: il nostro articolo c'e', ma il nostro ledger e' stato risolto
  // prendendo upstream (vuoto per la nostra sezione).
  const rebased = { ...sectionFiles(SECOND, { ids: ['mio'] }) };
  const w = world({ upstream, mine, rebased });
  try {
    const { code, out } = runScript(w.root, '--produced', w.produced, '--against', w.against);
    assert.equal(code, 1, out);
    assert.match(out, new RegExp(`${VIOLATION_MARKER} kind=source-url-cross-section section=${SECOND.section} id=mio other=${FIRST.section} otherId=suo`));
  } finally {
    w.cleanup();
  }
});

test('CLI non eseguibile: exit 2 con il suo marcatore, mai un falso «ok»', () => {
  const mine = sectionFiles(FIRST, { ids: ['x'] });
  const w = world({ upstream: {}, mine, rebased: { [SECOND.sourceLedger]: '{ rotto' } });
  try {
    const bad = runScript(w.root, '--produced', w.produced, '--against', w.against);
    assert.equal(bad.code, 2, bad.out);
    assert.match(bad.out, new RegExp(`${ERROR_MARKER}: .*JSON illeggibile`));

    const missing = runScript(w.root, '--produced', 'non-esiste');
    assert.equal(missing.code, 2, missing.out);
    assert.match(missing.out, new RegExp(ERROR_MARKER));
  } finally {
    w.cleanup();
  }
});

test('CLI: un file che c\'e\' ma non si legge e\' un errore, non una sezione vuota', () => {
  // Il caso che un `git show` fallito trattato da «assente» faceva passare: il
  // registro dell'altra sezione c'e' (l'albero lo elenca) ma il suo blob manca,
  // come in un clone parziale o con un oggetto corrotto. Leggerlo come vuoto
  // toglieva dal confronto proprio il duplicato.
  const mine = sectionFiles(SECOND, { ids: ['stesso-id'] });
  // Un id in piu' rende i blob di upstream diversi da quelli del nostro commit.
  const upstream = sectionFiles(FIRST, { ids: ['stesso-id', 'solo-upstream'] });
  const w = world({ upstream, mine, rebased: mine });
  try {
    const blob = git(w.root, 'rev-parse', `${w.against}:${FIRST.slugDataFile}`).trim();
    const regBlob = git(w.root, 'rev-parse', `${w.against}:${FIRST.registryFile}`).trim();
    for (const b of [blob, regBlob]) {
      rmSync(path.join(w.root, '.git', 'objects', b.slice(0, 2), b.slice(2)), { force: true });
    }
    const { code, out } = runScript(w.root, '--produced', w.produced, '--against', w.against);
    assert.equal(code, 2, out);
    assert.match(out, new RegExp(`${ERROR_MARKER}: .*esiste ma non si legge`));
    assert.doesNotMatch(out, new RegExp(OK_MARKER));
  } finally {
    w.cleanup();
  }
});

// ── Il cablaggio nel workflow ──────────────────────────────────────────────

test('generate-article.yml esegue il controllo dopo un rebase riuscito e non pusha se fallisce', () => {
  const wf = readFileSync(WORKFLOW, 'utf8');
  const step = sliceBetween(wf, '      - name: Commit and push\n', '      - name: Cleanup Codex auth broker');
  const active = step.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

  const producedAt = active.indexOf('PRODUCED="$(git rev-parse HEAD)"');
  const commitAt = active.lastIndexOf('git commit -m', producedAt);
  const loopAt = active.indexOf('for attempt in');
  const rebaseAt = active.indexOf('bash scripts/lib/rebase-onto-remote.sh', loopAt);
  const checkAt = active.indexOf('node scripts/ci/check-post-rebase-uniqueness.mjs --produced "$PRODUCED" --against HEAD');
  const doneMatch = /\n\s+done\n/.exec(active.slice(Math.max(0, checkAt)));
  const doneAt = doneMatch ? checkAt + doneMatch.index : -1;

  assert.ok(commitAt >= 0 && producedAt > commitAt && producedAt < loopAt,
    'PRODUCED va preso dopo il commit e PRIMA di ogni rebase: dopo, la voce del ledger del run puo\' essere sparita');
  assert.ok(rebaseAt > loopAt && checkAt > rebaseAt && doneAt > checkAt,
    'il controllo sta nel loop, dopo il rebase e prima del prossimo push');
  const rebaseCall = active.slice(rebaseAt, checkAt);
  assert.match(rebaseCall, /\|\| rebased=0\n/, 'l\'esito del rebase deve essere registrato, non buttato con `|| true`');
  const gate = active.slice(checkAt - 200, doneAt);
  assert.match(gate, /if \[ "\$rebased" -eq 1 \]; then/, 'il controllo gira solo dopo un rebase riuscito');
  assert.match(gate, /\|\| uniq_rc=\$\?/);
  assert.match(gate, /if \[ "\$uniq_rc" -ne 0 \]; then[\s\S]*?exit 1/, 'un controllo fallito deve fermare il run SENZA pushare');
});
