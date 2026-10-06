/**
 * followup-drainer — PARENT-CLOSE non richiude un padre che un monitor ha
 * riaperto dopo la decomposizione (meta' corpus della fix sito #11312).
 *
 * Caso reale qui: #339 «Loop drift: il ciclo autonomo diverge dal sito»,
 * padre `decomposed:1` con figlie tutte chiuse e insieme issue canonica di
 * `loop-drift-check.mjs`. Il creator la riapriva a ogni ricorrenza
 * (`🔁 **Reopened**`), il PARENT-CLOSE la richiudeva al tick dopo: 25
 * PARENT-CLOSE e 35 riaperture nello stesso thread al 2026-10-04. Sul sito la
 * stessa forma e' la issue 5661 (140 chiusure, 141 riaperture).
 *
 * Il modulo `scripts/ci/lib/parent-close-recurrence.mjs` e' `identical` col
 * sito: il test di identita' confronta i suoi byte con la baseline del
 * manifest, cosi' una modifica locale non riattestata diventa rossa qui.
 *
 * Se questo file diventa rosso: «PARENT-CLOSE corpus: guardia
 * reopenedAfterDecomposition assente o modulo diverso dal sito».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  reopenedAfterDecomposition,
  decomposedIntoNumbers,
} from '../../scripts/ci/lib/parent-close-recurrence.mjs';
import { decomposedChildNumbers } from '../../scripts/ci/followup-drainer.mjs';

const MODULE_REL = 'scripts/ci/lib/parent-close-recurrence.mjs';
const fromRoot = (rel) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));

const decomposed = (createdAt) => ({
  body: 'Decomposta.\n<!-- DECOMPOSED_INTO: #6672, #6673, #6674 -->',
  ...(createdAt === undefined ? {} : { createdAt }),
});
const parentClose = (createdAt) => ({
  body: '✅ Auto-chiusa dal followup-drainer (PARENT-CLOSE): tutte le sub-issue della decomposizione (#6672, #6673, #6674) risultano chiuse.',
  createdAt,
});
const reopened = (createdAt) => ({
  body: '🔁 **Reopened** — ricorrenza il 2026-10-03T11:00:00Z: la stessa condizione si è ripresentata entro 720h dalla chiusura.\n\n**Misura corrente:**\n\n…',
  ...(createdAt === undefined ? {} : { createdAt }),
});

test('true: decomposizione, PARENT-CLOSE, poi riapertura del monitor', () => {
  assert.equal(reopenedAfterDecomposition([
    decomposed('2026-10-03T10:00:00Z'),
    parentClose('2026-10-03T10:05:00Z'),
    reopened('2026-10-03T11:00:00Z'),
  ]), true);
});

test('true: il monitor annota una ricorrenza su una issue già aperta', () => {
  assert.equal(reopenedAfterDecomposition([
    decomposed('2026-10-03T10:00:00Z'),
    { body: '🔁 Recurrence on workflow run.\n\n**Workflow:** Bing SEO closed loop', createdAt: '2026-10-03T11:00:00Z' },
  ]), true);
});

test('false: decomposizione rifatta DOPO la ricorrenza ridà l\'autorità al PARENT-CLOSE', () => {
  assert.equal(reopenedAfterDecomposition([
    reopened('2026-10-03T11:00:00Z'),
    decomposed('2026-10-03T12:00:00Z'),
  ]), false);
});

test('false: l\'ULTIMO marker vince anche se una riapertura segue un marker precedente', () => {
  assert.equal(reopenedAfterDecomposition([
    decomposed('2026-10-01T10:00:00Z'),
    reopened('2026-10-02T10:00:00Z'),
    decomposed('2026-10-03T12:00:00Z'),
  ]), false);
});

test('a parità di secondo decide la posizione nel thread', () => {
  // GitHub data i commenti al secondo: una ricorrenza scritta nello stesso
  // secondo della decomposizione è «dopo» solo se viene dopo nell'elenco.
  assert.equal(reopenedAfterDecomposition([
    decomposed('2026-10-03T10:00:00Z'),
    reopened('2026-10-03T10:00:00Z'),
  ]), true);
  assert.equal(reopenedAfterDecomposition([
    reopened('2026-10-03T10:00:00Z'),
    decomposed('2026-10-03T10:00:00Z'),
  ]), false);
});

test('false: nessuna riapertura', () => {
  assert.equal(reopenedAfterDecomposition([
    decomposed('2026-10-03T10:00:00Z'),
    parentClose('2026-10-03T10:05:00Z'),
  ]), false);
});

test('false: riapertura senza alcun marker DECOMPOSED_INTO', () => {
  assert.equal(reopenedAfterDecomposition([reopened('2026-10-03T11:00:00Z')]), false);
});

test('false: createdAt della decomposizione mancante o non parsabile', () => {
  assert.equal(reopenedAfterDecomposition([decomposed(), reopened('2026-10-03T11:00:00Z')]), false);
  assert.equal(reopenedAfterDecomposition([decomposed('ieri'), reopened('2026-10-03T11:00:00Z')]), false);
});

test('false: riapertura senza createdAt non prova di essere posteriore', () => {
  assert.equal(reopenedAfterDecomposition([decomposed('2026-10-03T10:00:00Z'), reopened()]), false);
});

test('false: «🔁 **Reopened**» citato dentro un altro commento non è una riapertura', () => {
  assert.equal(reopenedAfterDecomposition([
    decomposed('2026-10-03T10:00:00Z'),
    { body: 'Il creator scrive `🔁 **Reopened**` a ogni ricorrenza.', createdAt: '2026-10-03T11:00:00Z' },
    { body: '> 🔁 **Reopened** — ricorrenza il …', createdAt: '2026-10-03T11:30:00Z' },
  ]), false);
});

test('false: input non-array o commenti nulli (lettura fallita)', () => {
  assert.equal(reopenedAfterDecomposition(null), false);
  assert.equal(reopenedAfterDecomposition(undefined), false);
  assert.equal(reopenedAfterDecomposition([null, decomposed('2026-10-03T10:00:00Z'), undefined]), false);
});

test('il marker che la guardia data è quello da cui il drainer del corpus legge le figlie', () => {
  // Il drainer adattato importa `decomposedIntoNumbers` dal modulo (come il
  // sito): pin di non-regressione contro un ritorno a una regex locale che
  // farebbe datare alla guardia un marker diverso da quello delle figlie.
  for (const body of [
    decomposed('2026-10-03T10:00:00Z').body,
    '<!-- DECOMPOSED_INTO: 12 ,#7, 12 -->',
    '<!--DECOMPOSED_INTO:#3-->',
    'niente marker',
    '<!-- DECOMPOSED_INTO: -->',
  ]) {
    assert.deepEqual(decomposedIntoNumbers(body), decomposedChildNumbers([{ body }]), body);
  }
});

test('identità: il modulo del corpus ha i byte della baseline `identical` del manifest', () => {
  const manifest = JSON.parse(readFileSync(fromRoot('scripts/ci/loop-sync-manifest.json'), 'utf8'));
  const entry = manifest.files.find((f) => f.path === MODULE_REL);
  assert.ok(entry, `${MODULE_REL} deve essere dichiarato nel loop-sync-manifest`);
  assert.equal(entry.mode, 'identical');
  assert.equal(entry.sitePath ?? MODULE_REL, MODULE_REL);
  assert.equal(entry.baseline?.site, entry.baseline?.corpus, 'baseline site e corpus devono coincidere per un identical');
  const digest = crypto.createHash('sha256').update(readFileSync(fromRoot(MODULE_REL))).digest('hex').slice(0, 16);
  assert.equal(digest, entry.baseline.corpus, 'modulo diverso dalla baseline: riallinealo al sito e riattesta la voce');
});

test('cablaggio: il PARENT-CLOSE importa e chiama la guardia prima di ogni lettura delle figlie, del pin e della chiusura', () => {
  const src = readFileSync(fromRoot('scripts/ci/followup-drainer.mjs'), 'utf8');
  assert.match(
    src,
    /import\s*\{[^}]*\breopenedAfterDecomposition\b[^}]*\}\s*from\s*'\.\/lib\/parent-close-recurrence\.mjs'/,
  );
  const start = src.indexOf('// --- PARENT-CLOSE:');
  const end = src.indexOf('// --- PRODUCTION-PROOF:', start);
  assert.ok(start > -1, 'blocco PARENT-CLOSE non trovato');
  assert.ok(end > start, 'fine del blocco PARENT-CLOSE non trovata');
  const block = src.slice(start, end);
  const at = (needle) => {
    const i = block.indexOf(needle);
    assert.ok(i > -1, `${needle} assente dal blocco PARENT-CLOSE`);
    return i;
  };
  const kids = at('decomposedChildNumbers(comments)');
  const guard = at('if (reopenedAfterDecomposition(comments))');
  const rearm = at('PARENT-REARM');
  const childState = at("'issue', 'view', String(k)");
  const pin = at('manifestPinFor(p.number)');
  const closeComment = at('Auto-chiusa dal followup-drainer (PARENT-CLOSE)');
  const close = at("closeIssue(p.number, { stage: 'parent-close' })");
  assert.ok(kids < guard, 'la guardia legge gli stessi commenti delle figlie, dopo di esse');
  assert.ok(guard < rearm);
  for (const [name, pos] of [['view stato figlie', childState], ['pin del manifest', pin], ['commento di chiusura', closeComment], ['closeIssue', close]]) {
    assert.ok(guard < pos, `la guardia deve precedere ${name}`);
  }
});

test('cablaggio: il riarmo puro scrive il marker prima di rimuovere il veto', () => {
  const src = readFileSync(fromRoot('scripts/ci/followup-drainer.mjs'), 'utf8');
  assert.match(src, /decideParentRearm\([\s\S]*?childStates/);
  assert.match(src, /parentRearmCommentBody\(\{/);
  assert.match(src, /remove: \[LBL_DECOMPOSED, 'agent:triaged', LBL_FIX, LBL_QUEUED\]/);
  assert.match(src, /triage-sweep/);
});

test('cablaggio: un padre non riaperto non paga le letture delle figlie del riarmo', () => {
  const src = readFileSync(fromRoot('scripts/ci/followup-drainer.mjs'), 'utf8');
  const start = src.indexOf('// --- PARENT-CLOSE:');
  const end = src.indexOf('// --- PRODUCTION-PROOF:', start);
  const block = src.slice(start, end);
  const guard = block.indexOf('if (reopenedAfterDecomposition(comments))');
  const childRead = block.indexOf('readParentRearmChildStates(kids)');
  assert.ok(guard >= 0);
  assert.ok(childRead > guard);
});
