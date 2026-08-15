/**
 * ── IL TIER CHE NON VENIVA MAI RAGGIUNTO (issue #379, passo 2) ──────────────
 *
 * `claude-cli/haiku` e' gia' tier-0 (`AI_COMPETING_TIERS`, dal 2026-07-29): il
 * suo TIER compete su score reale contro ogni modello normale invece di
 * affondare in coda per costruzione. Ma competere non e' vincere: ogni
 * modello mai provato parte con score 0, e a parita' di score e di tier
 * `sortChainByScore` sceglie in base all'INDICE originale nella catena —
 * `claude-cli/haiku` sta in fondo a `DEFAULT_CHAIN` (~180 modelli prima di
 * lui), quindi perdeva ogni pareggio. Misurato vuoto nella run 31690534255:
 * «46 modelli free esauriti, claude-cli not reached this run, 0 skip» — il
 * giro della catena non ci arrivava proprio.
 *
 * `AI_MODELS_PREFER` sposta gli id elencati in TESTA alla catena, in ordine,
 * SENZA troncare il resto — a differenza di `AI_MODELS_FORCE_CHAIN`, che
 * riduce la catena ai soli id elencati. Applicato PRIMA di
 * `sortChainByScore()`, cambia solo l'indice di pareggio: tier e score
 * continuano a decidere per primi, quindi un modello preferito ma
 * genuinamente affondato (score negativo da fallimenti reali) affonda
 * comunque sotto uno con score migliore.
 *
 * Il default (`DEFAULT_MODELS_PREFER`) include gia' `claude-cli/haiku` — e'
 * la decisione del proprietario ("porta Haiku al primo livello") applicata,
 * non solo resa possibile da un knob mai usato.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  AI_MODELS,
  DEFAULT_CHAIN,
  DEFAULT_MODELS_PREFER,
  applyModelsPrefer,
} from '../scripts/lib/ai-models.mjs';

describe('AI_MODELS_PREFER — riordina senza troncare', () => {
  it('default: claude-cli/haiku e\' nella lista dei preferiti', () => {
    assert.ok(
      DEFAULT_MODELS_PREFER.includes(AI_MODELS.CLAUDE_CLI_HAIKU),
      'il default deve promuovere claude-cli/haiku, altrimenti il tier resta irraggiungibile per pareggio',
    );
  });

  it('senza env: claude-cli/haiku finisce in testa alla catena reale', () => {
    const chain = applyModelsPrefer([...DEFAULT_CHAIN]);
    assert.equal(chain[0], AI_MODELS.CLAUDE_CLI_HAIKU);
    // Niente troncamento: tutti gli altri modelli restano, stesso conteggio.
    assert.equal(chain.length, DEFAULT_CHAIN.length);
    assert.deepEqual([...chain].sort(), [...DEFAULT_CHAIN].sort());
  });

  it('riordina senza troncare: nessun modello sparisce e nessuno si duplica', () => {
    const chain = ['a', 'b', 'c', 'd', 'e'];
    const orig = process.env.AI_MODELS_PREFER;
    process.env.AI_MODELS_PREFER = 'd,b';
    try {
      const out = applyModelsPrefer(chain);
      assert.deepEqual(out, ['d', 'b', 'a', 'c', 'e']);
      assert.equal(out.length, chain.length);
      assert.deepEqual([...out].sort(), [...chain].sort());
    } finally {
      if (orig === undefined) delete process.env.AI_MODELS_PREFER;
      else process.env.AI_MODELS_PREFER = orig;
    }
  });

  it('stringa vuota esplicita ("") e\' la leva di rollback: nessuna preferenza', () => {
    const chain = ['a', 'b', 'c'];
    const orig = process.env.AI_MODELS_PREFER;
    process.env.AI_MODELS_PREFER = '';
    try {
      assert.deepEqual(applyModelsPrefer(chain), chain);
    } finally {
      if (orig === undefined) delete process.env.AI_MODELS_PREFER;
      else process.env.AI_MODELS_PREFER = orig;
    }
  });

  it('id preferito assente dalla catena viene ignorato, non inventato', () => {
    const chain = ['a', 'b', 'c'];
    const orig = process.env.AI_MODELS_PREFER;
    process.env.AI_MODELS_PREFER = 'not-in-chain,b';
    try {
      assert.deepEqual(applyModelsPrefer(chain), ['b', 'a', 'c']);
    } finally {
      if (orig === undefined) delete process.env.AI_MODELS_PREFER;
      else process.env.AI_MODELS_PREFER = orig;
    }
  });

  it('env non impostata: usa il default (claude-cli/haiku in testa)', () => {
    const chain = ['x', 'y', AI_MODELS.CLAUDE_CLI_HAIKU, 'z'];
    const orig = process.env.AI_MODELS_PREFER;
    delete process.env.AI_MODELS_PREFER;
    try {
      assert.deepEqual(applyModelsPrefer(chain), [AI_MODELS.CLAUDE_CLI_HAIKU, 'x', 'y', 'z']);
    } finally {
      if (orig === undefined) delete process.env.AI_MODELS_PREFER;
      else process.env.AI_MODELS_PREFER = orig;
    }
  });
});
