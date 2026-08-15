#!/usr/bin/env node
/**
 * pr-body-contract.mjs — gate deterministico sul body delle PR.
 *
 * Verifica quattro cose:
 *   1. `## Implementato` e `## Non implementato (ancora)` presenti con
 *      l'header LETTERALE, e con contenuto sostanziale — non i `- ` vuoti che
 *      il template lascia (`pr-body-sections-check.mjs`, condiviso col sito).
 *   2. Nessun `Closes #a #b` sulla stessa riga (`pr-body-closes-check.mjs`,
 *      condiviso col sito): GitHub chiude SOLO la prima issue dopo la keyword,
 *      quindi le altre restano aperte in silenzio.
 *   3. Nessuna voce di `## Non implementato (ancora)` che rimandi il lavoro con
 *      una scappatoia al posto di uno stato (`pr-body-nextstep-check.mjs`).
 *      E' il difetto dell'escalation #140: la sezione c'era, non era vuota, e
 *      il contratto restava disatteso lo stesso — perche' cio' che il gate
 *      misurava era la PRESENZA, e cio' che REVIEW.md §98 chiede e' un PIANO.
 *   4. Nessun path citato fra backtick che in questo repo non esista
 *      (`pr-body-filepath-check.mjs`, AVVISO non bloccante). E' il secondo giro
 *      di #140: i tre check sopra guardano tutti la FORMA, e un body puo' essere
 *      di forma perfetta e citare file che qui non ci sono — e' successo sulla
 *      #358, dove a trovarlo e' stato il reviewer, spendendo un ciclo. Perche'
 *      avvisi e non errore: la misura su 45 PR mergiate sta nel docblock del
 *      modulo, e dice che in nessun caso il path era inventato.
 *
 * ## Perché un gate e non solo la review
 *
 * Il reviewer Claude segnala già la violazione come 🔴 process, ma lo fa
 * spendendo un ciclo di review — cioè quota condivisa col sito — per dire una
 * cosa che una regex sa. Rilevarla qui sposta il triage a sinistra: il fixer
 * (o chi apre la PR) la vede subito e la corregge prima che qualcuno paghi una
 * review per scoprirlo.
 *
 * ## Corpus-only, e perché
 *
 * Il `pr-body-contract.yml` del sito è molto più grande: incorpora una decina
 * di check specifici del suo dominio (CLS degli slot AdSense, lookbehind lato
 * client, pattern dei sibling...) che qui non hanno senso. Questo è il
 * sottoinsieme generico — le due verifiche sul contratto del body — costruito
 * sopra gli stessi due moduli condivisi, che restano `identical` e sorvegliati.
 *
 * Uso: node scripts/ci/pr-body-contract.mjs <pr-number>
 * Env: GH_TOKEN, GITHUB_REPOSITORY.
 */

import { execFileSync } from 'node:child_process';
import { checkPrBodySections } from '../lib/pr-body-sections-check.mjs';
import { checkClosesLines } from '../lib/pr-body-closes-check.mjs';
import { checkNextStepStates, suggestedSection } from '../lib/pr-body-nextstep-check.mjs';
import { checkCitedFilePaths } from '../lib/pr-body-filepath-check.mjs';

const PR = process.argv[2];
const REPO = process.env.GITHUB_REPOSITORY || '';
const MARKER = '<!-- pr-body-contract -->';

function gh(args, fallback = '') {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    console.warn(`[pr-body-contract] gh ${args.slice(0, 2).join(' ')} fallito: ${String(e.message).slice(0, 120)}`);
    return fallback;
  }
}

/** Commento sticky: aggiorna quello esistente invece di accumularne uno per push. */
function upsertComment(body) {
  const raw = gh(['api', `repos/${REPO}/issues/${PR}/comments`, '--paginate', '--jq',
    `[.[] | select(.body // "" | contains("${MARKER}"))] | last | .id // empty`]);
  if (raw) {
    gh(['api', '-X', 'PATCH', `repos/${REPO}/issues/comments/${raw}`, '-f', `body=${body}`]);
    console.log(`[pr-body-contract] commento sticky aggiornato (id=${raw}).`);
  } else {
    gh(['pr', 'comment', PR, '--repo', REPO, '--body', body]);
    console.log('[pr-body-contract] commento sticky creato.');
  }
}

function main() {
  if (!PR || !REPO) {
    console.error('[pr-body-contract] servono <pr-number> e GITHUB_REPOSITORY — esco senza bloccare.');
    return 0;
  }

  const body = gh(['pr', 'view', PR, '--repo', REPO, '--json', 'body', '--jq', '.body // ""']);
  const sections = checkPrBodySections(body);
  const closes = checkClosesLines(body);
  const nextStep = checkNextStepStates(body);

  // I file toccati dalla PR contano come esistenti anche quando l'albero non li
  // ha. Il checkout di `pull_request` e' il MERGE REF, quindi cio' che la PR
  // AGGIUNGE c'e' gia' — questa lista serve per l'altra meta': un file che la PR
  // RIMUOVE, e che il body nomina proprio per dire che l'ha rimosso. `--jq` su
  // lista vuota o `gh` fallito torna '', e allora la lista e' vuota: il modulo
  // degrada a «solo l'albero», mai a un errore.
  const touched = gh(['api', `repos/${REPO}/pulls/${PR}/files`, '--paginate', '--jq', '.[].filename'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const filePaths = checkCitedFilePaths(body, { extraExisting: touched });

  const problems = [
    ...sections.violations.map((v) => `- ${v.message}`),
    // `v.message` quando c'e', altrimenti il messaggio storico. Il modulo
    // `pr-body-closes-check.mjs` e' `identical` col sito e li' sta arrivando un
    // secondo tipo di violazione (le pseudo-keyword di chiusura: `Chiude #133`
    // non chiude niente, GitHub riconosce solo close/fix/resolve). Quando quel
    // file scendera' qui, questo runner lo rendera' gia' col messaggio giusto
    // invece di descrivere ogni violazione come se fosse un multi-ref.
    ...closes.violations.map((v) =>
      v.message
        ? `- Riga ${v.line}: ${v.message}`
        : `- Riga ${v.line}: \`${v.text}\` chiude **solo ${v.refs[0]}** — GitHub ignora i riferimenti successivi sulla stessa riga. Usa una keyword per issue, una per riga.`,
    ),
    ...nextStep.violations.map((v) => `- ${v.message}`),
  ];

  // Gli avvisi non fanno fallire: vedi la tabella di misura in
  // `pr-body-nextstep-check.mjs`. Pretendere la forma letterale su OGNI voce
  // boccerebbe 34 PR su 40 fra quelle che il reviewer ha approvato — un gate
  // con quel tasso lo si spegne, non lo si rispetta.
  //
  // Stessa politica, stessa ragione, per i path citati (#140, secondo giro): il
  // modulo trova le citazioni che non risolvono qui, ma su 45 PR mergiate ZERO
  // erano path inventati — sette su otto esistevano sul sito. Bloccare su quel
  // profilo fermerebbe 6 PR su 45 senza un difetto vero. Vedi la misura completa
  // nel docblock di `pr-body-filepath-check.mjs`.
  const advisories = [
    ...nextStep.advisories.map((a) => `- ${a.message}`),
    ...filePaths.violations.map((v) => `- ${v.message}`),
  ];

  if (!problems.length && !advisories.length) {
    console.log('[pr-body-contract] contratto del body rispettato ✔');
    // Se c'era una violazione ora risolta, il commento sticky resta ma dice il
    // vero: aggiornarlo evita di lasciare un allarme spento acceso.
    const existing = gh(['api', `repos/${REPO}/issues/${PR}/comments`, '--paginate', '--jq',
      `[.[] | select(.body // "" | contains("${MARKER}"))] | length`], '0');
    if (existing !== '0') {
      upsertComment(`${MARKER}\n✅ **Contratto del body rispettato.** Le sezioni richieste ci sono e hanno contenuto.`);
    }
    return 0;
  }

  // La sezione gia' riscritta, quando c'e' qualcosa da riscrivere. E' la parte
  // che distingue un gate da un allarme: dire «manca lo stato» lascia comunque
  // addosso il lavoro di capire dove e come, e la regola era gia' scritta in
  // REVIEW.md — a ricorrere non era l'ignoranza della regola, era il costo di
  // applicarla. Qui la correzione si incolla.
  const suggestion = suggestedSection(body);

  const comment = [
    MARKER,
    problems.length
      ? '🔴 **Il body di questa PR non rispetta il contratto** (`REVIEW.md` → Completeness contract).'
      : '🟡 **Il body rispetta il contratto**, ma il piano di completamento si può stringere.',
    '',
    ...(problems.length ? ['**Da correggere:**', '', ...problems, ''] : []),
    ...(advisories.length ? ['**Avvisi** (non bloccano il check):', '', ...advisories, ''] : []),
    ...(suggestion
      ? ['<details><summary>Sezione già riscritta — da incollare</summary>', '', '```markdown', suggestion, '```', '', '</details>', '']
      : []),
    'Forma attesa:',
    '',
    '```markdown',
    '## Implementato',
    '- <cosa fa la PR>',
    '',
    '## Non implementato (ancora)',
    '- <scope ancora dovuto>. **Stato:** `in questa PR` | `PR concatenata #N` | `blocked: <causa>`',
    '```',
    '',
    'oppure «Nessuno» in `## Non implementato (ancora)` se il task è completo.',
    '',
    '_Gate deterministico, zero Claude: intercettarlo qui evita di spendere un ciclo di review — cioè quota condivisa col sito — per dire una cosa che una regex sa._',
  ].join('\n');

  upsertComment(comment);
  if (!problems.length) {
    console.log(`[pr-body-contract] contratto rispettato; ${advisories.length} avvisi non bloccanti.`);
    return 0;
  }
  console.error(`::error::Contratto del body violato (${problems.length} problemi) — vedi il commento sulla PR #${PR}.`);
  return 1;
}

try {
  process.exit(main());
} catch (e) {
  // PROCEED-SAFE: un gate rotto non deve bloccare le PR. Al massimo si torna
  // al comportamento precedente, in cui la violazione la trovava il reviewer.
  console.error(`[pr-body-contract] errore non fatale: ${e && e.stack ? e.stack : e}`);
  process.exit(0);
}
