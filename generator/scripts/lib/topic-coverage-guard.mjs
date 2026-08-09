/**
 * topic-coverage-guard.mjs — "questo mestiere è già coperto" gate.
 *
 * ## Il difetto misurato (2026-08-09)
 *
 * Due articoli sullo stesso mestiere, pubblicati a 24 minuti di distanza:
 *
 *   15:44  frontaliere-piastrellista-ticino-stipendio-requisiti
 *          «Lavorare come piastrellista in Ticino: stipendio, requisiti e
 *           riconoscimento del titolo»
 *   16:08  lavoro-piastrellista-ticino-frontaliere
 *          «Lavorare come piastrellista in Ticino: guida per frontalieri»
 *
 * (e un terzo alle 11:30 dello stesso giorno,
 * `piastrellista-frontaliere-ticino-guadagno`.)
 *
 * Nessuno dei tre gate esistenti li vede, e non è un tuning sbagliato: è la
 * FORMA del segnale. Misurato sulla coppia reale con le soglie di produzione
 * (`checkForDuplicates`, create-article.mjs):
 *
 *   id=0.50  titolo=0.33  excerpt=0.21  entità=0.00  combinato=0.278
 *   soglie:  id 0.72 | titolo ≈0.81 (adattiva) | excerpt 0.62 | combinato 0.55
 *
 * Il token che conta — `piastrell` — è UNO su cinque-sette token di titolo. Gli
 * altri sono vocabolario di dominio («lavorare», «ticino», «frontaliere») o
 * l'inquadratura specifica di ciascun pezzo («guida» vs «stipendio requisiti
 * riconoscimento titolo»). Jaccard misura la sovrapposizione dell'INTERO
 * insieme, quindi più le due inquadrature divergono più il punteggio SCENDE,
 * mentre l'argomento resta identico. Nessuna soglia salva questa classe: per
 * catturarla con Jaccard servirebbe scendere sotto 0.33, dove finirebbe dentro
 * mezzo corpus.
 *
 * Lo stesso vale per gli altri due strati:
 *  - `preFlightEvergreenTopicCheck` usa lo stesso Jaccard sui titoli, più le
 *    "famiglie" di `evergreenTopicFamily` — che coprono i temi fiscali
 *    (permesso G/B, LAMal-CMI, AVS-INPS, telelavoro…) e NON i mestieri;
 *  - `checkSemanticNearDuplicate` (embeddings) è fail-open e la sua soglia è
 *    adattiva alla taglia del corpus: a ~3.800 articoli
 *    `computeAdaptiveNearDupCosine` restituisce ≈0.948, praticamente spenta.
 *
 * ## Perché il difetto è SISTEMATICO, non un caso sfortunato
 *
 * `buildProfessionEvergreenTopics` (evergreen-topic-generator.mjs) emette DUE
 * candidati per ogni mestiere della tassonomia, per costruzione:
 *
 *   `frontaliere ${label} ticino stipendio requisiti`
 *   `quanto guadagna un ${label} frontaliere in ticino`
 *
 * Sono lo stesso argomento con due inquadrature — cioè esattamente la coppia
 * che Jaccard non può vedere — moltiplicati per i ~70 mestieri della
 * tassonomia. Misurato sul corpus reale: 158 articoli sono guide-mestiere, e
 * 89 di essi (48 mestieri distinti) sono usciti quando lo stesso mestiere era
 * già coperto entro 90 giorni. `educatore` da solo ne ha nove.
 *
 * ## Il criterio
 *
 * Non un'altra soglia di similarità: una CHIAVE DI ARGOMENTO. Un articolo è
 * una «guida-mestiere» quando (a) il titolo o lo slug nomina un mestiere della
 * `PROFESSION_TAXONOMY` e (b) esprime intento da guida al lavoro (stipendio,
 * requisiti, «quanto guadagna», riconoscimento del titolo…). Due guide-mestiere
 * sullo stesso mestiere entro la finestra sono lo stesso argomento, quale che
 * sia la distanza lessicale fra i loro titoli.
 *
 * La congiunzione (a)∧(b) è ciò che rende il gate stretto. Presi da soli:
 *  - il solo mestiere marcherebbe 8.275 coppie in 7 giorni, perché
 *    `matchProfession` è tarato sui log di ricerca on-site e la sua tolleranza
 *    al prefisso di digitazione fa combaciare «cassa malati» con `cassiere` e
 *    «Corriere del Ticino» con `corriere`. Qui si usa `professionTopicKey`,
 *    che richiede l'UGUAGLIANZA dello stem, non il prefisso;
 *  - la sola intento-da-guida marcherebbe ogni notizia che cita uno stipendio.
 *
 * ## Immunità alle serie legittime — VERIFICATA sui dati, non a occhio
 *
 * Le serie templatizzate per comune (`trasferirsi-a-<comune>-…`,
 * `vivere-<comune>-…`) e le edizioni quotidiane `bollettino-frontaliere-<data>`
 * sono intenzionali e non devono mai essere marcate. Non lo sono per
 * costruzione, non per fortuna: non nominano un mestiere, quindi
 * `professionTopicKey` restituisce null e il gate non si attiva mai su di
 * loro. Misurato sul corpus: 0/25 serie-comune e 0/2 bollettini marcabili.
 * `article-topic-coverage-guard.test.mjs` lo asserisce sui dati reali.
 *
 * Fail-open sui dati mancanti: un articolo esistente senza data non può essere
 * collocato nella finestra e viene ignorato, così un registro incompleto non
 * blocca la pipeline.
 */
import {
  PROFESSION_TAXONOMY,
  normalizeText,
  stemToken,
} from './profession-taxonomy.mjs';

/**
 * Finestra di copertura in giorni. 90 è misurato, non scelto a sentimento: a
 * 90 giorni il gate marca 180 delle 194 coppie storiche (93%), e le 14 che
 * restano fuori sono i confronti a lunga distanza fra guide di GEOGRAFIE
 * diverse — «Educatori in Germania» vs «educatore dell'infanzia in Ticino»,
 * a 144 giorni — che non sono duplicati. Una finestra infinita le prenderebbe
 * e vieterebbe per sempre l'aggiornamento annuale legittimo di una guida
 * (un nuovo CCL, una tabella salariale nuova).
 */
export const TOPIC_COVERAGE_WINDOW_DAYS = Number.parseInt(
  process.env.TOPIC_COVERAGE_WINDOW_DAYS || '90',
  10,
) || 90;

/**
 * Intento «guida al lavoro». Volutamente più stretto del senso comune: sono i
 * termini che portano l'intento di ricerca «lavorare come X», non ogni
 * menzione di uno stipendio.
 *
 * `professione`, `carriera`, `assunzioni` e `mestiere` sono stati RIMOSSI dopo
 * la misurazione: facevano passare per guida notizie come «Riforma medici
 * famiglia: Sumai, il nodo è organizzazione e carenza professionisti», che è
 * l'unico falso positivo che le 92 coppie a 7 giorni contenessero. Senza di
 * essi il corpus non ne produce nessuno.
 */
const GUIDE_INTENT_RE = /(stipendi|salari|guadagn|retribuz|requisit|lavorare come|lavoro come|quanto guadagna|diventare|inquadrament|riconoscimento del titolo|riconoscimento del diploma)/;

/**
 * Chiave-mestiere deterministica per il testo di un articolo.
 *
 * Differisce da `matchProfession` (profession-taxonomy.mjs) su un punto solo,
 * ed è il punto che conta qui: NIENTE tolleranza al prefisso di digitazione.
 * Quella tolleranza esiste perché i log di ricerca on-site contengono termini
 * parziali («inferm» mentre l'utente digita), e su un titolo di articolo
 * produce accoppiamenti assurdi — «cassa» → `cassiere`, «medica» → `medico`.
 * Qui si richiede l'uguaglianza dello stem.
 *
 * L'alias più lungo vince, con la stessa regola di `matchProfession` (`>`
 * stretto: a parità di lunghezza vince il primo dichiarato).
 *
 * @param {string} text — di norma `${title} ${id-con-trattini-come-spazi}`
 * @returns {string|null} l'id del mestiere, o null
 */
export function professionTopicKey(text) {
  const norm = normalizeText(text);
  if (!norm) return null;
  const stems = new Set(
    norm.split(' ').filter((t) => t.length >= 3).map(stemToken),
  );
  if (stems.size === 0) return null;
  let best = null;
  for (const entry of PROFESSION_TAXONOMY) {
    for (const alias of entry.aliases) {
      const matched = alias.includes(' ')
        ? alias.split(' ').every((w) => stems.has(stemToken(w)))
        : stems.has(stemToken(alias));
      if (matched && (!best || alias.length > best.aliasLength)) {
        best = { id: entry.id, aliasLength: alias.length };
      }
    }
  }
  return best ? best.id : null;
}

/** L'articolo esprime intento «guida al lavoro»? */
export function hasProfessionGuideIntent(text) {
  return GUIDE_INTENT_RE.test(normalizeText(text));
}

/**
 * Testo su cui si decide: titolo + slug, MAI l'excerpt.
 *
 * L'excerpt è prosa e trascina dentro mestieri solo nominati di passaggio —
 * è quello che faceva salire i falsi positivi di un ordine di grandezza nella
 * misurazione. Titolo e slug sono ciò che l'articolo dichiara DI ESSERE.
 */
function decisionText(article) {
  const id = String(article?.id || '').replace(/-/g, ' ');
  return `${article?.title || ''} ${id}`;
}

/**
 * La chiave di argomento di un articolo, o null se non è una guida-mestiere.
 *
 * @param {{id?: string, title?: string}} article
 * @returns {{kind: 'profession-guide', professionId: string}|null}
 */
export function topicCoverageKey(article) {
  const text = decisionText(article);
  if (!hasProfessionGuideIntent(text)) return null;
  const professionId = professionTopicKey(text);
  if (!professionId) return null;
  return { kind: 'profession-guide', professionId };
}

/**
 * Cerca fra gli articoli già pubblicati uno che copra lo stesso argomento
 * entro la finestra.
 *
 * @param {{id?: string, title?: string}} candidate
 * @param {Array<{id?: string, title?: string, date?: string}>} existingArticles
 * @param {{now?: number|Date, windowDays?: number}} [opts]
 * @returns {{professionId: string, existingId: string, existingTitle: string, ageDays: number}|null}
 */
export function findRecentTopicCoverage(candidate, existingArticles, opts = {}) {
  const key = topicCoverageKey(candidate);
  if (!key) return null;

  const windowDays = typeof opts.windowDays === 'number'
    ? opts.windowDays
    : TOPIC_COVERAGE_WINDOW_DAYS;
  const nowMs = opts.now instanceof Date
    ? opts.now.getTime()
    : (typeof opts.now === 'number' ? opts.now : Date.now());

  let closest = null;
  for (const existing of existingArticles || []) {
    // Un articolo non è duplicato di se stesso (ripubblicazione/rigenerazione).
    if (existing?.id && candidate?.id && existing.id === candidate.id) continue;

    const existingKey = topicCoverageKey(existing);
    if (!existingKey || existingKey.professionId !== key.professionId) continue;

    // Fail-open: senza data non si può collocare nella finestra.
    const ts = existing?.date ? Date.parse(existing.date) : NaN;
    if (!Number.isFinite(ts)) continue;

    const ageDays = (nowMs - ts) / 86_400_000;
    // `ageDays < 0` = articolo datato nel futuro: lo trattiamo come recente
    // (distanza 0), non lo scartiamo — un orologio avanti non deve aprire un
    // buco nel gate.
    if (ageDays > windowDays) continue;

    const distance = Math.max(0, ageDays);
    if (!closest || distance < closest.ageDays) {
      closest = {
        professionId: key.professionId,
        existingId: existing.id,
        existingTitle: existing.title || '',
        ageDays: distance,
      };
    }
  }
  return closest;
}

/**
 * Gate bloccante, nella stessa forma di `checkForDuplicates`: lancia sul
 * duplicato, restituisce `data` altrimenti.
 *
 * @param {object} data — legge data.id e data.content.it.title
 * @param {Array<{id?: string, title?: string, date?: string}>} existingArticles
 * @param {{now?: number|Date, windowDays?: number, log?: (m: string) => void}} [opts]
 * @returns {object} lo stesso `data`
 * @throws {Error} quando il mestiere è già coperto entro la finestra
 */
export function assertTopicNotRecentlyCovered(data, existingArticles, opts = {}) {
  const log = opts.log || ((msg) => console.error(msg));
  const candidate = { id: data?.id, title: data?.content?.it?.title || '' };
  const hit = findRecentTopicCoverage(candidate, existingArticles, opts);

  if (hit) {
    const windowDays = typeof opts.windowDays === 'number'
      ? opts.windowDays
      : TOPIC_COVERAGE_WINDOW_DAYS;
    const err = new Error(
      '❌ ARGOMENTO GIÀ COPERTO:\n'
      + `   Nuovo:     "${candidate.title}" [${candidate.id}]\n`
      + `   Esistente: "${hit.existingTitle}" [${hit.existingId}]\n`
      + `   Mestiere:  ${hit.professionId} — pubblicato ${hit.ageDays.toFixed(2)} giorni fa (finestra ${windowDays}g)\n`
      + '   Due guide sullo stesso mestiere si cannibalizzano in SERP.\n'
      + '   Scegli un mestiere non ancora coperto, o un taglio che non sia una guida al lavoro.',
    );
    // Stessa semantica di un rifiuto di qualità: il selettore salta questo
    // candidato e prova il prossimo invece di abortire l'intera run.
    err.qualityReject = true;
    throw err;
  }

  const key = topicCoverageKey(candidate);
  if (key) log(`  ✅ Mestiere "${key.professionId}" non coperto di recente`);
  return data;
}
