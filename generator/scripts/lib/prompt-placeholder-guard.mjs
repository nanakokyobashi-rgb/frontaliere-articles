/**
 * prompt-placeholder-guard.mjs — un solo guard sui SEGNAPOSTO DEL PROMPT, per
 * ogni campo di testo pubblicato.
 *
 * ## Il difetto che chiude
 *
 * Il prompt di `create-article.mjs` mostra al modello uno schema JSON con
 * valori di esempio LETTERALI. Un modello che esaurisce l'attenzione li
 * ricopia invece di compilarli, e nessuno se ne accorge perche' un segnaposto
 * e' un valore **ben formato**: e' una stringa, ha la lunghezza giusta, e ogni
 * controllo che guarda la FORMA lo lascia passare.
 *
 * MISURATO il 2026-08-10 su `origin/main`, 46.175 campi metadato e 61.484
 * campi body/faq: **34 articoli distinti** portavano almeno un segnaposto in
 * produzione. Il piu' recente era stato pubblicato quello stesso pomeriggio.
 *
 * ## Perche' la FAQ e' il caso grave, e non `imageAlt`
 *
 * 24 di quei file portano il blocco FAQ INTERO sostituito dallo schema:
 *
 *     'blog.article.<id>.faq': '[{"q":"Domanda frequente 1 basata sui fatti
 *     dell\'articolo?","a":"Risposta con dati DALLA FONTE. 50-100 parole."},…]'
 *
 * e la FAQ non resta nel corpo: `engine/ogPagesPlugin.ts` la legge (`:1320`),
 * ne fa lo **schema FAQPage** (`:1354`) e la stampa anche come accordion
 * visibile (`:1370`). Quegli articoli hanno quindi pubblicato verso i motori di
 * ricerca dati strutturati la cui domanda e' «Domanda frequente 1». Non e' un
 * campo brutto: e' structured data falso.
 *
 * Il controllo che avrebbe dovuto fermarli e' in `create-article.mjs`:
 *
 *     pair.q.length > 10 && pair.a.length > 20   →  "✅ FAQ: 3 coppie valide"
 *
 * La domanda segnaposto e' lunga 50 caratteri e la risposta 44. **Una FAQ
 * segnaposto e' strutturalmente valida**: si contano le coppie e si passa. Il
 * log del run 31402084443 stampa «✅ FAQ: 3 coppie valide» esattamente mentre
 * le tre coppie sono lo schema.
 *
 * ## Perche' UN guard e non tre
 *
 * Tre fix hanno chiuso tre campi e lasciato la classe aperta: la PR #121 lo
 * slug, `it-microcopy-guard.mjs` lo stile di titolo/excerpt, il filtro sopra
 * la forma della FAQ. Ogni volta il segnaposto e' semplicemente ricomparso nel
 * campo successivo. Qui il criterio e' uno solo e vale per ogni campo di testo
 * pubblicato — corpo, FAQ, excerpt, imageAlt, title, seo.
 *
 * ## Il criterio e' DERIVATO dal template, non scritto a mano
 *
 * `SCHEMA_PLACEHOLDER_LITERALS` e' la copia dei valori letterali dello schema
 * JSON del prompt, e i matcher si costruiscono da quella lista con `leadOf()` —
 * meccanicamente, non a mano. `generator/tests/prompt-placeholder-guard.test.mjs`
 * ri-estrae i letterali da `create-article.mjs` e pretende l'uguaglianza fra i
 * due insiemi: **se il template acquisisce un segnaposto nuovo, il test
 * diventa rosso**, non il corpus fra tre giorni.
 *
 * ## Le tre forme che un letterale non basta a coprire
 *
 * E' la lezione gia' scritta al guard degli slug (`inspectSlugForPromptPlaceholder`
 * in create-article.mjs): «il segnaposto non sopravvive come letterale». Il
 * prompt e' scritto in italiano, quindi il modello ne traduce il SIGNIFICATO e
 * restituisce un token che non era nel suo input. Tre regole di FORMA coprono
 * cio' che nessuna lista di stringhe puo' vedere:
 *
 *   · `budget-as-value`   — `Max 125 caratteri`. Nel template c'e'
 *     `max 125 chars`: la variante italiana e' un'invenzione del modello, ed e'
 *     la piu' diffusa (40 campi su 40 offender di questa famiglia).
 *   · `faq-numbered-label` — `Domanda frequente 4:`. Lo schema si ferma a 3.
 *   · `prompt-scaffold`    — `HEADLINE:`, `RECENT ARTICLE IDS`. Non sono nello
 *     schema JSON: sono le etichette del PREAMBOLO, che il modello rispedisce
 *     indietro insieme alla pagina di origine.
 *
 * Tre altre sono arrivate dopo, dalla misura di #295 su un guard che restava
 * VERDE su tre varianti reali (0 rossi su 85 test) — il piano e' in #300:
 *
 *   · `budget-tail`           — il budget in CODA a un campo vero, senza
 *     parentesi: `… con camerieri in servizio. Max 125 char`. 15 campi
 *     pubblicati, che ne' `budget-as-value` ne' `budget-parenthetical` vedono.
 *   · `source-echo-allcaps`   — `DALLA FONTE` e le sue traduzioni, quando
 *     arrivano da un template DIVERSO e senza la prosa italiana attorno a cui
 *     i letterali sono ancorati.
 *   · `alt-field-description` — il campo che descrive SE STESSO
 *     («Descrizione dell'immagine in tedesco, massimo 125 caratteri»).
 *
 * ## Falsi positivi: misurati per TIPO DI CAMPO, perche' il rischio e' diverso
 *
 * Su `imageAlt` un falso positivo costa un alt-text rigenerato; su `body1`
 * costa un articolo buono rifiutato. I due tassi vanno quindi misurati
 * separatamente, ed e' cio' che fa il blocco `gate` del test:
 *
 *   · 46.175 campi metadato  → 42 segnalati, 42 offender veri, 0 falsi
 *   · 61.484 campi body/faq  → 33 segnalati, 33 offender veri, 0 falsi
 *
 * `(max ` NON e' un marcatore, ed e' l'esclusione piu' importante del file:
 * compare in **48 campi body legittimi** («max 15.000 CHF/anno», «max 9
 * ore/giorno», «max 1 page»). Un guard che lo includesse rigetterebbe 48
 * articoli buoni — peggio del difetto che ripara. Cio' che identifica il
 * segnaposto non e' `(max `: e' il budget di caratteri USATO COME VALORE
 * INTERO del campo, che e' quello che `budget-as-value` pretende.
 *
 * Restano fuori per la stessa ragione, con 0 offender misurati:
 *   · `RELATED:` — il prompt la emette, ma e' un'etichetta editoriale corrente
 *     su una pagina inglese scrapata: il segnale non distingue il leak dalla
 *     fonte.
 *   · `id` e `slugs` — non sono campi di testo e hanno gia' il loro
 *     classificatore, `inspectSlugForPromptPlaceholder()`, che copre anche le
 *     varianti tradotte (`slug-inglese`). Il test di lock lo mette nel conto:
 *     ogni letterale dello schema dev'essere visto da QUESTO guard **oppure**
 *     da quello.
 *
 * @see generator/tests/prompt-placeholder-guard.test.mjs
 * @see generator/scripts/repair-prompt-placeholders.mjs — la bonifica del gia' pubblicato
 */

// ─────────────────────────────────────────────────────────────────────────────
// I letterali dello schema JSON del prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * I valori di esempio che il prompt mostra al modello, verbatim.
 *
 * Copiati dal blocco «Genera JSON (no markdown, no code fences)» di
 * `generator/scripts/create-article.mjs`. Il test ri-estrae quel blocco e
 * pretende che i due insiemi coincidano: questa lista non puo' restare
 * indietro rispetto al template senza che la CI se ne accorga.
 *
 * `id` e `slugs` sono inclusi per completezza del lock (il test verifica che
 * qualcuno li copra) ma non producono matcher qui — vedi l'intestazione.
 */
export const SCHEMA_PLACEHOLDER_LITERALS = Object.freeze([
  'kebab-case-3-5-words-max-40-chars',
  'max 125 chars',
  'slug-it',
  'slug-en',
  'slug-de',
  'slug-fr',
  "Titolo giornalistico con keyword (OBBLIGATORIO ≤ 60 caratteri totali, target 50-55. Il suffisso ' | Frontaliere Ticino' viene aggiunto automaticamente — NON includerlo nel title)",
  'Sottotitolo con dati concreti DALLA FONTE (max 160 chars)',
  "Inizia con '## In breve' (3-4 bullet TL;DR ≤80 char) + '## Fatti chiave' (5-8 coppie **Cosa/Quando/Dove/Chi/Importo**: valore). Poi il LEAD: FATTI dalla fonte (chi, cosa, dove, quando, perché). Solo cronaca verificabile. 300-400 parole (escluse TL;DR/Fatti chiave). Min 1 ### sotto-sezione.",
  'Analisi pratica: implicazioni, confronti, scenari. Contenuto DIVERSO da body1. 300-400 parole. Min 1 ### sotto-sezione.',
  'Azione: procedura step-by-step, scadenze, strumenti + CTA finale. NON riassumere body1/body2. 300-400 parole.',
  "Domanda frequente 1 basata sui fatti dell'articolo?",
  'Risposta con dati DALLA FONTE. 50-100 parole.',
  'Domanda frequente 2?',
  'Risposta pratica basata sulla fonte.',
  'Domanda frequente 3?',
  'Risposta con procedura o scadenza dalla fonte.',
  "SEO Title senza brand suffix (OBBLIGATORIO ≤ 60 caratteri TOTALI; il suffisso ' | Frontaliere Ticino' viene aggiunto automaticamente — NON includerlo)",
  'Meta description 150-160 chars (HARD CAP: ≤ 160 caratteri)',
  '6-8 keywords IT',
  'OG title (OBBLIGATORIO ≤ 60 caratteri)',
  "OG desc per la card social — 200-250 caratteri, NON una copia della description: Facebook/LinkedIn/WhatsApp mostrano molto piu' di una SERP (HARD CAP: ≤ 250 caratteri)",
  'Headline JSON-LD',
  'Breadcrumb 2-3 parole',
]);

/**
 * I letterali che NON producono un matcher testuale qui: non sono campi di
 * testo, e `inspectSlugForPromptPlaceholder()` in create-article.mjs li
 * classifica gia' — compresa la famiglia tradotta (`slug-inglese`) che una
 * lista di stringhe non puo' vedere. Duplicarli qui creerebbe due verita' sullo
 * stesso campo.
 */
export const SLUG_OWNED_LITERALS = Object.freeze([
  'kebab-case-3-5-words-max-40-chars',
  'slug-it',
  'slug-en',
  'slug-de',
  'slug-fr',
]);

/**
 * Le etichette del PREAMBOLO del prompt — non dello schema JSON. Il modello le
 * rispedisce indietro insieme alla pagina scrapata quando confonde l'input con
 * l'output. Il test verifica che ognuna sia ancora costruita da
 * `create-article.mjs`, cosi' una rinomina del preambolo non lascia la regola
 * a puntare nel vuoto.
 *
 * `RELATED:` e' esclusa di proposito: vedi l'intestazione.
 */
export const PROMPT_SCAFFOLD_LABELS = Object.freeze([
  'HEADLINE:',
  'SOURCE URL:',
  'SOURCE CONTENT:',
  'RECENT ARTICLE IDS',
  'EXISTING ARTICLE IDS',
]);

/**
 * I marcatori ALL-CAPS che sopravvivono alla TRADUZIONE del segnaposto.
 *
 * ## Il buco che chiudono, misurato (#295 item 1.3, riportato in #300)
 *
 * I matcher derivati dai letterali sono ancorati alla prosa italiana dello
 * schema (`leadOf('Risposta con dati DALLA FONTE. 50-100 parole.')` →
 * `Risposta con dati DALLA FONTE`). L'articolo
 * `trasferirsi-a-aprica-da-frontaliere-pro-e-contro` e' uscito in produzione con
 * lo stesso segnaposto prodotto da un template DIVERSO (la serie «trasferirsi a
 * X da frontaliere»), quindi senza quella prosa attorno, e propagato in quattro
 * lingue: `DALLA FONTE` / `FROM THE SOURCE` / `AUS DER QUELLE` / `DE LA SOURCE`.
 * Nessun letterale lo vedeva, in nessuna delle quattro locali.
 *
 * ## Perche' ALL-CAPS e perche' NON case-insensitive
 *
 * E' la stessa forma di `budget-parenthetical`: si cerca cio' che il traduttore
 * NON riscrive. Qui l'invariante e' il MAIUSCOLO — lo schema urla il vincolo, e
 * il modello lo ricopia urlando anche quando ne traduce le parole.
 *
 * La distinzione porta tutto il peso, ed e' misurata: sui 157.426 campi
 * pubblicati la variante case-insensitive (`\b(dalla fonte|from the source|…)`)
 * scatta su **168 campi**, tutti prosa legittima («dati provengono dalla fonte
 * ufficiale», «données de la source»). La variante ALL-CAPS scatta su **0**.
 * Un guard costruito sulla prima sarebbe stato spento entro un giorno.
 *
 * Il LOCK sul template vive nel test: `DALLA FONTE` dev'essere ancora presente
 * in `SCHEMA_PLACEHOLDER_LITERALS`, altrimenti questa lista sta inseguendo un
 * prompt che non esiste piu'. Le altre tre sono le traduzioni OSSERVATE in
 * produzione (#295), non una lista di lingue immaginate: stessa disciplina di
 * `PROMPT_SCAFFOLD_LABELS`, che elenca le etichette che il prompt costruisce
 * davvero.
 */
export const SOURCE_ECHO_MARKERS = Object.freeze([
  'DALLA FONTE',
  'DALLE FONTI',
  'FROM THE SOURCE',
  'FROM SOURCE',
  'AUS DER QUELLE',
  'DE LA SOURCE',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Derivazione dei matcher
// ─────────────────────────────────────────────────────────────────────────────

/**
 * La testa DISTINTIVA di un letterale dello schema: la parte che identifica il
 * segnaposto senza portarsi dietro la coda di istruzioni, che il modello
 * riscrive volentieri (`(max 160 chars)` → `(max 160 char)` nel corpus).
 *
 * Taglia, in ordine: al primo inciso fra parentesi, alla prima frase, a 60
 * caratteri su confine di parola. Deterministica e testata sui 25 letterali.
 */
export function leadOf(literal) {
  let s = String(literal || '').trim();
  const paren = s.indexOf(' (');
  if (paren > 12) s = s.slice(0, paren);
  const sentence = /^(.*?[.?!])(?:\s|$)/.exec(s);
  if (sentence) s = sentence[1];
  s = s.replace(/[.?!]+$/, '').trim();
  if (s.length > 60) {
    const cut = s.lastIndexOf(' ', 60);
    if (cut > 20) s = s.slice(0, cut).trim();
  }
  return s;
}

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** I letterali che diventano matcher (tutti tranne quelli di competenza dello slug guard). */
const TEXT_LITERALS = SCHEMA_PLACEHOLDER_LITERALS.filter((l) => !SLUG_OWNED_LITERALS.includes(l));

/**
 * ── LE REGOLE ─────────────────────────────────────────────────────────────
 *
 * `kind` decide cosa se ne fa il chiamante, non solo se segnalare:
 *
 *   · `schema-echo`   — il campo ricopia una descrizione dello schema. Non c'e'
 *                       contenuto da salvare.
 *   · `schema-label`  — l'etichetta dello schema e' incollata davanti a
 *                       contenuto VERO («Domanda frequente 1: Quali sono i
 *                       portali di annunci di lavoro?»). Togliere l'etichetta
 *                       lascia un campo corretto: e' riparabile.
 *   · `budget`        — il valore E' un budget di caratteri.
 *   · `scaffold`      — il campo contiene il preambolo del prompt. Il testo che
 *                       segue e' input, non articolo.
 */
export const PLACEHOLDER_RULES = Object.freeze([
  // ── Forme che nessun letterale copre ────────────────────────────────────
  {
    id: 'budget-as-value',
    kind: 'budget',
    // Ancorata: e' il valore INTERO a dover essere il budget. Senza le ancore
    // questa regola diventerebbe `(max ` e rigetterebbe 48 body legittimi.
    rx: /^\s*\(?\s*(?:max|max\.|massimo|maximum|maximal)\s+\d{2,4}\s*(?:chars?|characters?|caratteri|carattere|caractères|caracteres|Zeichen)\s*\)?[.]?\s*$/i,
    why: "Il campo E' l'istruzione di lunghezza dello schema (`max 125 chars`), o la sua traduzione italiana `Max 125 caratteri`, che nel prompt non compare.",
  },
  {
    id: 'budget-parenthetical',
    kind: 'schema-echo',
    // ── LA REGOLA CHE SOPRAVVIVE ALLA TRADUZIONE ─────────────────────────
    //
    // Un segnaposto non resta in italiano. `translateArticle()` lo tratta come
    // contenuto e lo traduce, e l'excerpt di `trasferirsi-a-marchirolo-…` e'
    // uscito in produzione in quattro lingue:
    //
    //   it  Sottotitolo con dati concreti DALLA FONTE (max 160 char)
    //   en  Subtitle with concrete data FROM THE SOURCE (max 160 char)
    //   de  Untertitel mit konkreten Angaben AUS DER QUELLE (max 160 char)
    //   fr  Sous-titre avec des données concrètes DE LA SOURCE (max 160 char)
    //
    // Nessun matcher costruito sul letterale italiano vede le altre tre. Cio'
    // che il traduttore NON tocca — perche' non e' prosa — e' l'inciso col
    // budget di caratteri: e' quello l'invariante, ed e' questa la regola.
    //
    // FALSO POSITIVO: e' l'unita' di misura a fare il lavoro. `(max ` da solo
    // compare in 48 campi body legittimi («max 15.000 CHF/anno», «max 9
    // ore/giorno», «max 1 page»), e nessuno di quei 48 nomina caratteri.
    // Misurato: 0 falsi positivi su 107.659 campi pubblicati.
    rx: /\(\s*(?:max|max\.|massimo|maximum|maximal|máximo)\s+\d{2,4}\s*(?:chars?|characters?|caratteri|carattere|caractères|caracteres|Zeichen)\s*\)/i,
    why: "Inciso col budget di caratteri dello schema (`(max 160 chars)`): sopravvive alla traduzione del segnaposto in en/de/fr, dove nessun letterale italiano arriva.",
  },
  {
    id: 'budget-tail',
    kind: 'schema-echo',
    // ── LA TERZA FORMA DEL BUDGET, e perche' le altre due non la vedono ──
    //
    // `budget-as-value` pretende che il budget sia il valore INTERO,
    // `budget-parenthetical` che stia fra parentesi. Il caso reale non e' ne'
    // l'uno ne' l'altro: il modello scrive un alt-text VERO e ci appiccica in
    // coda l'istruzione, senza parentesi. Misurato su `origin/main` il
    // 2026-08-14, 15 campi pubblicati in 10 file, due articoli piu' uno:
    //
    //   it  Un ristorante in Lugano, Ticino, con camerieri in servizio. Max 125 char
    //   en  A restaurant in Lugano, Ticino, with waiters in service. Max 125 char
    //   de  Ein Restaurant in Lugano, Ticino, mit Bedienungen im Dienst. Max 125 Char
    //   fr  Un restaurant à Lugano, Ticino, avec des serveurs en service. Max 125 Char
    //
    // piu' i gemelli `structuredData.caption` in content/seo/, che portano lo
    // stesso testo (vedi l'intestazione di repair-prompt-placeholders.mjs).
    //
    // ── L'ANCORA DI SINISTRA, che e' cio' che separa questa regola da `(max ` ──
    //
    // Il budget deve aprire la propria CLAUSOLA: inizio campo, oppure dopo
    // `. ! ? ; : ,` o un a capo. E' quella condizione a escludere l'uso
    // legittimo, dove il budget e' incastonato in una frase con la sua
    // preposizione davanti — «il campo note accetta al massimo 500 caratteri.»,
    // «la domanda va posta in massimo 200 caratteri». Senza l'ancora questa
    // regola diventerebbe la stessa `(max ` che l'intestazione argomenta di non
    // usare, con i suoi 48 body legittimi.
    //
    // FALSI POSITIVI: 0 su 157.426 campi pubblicati (metadati + corpi/faq +
    // seo + gemelli JSON-LD). I 15 che scattano sono tutti offender veri.
    rx: /(?:^|[.!?;:,–—]|\n)\s*\(?\s*(?:max|max\.|massimo|maximum|maximal|máximo)\s+\d{2,4}\s*(?:chars?|characters?|caratteri|carattere|caractères|caracteres|Zeichen)\s*\)?\s*[.!]?\s*$/i,
    why: "Il budget di caratteri dello schema appiccicato in CODA a un campo altrimenti vero (`… in servizio. Max 125 char`): non e' il valore intero (`budget-as-value`) ne' un inciso fra parentesi (`budget-parenthetical`).",
  },
  {
    id: 'source-echo-allcaps',
    kind: 'schema-echo',
    // Vedi `SOURCE_ECHO_MARKERS`: l'invariante e' il MAIUSCOLO, non le parole.
    // Case-insensitive scatterebbe su 168 campi di prosa legittima; cosi' com'e'
    // scatta su 0 — e vede il leak del template «trasferirsi a X» in tutte e
    // quattro le locali, dove nessun letterale italiano arriva.
    rx: new RegExp(`(?:^|[^\\p{Lu}])(?:${SOURCE_ECHO_MARKERS.map(escapeRx).join('|')})(?![\\p{Lu}])`, 'u'),
    why: 'Marcatore ALL-CAPS dello schema («dati DALLA FONTE») o una sua traduzione: sopravvive alla traduzione del segnaposto e non dipende dalla prosa italiana che gli sta attorno.',
  },
  {
    id: 'alt-field-description',
    kind: 'schema-echo',
    // Il campo DESCRIVE se stesso invece di descrivere l'immagine. Osservato su
    // `terzo-pilastro-3a-vantaggi-2026-basilea` (imageAlt it/en/de/fr + la
    // caption gemella): «Descrizione dell'immagine in tedesco, massimo 125
    // caratteri» — in ITALIANO anche nel file `de`, quindi non e' output del
    // traduttore ma l'istruzione di un template che non e' piu' in
    // create-article.mjs (verificato: la stringa non compare in nessun prompt
    // vivo di questo repo).
    //
    // NON e' una regola cosmetica aggiunta per completezza: senza di lei
    // `rebuildImageAlt()` in repair-prompt-placeholders.mjs toglierebbe la sola
    // coda `massimo 125 caratteri` — che `budget-tail` vede — e pubblicherebbe
    // «Descrizione dell'immagine in tedesco» come alt-text, cioe' un segnaposto
    // che nessuna regola vede piu'. Con la regola il campo non e' riparabile per
    // sottrazione e si ricade sulla ricetta dal titolo, che e' quella giusta.
    //
    // Ancorata all'INIZIO del campo: un corpo che parla della descrizione di
    // un'immagine («la descrizione dell'immagine allegata al modulo…») non la
    // apre. Misurato: 5 campi su 157.426, tutti e cinque offender veri.
    rx: /^\s*(?:descrizione\s+dell'immagine|image\s+description|bildbeschreibung|description\s+de\s+l'image)\b/i,
    why: "Il campo ricopia la DESCRIZIONE del campo («Descrizione dell'immagine in italiano, massimo 125 caratteri») invece di descrivere l'immagine.",
  },
  {
    id: 'schema-field-name-as-keyword',
    kind: 'schema-echo',
    // Il NOME del campo dello schema sopravvissuto come token isolato di una
    // tag-list. E' il residuo che nessun letterale poteva vedere, ed e' il
    // punto 2 di #300 — dichiarato li' `blocked: serve la ricetta di
    // generazione`. La ricetta c'e', ed e' deterministica:
    // `optimizeSeoMetadata()` in create-article.mjs NON usa le `keywords` che
    // il modello propone, le RIDERIVA da `title + excerpt + id` della locale
    // IT, minuscole, tokenizzate, filtrate per lunghezza > 3 e per stopword.
    // Verificata rieseguendola sul corpus: 4.823 campi su 5.134 riprodotti
    // byte a byte (93,9%; il resto e' keyword-set scritti a mano o drift da
    // edit successivi di title/excerpt).
    //
    // Quindi un `sottotitolo` nudo fra le keywords non e' un'invenzione del
    // modello su quel campo: e' il letterale «Sottotitolo con dati concreti
    // DALLA FONTE (max 160 chars)» finito nell'EXCERPT e poi compresso a un
    // token dalla derivazione, che getta via tutto il resto della frase — cioe'
    // tutto cio' a cui i letterali si agganciano. Il caso reale (riparato nei
    // dati da #296, mai rilevabile) e' `trasferirsi-a-marchirolo-...`.
    //
    // Solo la famiglia sottotitolo/traduzioni, e per una ragione misurata:
    // allargare ai nomi di campo generici (`titolo`/`title`/`titel`/`titre`/
    // `keyword`) produce 11 falsi positivi VERI, tutti legittimi — «spareggio,
    // titolo» (titolo sportivo), «equipollenza, titolo, studio» (titolo di
    // studio), «inchieste, keyword». E' lo stesso argomento con cui
    // `budget-tail` non matcha `(max ` da solo: la parola generica non
    // distingue il leak dal contenuto.
    //
    // Ancorata ai confini della tag-list (inizio campo o virgola), non alla
    // parola: gli articoli che parlano DAVVERO di sottotitoli usano il plurale
    // o il participio dentro la prosa (`sottotitoli`, `sottotitolata`,
    // `Untertiteln`, `sous-titres`) e non hanno mai la parola fra le keywords.
    // Misurato su tutto il corpus a regola scritta: 0 hit su 5.134 campi
    // `keywords`, 0 su 25.668 campi seo, 0 su 50.394 campi meta, 0 sui corpi.
    rx: /(?:^|,)\s*(?:sottotitol[oi]|untertiteln?|sous-titres?|subtitles?)\s*(?:,|$)/i,
    why: 'Il NOME del campo dello schema («Sottotitolo…») sopravvissuto come token isolato della tag-list `keywords`, che optimizeSeoMetadata deriva da title + excerpt + id invece di prenderla dal modello.',
  },
  {
    id: 'faq-numbered-label',
    kind: 'schema-label',
    rx: /(?:^|[\s*#>\-–—.)\]])\**\s*domanda\s+frequente\s+\d+\**\s*[:.?\-–—]/i,
    why: "L'etichetta numerata dello schema FAQ, usata come intestazione o come domanda. Lo schema si ferma a 3: la regola conta qualunque cifra.",
  },
  {
    id: 'faq-numbered-bare',
    kind: 'schema-echo',
    rx: /^\s*\**\s*domanda\s+frequente\s+\d+\s*\**\s*\??\s*$/i,
    why: 'La domanda E\' l\'etichetta e basta ("Domanda frequente 1"), senza nulla dietro.',
  },
  ...PROMPT_SCAFFOLD_LABELS.map((label) => ({
    id: `scaffold-${label.replace(/[^A-Za-z]+/g, '-').toLowerCase().replace(/^-|-$/g, '')}`,
    kind: 'scaffold',
    rx: new RegExp(`(?:^|[\\s\\n])${escapeRx(label)}`),
    why: `Etichetta del preambolo del prompt ("${label}"): il modello ha rispedito il proprio input.`,
  })),
  // ── Forme derivate dai letterali dello schema ───────────────────────────
  ...TEXT_LITERALS.map((literal) => ({
    id: `schema-lead-${leadOf(literal).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-|-$/g, '')}`,
    kind: 'schema-echo',
    rx: new RegExp(escapeRx(leadOf(literal)), 'i'),
    why: `Testa del valore di esempio dello schema: ${JSON.stringify(leadOf(literal))}.`,
    literal,
  })),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Rilevamento
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ogni segnaposto trovato in un valore di testo.
 *
 * @param {unknown} value
 * @returns {Array<{ rule: string, kind: string, found: string, index: number }>}
 */
export function findPromptPlaceholders(value) {
  if (typeof value !== 'string' || !value) return [];
  const hits = [];
  for (const rule of PLACEHOLDER_RULES) {
    const m = rule.rx.exec(value);
    if (!m) continue;
    hits.push({ rule: rule.id, kind: rule.kind, found: m[0].trim(), index: m.index });
  }
  return hits;
}

/** @returns {boolean} true se il valore porta almeno un segnaposto. */
export function hasPromptPlaceholder(value) {
  return findPromptPlaceholders(value).length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Riparazioni deterministiche
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Toglie l'etichetta `Domanda frequente N:` lasciando il contenuto vero.
 *
 * Osservata in 7 campi body e in 1 campo faq: il modello ha scritto una FAQ
 * REALE e le ha incollato davanti il numero dello schema. Buttare il campo
 * butterebbe contenuto buono.
 *
 *   "1. **Domanda frequente 1**: Quali sono i servizi inclusi?"
 *     → "1. Quali sono i servizi inclusi?"
 *
 * Non tocca nulla quando dietro l'etichetta non resta niente: quel caso e'
 * `faq-numbered-bare`, e va scartato, non ripulito.
 */
export function stripFaqNumberedLabels(value) {
  if (typeof value !== 'string' || !value) return { value, stripped: 0 };
  let stripped = 0;
  // `pre` si porta dentro la spaziatura: senza, «- Domanda frequente 1: X»
  // tornerebbe «-X», perche' lo spazio del bullet viene mangiato dall'etichetta.
  const out = value.replace(
    /((?:^|[\s\n*#>\-–—.)\]])\s*)\**\s*[Dd]omanda\s+frequente\s+\d+\**\s*[:.\-–—]\s*(?=\S)/g,
    (match, pre, offset, whole) => {
      // Solo se dopo l'etichetta resta contenuto vero sulla stessa riga.
      const rest = whole.slice(offset + match.length);
      const line = rest.split('\n', 1)[0].trim();
      if (line.length < 8) return match;
      stripped += 1;
      return pre;
    },
  );
  return { value: out, stripped };
}

/**
 * Dopo `stripFaqNumberedLabels` una domanda puo' restare con l'iniziale
 * minuscola («che cosa significa la domanda scomoda?»), perche' la maiuscola
 * stava sull'etichetta. Rimetterla e' deterministico e vale solo qui: e' una
 * domanda che finisce in `FAQPage.name`.
 */
function capitalizeFirstLetter(text) {
  const s = String(text || '');
  const i = s.search(/\p{L}/u);
  if (i < 0) return s;
  const ch = s[i];
  if (ch !== ch.toLowerCase()) return s;
  return s.slice(0, i) + ch.toUpperCase() + s.slice(i + 1);
}

/**
 * Toglie una riga di intestazione che ripete la DESCRIZIONE del campo dallo
 * schema (`## Analisi pratica: implicazioni, confronti, scenari`), quando e' la
 * prima riga e il corpo sotto e' reale. Osservata una volta, su
 * `confronto-imposta-cantonale-svizzera-cantoni.body2`.
 */
export function stripSchemaHeadingLine(value) {
  if (typeof value !== 'string' || !value) return { value, stripped: 0 };
  const lines = value.split('\n');
  let stripped = 0;
  while (lines.length > 2) {
    const first = lines[0].trim();
    if (!/^#{1,6}\s/.test(first)) break;
    const heading = first.replace(/^#{1,6}\s*/, '').trim();
    const echo = PLACEHOLDER_RULES.some((r) => r.kind === 'schema-echo' && r.rx.test(heading));
    if (!echo) break;
    lines.shift();
    while (lines.length && !lines[0].trim()) lines.shift();
    stripped += 1;
  }
  return { value: stripped ? lines.join('\n') : value, stripped };
}

/**
 * Taglia il campo al primo marcatore di preambolo del prompt.
 *
 * Il caso reale (`ristorni-frontalieri-…`, it + en) e' un body1 di 7.173
 * caratteri di cui gli ultimi 1.961 (27%) sono la pagina di origine seguita da
 * `HEADLINE:` e da `RECENT ARTICLE IDS (…)`. Dal marcatore in poi non c'e'
 * niente da salvare.
 *
 * ATTENZIONE — questa riparazione sta nello script di bonifica e NON nel
 * percorso di scrittura. Su un articolo gia' pubblicato togliere il preambolo
 * e' meglio che lasciarlo; su un articolo in generazione lo stesso taglio
 * NASCONDEREBBE una generazione fallita e la pubblicherebbe lo stesso. Il
 * percorso di scrittura per questo `kind` lancia (vedi `assertNoPromptPlaceholders`).
 */
export function truncateAtPromptScaffold(value) {
  if (typeof value !== 'string' || !value) return { value, removed: 0 };
  let cut = -1;
  for (const rule of PLACEHOLDER_RULES) {
    if (rule.kind !== 'scaffold') continue;
    const m = rule.rx.exec(value);
    if (m && (cut === -1 || m.index < cut)) cut = m.index;
  }
  if (cut < 0) return { value, removed: 0 };
  const kept = value.slice(0, cut).replace(/\s+$/, '');
  return { value: kept, removed: value.length - kept.length };
}

/**
 * Ripara ogni forma riparabile in un campo di testo, in ordine.
 * @returns {{ value: string, changed: boolean, residual: Array }}
 *   `residual` sono i segnaposto che restano DOPO la riparazione: se non e'
 *   vuoto, il campo non e' recuperabile in modo deterministico.
 */
export function repairTextField(value, { allowTruncate = false } = {}) {
  let out = typeof value === 'string' ? value : '';
  const before = out;
  out = stripFaqNumberedLabels(out).value;
  out = stripSchemaHeadingLine(out).value;
  if (allowTruncate) out = truncateAtPromptScaffold(out).value;
  return { value: out, changed: out !== before, residual: findPromptPlaceholders(out) };
}

// ─────────────────────────────────────────────────────────────────────────────
// FAQ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ripulisce le coppie FAQ, con **tre esiti diversi per tre casi diversi** —
 * tutti e tre osservati sul corpus:
 *
 *   · «Domanda frequente 1: che cosa significa la domanda scomoda?» → l'etichetta
 *     si toglie e resta una domanda vera. RIPARATA.
 *   · «Domanda frequente 1 basata sui fatti dell'articolo?» + «Risposta con dati
 *     DALLA FONTE. 50-100 parole.» → schema puro. SCARTATA.
 *   · «Domanda frequente 1 basata sui fatti dell'articolo?» + una risposta VERA
 *     (`tennis-donne-open-di-chiasso…`). SCARTATA lo stesso: una domanda non si
 *     inventa, e la coppia finirebbe in `FAQPage.name`.
 *
 * Sotto le 2 coppie superstiti il campo intero va tolto, non lasciato monco:
 * e' la stessa soglia che `engine/ogPagesPlugin.ts:1328` applica prima di
 * ricadere sull'euristica (`if (faqPairsFromData!.length < 2) … = null`), quindi
 * un articolo senza `faq` torna semplicemente al comportamento pre-FAQ invece
 * di pubblicare uno schema mutilato.
 *
 * Una FAQ ASSENTE e' meglio di una FAQ FINTA: l'assente non produce
 * structured data, la finta sì.
 *
 * ## `dropShort`, e perche' non e' sempre acceso
 *
 * Le due soglie `q > 10` / `a > 20` sono quelle che il filtro di FORMA in
 * `create-article.mjs` applicava gia': restano accese LI', al punto di
 * accettazione, perche' toglierle allargherebbe cio' che passa.
 *
 * Sul percorso di scrittura e nella bonifica del corpus vanno invece SPENTE.
 * Misurato: 30 file di `content/blog-body**` (de/en/fr) hanno coppie tradotte
 * corte che nessun segnaposto tocca — sono un difetto di un'altra classe, con
 * un altro proprietario. Un guard sui segnaposto che ne approfitta per
 * cancellarle sta facendo un secondo lavoro che nessuno ha misurato, ed e'
 * esattamente il modo in cui una bonifica diventa una regressione.
 *
 * @returns {{ pairs: Array<{q:string,a:string}>|null, repaired: number, dropped: Array }}
 */
export function cleanFaqPairs(pairs, { dropShort = true } = {}) {
  if (!Array.isArray(pairs)) return { pairs: null, repaired: 0, dropped: [] };
  const kept = [];
  const dropped = [];
  let repaired = 0;
  for (const pair of pairs) {
    if (!pair || typeof pair.q !== 'string' || typeof pair.a !== 'string') {
      if (dropShort) {
        dropped.push({ pair, reason: 'shape', placeholder: false });
        continue;
      }
      kept.push(pair);
      continue;
    }
    const q = stripFaqNumberedLabels(pair.q);
    const a = stripFaqNumberedLabels(pair.a);
    const nextQ = q.stripped ? capitalizeFirstLetter(q.value.trim()) : q.value.trim();
    const nextA = a.stripped ? capitalizeFirstLetter(a.value.trim()) : a.value.trim();
    const bad = [...findPromptPlaceholders(nextQ), ...findPromptPlaceholders(nextA)];
    if (bad.length) {
      dropped.push({ pair, reason: bad.map((b) => b.rule).join(','), placeholder: true });
      continue;
    }
    if (dropShort && (nextQ.length < 10 || nextA.length < 20)) {
      dropped.push({ pair, reason: 'too-short', placeholder: false });
      continue;
    }
    if (q.stripped || a.stripped) repaired += 1;
    kept.push({ ...pair, q: nextQ, a: nextA });
  }
  return { pairs: kept.length >= 2 ? kept : null, repaired, dropped };
}

/**
 * Le locali la cui `faq` e' rimasta ORFANA: `it` non ce l'ha, loro si'.
 *
 * ## Il difetto che chiude, misurato
 *
 * L'intestazione di questo modulo lo dice gia' per gli slug — «il segnaposto
 * non sopravvive come letterale: il prompt e' scritto in italiano, quindi il
 * modello ne traduce il SIGNIFICATO» — ma la bonifica del 2026-08-10 (#196) ha
 * applicato quella lezione solo dove esisteva un rilevatore. Su una FAQ
 * segnaposto ha quindi tolto la chiave dal file `it`, dove i letterali
 * italiani matchano, e NON dai file en/de/fr, dove lo stesso segnaposto era
 * gia' passato dal traduttore:
 *
 *     it → (chiave rimossa)
 *     en → 'FAQ 1 based on the facts of the article?' / 'Response with data FROM SOURCE. 50-100 words.'
 *     de → 'FAQ 1 basierend auf den Fakten des Artikels?'
 *     fr → 'Question fréquemment posée 1 basée sur les faits de l\'article ?'
 *
 * Misurato su `origin/main` il 2026-08-11: **19 articoli × 3 locali = 57
 * chiavi orfane** (10 in `blog-body`, 9 in `blog-body-ch`), tutte e sole quelle
 * di #196. Il costo non e' cosmetico: quelle 57 chiavi sono l'unico
 * fallimento del job `tests` del sito
 * (`tests/i18n-completeness.test.ts` → «consistent keys across all locales»),
 * e poiche' `pr-review-loop` gira solo su `tests` verde tenevano ferme tutte le
 * PR aperte del sito.
 *
 * ## Perche' la regola e' sull'ORFANO e non sul testo tradotto
 *
 * Inseguire il testo tradotto vorrebbe dire mantenere i letterali dello schema
 * in quattro lingue, e sarebbe una lista che il modello puo' sempre riscrivere
 * (nemmeno le tre traduzioni sopra sono uguali fra loro: `FAQ 1` in de,
 * `Question fréquemment posée 1` in fr). La relazione strutturale invece non
 * dipende dalla lingua: **la FAQ di en/de/fr e' una TRADUZIONE di quella di
 * `it`** (`translateArticle()` in create-article.mjs), quindi una traduzione
 * senza originale non e' un dato incompleto, e' un dato che non ha piu' una
 * fonte. Vale per qualunque causa abbia tolto l'originale, non solo per i
 * segnaposto.
 *
 * `hasFile` e' richiesto perche' l'assenza del file `it` e' un difetto di
 * un'altra classe (un articolo pubblicato solo in traduzione): li' cancellare
 * distruggerebbe l'unico contenuto rimasto invece di ripararlo.
 *
 * @param {Record<string, {hasFile?: boolean, hasFaq?: boolean}>} faqByLocale
 * @param {{sourceLocale?: string}} [opts]
 * @returns {string[]} locali da cui togliere la chiave, ordinate
 */
export function orphanFaqLocales(faqByLocale, { sourceLocale = 'it' } = {}) {
  if (!faqByLocale || typeof faqByLocale !== 'object') return [];
  const source = faqByLocale[sourceLocale];
  if (!source || source.hasFile !== true || source.hasFaq !== false) return [];
  return Object.entries(faqByLocale)
    .filter(([locale, state]) => locale !== sourceLocale && state && state.hasFaq === true)
    .map(([locale]) => locale)
    .sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Enforcement sul percorso di scrittura
// ─────────────────────────────────────────────────────────────────────────────

/** I campi di testo pubblicati di un `data` di articolo, appiattiti. */
export function* iterateTextFields(data) {
  if (!data || typeof data !== 'object') return;
  const alt = data.imageAlt;
  if (alt && typeof alt === 'object') {
    for (const [locale, value] of Object.entries(alt)) {
      if (typeof value === 'string') yield { path: `imageAlt.${locale}`, field: 'imageAlt', locale, value };
    }
  }
  const content = data.content;
  if (content && typeof content === 'object') {
    for (const [locale, localeContent] of Object.entries(content)) {
      if (!localeContent || typeof localeContent !== 'object') continue;
      for (const [field, value] of Object.entries(localeContent)) {
        if (typeof value !== 'string') continue;
        yield { path: `content.${locale}.${field}`, field, locale, value };
      }
    }
  }
  const seo = data.seo;
  if (seo && typeof seo === 'object') {
    for (const [field, value] of Object.entries(seo)) {
      if (typeof value === 'string') yield { path: `seo.${field}`, field: `seo.${field}`, locale: 'it', value };
    }
  }
}

/** `imageAlt` mancante: la ricetta deterministica gia' usata da `validate()`. */
const IMAGE_ALT_FALLBACK = Object.freeze({
  it: (t) => `Immagine editoriale relativa a: ${t}`,
  en: (t) => `Editorial image related to: ${t}`,
  de: (t) => `Redaktionelles Bild zu: ${t}`,
  fr: (t) => `Image éditoriale relative à: ${t}`,
});

/**
 * Il gate del percorso di scrittura. **Due risposte diverse, di proposito** —
 * la stessa asimmetria che `deriveAndSanitizeArticleSlugs()` argomenta per gli
 * slug:
 *
 *  · RIPARA, rumorosamente, dove una riparazione deterministica esiste ed e'
 *    corretta: l'etichetta FAQ numerata davanti a contenuto vero, l'intestazione
 *    che ripete lo schema, le coppie FAQ (`cleanFaqPairs`), e `imageAlt`, che
 *    ha gia' la sua ricetta a partire dal titolo in `validate()` — un alt-text
 *    segnaposto e' equivalente a un alt-text assente.
 *
 *  · LANCIA su tutto il resto. Un titolo, un excerpt, un body o un campo seo
 *    che ricopia lo schema non e' un campo da rattoppare: e' una generazione
 *    FALLITA, e i due rattoppi possibili sono entrambi peggiori del rifiuto.
 *    Derivare l'excerpt dal body1 propagherebbe il leak quando e' il body a
 *    essere contaminato — che e' esattamente il caso di `ristorni-frontalieri-…`,
 *    l'unico articolo con `scaffold` nel corpo. E troncare il preambolo
 *    pubblicherebbe come articolo i 1.961 caratteri di pagina scrapata che lo
 *    precedono.
 *
 * Gira dentro `registerArticleFiles()`, cioe' sul percorso di scrittura
 * CONDIVISO: `generate-daily-brief-article.mjs`, `generate-events-digest-article.mjs`,
 * `generate-border-wait-ranking-article.mjs` e `publish-journalist-article.mjs`
 * lo importano direttamente senza passare da `validate()`. Metterlo in
 * `validate()` sarebbe la forma esatta dell'incidente del 2026-08-09 sulla meta
 * description: una regola applicata a UN produttore invece che al percorso di
 * scrittura che condividono.
 *
 * @param {object} data
 * @returns {Array<{path: string, action: string, detail: string}>} le riparazioni fatte
 * @throws {Error} sul primo campo non recuperabile
 */
export function sanitizePromptPlaceholders(data) {
  const fixes = [];
  if (!data || typeof data !== 'object') return fixes;

  const itTitle = String(data?.content?.it?.title || data?.id || '');

  // ── FAQ, per locale ──────────────────────────────────────────────────────
  for (const [locale, localeContent] of Object.entries(data.content || {})) {
    if (!localeContent || typeof localeContent !== 'object') continue;
    if (!Array.isArray(localeContent.faq)) continue;
    // `dropShort: false` — qui si tolgono i segnaposto, non le coppie corte:
    // quelle sono di competenza del filtro di accettazione, che le ha gia'
    // viste. Vedi l'intestazione di `cleanFaqPairs`.
    const { pairs, repaired, dropped } = cleanFaqPairs(localeContent.faq, { dropShort: false });
    if (!dropped.length && !repaired) continue;
    if (pairs) {
      localeContent.faq = pairs;
    } else {
      delete localeContent.faq;
    }
    const detail = `${repaired} riparate, ${dropped.length} scartate (${dropped.map((d) => d.reason).join('; ')})`;
    fixes.push({ path: `content.${locale}.faq`, action: pairs ? 'faq-pruned' : 'faq-removed', detail });
    console.error(
      `  ⚠️ [prompt-placeholder] FAQ ${locale.toUpperCase()}: ${detail}. ` +
        (pairs
          ? `Restano ${pairs.length} coppie.`
          : 'Rimossa: sotto le 2 coppie ogPagesPlugin ricade sull\'euristica, e una FAQ assente non produce structured data — una finta si\'.'),
    );
  }

  // ── Ogni altro campo di testo ────────────────────────────────────────────
  for (const entry of iterateTextFields(data)) {
    const hits = findPromptPlaceholders(entry.value);
    if (!hits.length) continue;

    if (entry.field === 'imageAlt') {
      const build = IMAGE_ALT_FALLBACK[entry.locale] || IMAGE_ALT_FALLBACK.it;
      data.imageAlt[entry.locale] = build(itTitle);
      fixes.push({ path: entry.path, action: 'imagealt-rebuilt', detail: hits.map((h) => h.rule).join(',') });
      console.error(
        `  ⚠️ [prompt-placeholder] imageAlt ${entry.locale.toUpperCase()} era il segnaposto dello schema ` +
          `("${entry.value.slice(0, 60)}") → ricostruito dal titolo IT.`,
      );
      continue;
    }

    // Riparabile? Solo etichette/intestazioni, mai un troncamento.
    const repaired = repairTextField(entry.value, { allowTruncate: false });
    if (repaired.changed && !repaired.residual.length) {
      setTextField(data, entry, repaired.value);
      fixes.push({ path: entry.path, action: 'label-stripped', detail: hits.map((h) => h.rule).join(',') });
      console.error(
        `  ⚠️ [prompt-placeholder] ${entry.path}: rimossa l'etichetta dello schema (${hits.map((h) => h.rule).join(', ')}).`,
      );
      continue;
    }

    const rule = PLACEHOLDER_RULES.find((r) => r.id === (repaired.residual[0] || hits[0]).rule);
    throw new Error(
      `[prompt-placeholder] ${entry.path} contiene un segnaposto del prompt: ` +
        `"${(repaired.residual[0] || hits[0]).found}" (regola ${rule?.id}). ${rule?.why || ''} ` +
        'Il modello ha ricopiato lo schema invece di compilarlo: la generazione e\' FALLITA e va ripetuta, ' +
        'non rattoppata. Rattoppare questo campo pubblicherebbe come articolo il testo che lo circonda, ' +
        'che nell\'unico caso osservato era la pagina di origine scrapata. ' +
        'Se ricorre, e\' il prompt a dover cambiare, non questa rete di sicurezza.',
    );
  }
  return fixes;
}

function setTextField(data, entry, value) {
  if (entry.path.startsWith('seo.')) data.seo[entry.path.slice(4)] = value;
  else if (entry.path.startsWith('content.')) data.content[entry.locale][entry.field] = value;
}
