/**
 * stale-claim-detector.test.mjs — la selezione dei lock `agent:in-progress`
 * appesi, e soprattutto i casi in cui NON si deve toccare niente.
 *
 * Il difetto coperto: `agent:in-progress` è un lock di mutua esclusione, non
 * uno stato. Appeso su una issue aperta la esclude dal fixer per sempre e in
 * silenzio (osservato sulla #4248 del sito, `priority:high`).
 *
 * La metà più importante di questi test è però l'errore OPPOSTO: finché una PR
 * è in volo il claim è corretto, e rilasciarlo fa partire un secondo fixer in
 * parallelo — cioè ricrea la collisione #4788/#4793 che il lock esiste per
 * impedire, causandola noi. I due errori non costano uguale, e la selezione è
 * tarata di conseguenza.
 *
 * `nowMs` è iniettato: una soglia temporale testata contro l'orologio reale è
 * un test che cambia risposta a seconda di quando gira.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectStaleClaims,
  referencedIssueNumbers,
  DEFAULT_STALE_CLAIM_HOURS,
} from '../../scripts/ci/stale-claim-detector.mjs';

const NOW = Date.parse('2026-08-08T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const CLAIM = [{ name: 'agent:in-progress' }];
const nums = (xs) => xs.map((x) => x.number);

test('un claim vecchio senza PR aperta è stale', () => {
  const issues = [{ number: 4248, labels: CLAIM, updatedAt: hoursAgo(30) }];
  assert.deepEqual(nums(selectStaleClaims(issues, new Set(), NOW)), [4248]);
});

test('un claim vecchio CON una PR aperta NON è stale — è la trappola del punto 6', () => {
  // Toglierlo qui farebbe partire un secondo fixer in parallelo sulla stessa
  // issue: la collisione #4788/#4793, causata dal detector che dovrebbe
  // prevenirla.
  const issues = [{ number: 4248, labels: CLAIM, updatedAt: hoursAgo(500) }];
  assert.deepEqual(nums(selectStaleClaims(issues, new Set([4248]), NOW)), []);
});

test('un claim recente non è stale, per quanto non abbia PR', () => {
  const issues = [{ number: 4248, labels: CLAIM, updatedAt: hoursAgo(2) }];
  assert.deepEqual(nums(selectStaleClaims(issues, new Set(), NOW)), []);
});

test('una issue senza il claim non viene mai toccata', () => {
  const issues = [{ number: 10, labels: [{ name: 'agent:fix' }], updatedAt: hoursAgo(900) }];
  assert.deepEqual(nums(selectStaleClaims(issues, new Set(), NOW)), []);
});

test('updatedAt assente o illeggibile → NON stale (in dubbio si tace)', () => {
  const issues = [
    { number: 1, labels: CLAIM },
    { number: 2, labels: CLAIM, updatedAt: 'boh' },
    { number: 3, labels: CLAIM, updatedAt: null },
  ];
  assert.deepEqual(nums(selectStaleClaims(issues, new Set(), NOW)), []);
});

test('entry malformate non fanno esplodere lo scan', () => {
  const issues = [
    null,
    { labels: CLAIM, updatedAt: hoursAgo(30) },
    { number: 'x', labels: CLAIM, updatedAt: hoursAgo(30) },
    { number: 9, labels: CLAIM, updatedAt: hoursAgo(30) },
  ];
  assert.deepEqual(nums(selectStaleClaims(issues, new Set(), NOW)), [9]);
});

test('input non-array o vuoto → []', () => {
  assert.deepEqual(selectStaleClaims(undefined, new Set(), NOW), []);
  assert.deepEqual(selectStaleClaims([], new Set(), NOW), []);
});

test('la soglia è configurabile e il default è 12h (2× il timeout di issue-fix)', () => {
  assert.equal(DEFAULT_STALE_CLAIM_HOURS, 12);
  const iss = { number: 7, labels: CLAIM, updatedAt: hoursAgo(8) };
  assert.deepEqual(nums(selectStaleClaims([iss], new Set(), NOW)), [], '8h < 12h di default');
  assert.deepEqual(nums(selectStaleClaims([iss], new Set(), NOW, 6)), [7], 'con soglia 6h rientra');
});

test('il confine della soglia non è inclusivo: esattamente 12h non è ancora stale', () => {
  const iss = { number: 7, labels: CLAIM, updatedAt: hoursAgo(12) };
  assert.deepEqual(nums(selectStaleClaims([iss], new Set(), NOW)), []);
  const older = { number: 8, labels: CLAIM, updatedAt: hoursAgo(12.1) };
  assert.deepEqual(nums(selectStaleClaims([older], new Set(), NOW)), [8]);
});

test('referenced accetta anche un array, non solo un Set', () => {
  const issues = [{ number: 42, labels: CLAIM, updatedAt: hoursAgo(99) }];
  assert.deepEqual(nums(selectStaleClaims(issues, [42], NOW)), []);
});

test('sceglie solo gli stale da un elenco misto', () => {
  const issues = [
    { number: 1, labels: CLAIM, updatedAt: hoursAgo(99) },                       // ← stale
    { number: 2, labels: CLAIM, updatedAt: hoursAgo(99) },                       // PR aperta
    { number: 3, labels: CLAIM, updatedAt: hoursAgo(1) },                        // recente
    { number: 4, labels: [{ name: 'agent:fix' }], updatedAt: hoursAgo(99) },     // niente claim
  ];
  assert.deepEqual(nums(selectStaleClaims(issues, new Set([2]), NOW)), [1]);
});

// ── referencedIssueNumbers: i tre canali con cui una PR dice "sto su #N" ──────

test('il branch deterministico fix/issue-N è riconosciuto', () => {
  assert.deepEqual([...referencedIssueNumbers([{ headRefName: 'fix/issue-4248' }])], [4248]);
});

test('(#N) nel titolo è riconosciuto', () => {
  assert.deepEqual([...referencedIssueNumbers([{ title: 'Qualcosa di utile (#1234)' }])], [1234]);
});

test('Closes/Fixes/Resolves #N nel body sono riconosciuti, in ogni forma e caso', () => {
  const prs = [{ body: 'Closes #1\nfixes #2\nRESOLVED: #3\nFixed #4' }];
  assert.deepEqual([...referencedIssueNumbers(prs)].sort((a, b) => a - b), [1, 2, 3, 4]);
});

test('un branch che somiglia ma non combacia NON conta', () => {
  // `fix/issue-4248-bis` non è il nome deterministico di issue-fix. Non
  // riconoscerlo è il verso sbagliato dell'errore, quindi vale la pena saperlo:
  // il titolo o il body lo recuperano se la PR è davvero legata alla issue.
  assert.deepEqual([...referencedIssueNumbers([{ headRefName: 'fix/issue-4248-bis' }])], []);
});

test('una PR che non nomina nessuna issue non ne protegge nessuna', () => {
  const prs = [{ headRefName: 'chore/pulizia', title: 'Pulizia', body: 'Vedi #99 per contesto' }];
  // `#99` senza keyword di chiusura è un cross-ref, non un "sto lavorando qui".
  assert.deepEqual([...referencedIssueNumbers(prs)], []);
});

test('più canali sulla stessa PR convergono senza duplicare', () => {
  const prs = [{ headRefName: 'fix/issue-5', title: 'Roba (#5)', body: 'Closes #5' }];
  assert.deepEqual([...referencedIssueNumbers(prs)], [5]);
});

test('input non-array o entry nulle → Set vuoto, niente eccezioni', () => {
  assert.equal(referencedIssueNumbers(undefined).size, 0);
  assert.equal(referencedIssueNumbers([null, undefined]).size, 0);
});
