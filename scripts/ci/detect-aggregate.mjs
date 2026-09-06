#!/usr/bin/env node
/**
 * detect-aggregate.mjs — la QUARTA copia del rilevatore di aggregati, rimossa
 * (item 7 di #868).
 *
 * `issue-fix.yml` decide con `is_aggregate` se dare al fixer il circuit-breaker
 * "fixa UN item e deferisci il resto" e l'eccezione `Refs #N` al posto di
 * `Closes #N`. Fino a qui quella decisione la prendeva una riga di shell nel
 * workflow:
 *
 *   agg_count=$(grep -cE '^[[:space:]]*[-*][[:space:]]+' <<< "$body")
 *   [ "$agg_count" -ge 4 ] && is_agg=true
 *
 * cioe' bullet top-level, soglia 4 — mentre i tre rilevatori fratelli in Node
 * (`check-issue-already-resolved.mjs`, `reconcile-followups.mjs`,
 * `harvest-agent-lessons.mjs`, tenuti identici da
 * `generator/tests/aggregate-detectors-agree.test.mjs`) usano il conteggio
 * dichiarato nel titolo con soglia **2**, le keyword `sweep|batch|bulk` e gli
 * item enumerati nel corpo (`hasEnumeratedItems`, #568).
 *
 * Il disallineamento non fa rumore: su un'aggregata da 2-3 item il workflow
 * dava `is_aggregate=false`, il fixer non riceveva l'eccezione, scriveva
 * `Closes #N` — e al merge GitHub chiudeva il TRACKER insieme agli item appena
 * deferiti in `## Non implementato`. Sparito il tracker, non resta niente da
 * ri-accodare: e' esattamente la classe che il circuit-breaker esiste per
 * evitare, lasciata scoperta sotto i 4 bullet.
 *
 * La decisione ora ha UNA sorgente (AGENTS.md #6): `isAggregate()` importata.
 * `check-issue-already-resolved.mjs` e' `mode: identical` nel manifest, quindi
 * non la si tocca da qui — la si CHIAMA.
 *
 * Uso (dal workflow):
 *   ISSUE_TITLE=... ISSUE_BODY=... node scripts/ci/detect-aggregate.mjs
 * Stampa su stdout, e appende a $GITHUB_OUTPUT se presente:
 *   is_aggregate=<true|false>
 *   agg_count=<n>
 */
import fs from 'node:fs';
import { isAggregate } from './check-issue-already-resolved.mjs';

/**
 * Quanti item il corpo ENUMERA, per il solo prompt ("item=N").
 *
 * E' un'indicazione, non un gate: chi decide e' `isAggregate()` qui sopra, e
 * questo file e' l'unico posto in cui il conteggio viene calcolato — quindi
 * non c'e' una seconda sorgente da tenere allineata. Un conteggio dichiarato
 * nel titolo ("N items deferred") e' autoritativo come lo e' per il
 * rilevatore; altrimenti si prende la forma di enumerazione piu' popolata fra
 * sezioni numerate, lista ordinata con lead in grassetto e bullet top-level.
 *
 * @param {string} title
 * @param {string} body
 * @returns {number}
 */
export function countItems(title = '', body = '') {
  const declared = `${title}\n${body}`.match(/(\d+)\s+items?\s+deferred/i);
  if (declared) return Number(declared[1]);
  const b = String(body || '');
  const counts = [
    (b.match(/^#{2,4}[ \t]*\d+[.)](?=[ \t]|$)/gm) || []).length,
    (b.match(/^[ \t]*\d+[.)][ \t]+\*\*/gm) || []).length,
    (b.match(/^[-*][ \t]+(?:\[[ xX]\][ \t]*)?/gm) || []).length,
  ];
  return Math.max(...counts);
}

const title = process.env.ISSUE_TITLE || '';
const body = process.env.ISSUE_BODY || '';

const isAgg = isAggregate(title, body);
const count = countItems(title, body);
const out = `is_aggregate=${isAgg}\nagg_count=${count}\n`;

process.stdout.write(out);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, out);
