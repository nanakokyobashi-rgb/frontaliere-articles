/**
 * Il registro dei tre contratti JSON del REWIRE set (issue #101, che nasce dalla
 * `reason` lasciata aperta dalla #92; il REWIRE originale e' l'item 3 della
 * #4974 sul repo del sito).
 *
 * ## Cosa e' un «contratto» qui, e perche' nessun guard esistente lo vede
 *
 * Tre artefatti JSON che il SITO pubblica su `cdn.frontaliereticino.ch/data/` e
 * che QUESTO repo consuma. I due capi sono due file diversi, in due repo
 * diversi, con NOMI DIVERSI, e non si importano: si parlano via HTTP.
 *
 * Questo li mette fuori da tutti e tre i guard che il ciclo ha:
 *
 *   - `loop-drift-check.mjs` confronta i file del manifest **per path**. Non
 *     esiste nessun `scripts/refresh-border-wait-window.mjs` sul sito: il capo
 *     produttore si chiama `publish-border-wait-window.mjs`. Anche registrandoli
 *     ingenuamente resterebbero invisibili, perche' i due file DEVONO essere
 *     diversi.
 *   - `loop-scripts-closure.test.mjs` risolve gli **import**. Qui non c'e'
 *     niente da risolvere.
 *   - `loop-references-exist.test.mjs` verifica che un path citato **esista**.
 *     `public/data/border-wait-ranking-window.json` sul sito esiste: la sua
 *     esistenza non dice niente sulla sua FORMA.
 *
 * E' la stessa classe del `SiteShellContract` di CLAUDE.md e del caso #45
 * (`alert-pat-down.mjs` → `gh-pat-expiry-monitor.yml`): un contratto che non ha
 * forma di import non e' coperto dai guard che seguono gli import, e passa con
 * la CI verde su entrambi i lati. Con un'aggravante: questo non ha nemmeno
 * forma di **path condiviso**, quindi sfugge anche al confronto per path.
 *
 * ## Cosa fa questo file, che il fixture da solo non farebbe
 *
 * Dichiara l'accoppiamento. Le tre coppie produttore↔consumatore smettono di
 * essere una cosa che si scopre leggendo due intestazioni in due repo e
 * diventano un dato, con sopra le asserzioni di
 * `generator/tests/rewire-json-contracts.test.mjs`.
 *
 * ## Il limite, scritto qui perche' non venga dimenticato
 *
 * Il produttore sta sul sito e da qui non e' pinnabile. Un fixture registrato
 * pinna **l'aspettativa del consumatore**: fallisce quando cambia il
 * consumatore (o quando qualcuno indebolisce la validazione del `refresh`), NON
 * quando cambia il produttore. La meta' che vede muoversi il produttore e'
 * l'altra: i `--check` dei tre `refresh` contro i dati veri, che
 * `.github/workflows/rewire-contract-watch.yml` esegue a orologio. Le due meta'
 * non sono alternative — coprono direzioni diverse, e servono entrambe.
 */

/** Cartella pubblica del sito da cui i tre `refresh` fetchano (con fallback same-origin). */
export const CDN_DATA_BASE = 'https://cdn.frontaliereticino.ch/data';

/**
 * Le tre coppie.
 *
 * `producer.path` e' un path del repo del SITO: qui non esiste, e non deve
 * esistere. E' documentazione verificabile a mano, non un riferimento risolto —
 * per questo il registro vive sotto `generator/tests/`, che
 * `loop-references-exist.test.mjs` non scandisce: dichiararlo li' costringerebbe
 * a classificarlo `site-only`, cioe' «niente qui dipende dalla sua esistenza»,
 * che e' precisamente il contrario del vero.
 *
 * `readBy[].fields` sono i nomi di campo che quel file LEGGE davvero, verificati
 * nel codice uno per uno, non dedotti dai nomi.
 *
 * `producedUnread` sono i campi che il produttore emette e che qui non legge
 * nessuno. Sono asseriti come NON letti: se domani qualcuno li leggesse, la
 * voce va tolta consapevolmente invece di scoprirlo a valle.
 */
export const REWIRE_CONTRACTS = [
  {
    id: 'border-wait-window',
    artifact: 'border-wait-ranking-window.json',
    producer: {
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      path: 'scripts/publish-border-wait-window.mjs',
    },
    consumer: {
      refresh: 'generator/scripts/refresh-border-wait-window.mjs',
      envUrl: 'BORDER_WAIT_WINDOW_URL',
      cache: 'generator/data/border-wait-ranking-window.json',
    },
    failureMode: 'hard',
    symptom:
      "l'articolo evergreen `classifica-dogane-ticino` (4 locale) viene rigenerato senza classifica: " +
      'sotto due valichi ticinesi superstiti `hasData` e\' falso, body2/body4 diventano vuoti e body1 ' +
      'diventa la copy «non ci sono ancora abbastanza dati». Un articolo che posiziona sostituito da ' +
      'uno stub, con il workflow settimanale che esce 0.',
    fixture: 'generator/tests/fixtures/rewire/border-wait-ranking-window.json',
    recorded: {
      at: '2026-08-10',
      trimmedTo: '10 valichi sui 141 pubblicati (8 ticinesi + 2 no), numeri non alterati',
    },
    readBy: [
      {
        file: 'generator/scripts/refresh-border-wait-window.mjs',
        fields: [
          'windowDays',
          'current',
          'previous',
          'weekStart',
          'weekEnd',
          'perCrossing',
          'weightedAvgMinutes',
          'totalSamples',
        ],
      },
      {
        file: 'generator/scripts/generate-border-wait-ranking-article.mjs',
        fields: ['current', 'previous', 'perCrossing'],
      },
      {
        file: 'generator/scripts/lib/border-wait-ranking.mjs',
        fields: ['weightedAvgMinutes', 'totalSamples'],
      },
    ],
    producedUnread: ['generatedFor'],
    notJsonExpect: /is not valid JSON/,
  },
  {
    id: 'border-wait-averages',
    artifact: 'border-wait-averages.json',
    producer: {
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      path: 'scripts/compute-border-wait-averages.mjs',
    },
    consumer: {
      refresh: 'generator/scripts/refresh-border-wait-averages.mjs',
      envUrl: 'BORDER_WAIT_AVERAGES_URL',
      cache: 'generator/data/border-wait-averages.json',
    },
    failureMode: 'soft',
    symptom:
      'le stringhe sono GIA\' formattate per il rendering e finiscono verbatim nel corpo di un ' +
      'articolo (`borderCrossings.ts` le assegna a `avgWaitMorning`/`avgWaitEvening`). L\'assenza e\' ' +
      'coperta dai default editoriali; il caso brutto e\' un formato che passa il gate ed e\' sbagliato.',
    fixture: 'generator/tests/fixtures/rewire/border-wait-averages.json',
    recorded: {
      at: '2026-08-10',
      trimmedTo: '10 valichi sui 20 pubblicati, stringhe non alterate',
    },
    readBy: [
      {
        file: 'generator/scripts/refresh-border-wait-averages.mjs',
        fields: ['morning', 'evening'],
      },
      {
        file: 'generator/data/borderCrossings.ts',
        fields: ['morning', 'evening'],
      },
    ],
    producedUnread: [],
    notJsonExpect: /is not valid JSON/,
  },
  {
    id: 'events-dataset',
    artifact: 'events.json',
    producer: {
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      path: 'scripts/assemble-events-dataset.mjs',
    },
    consumer: {
      refresh: 'generator/scripts/refresh-events-dataset.mjs',
      envUrl: 'EVENTS_DATASET_URL',
      cache: 'data/events.json',
    },
    failureMode: 'hard',
    symptom:
      '`loadEventsDataset()` inghiotte ogni fallimento e ritorna `{ events: [] }`, e il digest ' +
      'renderizza «nessun evento questo weekend» SOVRASCRIVENDO il digest corretto sulla URL ' +
      'evergreen `eventi-weekend-ticino`.',
    fixture: 'generator/tests/fixtures/rewire/events.json',
    recorded: {
      at: '2026-08-10',
      trimmedTo:
        '6 eventi sui 3131 pubblicati (4 TI su 3 comuni, 1 SZ, 1 senza comune ne\' canton risolti), ' +
        'descrizioni accorciate, date spostate su un weekend fisso',
    },
    readBy: [
      {
        file: 'generator/scripts/refresh-events-dataset.mjs',
        fields: ['events', 'schemaVersion', 'startDate'],
      },
      {
        file: 'generator/scripts/lib/events-utils.mjs',
        fields: ['events', 'startDate', 'endDate', 'comune', 'title', 'id'],
      },
      {
        file: 'generator/scripts/lib/events-digest-content.mjs',
        fields: ['startDate', 'startTime', 'title', 'canton'],
      },
    ],
    producedUnread: ['totalEvents'],
    notJsonExpect: /did not return JSON/,
  },
];

/** Un contratto per id — perche' i test parlino per nome invece che per indice. */
export function contract(id) {
  const found = REWIRE_CONTRACTS.find((c) => c.id === id);
  if (!found) throw new Error(`contratto REWIRE sconosciuto: ${id}`);
  return found;
}

const DAY_MS = 86_400_000;
const isoShift = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * Rimette in data la registrazione del border-wait window.
 *
 * Il `refresh` rifiuta una finestra che finisce piu' di 14 giorni fa — ed e'
 * giusto che lo faccia: e' il gate che distingue «il publisher si e' fermato»
 * da «va tutto bene». Ma una registrazione e' datata per definizione, quindi un
 * fixture congelato comincerebbe a fallire 14 giorni dopo essere stato scritto,
 * per una ragione che con la FORMA non c'entra niente — e un test che fallisce
 * da solo col tempo viene disattivato, non riparato.
 *
 * Quindi si trasla in blocco (interi giorni, entrambe le finestre, stesso
 * delta), il che lascia intatto tutto cio' che il test guarda davvero: la
 * durata delle due finestre, la loro contiguita', e ogni numero. Il gate di
 * staleness NON resta scoperto: ha un caso di mutazione tutto suo, che porta la
 * finestra indietro apposta.
 */
export function freshenWindow(payload, todayIso) {
  const target = isoShift(todayIso, -1); // il window finisce il giorno prima di oggi
  const delta = Math.round((Date.parse(`${target}T00:00:00Z`) - Date.parse(`${payload.current.weekEnd}T00:00:00Z`)) / DAY_MS);
  const shifted = structuredClone(payload);
  if (typeof shifted.generatedFor === 'string') shifted.generatedFor = isoShift(shifted.generatedFor, delta);
  for (const half of ['current', 'previous']) {
    shifted[half].weekStart = isoShift(shifted[half].weekStart, delta);
    shifted[half].weekEnd = isoShift(shifted[half].weekEnd, delta);
  }
  return shifted;
}
