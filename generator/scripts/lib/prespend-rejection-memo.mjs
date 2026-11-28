/**
 * Memo cross-run dei "no" del classifier pre-spend (M4, stadio `selection`).
 *
 * `_preSpendGateCache` in create-article.mjs vive solo dentro il processo: ogni
 * run riclassifica con una chiamata LLM le stesse headline che il run di 30
 * minuti prima aveva gia' scartato (la telemetria PRESPEND_GATE_OUTCOME misura
 * `emptied=1 recovered=none` in 10 run `svizzera` su 11). Il topic-gate
 * (REGOLA #0) ricorda gia' per 48 h gli URL che ha abortito; questo modulo fa
 * lo stesso per il verdetto "non rilevante" del classifier, riusando lo stesso
 * campo `topicGateUrls` con una chiave a prefisso proprio, cosi' il pre-filtro
 * del topic-gate esistente non cambia comportamento.
 *
 * Cio' che NON cambia: il gate resta lo stesso (stesso prompt, stessa soglia, i
 * backstop D/E ripartono dall'intero pool). Si salta solo la chiamata che
 * restituirebbe lo stesso "no". Solo i verdetti definitivi vengono ricordati:
 * mai un fail-open (`fromError`), un esito non analizzato o un "no" incerto
 * (`uncertain`: confidenza <= 0,5 della Decisions API, non confermata dal
 * fallback testuale per scadenza, errore o risposta illeggibile).
 *
 * La chiave comprende un hash breve di titolo+sommario: una notizia aggiornata
 * sullo stesso URL con un titolo diverso viene rivalutata. Le voci hanno un
 * tetto proprio (`PRESPEND_RELEVANCE_URL_MAX`), separato da quello degli abort
 * del topic-gate, che quindi non vengono cacciati.
 */
import { createHash } from 'node:crypto';
import {
  PRESPEND_RELEVANCE_KEY_PREFIX,
  isTopicGateAbortedUrl,
  recordTopicGateAbortedUrl,
} from './article-topic-selector.mjs';

export const PRESPEND_REJECTION_KEY_PREFIX = PRESPEND_RELEVANCE_KEY_PREFIX;

/** Hash breve (8 hex) di titolo+sommario, normalizzati: maiuscole e spazi non contano. */
export function contentFingerprint(title, summary) {
  const norm = (v) => String(v ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(`${norm(title)}\n${norm(summary)}`).digest('hex').slice(0, 8);
}

/** Chiave del memo: URL normalizzato, piu' `#<hash>` se l'item ha un contenuto da distinguere. */
export function memoUrlKey(urlKey, fingerprint = '') {
  return urlKey ? `${urlKey}${fingerprint ? `#${fingerprint}` : ''}` : '';
}

function memoKey(urlKey) {
  return urlKey ? `${PRESPEND_REJECTION_KEY_PREFIX}${urlKey}` : '';
}

/** Whether the classifier already said "no" to `urlKey` in `section` within the TTL. */
export function isPrespendRejectedUrl(tracker, urlKey, section, now = Date.now()) {
  const key = memoKey(urlKey);
  return !!key && isTopicGateAbortedUrl(tracker, key, section, now);
}

/** Pure: record a batch of definitive classifier rejections. */
export function recordPrespendRejectedUrls(tracker, urlKeys, section, now = Date.now()) {
  let next = tracker;
  for (const urlKey of urlKeys) {
    const key = memoKey(urlKey);
    if (key) next = recordTopicGateAbortedUrl(next, key, section, now);
  }
  return next;
}

/** A verdict worth remembering: an explicit, confident "no" the classifier actually produced. */
export function isDefinitiveRejection(verdict) {
  return !!verdict && verdict.relevant === false
    && verdict.fromError !== true && verdict.memo !== true && verdict.uncertain !== true;
}

/**
 * Resolve the verdict of every `item` ({ url, ... }), calling `classify` only
 * for those with no live "no" in `tracker`.
 *
 * `fingerprint(item)` (opzionale) restituisce l'hash di contenuto che entra
 * nella chiave: un item con lo stesso URL ma un contenuto diverso non e' un hit.
 *
 * @returns {Promise<{ verdicts: object[], memoHits: number, newRejections: string[] }>}
 */
export async function classifyWithRejectionMemo(items, {
  tracker,
  section,
  normalizeUrl,
  classify,
  runAll,
  canReuse = () => true,
  fingerprint = () => '',
  now = Date.now(),
}) {
  const urlKeys = items.map((item) => (item?.url ? memoUrlKey(normalizeUrl(item.url), fingerprint(item)) : ''));
  let memoHits = 0;
  const verdicts = await runAll(items, async (item, i) => {
    if (urlKeys[i] && canReuse(item) && isPrespendRejectedUrl(tracker, urlKeys[i], section, now)) {
      memoHits += 1;
      return { relevant: false, reason: 'prespend-rejection-memo', memo: true, parsed: true };
    }
    return classify(item, i);
  });
  const newRejections = [];
  verdicts.forEach((verdict, i) => {
    if (urlKeys[i] && isDefinitiveRejection(verdict) && !newRejections.includes(urlKeys[i])) {
      newRejections.push(urlKeys[i]);
    }
  });
  return { verdicts, memoHits, newRejections };
}
