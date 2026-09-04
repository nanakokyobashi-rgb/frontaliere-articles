/**
 * drain-decomposed-parent.test.mjs — il DRAIN non promuove i padri decomposti.
 *
 * Il difetto che chiude (#826, misurato su #786 il 2026-09-04): il pool del
 * DRAIN era l'unico stadio del drainer senza l'esclusione dello stadio
 * decompose che i quattro gemelli hanno (`isAgeOutCandidate`,
 * `isReparkableCandidate`, VERDICT-EXIT, `isDecomposeEligible`). Un padre
 * `decomposed:1` che rientrava in `agent:fix-queued` veniva promosso, il fixer
 * constatava che lo scope è tutto nelle figlie ed emetteva `overlap-skip` —
 * che è deliberatamente ri-tentabile (in generale l'overlap è transiente) —
 * quindi re-queue e di nuovo promozione: fino a `MAX_ATTEMPTS` run Claude per
 * padre, tutte con esito noto in partenza, su una quota condivisa col sito.
 *
 * L'overlap di un padre decomposto non è transiente: dura finché le figlie sono
 * aperte, e quando si chiudono è il PARENT-CLOSE a chiudere il padre senza
 * nessuna run del fixer. Questo test difende il predicato e — separatamente —
 * il fatto che il DRAIN lo usi davvero.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isDrainPromotable,
  isAgeOutCandidate,
  isReparkableCandidate,
  isDecomposeEligible,
} from '../../scripts/ci/followup-drainer.mjs';

const SRC = readFileSync(
  fileURLToPath(new URL('../../scripts/ci/followup-drainer.mjs', import.meta.url)),
  'utf8',
);

const iss = (...labels) => ({ labels: labels.map((name) => ({ name })) });

test('#826: un padre decomposed:1 non è promuovibile dal DRAIN', () => {
  assert.equal(isDrainPromotable(iss('agent:fix-queued', 'decomposed:1')), false);
  // …nemmeno con la priorità alta o il contatore dei tentativi addosso: è la
  // label a decidere, non l'ordinamento della coda.
  assert.equal(
    isDrainPromotable(iss('agent:fix-queued', 'decomposed:1', 'fu-prio:high', 'fu-attempt:2')),
    false,
  );
});

test('#826: lo stadio decompose e il park restano esclusi come nei gemelli', () => {
  for (const l of ['agent:decompose', 'agent:decompose-queued', 'fu-parked']) {
    assert.equal(isDrainPromotable(iss('agent:fix-queued', l)), false, l);
  }
});

test('#826: una follow-up normale resta promuovibile (nessun over-block)', () => {
  assert.equal(isDrainPromotable(iss('agent:fix-queued', 'follow-up')), true);
  assert.equal(isDrainPromotable(iss('agent:fix-queued', 'fu-prio:low', 'fu-attempt:1')), true);
  // Una FIGLIA della decomposizione è esattamente ciò che il DRAIN deve
  // promuovere: `from-decompose` non è `decomposed:1`.
  assert.equal(isDrainPromotable(iss('agent:fix-queued', 'from-decompose')), true);
  assert.equal(isDrainPromotable({}), true); // issue senza label → nessun blocco
});

test('#826: `decomposed:1` è escluso da TUTTI gli stadi, DRAIN incluso', () => {
  // L'invariante di classe: il difetto non era il singolo filtro mancante, era
  // che un solo stadio su cinque leggesse la label in modo diverso dagli altri.
  const parent = iss('decomposed:1');
  assert.equal(isDrainPromotable(parent), false);
  assert.equal(isReparkableCandidate(parent), false);
  assert.equal(isDecomposeEligible(parent), false);
  assert.equal(
    isAgeOutCandidate(
      { ...parent, createdAt: new Date(Date.now() - 90 * 86_400_000).toISOString() },
      { now: Date.now(), ageOutDays: 30 },
    ),
    false,
  );
});

test('#826: il pool del DRAIN passa dal predicato, non da un filtro parafrasato', () => {
  // Un predicato esportato che nessuno chiama sarebbe verde qui e rotto in
  // produzione: si pretende il call-site.
  assert.match(SRC, /\.filter\(isDrainPromotable\)/);
  // E nessuna coda ordinata per promozione (`prioRank`) deve restare filtrata
  // dal solo `!has(i, LBL_PARKED)`: era la forma esatta del bug. Lo scan del
  // beacon di quota usa la stessa `listIssues(LBL_QUEUED).filter(!parked)` ma
  // ordina per `updatedAt` e NON promuove nulla — deve restare com'è, perché il
  // beacon può stare proprio su un padre decomposto.
  assert.doesNotMatch(
    SRC,
    /listIssues\(LBL_QUEUED\)\s*\n\s*\.filter\(\(i\) => !has\(i, LBL_PARKED\)\)\s*\n\s*\.sort\(\(a, b\) => prioRank/,
  );
});

test('#826: le due porte di rientro parkano il padre invece di ri-accodarlo', () => {
  // Il rescue di `agent:fix` (ZERO_WORK + orfano) rimetteva in coda senza
  // guardare la label: senza questo ramo il padre farebbe ping-pong fra
  // `agent:fix-queued` e `fu-parked` a ogni tick.
  assert.match(SRC, /has\(iss, LBL_DECOMPOSED\) && quotaBackoffUntil === null/);
});
