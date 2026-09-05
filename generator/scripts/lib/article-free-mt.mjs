/**
 * Quota-free article translation helpers (2026-06-22).
 *
 * Article translation historically went through the generation LLM cascade
 * (callLLM), consuming ~60% of the per-article LLM calls — the daily free-tier
 * quota bottleneck that starves GENERATION. These helpers route translation
 * through the dedicated free MT cascade instead (the same `freeTranslateWithRetry`
 * the job crawlers + FAQ batch already use), so the LLM quota is reserved for
 * generation.
 *
 * Extracted into a lib module so the logic is unit-testable: scripts/create-article.mjs
 * runs `main()` on import, so its internals can't be imported directly.
 */

import { hasUsableTranslatedText, hasUsableContentText } from './body2-payload-verdict.mjs';

const NAV_LINK_RE = /\[[^\]]+\]\(nav:[^)]+\)/g;
const NAV_SENTINEL_RE = /0NAV(\d+)0/g;

/**
 * Returns the translated field only when the model actually produced a string.
 *
 * A translation call asks for `{"body1": "..."}` but a model is free to answer
 * `{"body1": {"text": "..."}}` or `{"body1": ["...", "..."]}`. That still parses
 * as valid JSON, so `callWithRetry` returns it happily and every downstream
 * truthiness check (`if (!content[field])`, `chunk || ''`) passes — an object is
 * truthy. The value then reached a string context (a `.join('\n\n')` over the
 * chunks, or the TS serializer) and JavaScript stringified it to the literal
 * `[object Object]`, which shipped as published prose.
 *
 * That is exactly how 206 en/de/fr body files ended up with an `[object Object]`
 * paragraph where a real block should have been (it/ was untouched because it is
 * generated, not translated). Two shapes were produced: the whole body replaced
 * (single-call path) and one paragraph replaced among good prose (chunked path).
 *
 * Failing CLOSED here — returning null rather than a stringified object — is what
 * makes the existing recovery work: the field reads as missing, so the per-field
 * missing-translation retry runs and, failing that, falls back to the IT source.
 * A stringified object is unrecoverable; a missing field is not.
 *
 * Il test di non-vuoto e' `hasUsableTranslatedText` e non un `value.trim()` nudo:
 * un modello che serializza il `null` come STRINGA (`"null"` — la forma
 * misurata su `haiku` in #799) supera il trim, e qui non c'e' nessun
 * `normalizeItalianContentFromPayload` a valle a ripulirlo, perche'
 * `validateItalianPayload` gira solo su `content.it`. Un `body1` de/en/fr con
 * testo `null` andrebbe dritto in `content/`, in `dist/api/meta-<locale>.json`
 * e nei feed RSS. Fallendo CHIUSI qui il campo si legge come mancante e la
 * recovery per-campo (retry mirato -> fallback IT) lo recupera.
 *
 * Il predicato e' quello dei campi TRADOTTI, ed e' PER LOCALE: su `de` solo la
 * forma serializzata (`null` minuscolo) e' scartata, perche' `Null` maiuscolo
 * e' la parola tedesca per «zero» e scartarla farebbe pubblicare il testo IT
 * sotto `/de/` (#831). Su en/fr — e quando il chiamante non passa il locale —
 * vale la regola severa: `Null`/`NULL` non e' prosa, resta un campo mancante e
 * la recovery per-campo lo ripara.
 *
 * @param {unknown} value raw field value as parsed from the model's JSON
 * @param {string} [targetLang] locale del campo tradotto ('en' | 'de' | 'fr')
 * @returns {string|null} the string, or null when it is anything else / blank
 *          / the literal serialization of `null`
 */
export function translatedStringOrNull(value, targetLang) {
  return hasUsableTranslatedText(value, targetLang) ? value : null;
}

/**
 * Joins per-chunk translations of one body field, refusing to stringify a chunk
 * the model returned as a non-string.
 *
 * Returns null when ANY chunk is unusable: a body silently missing its third
 * paragraph is worse than a body the recovery path re-translates whole, and the
 * caller cannot tell the difference once the chunks are joined.
 *
 * @param {unknown[]} results  per-chunk parsed JSON objects
 * @param {string} bodyKey     'body1' | 'body2' | 'body3'
 * @param {string} [targetLang] locale dei chunk tradotti ('en' | 'de' | 'fr')
 * @returns {string|null}
 */
export function joinTranslatedChunks(results, bodyKey, targetLang) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const parts = [];
  for (const r of results) {
    const part = translatedStringOrNull(r?.[bodyKey], targetLang);
    if (part === null) return null;
    parts.push(part);
  }
  return parts.join('\n\n');
}

/**
 * Mask internal `[testo](nav:azione)` CTA links so machine translation passes
 * them through verbatim (the `nav:azione` target is a router action, not prose).
 *
 * The sentinel is digit-delimited ASCII and — this is the load-bearing part —
 * contains NO translatable word. It used to be `0NAVLINK<n>0`, and the docstring
 * claimed MT engines "leave this token intact in practice". They do not: French
 * MT reads the embedded English word and returns `0NAVLIEN<n>0`. `restore()`
 * then counts a mismatch and the caller drops the field, so a French body
 * carrying a single nav CTA silently lost the free-MT tier and fell through to
 * the paid/degraded path — a quiet coverage loss, invisible because failing
 * closed here looks exactly like a translator being unavailable.
 *
 * Found while repairing the 2026-07-28 `[object Object]` corruption, where the
 * same sentinel made six files unrepairable until the mask was changed.
 *
 * `restore()` still reports `ok:false` on a count mismatch, letting the caller
 * drop a mangled field rather than ship a body with a broken internal link.
 *
 * @param {string} text
 * @returns {{ masked: string, expected: number, restore: (s: string) => { text: string, ok: boolean } }}
 */
export function maskNavLinks(text) {
  const store = [];
  const masked = String(text ?? '').replace(NAV_LINK_RE, (m) => {
    const token = `0NAV${store.length}0`;
    store.push(m);
    return token;
  });
  const restore = (s) => {
    let n = 0;
    const out = String(s ?? '').replace(NAV_SENTINEL_RE, (_, i) => {
      const original = store[Number(i)];
      if (original === undefined) return '';
      n += 1;
      return original;
    });
    return { text: out, ok: n === store.length };
  };
  return { masked, expected: store.length, restore };
}

/**
 * Translate a single article text field via the injected free MT translator,
 * preserving internal nav-links. Returns '' on any failure (empty input, MT
 * error, empty output, or a mangled nav-link sentinel) so the caller's per-field
 * recovery (LLM retry → IT fallback) takes over — free MT can only IMPROVE
 * coverage, never produce broken output.
 *
 * @param {object} args
 * @param {string} args.text                source text
 * @param {string} args.sourceLang
 * @param {string} args.targetLang
 * @param {string} args.fieldType           'title' | 'description'
 * @param {(a: { text: string, sourceLang: string, targetLang: string, fieldType: string }) => Promise<string>} args.translate
 *        the MT call (freeTranslateWithRetry in prod, a stub in tests)
 * @param {(s: string) => string} [args.balanceMarkdown]  optional markdown repair
 * @param {(msg: string) => void} [args.onWarn]
 * @returns {Promise<string>}
 */
export async function translateFieldFreeMt({
  text,
  sourceLang,
  targetLang,
  fieldType,
  translate,
  balanceMarkdown = (s) => s,
  onWarn = () => {},
}) {
  const src = String(text ?? '').trim();
  if (!src) return '';
  const { masked, expected, restore } = maskNavLinks(src);
  let out;
  try {
    out = await translate({ text: masked, sourceLang, targetLang, fieldType });
  } catch (err) {
    onWarn(`free-MT ${targetLang}:${fieldType} failed (${err?.message || err})`);
    return '';
  }
  // L'uscita di un MOTORE, non la prosa di un modello: qui vale il predicato
  // severo, TUTTE le grafie di `null` (vedi il blocco «QUALE DEI DUE
  // PREDICATI» in body2-payload-verdict.mjs). `Null`/`NULL` e' cio' che un
  // motore della cascata gratuita emette quando NON ha una traduzione — un
  // marker di fallimento, non la parola tedesca per «zero» scelta da qualcuno
  // che sapeva cosa stava traducendo. Accettarlo su `targetLang === 'de'`
  // pubblicava il marker verbatim in `content/`, in `meta-de.json`, nel feed
  // RSS `de` e come segmento di slug `/de/blog/null` (#868 item 4).
  // Scartarlo costa al piu' una recovery per-campo (retry mirato → fallback
  // IT): un retry, non una pubblicazione sbagliata.
  if (!hasUsableContentText(out)) return '';
  let restored = String(out);
  if (expected > 0) {
    const r = restore(restored);
    if (!r.ok) {
      onWarn(`free-MT ${targetLang}:${fieldType} nav-link sentinel mangled (expected ${expected})`);
      return '';
    }
    restored = r.text;
  }
  return balanceMarkdown(restored);
}
