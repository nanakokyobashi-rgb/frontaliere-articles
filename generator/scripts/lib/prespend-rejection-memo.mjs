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
 * La chiave comprende l'identita' del classifier (modello + prompt) e un hash
 * breve di titolo+sommario: una notizia aggiornata
 * sullo stesso URL con un titolo diverso viene rivalutata. Le voci hanno un
 * tetto proprio (`PRESPEND_RELEVANCE_URL_MAX`), separato da quello degli abort
 * del topic-gate, che quindi non vengono cacciati.
 */
import { createHash } from 'node:crypto';
import {
  PRESPEND_RELEVANCE_KEY_PREFIX,
  isTopicGateAbortedUrl,
  recordTopicGateAbortedUrl,
  topicGateUrlKey,
} from './article-topic-selector.mjs';

export const PRESPEND_REJECTION_KEY_PREFIX = PRESPEND_RELEVANCE_KEY_PREFIX;

/**
 * Identita' del classifier: modello + testo delle istruzioni (il prompt reso
 * con input vuoti) + via di decisione. Cambia se cambia uno dei tre, quindi un
 * cambio di `PRESPEND_GATE_MODEL` o di policy invalida i "no" gia' memorizzati.
 */
export function classifierIdentity({ model = '', promptTemplate = '', extra = '' } = {}) {
  return createHash('sha256').update(`${model}\n${promptTemplate}\n${extra}`).digest('hex').slice(0, 8);
}

/**
 * Hash breve (8 hex) di titolo+sommario, normalizzati: maiuscole e spazi non
 * contano. Con `identity` (vedi `classifierIdentity`) entra nell'hash anche il
 * classifier che ha dato il verdetto.
 */
export function contentFingerprint(title, summary, identity = '') {
  const norm = (v) => String(v ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  const body = `${norm(title)}\n${norm(summary)}`;
  return createHash('sha256').update(identity ? `${identity}\n${body}` : body).digest('hex').slice(0, 8);
}

/**
 * Il pool e' PROVATO vuoto solo se nessuna generazione e' partita e non resta
 * nessun candidato dopo scan, filtri, topic-gate e pre-spend (backstop inclusi).
 * Un tentativo fallito per duplicato o qualita' non e' un pool vuoto.
 */
export function isPoolProvenEmpty({ candidateAttempted, remainingHeadlines }) {
  return candidateAttempted !== true && (remainingHeadlines?.length ?? 0) === 0;
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
    if (!key) continue;
    next = withoutOtherRevisions(next, key, section);
    next = recordTopicGateAbortedUrl(next, key, section, now);
  }
  return next;
}

/**
 * Un URL con molte revisioni di titolo non deve riempire il tetto: registrando
 * una chiave `<url>#<hash>` si tolgono le altre revisioni dello stesso URL.
 */
function withoutOtherRevisions(tracker, key, section) {
  const hash = key.lastIndexOf('#');
  const urls = tracker?.topicGateUrls;
  if (hash < 0 || !urls) return tracker;
  const stem = topicGateUrlKey(key.slice(0, hash + 1), section);
  const full = topicGateUrlKey(key, section);
  const kept = Object.fromEntries(Object.entries(urls).filter(([k]) => k === full || !k.startsWith(stem)));
  return Object.keys(kept).length === Object.keys(urls).length ? tracker : { ...tracker, topicGateUrls: kept };
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
