/**
 * Il registro dei contratti JSON del REWIRE set (issue #101, che nasce dalla
 * `reason` lasciata aperta dalla #92; il REWIRE originale e' l'item 3 della
 * #4974 sul repo del sito).
 *
 * ## Cosa e' un «contratto» qui, e perche' nessun guard esistente lo vede
 *
 * Artefatti JSON che il SITO pubblica su `cdn.frontaliereticino.ch/data/` e
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
 * Dichiara l'accoppiamento. Le coppie produttore↔consumatore smettono di
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
 * l'altra: i `--check` dei `refresh` contro i dati veri, che
 * `.github/workflows/rewire-contract-watch.yml` esegue a orologio. Le due meta'
 * non sono alternative — coprono direzioni diverse, e servono entrambe.
 */

/** Cartella pubblica del sito da cui i `refresh` fetchano (con fallback same-origin). */
export const CDN_DATA_BASE = 'https://cdn.frontaliereticino.ch/data';

/**
 * Le coppie: le tre del REWIRE originale piu' i dataset di categoria (D11)
 * costruiti con la stessa forma (carburanti, avvisi, servizi, fisco, pensioni).
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
 *
 * `productionFetch` dichiara CHI scarica davvero l'artefatto (il `refresh`
 * senza `--check`): `workflows` sono i workflow di produzione, `ci` quelli di
 * test. Oppure `none` con il motivo, quando nessun workflow lo scarica. Il
 * test lo confronta in entrambe le direzioni con le invocazioni nei workflow:
 * un consumatore che legge una cache che nessun job riempie non e' piu'
 * invisibile (il caso `border-wait-averages`, rimasto non scaricato da quando
 * il REWIRE l'ha spostato qui senza che nessun test lo notasse).
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
    productionFetch: {
      workflows: ['generate-border-wait-ranking-weekly.yml'],
      ci: ['generator-ci.yml'],
    },
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
      'le stringhe sono GIA\' formattate per il rendering: `borderCrossings.ts` le assegna a ' +
      '`avgWaitMorning`/`avgWaitEvening`, che OGGI nessun generatore del corpus legge (verificato ' +
      '2026-10-05: `borderCrossings.ts` e\' importato solo da `evergreen-topic-generator.mjs`, per la ' +
      'geografia). L\'assenza e\' coperta dai default editoriali; il caso brutto, il giorno in cui un ' +
      'articolo le stampera\', e\' un formato che passa il gate ed e\' sbagliato.',
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
    productionFetch: {
      none:
        'nessun workflow lo scarica e nessun generatore ne legge i valori: l\'overlay di ' +
        '`borderCrossings.ts` resta vuoto in produzione senza effetti su alcun articolo. Il primo ' +
        'generatore che stampera\' `avgWaitMorning`/`avgWaitEvening` deve cablare ' +
        '`npm run refresh:border-wait` nel proprio workflow e spostare questa voce in `workflows`.',
    },
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
    productionFetch: {
      workflows: ['refresh-events-digest.yml'],
    },
  },
  {
    // Quarto artefatto, fuori dal REWIRE originale ma con la stessa forma:
    // dataset di categoria carburanti per cantone (P9b del programma sezioni
    // cantonali, decisione D11). Nessun generatore lo legge ancora: lo
    // leggeranno gli hub cantonali (P10), e a quel punto i loro file entrano
    // in `readBy`.
    id: 'fuel-cantons',
    artifact: 'fuel-prices-cantons.json',
    producer: {
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      path: 'scripts/build-fuel-cantons-dataset.mjs',
    },
    consumer: {
      refresh: 'generator/scripts/refresh-fuel-cantons.mjs',
      envUrl: 'FUEL_CANTONS_URL',
      cache: 'generator/data/fuel-prices-cantons.json',
    },
    failureMode: 'soft',
    symptom:
      'i prezzi finiscono come numeri in un blocco dati degli hub cantonali: un\'unita\' cambiata ' +
      '(centesimi, millesimi), una valuta scambiata fra lato CH ed estero o un dataset fermo da giorni ' +
      'stamperebbero un confronto CH/estero sbagliato senza che niente fallisca. L\'assenza invece e\' ' +
      'coperta: senza cache il blocco non compare.',
    fixture: 'generator/tests/fixtures/rewire/fuel-prices-cantons.json',
    recorded: {
      at: '2026-10-05',
      trimmedTo:
        '8 record sui 32 di un run locale del producer (TI CH+IT, GE FR, SG AT), numeri non alterati; ' +
        'blocchi di testa (cantons, sources, coverage, exchangeRate) completi',
    },
    readBy: [
      {
        file: 'generator/scripts/refresh-fuel-cantons.mjs',
        fields: [
          'schemaVersion',
          'generatedAt',
          'cantons',
          'records',
          'canton',
          'side',
          'fuel',
          'currency',
          'avg',
          'min',
          'stations',
          'observedAt',
          'source',
        ],
      },
    ],
    producedUnread: ['median', 'area', 'coverage', 'exchangeRate', 'sources'],
    notJsonExpect: /is not valid JSON/,
    productionFetch: {
      none:
        'nessun generatore legge ancora la cache (P9b consegna solo refresh + contratto): il ' +
        'producer degli hub cantonali (P10) deve cablare `npm run refresh:fuel-cantons` nel proprio ' +
        'workflow e spostare questa voce in `workflows`. Fino ad allora la forma e\' sorvegliata ' +
        'solo dal `--check` di rewire-contract-watch.yml.',
    },
  },
  {
    id: 'canton-notices',
    artifact: 'canton-notices.json',
    producer: {
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      path: 'scripts/crawl-canton-notices.mjs',
    },
    consumer: {
      refresh: 'generator/scripts/refresh-canton-notices.mjs',
      envUrl: 'CANTON_NOTICES_URL',
      cache: 'generator/data/canton-notices.json',
    },
    failureMode: 'soft',
    symptom:
      'il blocco «avvisi ufficiali» degli hub cantonali (P10) elenca titolo, link e data di comunicati ' +
      'fiscali, AVS/pensioni, mobilita\' e servizi: un documento troncato o di un\'altra forma metterebbe ' +
      'negli hub link sbagliati o vuoti come se fossero l\'elenco ufficiale.',
    fixture: 'generator/tests/fixtures/rewire/canton-notices.json',
    recorded: {
      at: '2026-10-05',
      trimmedTo: '205 avvisi sui 1041 del giro (max 10 per cantone, 21 cantoni), registro e salute ridotti al sommario',
    },
    freshen: 'shift-timestamps',
    readBy: [
      {
        file: 'generator/scripts/refresh-canton-notices.mjs',
        fields: ['notices', 'canton', 'publishedAt'],
      },
      {
        file: 'generator/scripts/lib/canton-notices-data.mjs',
        fields: ['schemaVersion', 'generatedAt', 'notices', 'id', 'canton', 'category', 'title', 'url', 'publishedAt', 'observedAt', 'source'],
      },
    ],
    producedUnread: ['sourcesRegistry', 'totalNotices', 'health', 'language'],
    notJsonExpect: /is not valid JSON/,
    productionFetch: {
      none:
        'nessun generatore legge ancora la cache (P9g consegna solo refresh + contratto): il ' +
        'producer degli hub cantonali (P10) deve cablare `npm run refresh:canton-notices` nel proprio ' +
        'workflow e spostare questa voce in `workflows`. Fino ad allora la forma e\' sorvegliata ' +
        'dal `--check` di rewire-contract-watch.yml e di generator-ci.yml.',
    },
  },
  // ── P9f: i quattro input dell'aggregatore dei servizi ─────────────────────
  // Un solo consumatore per quattro artefatti: l'armatura serve gli altri tre
  // dai loro fixture mentre ne esercita uno (`consumer.inputKey`), e la cache e'
  // una VISTA derivata, non il documento scaricato (`consumer.view`).
  {
    id: 'health-premiums',
    artifact: 'health-premiums.json',
    producer: {
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      path: 'scripts/fetch-health-premiums.mjs',
    },
    consumer: {
      refresh: 'generator/scripts/refresh-canton-services-data.mjs',
      envUrl: 'HEALTH_PREMIUMS_URL',
      cache: 'generator/data/canton-services.json',
      view: true,
      inputKey: 'premiums',
    },
    failureMode: 'soft',
    symptom:
      'il blocco premi dell\'hub servizi riporta minimo/mediana/massimo del premio adulto standard per ' +
      'regione: una chiave cambiata (classe d\'eta\', franchigia, modello) darebbe cifre di un\'altra base.',
    fixture: 'generator/tests/fixtures/rewire/health-premiums.json',
    recorded: {
      at: '2026-10-05',
      trimmedTo: 'quotes ridotte a 2 assicuratori (CSS id 8, id 32) e alla sola base ERW/con infortunio/franchigia 300, niente comuni ne\' premi per comune',
    },
    freshen: 'current-year',
    readBy: [
      {
        file: 'generator/scripts/lib/canton-services-data.mjs',
        fields: ['year', 'quotes', 'insurers', 'ERW', 'withAccident', 'standard', 'fetchedAt'],
      },
    ],
    producedUnread: ['rankings'],
    notJsonExpect: /is not valid JSON/,
    productionFetch: {
      none:
        'nessun generatore legge ancora la vista dei servizi (P9f consegna solo aggregatore + ' +
        'contratti): il producer degli hub cantonali (P10) deve cablare `npm run refresh:canton-services` ' +
        'nel proprio workflow e spostare questa voce in `workflows`. Fino ad allora la forma e\' ' +
        'sorvegliata dal `--check` di rewire-contract-watch.yml e di generator-ci.yml.',
    },
  },
  {
    id: 'plate-auctions',
    artifact: 'plate-auctions.json',
    producer: {
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      path: 'functions/index.js (refreshPlateAuctions) + .github/workflows/refresh-plate-auctions.yml',
    },
    consumer: {
      refresh: 'generator/scripts/refresh-canton-services-data.mjs',
      envUrl: 'PLATE_AUCTIONS_URL',
      cache: 'generator/data/canton-services.json',
      view: true,
      inputKey: 'plateAuctions',
    },
    failureMode: 'soft',
    symptom:
      'il blocco aste dell\'hub servizi conta le aste attive e cita le offerte piu\' alte con il link ' +
      'ufficiale: uno stato o un campo rinominato svuoterebbe il blocco senza errori.',
    fixture: 'generator/tests/fixtures/rewire/plate-auctions.json',
    recorded: {
      at: '2026-10-05',
      trimmedTo: '2 aste attive per fonte (36 su 17720), storico tolto, fonti ridotte ai campi pubblici',
    },
    freshen: 'shift-timestamps',
    readBy: [
      {
        file: 'generator/scripts/lib/canton-services-data.mjs',
        fields: ['schema', 'generatedAt', 'auctions', 'sources', 'sourceKey', 'auctionStatus', 'endsAt', 'currentBidChf', 'normalizedPlate', 'officialDetailUrl', 'officialUrl', 'status'],
      },
    ],
    producedUnread: ['complete', 'bidCount'],
    notJsonExpect: /is not valid JSON/,
    productionFetch: {
      none:
        'nessun generatore legge ancora la vista dei servizi (P9f consegna solo aggregatore + ' +
        'contratti): il producer degli hub cantonali (P10) deve cablare `npm run refresh:canton-services` ' +
        'nel proprio workflow e spostare questa voce in `workflows`. Fino ad allora la forma e\' ' +
        'sorvegliata dal `--check` di rewire-contract-watch.yml e di generator-ci.yml.',
    },
  },
  {
    id: 'pharmacy-duty-cantons',
    artifact: 'pharmacy-duty-cantons.json',
    producer: {
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      path: 'scripts/publish-pharmacy-duty-cantons.mjs',
    },
    consumer: {
      refresh: 'generator/scripts/refresh-canton-services-data.mjs',
      envUrl: 'PHARMACY_DUTY_CANTONS_URL',
      cache: 'generator/data/canton-services.json',
      view: true,
      inputKey: 'pharmacyDuties',
    },
    failureMode: 'soft',
    symptom:
      'il blocco turni farmacia dell\'hub servizi elenca le prossime farmacie di turno: un rilascio non ' +
      'fresco pubblicato come buono manderebbe la gente nella farmacia sbagliata.',
    fixture: 'generator/tests/fixtures/rewire/pharmacy-duty-cantons.json',
    recorded: {
      at: '2026-10-05',
      trimmedTo: '3 turni per gruppo cantonale (6 gruppi con fonte ufficiale)',
    },
    freshen: 'shift-timestamps',
    readBy: [
      {
        file: 'generator/scripts/lib/canton-services-data.mjs',
        fields: ['schemaVersion', 'cantons', 'duties', 'state', 'fetchedAt', 'sourceUrl', 'dutyHubPath', 'pharmacy', 'city', 'coverageName', 'dutyType', 'startsAt', 'endsAt'],
      },
    ],
    producedUnread: ['windowDays', 'unresolvedDuties'],
    notJsonExpect: /is not valid JSON/,
    productionFetch: {
      none:
        'nessun generatore legge ancora la vista dei servizi (P9f consegna solo aggregatore + ' +
        'contratti): il producer degli hub cantonali (P10) deve cablare `npm run refresh:canton-services` ' +
        'nel proprio workflow e spostare questa voce in `workflows`. Fino ad allora la forma e\' ' +
        'sorvegliata dal `--check` di rewire-contract-watch.yml e di generator-ci.yml.',
    },
  },
  {
    id: 'weather-snapshot',
    artifact: 'weather-snapshot.json',
    producer: {
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      path: 'scripts/update-weather.ts (copiato in dist/data da build-plugins/weatherCityPagesPlugin.ts)',
    },
    consumer: {
      refresh: 'generator/scripts/refresh-canton-services-data.mjs',
      envUrl: 'WEATHER_SNAPSHOT_URL',
      cache: 'generator/data/canton-services.json',
      view: true,
      inputKey: 'weather',
    },
    failureMode: 'soft',
    symptom:
      'il blocco meteo dell\'hub servizi riporta temperatura e massime/minime delle citta\' del cantone: ' +
      'uno snapshot fermo pubblicherebbe il meteo di giorni fa come attuale.',
    fixture: 'generator/tests/fixtures/rewire/weather-snapshot.json',
    recorded: {
      at: '2026-10-05',
      trimmedTo: '3 citta\' su 8 (lugano, bellinzona, como), 2 giorni di previsione, niente orario ne\' allerte',
    },
    freshen: 'shift-timestamps',
    readBy: [
      {
        file: 'generator/scripts/lib/canton-services-data.mjs',
        fields: ['generatedAt', 'cities', 'current', 'temperature', 'weatherCode', 'daily7', 'tempMax', 'tempMin', 'precipProb'],
      },
    ],
    producedUnread: ['alerts', 'confidence'],
    notJsonExpect: /is not valid JSON/,
    productionFetch: {
      none:
        'nessun generatore legge ancora la vista dei servizi (P9f consegna solo aggregatore + ' +
        'contratti): il producer degli hub cantonali (P10) deve cablare `npm run refresh:canton-services` ' +
        'nel proprio workflow e spostare questa voce in `workflows`. Fino ad allora la forma e\' ' +
        'sorvegliata dal `--check` di rewire-contract-watch.yml e di generator-ci.yml.',
    },
  },
  {
    id: 'canton-tax',
    artifact: 'canton-tax/latest.json',
    producer: {
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      path: 'scripts/fetch-canton-tax-data.mjs',
    },
    consumer: {
      refresh: 'generator/scripts/refresh-canton-tax.mjs',
      envUrl: 'CANTON_TAX_URL',
      cache: 'generator/data/canton-tax.json',
    },
    failureMode: 'hard',
    freshen: 'shift-year',
    symptom:
      'gli hub fiscali cantonali e il brief di fattualita\' degli articoli cantonali citerebbero onere e ' +
      'aliquote alla fonte non verificati o di un anno vecchio: e\' la classe di cifre per cui 94 evergreen ' +
      'svizzeri su 110 sono stati bocciati al fact-check.',
    fixture: 'generator/tests/fixtures/rewire/canton-tax.json',
    recorded: {
      at: '2026-10-05',
      trimmedTo:
        '26 cantoni, onere del solo anno del dataset (il produttore pubblica anche i due precedenti), ' +
        'tariffe alla fonte ridotte ai codici A0/R0 senza imposta minima; numeri non alterati',
    },
    readBy: [
      {
        file: 'generator/scripts/refresh-canton-tax.mjs',
        fields: ['schemaVersion', 'year', 'burden', 'incomeBracketsCHF', 'cantons', 'burdenPct', 'withholding', 'ratesPct', 'A0'],
      },
    ],
    producedUnread: ['generatedAt', 'sources', 'taxAuthority', 'deadlines', 'deadlinesSource', 'withholdingSource', 'capital'],
    productionFetch: {
      none:
        'nessun generatore legge ancora la cache (P9d/P9e consegnano solo refresh + contratto): ' +
        'gli hub fiscali (P10) e il brief di fattualita\' di create-article devono cablare `npm run refresh:canton-tax` nel proprio workflow e spostare questa voce in ' +
        '`workflows`. Fino ad allora la forma e\' sorvegliata da rewire-contract-watch.yml e generator-ci.yml.',
    },
    notJsonExpect: /did not return JSON/,
  },
  {
    id: 'pension-parameters',
    artifact: 'pension-parameters/latest.json',
    producer: {
      repo: 'valerielinc-ops/frontaliere-si-o-no',
      path: 'scripts/fetch-pension-parameters.mjs',
    },
    consumer: {
      refresh: 'generator/scripts/refresh-pension-parameters.mjs',
      envUrl: 'PENSION_PARAMETERS_URL',
      cache: 'generator/data/pension-parameters.json',
    },
    failureMode: 'hard',
    freshen: 'shift-year',
    symptom:
      'rendita AVS, soglie LPP e massimali 3a di un anno vecchio finirebbero negli hub pensioni e nel ' +
      'brief di fattualita\': il sito stesso ha pubblicato 2\'450 CHF di rendita massima 2026 quando la ' +
      'cifra ufficiale era 2\'520.',
    fixture: 'generator/tests/fixtures/rewire/pension-parameters.json',
    recorded: {
      at: '2026-10-05',
      trimmedTo: 'documento intero (26 cantoni), numeri non alterati',
    },
    readBy: [
      {
        file: 'generator/scripts/refresh-pension-parameters.mjs',
        fields: [
          'schemaVersion',
          'year',
          'federal',
          'avs',
          'minMonthlyCHF',
          'maxMonthlyCHF',
          'lpp',
          'entryThresholdCHF',
          'coordinationDeductionCHF',
          'maxInsuredSalaryCHF',
          'minInterestRatePct',
          'minConversionRatePct',
          'pillar3a',
          'maxWithLppCHF',
          'maxWithoutLppCHF',
          'cantons',
          'compensationFund',
          'url',
          'name',
        ],
      },
    ],
    producedUnread: ['generatedAt', 'sources', 'contributions', 'unemployment', 'publicPensionFund', 'capitalWithdrawalTax'],
    productionFetch: {
      none:
        'nessun generatore legge ancora la cache (P9d/P9e consegnano solo refresh + contratto): ' +
        'gli hub pensioni (P10) e il brief di fattualita\' di create-article devono cablare `npm run refresh:pension-parameters` nel proprio workflow e spostare questa voce in ' +
        '`workflows`. Fino ad allora la forma e\' sorvegliata da rewire-contract-watch.yml e generator-ci.yml.',
    },
    notJsonExpect: /did not return JSON/,
  },
];

/**
 * Rimette in data una registrazione che ha un gate di freschezza nel
 * consumatore (stesso ragionamento di `freshenWindow`: un fixture congelato
 * fallirebbe da solo col calendario per una ragione che con la FORMA non
 * c'entra).
 *
 * - `shift-timestamps`: ogni timestamp ISO del documento trasla dello stesso
 *   delta (ancora: `generatedAt`), ogni data `YYYY-MM-DD` dello stesso numero
 *   di giorni — l'ordine e le distanze, cioe' cio' che il consumatore misura,
 *   restano identici;
 * - `current-year`: il campo `year` diventa l'anno in corso (i premi sono
 *   annuali e il consumatore rifiuta un anno passato).
 *
 * I gate di freschezza restano coperti dai casi di mutazione dedicati.
 */
export function freshenRecording(c, payload, nowMs = Date.now()) {
  if (c.freshen === 'current-year') return { ...structuredClone(payload), year: new Date(nowMs).getUTCFullYear() };
  if (c.freshen === 'shift-year') return freshenYear(payload, new Date(nowMs).getUTCFullYear());
  if (c.freshen !== 'shift-timestamps') return payload;
  const anchor = Date.parse(payload.generatedAt);
  const delta = nowMs - 3600_000 - anchor; // un'ora fa: «appena pubblicato»
  const days = Math.round(delta / DAY_MS);
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(v)) return new Date(Date.parse(v) + delta).toISOString();
    if (typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v)) return isoShift(v, days);
    return v;
  };
  return walk(payload);
}

/** Un contratto per id — perche' i test parlino per nome invece che per indice. */
export function contract(id) {
  const found = REWIRE_CONTRACTS.find((c) => c.id === id);
  if (!found) throw new Error(`contratto REWIRE sconosciuto: ${id}`);
  return found;
}

const DAY_MS = 86_400_000;
const isoShift = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * Rimette in data la registrazione del dataset carburanti per cantone: il
 * `refresh` rifiuta un `generatedAt` piu' vecchio di 7 giorni (il sito lo
 * scrive ogni giorno, quindi vecchio = publisher fermo), e la registrazione
 * comincerebbe a fallire da sola. Si sposta solo `generatedAt` a `nowIso`; il
 * gate di staleness ha il suo caso di mutazione.
 */
export function freshenGeneratedAt(payload, nowIso) {
  return { ...structuredClone(payload), generatedAt: nowIso };
}

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

/**
 * Rimette in anno un dataset annuale (canton-tax, pension-parameters).
 *
 * I due `refresh` rifiutano un `year` piu' vecchio di un anno rispetto al
 * calendario — il gate che distingue «il publisher si e' fermato» da «va tutto
 * bene». Una registrazione e' datata per definizione: senza traslazione il
 * fixture comincerebbe a fallire da solo fra due anni. Si sposta l'anno in
 * blocco (campo `year`, `burden.years` e le chiavi per anno di `burdenPct`),
 * lasciando intatto ogni numero; il gate di staleness ha il suo caso di
 * mutazione che porta l'anno indietro apposta.
 */
export function freshenYear(payload, currentYear) {
  const delta = currentYear - payload.year;
  const shifted = structuredClone(payload);
  if (delta === 0) return shifted;
  shifted.year += delta;
  if (Array.isArray(shifted.burden?.years)) shifted.burden.years = shifted.burden.years.map((y) => y + delta);
  for (const canton of Object.values(shifted.cantons || {})) {
    if (canton && canton.burdenPct && typeof canton.burdenPct === 'object') {
      canton.burdenPct = Object.fromEntries(Object.entries(canton.burdenPct).map(([y, v]) => [String(Number(y) + delta), v]));
    }
  }
  return shifted;
}
