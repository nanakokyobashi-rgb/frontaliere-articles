import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectClaudeRateLimit } from '../../scripts/ci/claude-rate-limit.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIX_OUTCOME_RE } from '../../scripts/ci/close-recovered-failure-issues.mjs';
import {
  CAP_HIT_AFTER_DELIVERY_MARKER,
  formatDeliveredDespiteMaxTurnsComment,
  hasCapHitAfterDeliveryNote,
} from '../../scripts/ci/mark-claude-terminal-outcome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readRoot = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('detectClaudeRateLimit', () => {
  it('non confonde overage rifiutato con quota primaria esaurita quando status è allowed', () => {
    const raw = JSON.stringify([
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          rateLimitType: 'five_hour',
          resetsAt: Math.floor(Date.now() / 1000) + 5 * 60 * 60,
          overageStatus: 'rejected',
          overageDisabledReason: 'out_of_credits',
          isUsingOverage: false,
        },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 38,
        total_cost_usd: 0.6,
        api_error_status: null,
      },
    ]);

    assert.deepEqual(detectClaudeRateLimit(raw), {
      rateLimited: false,
      resetsAt: null,
      rateLimitType: null,
    });
  });

  it('continua a riconoscere il rifiuto della quota primaria', () => {
    const resetSeconds = Math.floor(Date.now() / 1000) + 5 * 60 * 60;
    const raw = JSON.stringify([
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          rateLimitType: 'five_hour',
          resetsAt: resetSeconds,
          overageStatus: 'allowed',
        },
      },
    ]);

    assert.deepEqual(detectClaudeRateLimit(raw), {
      rateLimited: true,
      resetsAt: resetSeconds,
      rateLimitType: 'five_hour',
    });
  });
});

// Morte al cap DOPO la consegna: il verdetto segue il lavoro, non l'exit della CLI.
// Su 124 issue con marker `max-turns` in 5 giorni (sito, 2026-09-05) 74 avevano una PR
// e tutte e 74 erano MERGED. Il marker sbagliato non e' cosmetico: `max-turns` sta in
// `PREPASS_VERDICT_BEATS_FAMILY` del drainer e manda la issue in `needs-human`.
describe('marker della consegna nonostante error_max_turns', () => {
  it('e\' `pr-created` e porta il numero della PR', () => {
    const body = formatDeliveredDespiteMaxTurnsComment(7441);
    assert.ok(body.includes('<!-- FIX_OUTCOME: pr-created -->'));
    assert.ok(body.includes('#7441'));
    assert.ok(!body.includes('<!-- FIX_OUTCOME: max-turns -->'));
  });

  it('non contiene BACKSTOP_MARKER, altrimenti il drainer lo scarta', () => {
    // `latestFixOutcomeFromComments` salta i commenti con 'post-step deterministico':
    // un marker che la contenesse sarebbe invisibile e la issue tornerebbe
    // «run morta, ri-tentabile».
    assert.ok(!formatDeliveredDespiteMaxTurnsComment(1).includes('post-step deterministico'));
  });
});

// #925: senza marker il fenomeno «morte al cap DOPO la consegna» smette di essere
// contabile. Prima del ramo di consegna queste run finivano nel bucket `max-turns`,
// quindi chi ne misura la quota vedrebbe il calo per costruzione — non perche' il
// fenomeno sia cambiato — e proprio la misura post-merge che il body di #899 rimanda
// resterebbe senza strumento.
describe('CAP_HIT_AFTER_DELIVERY: il fenomeno resta osservabile', () => {
  it('il commento porta il marker informativo accanto al verdetto', () => {
    const body = formatDeliveredDespiteMaxTurnsComment(7441);
    assert.ok(body.includes(CAP_HIT_AFTER_DELIVERY_MARKER));
  });

  it('il marker NON e\' un FIX_OUTCOME: il verdetto letto dal drainer resta `pr-created`', () => {
    // Se fosse un FIX_OUTCOME entrerebbe in `PREPASS_VERDICT_BEATS_FAMILY` come
    // codice sconosciuto e cambierebbe l'instradamento invece di annotarlo.
    assert.ok(!/FIX_OUTCOME/i.test(CAP_HIT_AFTER_DELIVERY_MARKER));
    const m = FIX_OUTCOME_RE.exec(formatDeliveredDespiteMaxTurnsComment(7441));
    assert.equal(m && m[1], 'pr-created');
  });
});

// #925: il drainer ri-accoda fino a tre volte, e un commento di bot ripetuto alza
// `updatedAt` — che e' esattamente cio' che affama il cooldown del parked-retry.
// Stessa ragione di `ORPHAN_NOTE_MARKER` in `orphan-max-turns-work.mjs`.
describe('dedup della nota di consegna', () => {
  it('riconosce la nota gia\' presente, come stringa o come commento', () => {
    const body = formatDeliveredDespiteMaxTurnsComment(7441);
    assert.equal(hasCapHitAfterDeliveryNote([body]), true);
    assert.equal(hasCapHitAfterDeliveryNote([{ body }]), true);
  });

  it('non confonde un `pr-created` qualsiasi con la nota di questo step', () => {
    // Il `pr-created` postato dall'agente non dice «sono morto al cap dopo aver
    // consegnato»: deduparci sopra perderebbe proprio il dato da misurare.
    assert.equal(hasCapHitAfterDeliveryNote(['<!-- FIX_OUTCOME: pr-created -->\nPR aperta.']), false);
    assert.equal(hasCapHitAfterDeliveryNote([]), false);
    assert.equal(hasCapHitAfterDeliveryNote(null), false);
  });
});

// #925: `.[0]` su una lista di PR che mescola OPEN e MERGED prende un elemento in un
// ordine che `gh` non documenta. Con un branch `fix/issue-<N>` riusato dopo un merge —
// il caso normale su una issue ri-accodata — il numero mostrato all'umano e' quello
// della PR vecchia. Il predicato vive in due posti (script + YAML) e non possono
// importarsi: il legame va tenuto da un test (AGENTS.md #6).
describe('selezione della PR consegnata: la piu\' recente, non la prima', () => {
  const SORTED = 'sort_by(.createdAt) | last | .number // empty';

  it('lo script ordina per createdAt e non usa piu\' `.[0].number`', () => {
    const src = readRoot('scripts/ci/mark-claude-terminal-outcome.mjs');
    assert.ok(src.includes(SORTED));
    assert.ok(!src.includes('.[0].number'));
  });

  it('issue-fix.yml usa lo stesso predicato del gemello in JS', () => {
    const yml = readRoot('.github/workflows/issue-fix.yml');
    assert.ok(yml.includes(SORTED));
    assert.ok(!yml.includes('fix/issue-$ISSUE" --state all --json number,state \\'));
    assert.ok(!/fix\/issue-\$ISSUE[\s\S]{0,200}?\.\[0\]\.number/.test(yml));
  });
});
