/**
 * anchor-needle-regex-escape.test.mjs — regressione per issue #467
 * (follow-up di #444: "anchorNeedle regex non escaped in org/pct").
 *
 * `anchorNeedle`, in `article-factuality-gates.mjs`, costruisce una RegExp a
 * partire dal valore di un'ancora estratta dal testo sorgente. Due difetti,
 * stessa causa (nessun escaping prima di interpolare in una RegExp):
 *
 *  - kind `org`: un valore con un metacarattere regex (es. un acronimo con un
 *    punto, "S.p.A") altera il match invece di essere letto alla lettera. Il
 *    path e' eseguito due volte per ogni ancora (`findAnchorSentence` e
 *    `truncateForPrompt`, condivise da `anchorEvidence`), e di nuovo nel
 *    twin `matchedAnchors` (usato per il recall check).
 *  - kind `pct`: `value.replace('.', '[.,]')` sostituisce SOLO il primo
 *    punto — un'ancora percentuale con piu' di un punto decimale (a monte
 *    non validata) produce un needle che non copre oltre il primo punto.
 *
 * `anchorNeedle` non e' esportata: la si osserva attraverso `anchorEvidence`
 * (che la usa per `findAnchorSentence` + `truncateForPrompt`) e attraverso
 * `matchedAnchors`, il gemello che ha lo stesso difetto sul ramo `org`.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { anchorEvidence, matchedAnchors } from '../scripts/lib/article-factuality-gates.mjs';

describe('anchorNeedle — org: metacaratteri regex nel valore', () => {
  it('localizza la frase quando il valore contiene un punto letterale', () => {
    const src = 'La societa S.p.A svizzera ha risposto alla richiesta.';
    assert.equal(anchorEvidence(src, 'org:S.p.A'), src);
  });

  it('non lancia e localizza la frase con un metacarattere regex diverso dal punto', () => {
    const src = 'Il gruppo C++ Foundation ha pubblicato lo standard.';
    assert.doesNotThrow(() => anchorEvidence(src, 'org:C++ Foundation'));
    assert.equal(anchorEvidence(src, 'org:C++ Foundation'), src);
  });

  it('matchedAnchors (il gemello di anchorNeedle) accredita lo stesso valore con un punto', () => {
    const src = 'La societa S.p.A svizzera ha risposto alla richiesta.';
    const found = matchedAnchors(src, new Set(['org:S.p.A']));
    assert.ok(found.has('org:S.p.A'));
  });
});

describe('anchorNeedle — pct: piu di un punto decimale nel valore', () => {
  it('copre anche il secondo punto, non solo il primo', () => {
    const src = 'Il tasso applicato e del 1.2.3% secondo la fonte.';
    assert.equal(anchorEvidence(src, 'pct:1.2.3'), src);
  });

  it('riconosce la forma con virgola su entrambi i punti', () => {
    const src = 'Il tasso applicato e del 1,2,3% secondo la fonte.';
    assert.equal(anchorEvidence(src, 'pct:1.2.3'), src);
  });
});
