#!/usr/bin/env node
/**
 * Contratto del payload per il digest `needs-human`.
 *
 * `gh api --paginate --slurp` normalmente produce un array di pagine, ma un
 * errore GraphQL può arrivare con `errors` accanto a `data` e con exit code 0.
 * Questo parser è quindi il confine fra «lista vuota» e «input non misurato»:
 * una forma inattesa, un errore esplicito o un item senza i campi minimi fanno
 * fallire il pass, mai diventare `[]`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PAYLOAD_OK_MARKER = '<!-- NEEDS_HUMAN_DIGEST_PAYLOAD_OK -->';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function assertNoGraphQLErrors(value, where) {
  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, 'errors')) return;
  if (!Array.isArray(value.errors) || value.errors.length > 0) {
    throw new Error(`${where}: risposta con errors, anche se contiene data parziale`);
  }
}

function pageItems(page, index) {
  assertNoGraphQLErrors(page, `pagina ${index}`);
  if (Array.isArray(page)) return page;
  if (isRecord(page) && Array.isArray(page.data)) return page.data;
  throw new Error(`pagina ${index}: forma inattesa, manca un array di item`);
}

function assertItem(item, index) {
  if (!isRecord(item)) throw new Error(`item ${index}: non è un oggetto`);
  const number = Number(item.number);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`item ${index}: number non valido`);
  }
  if (typeof item.title !== 'string') throw new Error(`item ${index}: title non valido`);
  if (item.pull_request !== undefined && item.pull_request !== null && !isRecord(item.pull_request)) {
    throw new Error(`item ${index}: pull_request non è un oggetto o null`);
  }
  for (const key of ['updated_at', 'updatedAt']) {
    if (item[key] !== undefined && item[key] !== null && typeof item[key] !== 'string') {
      throw new Error(`item ${index}: ${key} non valido`);
    }
  }
}

/**
 * Normalizza il risultato di `gh api --paginate --slurp`.
 *
 * Accetta anche una singola pagina o un envelope `{data: [...]}` per rendere
 * il contratto testabile contro le forme che GitHub può restituire. Un envelope
 * con `errors` è sempre rifiutato, anche quando `data` è presente.
 */
export function parseNeedsHumanPayload(raw) {
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (error) {
    throw new Error(`payload non JSON: ${error.message}`);
  }

  assertNoGraphQLErrors(parsed, 'payload');
  let pages;
  if (Array.isArray(parsed)) {
    const isSlur = parsed.length === 0 || parsed.every((value) => Array.isArray(value)
      || (isRecord(value) && (Object.prototype.hasOwnProperty.call(value, 'data')
        || Object.prototype.hasOwnProperty.call(value, 'errors'))));
    pages = isSlur ? parsed : [parsed];
  } else {
    pages = [parsed];
  }

  const items = pages.flatMap((page, pageIndex) => pageItems(page, pageIndex));
  items.forEach(assertItem);
  return items;
}

/** Classifica i due passaggi jq senza nascondere la metà che ha funzionato. */
export function classifyDigestPartitions(prsRc, issuesRc) {
  const prsFailed = Number(prsRc) !== 0;
  const issuesFailed = Number(issuesRc) !== 0;
  const incomplete = [
    ...(prsFailed ? ['prs'] : []),
    ...(issuesFailed ? ['issues'] : []),
  ];
  if (incomplete.length === 0) {
    return { kind: 'complete', good: ['prs', 'issues'], incomplete };
  }
  if (incomplete.length === 2) {
    return { kind: 'failed', good: [], incomplete };
  }
  return {
    kind: 'partial',
    good: prsFailed ? ['issues'] : ['prs'],
    incomplete,
  };
}

export function formatPayload(items) {
  return `${PAYLOAD_OK_MARKER}\n${JSON.stringify(items)}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const items = parseNeedsHumanPayload(readFileSync(0, 'utf8'));
    process.stdout.write(formatPayload(items));
  } catch (error) {
    console.error(`::error::needs-human digest: ${error.message}`);
    process.exitCode = 1;
  }
}
