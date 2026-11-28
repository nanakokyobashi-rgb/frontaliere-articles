import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_FACTCHECK_ROUND_MS,
  planFactCheckRounds,
  remainingFactCheckRounds,
} from '../scripts/lib/fact-check-round-plan.mjs';

// Run 46096712400 (28/11, frontaliere): second fact-check opened with about
// 7 minutes left. The old plan cut it into 3 rounds of ~125 s; Codex needs
// 90-230 s, so every round ended at its deadline ("hard cap 100s") and the
// article was discarded.
const SEVEN_MIN = 420_000;

test('con Codex tra i verificatori una finestra di 7 minuti e un solo giro con tutto il tempo', () => {
  const plan = planFactCheckRounds(SEVEN_MIN, { codexVerifier: true });
  assert.equal(plan.maxPrimaryRounds, 1);
  const remaining = SEVEN_MIN - plan.finalReserveMs;
  const rounds = remainingFactCheckRounds(remaining, plan.maxPrimaryRounds, plan.minRoundMs);
  assert.equal(rounds, 1);
  assert.ok(Math.floor(remaining / rounds) >= CODEX_FACTCHECK_ROUND_MS, 'il giro deve durare piu\' di un fact-check Codex');
});

test('senza Codex il piano resta quello a giri da 15 s', () => {
  const plan = planFactCheckRounds(SEVEN_MIN, { codexVerifier: false });
  assert.equal(plan.maxPrimaryRounds, 3);
  assert.equal(plan.minRoundMs, 15_000);
});

test('ogni giro con Codex dura almeno la soglia, anche con finestre larghe', () => {
  for (const windowMs of [60_000, 120_000, 300_000, 480_000, 720_000, 1_500_000]) {
    const plan = planFactCheckRounds(windowMs, { codexVerifier: true });
    assert.ok(plan.maxPrimaryRounds >= 1 && plan.maxPrimaryRounds <= 3);
    const usable = windowMs - plan.finalReserveMs;
    if (plan.maxPrimaryRounds > 1) {
      assert.ok(usable / plan.maxPrimaryRounds >= CODEX_FACTCHECK_ROUND_MS, `finestra ${windowMs}`);
    }
  }
  assert.equal(planFactCheckRounds(720_000, { codexVerifier: true }).maxPrimaryRounds, 2);
  assert.equal(planFactCheckRounds(1_500_000, { codexVerifier: true }).maxPrimaryRounds, 3);
});

test('finestra vuota o non finita: un giro, nessuna riserva', () => {
  for (const bad of [0, -5, NaN, undefined]) {
    const plan = planFactCheckRounds(bad, { codexVerifier: true });
    assert.equal(plan.maxPrimaryRounds, 1);
    assert.equal(plan.finalReserveMs, 0);
  }
});
