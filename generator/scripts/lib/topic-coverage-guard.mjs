/**
 * topic-coverage-guard.mjs — "questo argomento è già coperto" gate.
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
 * Non un'altra soglia di similarità: una CHIAVE DI ARGOMENTO, cioè una coppia
 * `(kind, value)`. Un articolo è una «guida-mestiere» quando (a) il titolo o
 * lo slug nomina un mestiere della `PROFESSION_TAXONOMY` e (b) esprime intento
 * da guida al lavoro (stipendio, requisiti, «quanto guadagna», riconoscimento
 * del titolo…). Due articoli con la STESSA coppia `(kind, value)` entro la
 * finestra sono lo stesso argomento, quale che sia la distanza lessicale fra i
 * loro titoli.
 *
 * La congiunzione (a)∧(b) è ciò che rende il gate stretto. Presi da soli:
 *  - il solo mestiere marcherebbe 8.275 coppie in 7 giorni, perché
 *    `matchProfession` è tarato sui log di ricerca on-site e la sua tolleranza
 *    al prefisso di digitazione fa combaciare «cassa malati» con `cassiere` e
 *    «Corriere del Ticino» con `corriere`. Qui si usa `professionTopicKey`,
 *    che richiede l'UGUAGLIANZA dello stem, non il prefisso;
 *  - la sola intento-da-guida marcherebbe ogni notizia che cita uno stipendio.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## 2026-08-10 — l'immunità delle serie-comune era SBAGLIATA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Questo header sosteneva (versione del 2026-08-09) che le serie templatizzate
 * per comune — `trasferirsi-a-<comune>-…`, `vivere-<comune>-…` — fossero
 * «intenzionali e non devono mai essere marcate», con la misura «0/25
 * serie-comune marcabili». La misura era giusta, la conclusione no: 0/25 non
 * misurava l'assenza di duplicati, misurava soltanto che una chiave-MESTIERE
 * non si attiva su un nome di comune. Era una tautologia scambiata per prova.
 *
 * `buildComuneEvergreenTopics` (evergreen-topic-generator.mjs) ha esattamente
 * la stessa forma di `buildProfessionEvergreenTopics`: DUE keyword adiacenti
 * per ogni comune, sinonime nell'angle,
 *
 *   `vivere a ${name} e lavorare in ${canton} da frontaliere`
 *   `trasferirsi a ${name} da frontaliere pro e contro`
 *
 * moltiplicate per gli 85 comuni del pool (cap 40 Ticino + 25 Grigioni + 20
 * Vallese). La rotazione sequenziale del pool le pesca una dopo l'altra, e il
 * risultato è nel corpus pubblicato — coppie sullo stesso comune a minuti di
 * distanza:
 *
 *   15:18  trasferirsi-tronzano-lago-maggiore-frontaliere
 *   15:51  vivere-tronzano-lago-maggiore-lavorare-ticino-da-frontaliere
 *   00:08  vivere-maslianico-lavoro-ticino
 *   00:24  trasferirsi-a-maslianico-da-frontaliere-pro-e-contro
 *   04:52  vivere-besano-frontaliere-ticino
 *   06:06  vivere-besano-lavorare-ticino        ← due «vivere a Besano»
 *   06:18  trasferirsi-besano-da-frontaliere
 *
 * Quella coppia Besano dice anche COME dev'essere fatta la chiave: sono due
 * «vivere a», non una coppia vivere/trasferirsi. Se la chiave fosse
 * «comune + verbo» le sfuggirebbe. È «comune + INTENTO», con i due verbi che
 * collassano sullo stesso intento.
 *
 * ### Nessuna soglia di similarità le vede — misurato sui CORPI, non sui titoli
 *
 * Jaccard sui token >4 caratteri dei corpi IT delle coppie duplicate, contro
 * una baseline di due articoli non correlati:
 *
 *   0.291  vivere-tronzano-…            ~ trasferirsi-tronzano-…
 *   0.353  vivere-besano-frontaliere-…  ~ vivere-besano-lavorare-…
 *   0.190  vivere-a-porlezza-…          ~ vivere-porlezza-…-guida
 *   0.184  vivere-maslianico-…          ~ trasferirsi-a-maslianico-…
 *   0.172  trasferirsi-a-ronago-…       ~ vivere-ronago-lavorare-ticino
 *   ────
 *   0.147  baseline: stipendio-netto-2026 ~ lamal-vs-cmi (non correlati)
 *
 * 0,17-0,35 contro un rumore di fondo di 0,147: il modello scrive davvero due
 * testi diversi — cambiano gli esempi, i numeri citati, l'ordine dei paragrafi.
 * Non è duplicazione testuale, e abbassare una soglia fin lì porterebbe dentro
 * mezzo corpus. La cannibalizzazione è a livello di INTENTO DI RICERCA («vivere
 * / trasferirsi a Tronzano da frontaliere»), e solo una chiave di argomento la
 * vede. È la stessa conclusione dei mestieri, rimisurata sui comuni.
 *
 * ### La misura che sceglie le soglie (corpus 2026-08-10, 3.847 articoli)
 *
 * Chiave `comune-guide` = (nome di comune di `data/municipalities.ts`)
 * ∧ (intento residenza/pendolarismo). Congiunzione, per la stessa ragione dei
 * mestieri: il solo nome marcherebbe ogni cronaca che cita Como o Luino.
 *
 *   marcati        50 articoli su 3.847 (1,3 %)
 *   coppie ≤90g    33, su 20 comuni distinti
 *   rifiutati      26 articoli non sarebbero mai usciti
 *   falsi positivi 0
 *
 * Tre falsi positivi c'erano, e sono stati tolti misurando invece che a
 * occhio. Venivano TUTTI da `pendolarism` nell'intento — lo stesso errore che
 * `professione`/`carriera`/`assunzioni` facevano sul lato mestieri:
 *
 *   carnago-forza-italia-pendolarismo      «Carnago: Fratelli d'Italia attacca
 *                                           il pendolarismo di Forza Italia»
 *   pendolarismo-fatale-frontaliere-porlezza  «Tragedia a Porlezza: muore
 *                                              giovane frontaliere»
 *   bicicletta-insubria-varese-2026        «Pendolarismo sostenibile in bici»
 *
 * Senza `pendolarism` il corpus non ne produce nessuno, e il costo è UNA
 * coppia su 34 (la Varese qui sopra, che era un falso positivo comunque).
 * `pro e contro` e `costo della vita` invece restano: toglierli costerebbe la
 * coppia `lavena-ponte-tresa`, vera, senza guadagnare nessun falso positivo.
 *
 * ### Perché il nome di comune non è preso alla lettera
 *
 * Due restrizioni, entrambe misurate sui 518 comuni di
 * `data/municipalities.ts`:
 *
 *  1. i nomi di PIÙ parole vogliono la sequenza COMPLETA e contigua
 *     («Tronzano Lago Maggiore», «Maccagno con Pino e Veddasca»); nessuna
 *     tolleranza al primo token, che accoppierebbe «San …» e «Val …» a decine
 *     di comuni diversi;
 *  2. i nomi di UNA parola vogliono ≥4 caratteri e non essere in
 *     `AMBIGUOUS_COMUNE_TOKENS`. Quella lista non è intuizione: è il
 *     sottoinsieme dei 375 nomi di una parola che il corpus usa con un
 *     significato che NON è il comune — verificato documento per documento
 *     (`mese` 12/12 «al mese», `dazio` 2/2 dogana, `premia` 5/5 il verbo,
 *     `rossa` 2/2 «Croce Rossa», `erba` 2/3 «erba sintetica»/«Dell'Erba»,
 *     `re` 1/1 «Swiss Re»). Tutti gli altri nomi di una parola che compaiono
 *     nel corpus (varese, como, luino, gallarate, saronno, …) sono sempre il
 *     luogo, quindi restano dentro.
 *
 * ### La finestra resta 90 giorni, e anche questo è misurato
 *
 * Le 33 coppie stanno TUTTE entro 15 giorni. A 30, 90, 180, 365 e 3.650 giorni
 * il conteggio non cambia mai: 33. Allungare la finestra non comprerebbe una
 * sola coppia in più, comprerebbe solo il divieto dell'aggiornamento annuale
 * legittimo di una guida-comune. Restringerla a 7 giorni ne perderebbe 11.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ## 2026-08-10 — la stessa forma sulla sezione svizzera: `canton-theme`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Il pool nazionale (`buildDynamicEvergreenTopicsSvizzera`, create-article.mjs)
 * è pilastro-tematico × cantone, quindi ha la stessa patologia con una
 * dimensione in più. Nel corpus:
 *
 *   23:51  secondo-pilastro-lpp-svizzera-guida-2026-bern
 *   00:03  secondo-pilastro-lpp-bern-2026-guida          ← 12 minuti dopo
 *   ——     terzo-pilastro-3a-svizzera-vantaggi-2026-canton-basilea
 *          terzo-pilastro-3a-svizzero-vantaggi-2026-canton-basilea
 *                                        ↑ «svizzera» vs «svizzero», e basta
 *
 * La chiave giusta è la COPPIA (tema, cantone), non la sovrapposizione di
 * token: `premi-cassa-malati-lamal × zurigo` ≠ `… × berna` (due articoli
 * legittimi del pool), ma `secondo-pilastro-lpp × berna` = sé stesso comunque
 * lo si scriva. Il cantone può essere ASSENTE, e allora l'articolo è quello
 * nazionale — che collide solo con altri nazionali dello stesso tema, mai con
 * la variante cantonale (sono due target SERP diversi, ed è per quello che il
 * pool le genera entrambe).
 *
 * Misurato sul corpus (3.847 articoli, le due sezioni insieme perché è così
 * che il gate le vede — `loadExistingArticleSummaries` è cross-section):
 *
 *   marcati        41 articoli (40 svizzera, 1 frontaliere)
 *   coppie ≤90g    14, tutte duplicati veri, ispezionate una per una
 *   falsi positivi 0
 *
 * Anche qui le soglie vengono dalla misura, non dal gusto:
 *  - CANTONE UNICO. Un testo che ne nomina più d'uno non ha un focus, ha un
 *    confronto: «Zugo e Svitto, meno costosi di Ginevra e Vaud» veniva
 *    accoppiato al Ginevra del pool solo perché `ginevra` era il primo alias
 *    a combaciare. Con la regola del cantone unico sparisce.
 *  - INTENTO-GUIDA obbligatorio. Senza, «Voto Zurigo: alloggi e premi cassa
 *    malati» (cronaca) marcava `premi-cassa-malati-lamal-2026-canton-zurigo`
 *    (evergreen legittimo). Costa una coppia vera (`salario-medio@zurigo`) e
 *    ne toglie una falsa: sul lato del gate che rifiuta articoli, un falso
 *    positivo pesa più di un falso negativo.
 *  - `lpp` DA SOLO NON BASTA come tema, serve «secondo pilastro»: la sigla
 *    compare in «Contributi busta paga Svizzera 2026: AVS, LPP e trattenute»,
 *    che non è una guida al secondo pilastro. Nessuna coppia vera si perde —
 *    tutte le guide LPP del corpus scrivono anche «secondo pilastro».
 *  - il nazionale vuole `svizzer*` esplicito: senza, la chiave nazionale
 *    diventava il cestino di ogni articolo della sezione frontaliere che tocca
 *    un tema svizzero, e le coppie passavano da 14 a 52.
 *
 * ## Immunità alle serie legittime — VERIFICATA sui dati, non a occhio
 *
 * Le edizioni quotidiane `bollettino-frontaliere-<data>` sono intenzionali e
 * non devono mai essere marcate. Non lo sono per costruzione, non per fortuna:
 * non nominano un mestiere, non nominano un comune con intento di residenza,
 * non sono una guida tema×cantone. `article-topic-coverage-guard.test.mjs` lo
 * asserisce sui dati reali.
 *
 * Fail-open sui dati mancanti: un articolo esistente senza data non può essere
 * collocato nella finestra e viene ignorato, così un registro incompleto non
 * blocca la pipeline. Stessa scelta per l'elenco dei comuni: se
 * `data/municipalities.ts` diventa illeggibile la chiave `comune-guide` si
 * spegne invece di far esplodere la generazione — è il test a sorvegliare che
 * l'elenco resti pieno, non la produzione.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  PROFESSION_TAXONOMY,
  normalizeText,
  stemToken,
} from './profession-taxonomy.mjs';

/**
 * Finestra di copertura in giorni. 90 è misurato, non scelto a sentimento: a
 * 90 giorni il gate marca 180 delle 194 coppie storiche di mestiere (93%), e
 * le 14 che restano fuori sono i confronti a lunga distanza fra guide di
 * GEOGRAFIE diverse — «Educatori in Germania» vs «educatore dell'infanzia in
 * Ticino», a 144 giorni — che non sono duplicati. Una finestra infinita le
 * prenderebbe e vieterebbe per sempre l'aggiornamento annuale legittimo di una
 * guida (un nuovo CCL, una tabella salariale nuova).
 *
 * Le due chiavi aggiunte il 2026-08-10 confermano la stessa finestra invece di
 * volerne una propria: `comune-guide` marca 33 coppie a 30 giorni e ancora 33
 * a 3.650, `canton-theme` 14 a 30 e 16 a 3.650. Oltre i 90 giorni non c'è
 * niente da guadagnare, e c'è l'aggiornamento annuale da proteggere.
 */
export const TOPIC_COVERAGE_WINDOW_DAYS = Number.parseInt(
  process.env.TOPIC_COVERAGE_WINDOW_DAYS || '90',
  10,
) || 90;

// ══════════════════════════════════════════════════════════════════════════
// kind: 'profession-guide'
// ══════════════════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════════════════
// kind: 'comune-guide'
// ══════════════════════════════════════════════════════════════════════════

/**
 * Intento «dove abito / dove mi trasferisco».
 *
 * `pendolarism` NON è qui, ed è la riga che ha richiesto la misura: è il
 * termine che fa entrare la cronaca (l'attacco politico di Carnago, la
 * tragedia di Porlezza, la pedalata dell'Insubria — i tre soli falsi positivi
 * che il corpus produceva). Vedi l'header per i numeri.
 *
 * ── LA PREPOSIZIONE NON È PIÙ OBBLIGATORIA (2026-08-20) ───────────────────
 *
 * Era `vivere a |vivere in `, e quello spazio dopo la preposizione lasciava
 * fuori la forma che il generatore produce PIÙ spesso. Il testo di decisione è
 * `${title} ${id-con-trattini-come-spazi}`, e gli slug del pool comune non
 * portano la preposizione: `vivere-villa-guardia-lavorare-ticino` normalizza
 * in «vivere villa guardia lavorare ticino», dove dopo «vivere» c'è il nome
 * del comune. Restavano fuori anche «vivere ad Albese» (la `d` eufonica) e
 * «vivere e lavorare», che è la forma di metà dei titoli recenti.
 *
 * La misura, sul corpus intero (4.602 articoli, 2026-08-20), non su un
 * campione — e con lo stesso criterio che ha tarato il resto di questo file:
 *
 *   marcati        135 → 144  (+9)
 *   coppie ≤90g     26 →  28  (+2)
 *   falsi positivi   0 →   0  (i 9 ispezionati uno per uno)
 *
 * I 9 articoli nuovi sono tutti guide-comune vere: cinque erano i comuni
 * lasciati senza chiave e senza protezione dai doppioni (`tovo-di-sant-agata`,
 * `courmayeur`, `valpelline`, `villa-guardia`, `masciago-primo`), gli altri
 * quattro della stessa forma (`cerano-intelvi`, `lurate-caccivio`,
 * `albese-cassano`, `castelmarte`).
 *
 * Le due coppie nuove sono doppioni REALI, entrambi pubblicati lo STESSO
 * giorno — cioè esattamente ciò per cui questa chiave esiste:
 *
 *   tovo-di-sant-agata  vivere-tovo-di-sant-agata-e-lavorare-in-grigioni-da-frontaliere
 *                     ~ vivere-tovo-lavorare-grigioni
 *   courmayeur          vivere-courmayeur-e-lavorare-vallese-da-frontaliere
 *                     ~ courmayeur-lavora-vallese-frontaliere
 *
 * PERCHÉ «vivere » NUDO NON È TROPPO LARGO. Da solo lo sarebbe («vivere con
 * 2.000 euro», «costo della vita per vivere bene»), ma la chiave è una
 * CONGIUNZIONE: serve anche un nome di `data/municipalities.ts` nel testo, con
 * le due restrizioni già misurate (sequenza completa per i nomi di più parole,
 * ≥4 caratteri e non in `AMBIGUOUS_COMUNE_TOKENS` per quelli di una). È quella
 * congiunzione a reggere, ed è la ragione per cui i falsi positivi restano 0.
 *
 * Misurata anche l'alternativa più stretta, `vivere e lavorar`: prende 4 dei 9
 * articoli e **zero** coppie nuove, cioè non chiude nessuno dei due doppioni.
 * Scartata perché cura il sintomo di un titolo e non la forma dello slug.
 *
 * `conviene vivere` e `dove vivere` restano nell'alternanza: `vivere ` esige
 * lo spazio, e un testo che finisce con «dove vivere?» non ce l'ha.
 */
const RESIDENCE_INTENT_RE = /(vivere |abitare|trasferirsi|trasferirs|pro e contro|conviene vivere|costo della vita|zone consigliate|dove vivere|dove abitare|risiedere|residenza)/;

/** Il file da cui esce l'elenco dei comuni. Letto come TESTO: vedi sotto. */
const MUNICIPALITIES_SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../data/municipalities.ts',
);

/**
 * Nomi di comune che il corpus usa con un significato che NON è il comune.
 *
 * Non è una lista di sospetti: è il risultato di aver contato, per ognuno dei
 * 375 nomi di una parola, in quanti documenti del corpus il token compare, e
 * di aver letto quei documenti. Ogni voce qui sotto ha 0 occorrenze in cui il
 * token sia davvero il comune. Tutti gli altri nomi di una parola presenti nel
 * corpus (varese 153, como 101, gallarate 22, luino 16, …) sono sempre il
 * luogo e restano dentro.
 */
const AMBIGUOUS_COMUNE_TOKENS = new Set([
  'mese',   // 12/12 «al mese»
  'dazio',  // 2/2 dogana
  'premia', // 5/5 il verbo premiare
  'rossa',  // 2/2 «Croce Rossa»
  'erba',   // 2/3 «erba sintetica», «Dell'Erba»
  're',     // 1/1 «Swiss Re» (già escluso dai 4 caratteri, esplicito per chiarezza)
]);

/** Un nome di UNA parola sotto questa lunghezza non è distinguibile dal rumore. */
const MIN_SINGLE_WORD_COMUNE_LEN = 4;

/**
 * L'indice dei comuni, `primo token → [{value, words}]`.
 *
 * Letto come TESTO e non con un `import`: `data/municipalities.ts` è
 * TypeScript, e questo modulo è importato da
 * `generator/tests/article-topic-coverage-guard.test.mjs`, che la CI esegue
 * con un `node --test` nudo — nessun loader TS (generator-ci.yml lo dice
 * esplicitamente: «that suite runs under a bare node --test, which cannot
 * import TypeScript»). Un `import ... from '../../data/municipalities.ts'`
 * qui renderebbe rosso l'intero file di test su Node 22. Il regex prende solo
 * il campo `name`, quindi non tira dentro coordinate e popolazione.
 *
 * Fail-open: se il file manca o il parse rende meno di
 * `MIN_MUNICIPALITIES` nomi, l'indice resta vuoto e la chiave `comune-guide`
 * semplicemente non si attiva mai. Un elenco troncato spegne un gate, non
 * ferma la pipeline; a sorvegliare che resti pieno c'è il test.
 */
const MIN_MUNICIPALITIES = 400;
let _municipalityIndex = null;

export function municipalityNames() {
  try {
    const src = readFileSync(MUNICIPALITIES_SOURCE, 'utf-8');
    return [...src.matchAll(/^\s*\{\s*name:\s*'((?:[^'\\]|\\.)*)'/gm)]
      .map((m) => m[1].replace(/\\'/g, "'"));
  } catch {
    return [];
  }
}

function municipalityIndex() {
  if (_municipalityIndex !== null) return _municipalityIndex;
  const index = new Map();
  const names = municipalityNames();
  if (names.length < MIN_MUNICIPALITIES) {
    _municipalityIndex = index;
    return index;
  }
  for (const name of names) {
    const norm = normalizeText(name);
    if (!norm) continue;
    const words = norm.split(' ');
    if (words.length === 1) {
      // Un nome di una parola è indistinguibile dal vocabolario comune se è
      // corto o se il corpus lo usa per altro. I nomi di più parole non hanno
      // questo problema: si pretende la sequenza completa.
      if (words[0].length < MIN_SINGLE_WORD_COMUNE_LEN) continue;
      if (AMBIGUOUS_COMUNE_TOKENS.has(words[0])) continue;
    }
    if (!index.has(words[0])) index.set(words[0], []);
    index.get(words[0]).push({ value: norm.replace(/ /g, '-'), words });
  }
  _municipalityIndex = index;
  return index;
}

/** L'articolo esprime intento «residenza / trasferimento»? */
export function hasResidenceGuideIntent(text) {
  return RESIDENCE_INTENT_RE.test(normalizeText(text));
}

/**
 * Chiave-comune deterministica per il testo di un articolo.
 *
 * Sequenza COMPLETA e contigua, sempre: «Maccagno con Pino e Veddasca» non si
 * aggancia su «maccagno» da solo. Il nome più lungo vince, così «Tronzano Lago
 * Maggiore» batte un ipotetico «Tronzano».
 *
 * @param {string} text — di norma `${title} ${id-con-trattini-come-spazi}`
 * @returns {string|null} lo slug del comune, o null
 */
export function comuneTopicKey(text) {
  return comuneMatch(text)?.value ?? null;
}

/**
 * Come `comuneTopicKey`, ma dice anche DOVE il nome ha combaciato.
 *
 * La posizione non serve alla chiave — serve a `professionEvidenceIsOnlyAComuneName`,
 * che deve poter togliere dal testo esattamente quelle parole e nient'altro.
 * `comuneTopicKey` resta la porta pubblica e continua a rendere il solo slug,
 * cosi' i chiamanti e i test che la usano non cambiano.
 *
 * @returns {{value: string, start: number, words: string[]}|null}
 */
function comuneMatch(text) {
  const norm = normalizeText(text);
  if (!norm) return null;
  const index = municipalityIndex();
  if (index.size === 0) return null;
  const tokens = norm.split(' ');
  let best = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const candidates = index.get(tokens[i]);
    if (!candidates) continue;
    for (const candidate of candidates) {
      let n = 0;
      while (n < candidate.words.length && tokens[i + n] === candidate.words[n]) n += 1;
      if (n !== candidate.words.length) continue;
      if (!best || n > best.words.length) best = { value: candidate.value, start: i, words: candidate.words };
    }
  }
  return best;
}

/**
 * L'unica prova che questo sia un articolo su un MESTIERE e' il nome del
 * COMUNE di cui parla?
 *
 * ── PERCHE' ESISTE ────────────────────────────────────────────────────────
 *
 * `professionTopicKey` lavora su un SACCHETTO di stem, non su posizioni:
 * decide se un alias compare, non dove. Quindi non puo' accorgersi che il
 * token che lo ha convinto stava dentro un toponimo. E' la stessa cecita' che
 * `AMBIGUOUS_COMUNE_TOKENS` cura nella direzione opposta — li' un nome di
 * comune che non e' il comune, qui un nome di mestiere che non e' il mestiere
 * — con la differenza che quella e' una lista e questa e' una regola: un
 * elenco di toponimi-che-sembrano-mestieri andrebbe riscritto a ogni comune
 * nuovo, e i comuni sono 400+.
 *
 * ── IL CASO CHE L'HA RESA NECESSARIA ──────────────────────────────────────
 *
 * `vivere-villa-guardia-lavorare-ticino`, «Villa Guardia: vivere e lavorare
 * come frontaliere», pubblicato il 2026-08-19T07:27Z. Testo di decisione:
 *
 *     Villa Guardia: vivere e lavorare come frontaliere
 *     vivere villa guardia lavorare ticino
 *
 * «lavorare come» accende `hasProfessionGuideIntent`, e «guardia» — che qui e'
 * meta' del nome di un comune della provincia di Como — risolve sull'alias di
 * `agente-sicurezza`. L'articolo veniva classificato
 * `profession-guide:agente-sicurezza`: significa che il gate avrebbe potuto
 * bloccare una futura, legittima guida sulle guardie giurate perche' «gia'
 * coperta» da una guida su un paese, e non avrebbe protetto Villa Guardia da
 * un doppione. Ha anche reso ROSSO `article-topic-coverage-guard.test.mjs` su
 * OGNI branch, main compreso, quindi bloccato la coda di merge del repo.
 *
 * ── PERCHE' TOGLIERE IL NOME E RIPROVARE, E NON UN'ALLOWLIST ──────────────
 *
 * Il criterio e' causale, non lessicale: si toglie dal testo il nome di comune
 * che ha combaciato e si richiede la chiave-mestiere. Se sopravvive, il
 * mestiere aveva prove PROPRIE e vince come prima; se sparisce, l'unica prova
 * era il toponimo. Cosi' «Fare la guardia giurata a Villa Guardia» resta
 * `profession-guide` (la prova sopravvive alla rimozione) mentre «Villa
 * Guardia: vivere e lavorare» non lo e' piu'. Nessun mestiere perde una
 * classificazione che si reggeva su prove sue.
 */
function professionEvidenceIsOnlyAComuneName(text, professionId) {
  const comune = comuneMatch(text);
  if (!comune) return false;
  return professionTopicKey(removeWordSequence(normalizeText(text), comune.words)) !== professionId;
}

/**
 * Toglie da `norm` OGNI occorrenza della sequenza `words`.
 *
 * Due dettagli, ed entrambi sono stati sbagliati prima di essere misurati.
 *
 * OGNI occorrenza, non la prima. Il testo di decisione e' `${title} ${id}`, e
 * l'id ripete quasi sempre cio' che il titolo dice: «Villa Guardia: vivere e
 * lavorare come frontaliere vivere villa guardia lavorare ticino» contiene il
 * nome DUE volte. Togliendone una sola, l'altra basta a far sopravvivere la
 * chiave-mestiere e la guardia non scatta — che e' esattamente il risultato
 * misurato sulla prima stesura: zero articoli cambiati su 4.498.
 *
 * La SEQUENZA, non i token. Togliere i token uno per uno cancellerebbe anche
 * gli usi legittimi della stessa parola altrove nel testo: «Fare la guardia
 * giurata a Villa Guardia» perderebbe la prova vera del mestiere e finirebbe
 * classificato come comune. Togliendo solo «villa guardia» resta «fare la
 * guardia giurata a», il mestiere sopravvive, e la distinzione regge.
 */
function removeWordSequence(norm, words) {
  const tokens = norm.split(' ');
  const out = [];
  for (let i = 0; i < tokens.length;) {
    let n = 0;
    while (n < words.length && tokens[i + n] === words[n]) n += 1;
    if (n === words.length) { i += n; continue; }
    out.push(tokens[i]);
    i += 1;
  }
  return out.join(' ');
}

// ══════════════════════════════════════════════════════════════════════════
// kind: 'canton-theme'
// ══════════════════════════════════════════════════════════════════════════

/**
 * I 26 cantoni con le grafie IT/DE/FR che compaiono davvero negli slug.
 *
 * Tutti e 26 e non solo gli 8 che il pool usa oggi come `addOns`: la lista del
 * pool sta crescendo (create-article.mjs), e una chiave che la rispecchiasse
 * cambierebbe significato sotto i piedi al primo cantone aggiunto. Qui si
 * legge il TESTO dell'articolo, come per i mestieri e per i comuni.
 *
 * Le varianti «canton»/«cantone»/senza prefisso non compaiono perché non
 * servono: si cerca il nome del cantone, e il prefisso resta fuori dal match.
 */
const CANTON_ALIASES = [
  ['zurigo', ['zurigo', 'zurich', 'zuerich']],
  ['berna', ['berna', 'bern', 'berne']],
  ['lucerna', ['lucerna', 'luzern']],
  ['uri', ['uri']],
  ['svitto', ['svitto', 'schwyz']],
  ['obvaldo', ['obvaldo', 'obwalden']],
  ['nidvaldo', ['nidvaldo', 'nidwalden']],
  ['glarona', ['glarona', 'glarus']],
  ['zugo', ['zugo', 'zug']],
  ['friburgo', ['friburgo', 'fribourg', 'freiburg']],
  ['soletta', ['soletta', 'solothurn']],
  ['basilea', ['basilea', 'basel']],
  ['sciaffusa', ['sciaffusa', 'schaffhausen']],
  ['appenzello', ['appenzello', 'appenzell']],
  ['san-gallo', ['san gallo', 'sangallo', 'st gallen']],
  ['grigioni', ['grigioni', 'graubunden']],
  ['argovia', ['argovia', 'aargau']],
  ['turgovia', ['turgovia', 'thurgau']],
  ['ticino', ['ticino']],
  ['vaud', ['vaud']],
  ['vallese', ['vallese', 'wallis', 'valais']],
  ['neuchatel', ['neuchatel', 'neocastello']],
  ['ginevra', ['ginevra', 'geneve', 'genf']],
  ['giura', ['giura', 'jura']],
];

/**
 * I pilastri tematici, riconosciuti dal TESTO dell'articolo.
 *
 * Non derivati da `buildDynamicEvergreenTopicsSvizzera` né da
 * `PRIORITY_EVERGREEN_TOPICS_SVIZZERA`: quelle liste stanno crescendo, e
 * leggerle qui farebbe cambiare la chiave a ogni pilastro nuovo. Un pilastro
 * che non compare qui semplicemente non è coperto — fail-open, la direzione
 * giusta per un gate che rifiuta articoli.
 *
 * L'ordine conta: il primo che combacia vince, e `sistema-sanitario` sta prima
 * di `lamal-premi` perché una guida al sistema sanitario nomina anche la cassa
 * malati mentre il contrario non è vero (sono due pilastri distinti del pool,
 * e confonderli marcava una coppia legittima su Basilea).
 */
const CANTON_THEMES = [
  ['sistema-sanitario', /(sistema sanitario)/],
  ['lpp', /(secondo pilastro)/],
  ['terzo-pilastro', /(terzo pilastro|pilastro 3a)/],
  ['lamal-premi', /(premi cassa malati|premi lamal|premi della cassa malati|premi assicurazione malattia)/],
  ['imposta-cantonale', /(impost[ae] cantonal[ei])/],
  ['dichiarazione-imposte', /(dichiarazione (delle )?imposte)/],
  ['costo-vita', /(costo (della )?vita)/],
  ['affitti', /(mercato immobiliare|affitti)/],
  ['salario-medio', /(salari medi|salario medio)/],
  ['cercare-lavoro', /(cercare lavoro|cercare un lavoro|ricerca di lavoro)/],
];

/**
 * Intento «guida», il terzo braccio della congiunzione. Senza, la cronaca
 * cantonale marcava gli evergreen del pool: «Voto Zurigo: alloggi e premi
 * cassa malati» bloccava `premi-cassa-malati-lamal-2026-canton-zurigo`.
 */
const CANTON_GUIDE_INTENT_RE = /(guida|confronto|confrontare|come funziona|come scegliere|vantaggi|strategi|quanto costa|calcolo|requisit|funzionamento)/;

/** Il valore «nessun cantone nominato»: l'articolo nazionale. */
const NATIONAL_CANTON = 'svizzera';

/**
 * Chiave (tema × cantone) per la sezione svizzera.
 *
 * @param {string} text — di norma `${title} ${id-con-trattini-come-spazi}`
 * @returns {string|null} `tema:cantone`, o null
 */
export function cantonThemeTopicKey(text) {
  const norm = normalizeText(text);
  if (!norm) return null;
  if (!CANTON_GUIDE_INTENT_RE.test(norm)) return null;

  const named = CANTON_ALIASES
    .filter(([, aliases]) => aliases.some((a) => new RegExp(`(^| )${a}( |$)`).test(norm)))
    .map(([id]) => id);
  // Più di un cantone = un confronto, non un focus. «Zugo e Svitto, meno
  // costosi di Ginevra e Vaud» non è la guida-Ginevra del pool.
  if (named.length > 1) return null;
  // Nessun cantone: è l'articolo nazionale, ma solo se lo dichiara. Senza
  // questo requisito la chiave nazionale diventa il cestino di ogni articolo
  // della sezione frontaliere che sfiora un tema svizzero (coppie 14 → 52).
  if (named.length === 0 && !/svizzer/.test(norm)) return null;
  const canton = named.length === 1 ? named[0] : NATIONAL_CANTON;

  const theme = CANTON_THEMES.find(([, re]) => re.test(norm));
  if (!theme) return null;
  return `${theme[0]}:${canton}`;
}

// ══════════════════════════════════════════════════════════════════════════
// La chiave, e il gate
// ══════════════════════════════════════════════════════════════════════════

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
 * Etichetta umana per il messaggio d'errore, e la riga che spiega PERCHÉ due
 * articoli con quella chiave si cannibalizzano.
 */
const TOPIC_KINDS = {
  'profession-guide': {
    label: 'Mestiere',
    why: 'Due guide sullo stesso mestiere si cannibalizzano in SERP.',
    advice: 'Scegli un mestiere non ancora coperto, o un taglio che non sia una guida al lavoro.',
  },
  'comune-guide': {
    label: 'Comune',
    why: 'Due guide «vivere/trasferirsi» sullo stesso comune si cannibalizzano in SERP.',
    advice: 'Scegli un comune non ancora coperto, o un taglio che non sia una guida alla residenza.',
  },
  'canton-theme': {
    label: 'Tema × cantone',
    why: 'Due guide sullo stesso tema per lo stesso cantone si cannibalizzano in SERP.',
    advice: 'Scegli un altro cantone, un altro pilastro tematico, o un taglio che non sia una guida.',
  },
};

/**
 * La chiave di argomento di un articolo, o null se non ne ha nessuna.
 *
 * L'ordine è quello di scoperta dei tre difetti e non ha effetto misurabile:
 * sul corpus 2026-08-10 nessun articolo prende più di una chiave
 * (`profession-guide` ∩ `comune-guide` = 0, e le altre due intersezioni sono
 * vuote per la stessa ragione — gli intenti sono disgiunti). Se un giorno
 * smettesse di essere vero, il primo che combacia vince e il gate resta
 * comunque conservativo: una chiave sola, mai due blocchi per lo stesso pezzo.
 *
 * @param {{id?: string, title?: string}} article
 * @returns {{kind: 'profession-guide'|'comune-guide'|'canton-theme', value: string}|null}
 */
export function topicCoverageKey(article) {
  const text = decisionText(article);
  const cached = _keyCache.get(text);
  if (cached !== undefined) return cached;
  const key = computeTopicCoverageKey(text);
  _keyCache.set(text, key);
  return key;
}

function computeTopicCoverageKey(text) {
  if (hasProfessionGuideIntent(text)) {
    const professionId = professionTopicKey(text);
    // Il mestiere vince ancora per primo, ma non piu' quando la sua UNICA
    // prova e' il nome del comune di cui l'articolo parla — vedi
    // professionEvidenceIsOnlyAComuneName.
    if (professionId && !professionEvidenceIsOnlyAComuneName(text, professionId)) {
      return { kind: 'profession-guide', value: professionId };
    }
  }
  if (hasResidenceGuideIntent(text)) {
    const comuneId = comuneTopicKey(text);
    if (comuneId) return { kind: 'comune-guide', value: comuneId };
  }
  const cantonTheme = cantonThemeTopicKey(text);
  if (cantonTheme) return { kind: 'canton-theme', value: cantonTheme };
  return null;
}

/**
 * Memoizzazione sul testo di decisione.
 *
 * Non è un'ottimizzazione opportunistica, è ciò che tiene il gate usabile:
 * `preFlightEvergreenCheck` chiama `findRecentTopicCoverage` una volta per
 * candidato — centinaia per run — e ogni chiamata rideriva la chiave di tutti
 * i ~3.850 articoli esistenti. Misurato PRIMA di questa PR, con la sola
 * chiave-mestiere: 51 ms per chiamata, ≈15 s per 300 candidati; le due chiavi
 * nuove lo avrebbero peggiorato. Con la cache il costo è di una passata sola.
 *
 * Chiave sul testo e non sull'oggetto: i loader di create-article.mjs
 * ricostruiscono gli oggetti a ogni `map`, quindi una WeakMap sull'articolo
 * non colpirebbe mai.
 */
const _keyCache = new Map();

/** Solo per i test: svuota la memoizzazione. */
export function resetTopicCoverageCaches() {
  _keyCache.clear();
  _municipalityIndex = null;
}

/**
 * Cerca fra gli articoli già pubblicati uno che copra lo stesso argomento
 * entro la finestra.
 *
 * @param {{id?: string, title?: string}} candidate
 * @param {Array<{id?: string, title?: string, date?: string}>} existingArticles
 * @param {{now?: number|Date, windowDays?: number}} [opts]
 * @returns {{kind: string, value: string, existingId: string, existingTitle: string, ageDays: number}|null}
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
    // La coppia INTERA: un comune e un mestiere che si chiamassero uguale non
    // sono lo stesso argomento.
    if (!existingKey || existingKey.kind !== key.kind || existingKey.value !== key.value) continue;

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
        kind: key.kind,
        value: key.value,
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
 * @throws {Error} quando l'argomento è già coperto entro la finestra
 */
export function assertTopicNotRecentlyCovered(data, existingArticles, opts = {}) {
  const log = opts.log || ((msg) => console.error(msg));
  const candidate = { id: data?.id, title: data?.content?.it?.title || '' };
  const hit = findRecentTopicCoverage(candidate, existingArticles, opts);

  if (hit) {
    const windowDays = typeof opts.windowDays === 'number'
      ? opts.windowDays
      : TOPIC_COVERAGE_WINDOW_DAYS;
    const kind = TOPIC_KINDS[hit.kind] || {
      label: hit.kind, why: 'Due articoli sullo stesso argomento si cannibalizzano in SERP.', advice: 'Scegli un altro argomento.',
    };
    const err = new Error(
      '❌ ARGOMENTO GIÀ COPERTO:\n'
      + `   Nuovo:     "${candidate.title}" [${candidate.id}]\n`
      + `   Esistente: "${hit.existingTitle}" [${hit.existingId}]\n`
      + `   ${kind.label}: ${hit.value} (${hit.kind}) — pubblicato ${hit.ageDays.toFixed(2)} giorni fa (finestra ${windowDays}g)\n`
      + `   ${kind.why}\n`
      + `   ${kind.advice}`,
    );
    // Stessa semantica di un rifiuto di qualità: il selettore salta questo
    // candidato e prova il prossimo invece di abortire l'intera run.
    err.qualityReject = true;
    throw err;
  }

  const key = topicCoverageKey(candidate);
  if (key) {
    const label = (TOPIC_KINDS[key.kind] || { label: key.kind }).label;
    log(`  ✅ ${label} "${key.value}" non coperto di recente`);
  }
  return data;
}
