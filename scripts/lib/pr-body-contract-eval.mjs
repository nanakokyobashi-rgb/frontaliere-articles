/**
 * pr-body-contract-eval.mjs — il verdetto BLOCCANTE del contratto del body,
 * senza rete ne' commenti. Sorgente unica per chi lo decide:
 *  - `scripts/ci/pr-body-contract.mjs` (lo step `body_contract` di tests.yml),
 *  - `.github/workflows/retry-code-check-after-body-edit.yml`, che dopo un edit
 *    su una run gia' verde rilancia la run SOLO se il body nuovo viola il
 *    contratto (tests.yml non ascolta piu' `edited`).
 * I path citati (`pr-body-filepath-check.mjs`) restano fuori: sono avvisi.
 */
import { checkPrBodySections } from './pr-body-sections-check.mjs';
import { checkClosesLines } from './pr-body-closes-check.mjs';
import { checkNextStepStates, blockingNextStepFindings } from './pr-body-nextstep-check.mjs';

export function evaluateBodyContract(body) {
  const sections = checkPrBodySections(body);
  const closes = checkClosesLines(body);
  const nextStep = checkNextStepStates(body);
  const nextStepProblems = blockingNextStepFindings(nextStep);
  const blocking = sections.violations.length + closes.violations.length + nextStepProblems.length;
  return { sections, closes, nextStep, nextStepProblems, blocking };
}
