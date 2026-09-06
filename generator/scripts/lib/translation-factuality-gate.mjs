/**
 * Il gate deterministico di fattualita' sui body TRADOTTI, e la derivazione
 * delle sezioni di corpo su cui gira.
 *
 * ── Perche' vive qui e non dentro create-article.mjs (#980, item 2) ────────
 *
 * I percorsi di scrittura del corpus sono TRE, non due:
 *
 *   1. il flusso AI primario           → create-article.mjs, Step 3a.2
 *   2. la prima registrazione          → registerArticleFiles()
 *   3. il rerun idempotente same-day   → refreshBodyFiles() dei tre produttori
 *      (daily-brief, events-digest, border-wait-ranking), che riscrivono i
 *      body con `writeFileSync` senza passare dal registrar
 *
 * Il terzo era scoperto: il Bollettino gira piu' volte al giorno e ogni run
 * dopo il primo entra nel ramo `exists`, quindi il testo tradotto che finisce
 * su disco a fine giornata e' proprio quello che nessun giudizio ha visto.
 * Lo step «Guard» dei workflow esegue solo `article-fabrication-guard` e
 * `prompt-placeholder-guard`, che sono un'altra famiglia di controlli.
 *
 * La funzione stava dentro create-article.mjs, che i tre produttori importano
 * gia' — ma quel modulo ha dipendenze statiche (jsdom) presenti solo dove
 * `npm ci` e' girato, quindi non e' importabile dalle gate di
 * `node --test`. Estrarla in un modulo di libreria e' cio' che permette al
 * terzo percorso di essere coperto DA UN TEST e non solo dal codice: stessa
 * ragione per cui `loadSnapshot`/`buildData` vivono in
 * `lib/daily-brief-content.mjs` e non nel produttore.
 *
 * Una sola sorgente per tutti e tre i percorsi (AGENTS.md #6): il gate del
 * rerun e quello della registrazione non possono divergere perche' sono la
 * stessa funzione.
 */
import { runFactualityGates, formatIssues } from './article-factuality-gates.mjs';

/**
 * Le sezioni di corpo REALMENTE presenti in un `content[locale]`, in ordine
 * numerico: `{ body1, body2, ... }`.
 *
 * Esiste perche' enumerare `body1, body2, body3` a mano e' una premessa falsa
 * sul percorso CONDIVISO. Il flusso AI primario produce esattamente tre corpi
 * (lo schema JSON li richiede tutti e tre e nessun altro), ma i produttori
 * secondari entrano da `registerArticleFiles()` con la forma che vogliono: il
 * Bollettino giornaliero ne scrive QUATTRO
 * (`content/blog-body/it/bollettino-frontaliere-2026-09-05.ts`). Con la lista
 * cablata, `body4` non veniva letto da nessun giudizio — in tutte e quattro le
 * lingue, e in silenzio: nessun errore, solo una sezione mai guardata proprio
 * dai gate che esistono per guardarla.
 *
 * Derivare le chiavi invece di elencarle rende il numero di corpi un dettaglio
 * del produttore e non un invariante nascosto nei giudici. Su un articolo a tre
 * corpi il risultato e' identico a prima (le chiavi assenti valevano `''` e non
 * contribuivano nulla), quindi il cambiamento e' un'estensione, non uno
 * spostamento di soglia.
 */
export function collectBodySections(content) {
  const sections = {};
  if (!content || typeof content !== 'object') return sections;
  const keys = Object.keys(content)
    .filter((k) => /^body\d+$/.test(k) && typeof content[k] === 'string')
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
  for (const k of keys) sections[k] = content[k];
  return sections;
}

/**
 * Gate deterministico sui body en/de/fr FINITI — BLOCCANTE (issue #5661).
 *
 * ── Il buco che chiude ──────────────────────────────────────────────────────
 *
 * `runFactualityGates()` gira allo Step 3a.0b-bis su `data.content.it` e SOLO
 * li'. Le tre traduzioni non passano mai dal gate: al punto di ammissione
 * girano due soli assert mirati (`assertNoFabricatedLaborOfficeCrossLocale`
 * qui sopra e `assertNoFabricatedNormAcronyms`), che coprono due famiglie di
 * sigle e nient'altro. Tutto il resto — troncamenti, parentesi non chiuse,
 * grassetto non chiuso, importi dell'italiano spariti nella traduzione, falsi
 * amici — non ha mai avuto un verdetto sulla meta' tradotta dell'articolo.
 *
 * L'asimmetria e' misurata, non supposta. `audit-article-factuality.mjs` sugli
 * 871 articoli aggiunti a `origin/main` nei 14 giorni al 2026-09-05:
 *
 *     locale   flagged   con rilievo bloccante
 *     it          2,8%                       0
 *     en         45,6%                      59
 *     de         46,7%                      32
 *     fr         47,5%                      31
 *
 * 62 articoli su 871 (7,1%) sono usciti con almeno un rilievo bloccante, e
 * tutti e 62 lo avevano SOLTANTO in en/de/fr: zero in italiano. Il gate non e'
 * debole, e' scollegato dalla meta' dell'articolo che nessuno gli fa vedere.
 * Il commento dentro `runFactualityGates` lo prevedeva gia' («il giorno in cui
 * le traduzioni passeranno di qui il controllo c'e' gia'»): questa e' la
 * chiamata che mancava, non un gate nuovo.
 *
 * ── Perche' qui e non dentro translateArticle() ─────────────────────────────
 *
 * Perche' il testo continua a essere mutato DOPO la traduzione: Step 3c (strip
 * dei tag <a> e dei link `nav:` non validi), Step 3d (CTA e link interni
 * iniettati), Step 3e (citazione della fonte appesa a body3). Il retry di
 * troncamento dentro `translateArticle()` giudica un testo che non e' ancora
 * quello che finisce su disco. Questo e' il primo istante in cui `data` E' cio'
 * che verra' scritto, ed e' condiviso: sta accanto a
 * `sanitizePromptPlaceholders()`, che e' gia' su ENTRAMBI i percorsi di
 * scrittura — il flusso AI primario allo Step 3a.1, e `registerArticleFiles()`
 * per daily-brief / events-digest / border-wait-ranking / journalist.
 *
 * ── Perche' segnala e blocca, e non riscrive mai ────────────────────────────
 *
 * Un detector collegato a una riscrittura trasforma ogni falso positivo in un
 * danno attivo (i titoli job riscritti dal tedesco, 2026-08-10). Qui non si
 * riscrive niente: si stampa e, sul bloccante, si rigetta. I falsi positivi di
 * lingua sono gia' gestiti DENTRO il gate da `adjudicateAgainstItalian()`, che
 * degrada a `major` ogni `critical` non presente anche nell'italiano — quindi
 * un limite del riconoscimento in en/de/fr non blocca per costruzione.
 *
 * La chiamata e' identica a quella di `audit-article-factuality.mjs`, percio'
 * il verdetto di questo gate e quello dell'audit retrospettivo coincidono per
 * costruzione: l'osservatore non puo' divergere dal gate che osserva.
 *
 * `ARTICLE_TRANSLATION_GATE=0` lo disarma (stessa convenzione di
 * `ARTICLE_TRANSLATE_FREE_MT`), per lasciare all'owner la leva sul volume
 * senza un cambio di codice.
 */
export function assertTranslationsPassFactualityGates(data) {
  if (String(process.env.ARTICLE_TRANSLATION_GATE ?? '1') === '0') return;
  const it = data?.content?.it;
  if (!it) return;
  // Derivate dalle chiavi `bodyN` presenti, non elencate: sul percorso
  // condiviso passa anche il Bollettino, che ha quattro corpi (vedi
  // `collectBodySections`).
  const italianSections = collectBodySections(it);
  // Senza italiano di riferimento i controlli di fedelta' non girano e il gate
  // emette `translation-unadjudicated`: non c'e' nulla contro cui giudicare.
  if (!Object.values(italianSections).some((s) => s.trim())) return;

  const blocking = [];
  for (const locale of ['en', 'de', 'fr']) {
    const content = data?.content?.[locale];
    if (!content) continue;
    const sections = collectBodySections(content);
    if (!Object.values(sections).some((s) => s.trim())) continue;
    const result = runFactualityGates({ sections, locale, italianSections });
    if (result.issues.length > 0) {
      console.error(`  🔍 Gate fattualita' [${locale}]: ${result.issues.length} rilievi, ${result.blocking.length} bloccanti`);
      console.error(formatIssues(result.issues));
    }
    blocking.push(...result.blocking);
  }
  if (blocking.length === 0) return;
  const err = new Error(
    `Articolo rigettato — ${blocking.length} rilievi bloccanti nei body tradotti:\n${formatIssues(blocking)}`,
  );
  // Stessa classe di ogni altro rigetto di qualita' in questo file: il loop di
  // generazione ruota alla headline successiva invece di far cadere la run.
  err.qualityReject = true;
  throw err;
}
