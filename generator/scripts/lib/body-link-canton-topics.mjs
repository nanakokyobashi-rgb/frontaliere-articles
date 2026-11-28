/**
 * F6.3d: destinazioni tematiche per cantone per i link nel corpo degli articoli
 * delle sezioni cantonali: agenda eventi, tempi di attesa ai valichi, aste targhe,
 * stipendio per professione, strutture sanitarie e, solo per `canton-ti`, le pagine
 * del Ticino (meteo, allerte, farmacie di turno, giorni festivi, vacanze
 * scolastiche, costo della vita, carburanti).
 *
 * Regole comuni, tutte a favore della precisione:
 * - l'ancora e' il testo che c'e' gia' nell'articolo e contiene la locuzione del tema;
 * - il cantone della pagina e' sempre quello della SEZIONE dell'articolo;
 * - i temi «aperti» (eventi, valichi) richiedono nella stessa frase il nome del cantone
 *   (eventi) o una locuzione di confine (valichi): «eventi meteorologici», «di concerto con»,
 *   «valico alpino» non sono rinvii;
 * - le URL vengono SOLO da `generator/data/body-link-destinations.json`.
 *
 * Il modulo non importa nulla dal matcher principale: riceve gli helper di testo da
 * `body-link-destinations.mjs` (nessun import circolare).
 */

// ---------------------------------------------------------------- eventi

// Locuzioni di evento «chiuse»: «eventi» nudo (eventi meteorologici, sismici), «concerto» (di concerto con)
// e «Veranstaltungen» nudo (assemblee, divieti) non sono rinvii all'agenda.
const EVENT_PHRASES = {
  it: ['eventi culturali', 'eventi sportivi', 'eventi musicali', 'manifestazioni culturali', 'manifestazioni sportive', 'festival', 'concerti', 'mercatino di Natale', 'mercatini di Natale', 'sagra', 'sagre', 'cosa fare nel weekend', 'cosa fare nel fine settimana'],
  en: ['cultural events', 'sporting events', 'sports events', 'music events', 'festival', 'festivals', 'concerts', 'Christmas market', 'Christmas markets', 'things to do this weekend'],
  de: ['Kulturveranstaltungen', 'Sportveranstaltungen', 'Festival', 'Festivals', 'Konzerte', 'Weihnachtsmarkt', 'Weihnachtsmärkte', 'Fasnachtsumzug', 'Was am Wochenende tun'],
  fr: ['événements culturels', 'événements sportifs', 'manifestations culturelles', 'manifestations sportives', 'festival', 'festivals', 'concerts', 'marché de Noël', 'marchés de Noël', 'que faire ce week-end'],
};
// «eventi in <cantone>»: l'ancora comprende il cantone, quindi il nome del cantone e' nella locuzione.
const EVENT_IN_CANTON = {
  it: (names) => `eventi\\s+(?:in|a|nel|nella|nello|del|della|dello)\\s+(?:(?:il\\s+)?canton[ei]?\\s+(?:di\\s+|del\\s+)?)?(?:${names})`,
  en: (names) => `events\\s+(?:in|across)\\s+(?:the\\s+)?(?:canton\\s+(?:of\\s+)?)?(?:${names})`,
  de: (names) => `Veranstaltungen\\s+(?:in|im)\\s+(?:der\\s+)?(?:Kanton\\s+)?(?:${names})`,
  fr: (names) => `(?:événements|évènements)\\s+(?:à|au|en|dans\\s+le\\s+canton\\s+(?:de|du|d['’])\\s*)\\s*(?:l['’]|le\\s+|la\\s+)?(?:${names})`,
};
const EVENT_COUNT = { it: '\\d+\\s+eventi(?=\\s+(?:tra|in\\s+programma|da\\s+non\\s+perdere))' };

// ---------------------------------------------------------------- valichi

const BORDER_PHRASES = {
  it: ['valico di frontiera', 'valichi di frontiera', 'valico doganale', 'valichi doganali', 'code alla dogana', 'code ai valichi', 'code al confine', 'tempi di attesa alla dogana', 'tempi di attesa ai valichi', 'tempi di attesa al confine', 'attese alla dogana'],
  en: ['border crossing', 'border crossings', 'border queues', 'border wait times', 'waiting times at the border', 'customs queues'],
  de: ['Grenzübergang', 'Grenzübergänge', 'Grenzübergängen', 'Wartezeiten an der Grenze', 'Wartezeiten am Zoll', 'Grenzstau'],
  fr: ['poste-frontière', 'postes-frontières', 'passage frontalier', 'passages frontaliers', 'files d’attente à la frontière', 'temps d’attente à la douane'],
};
// Una locuzione di valico da sola (un incidente «al valico di ...», un controllo di polizia) non e' un
// rinvio ai tempi di attesa: serve nella frase un termine di coda, attesa o traffico.
const BORDER_CONTEXT = {
  it: /(?<!\p{L})(?:cod[ae]|attes[ae]|colonn[ae]|traffic|chiusur|tempi|ore\s+di\s+punta|congestion|rallentament|pendolar)/iu,
  en: /(?<!\p{L})(?:queue|wait|delay|traffic|jam|closure|rush\s+hour|congestion|commut)/iu,
  de: /(?<!\p{L})(?:stau|staus|warte|kolonne|verkehr|sperr|stosszeit|stoßzeit|pendler)/iu,
  fr: /(?<!\p{L})(?:file|files|attente|bouchon|embouteillage|trafic|fermetur|heures\s+de\s+pointe|pendulaire)/iu,
};
// Struttura sanitaria: la sua pagina parla di lavoro e stipendi, quindi la citazione serve in una frase
// di organico, assunzioni o stipendi (un«personale delle ambulanze» in un'esercitazione non lo e').
const FACILITY_CONTEXT = {
  it: /(?<!\p{L})(?:assunzion|assum|organico|dipendent|impieg(?:a|hi|ati|o)|posti\s+di\s+lavoro|stipend|salar)/iu,
  en: /(?<!\p{L})(?:hire|hiring|employ|workforce|salar|wage|jobs)/iu,
  de: /(?<!\p{L})(?:stellen|personalbestand|personalmangel|lohn|löhne|gehalt|anstellung|beschäftigte|angestellte)/iu,
  fr: /(?<!\p{L})(?:engag|employ|effectif|salaire|emplois|recrut)/iu,
};
const COUNTRY_KEY = {
  it: { germania: ['Germania'], francia: ['Francia'], austria: ['Austria'], liechtenstein: ['Liechtenstein'], italia: ['Italia'] },
  en: { germania: ['Germany'], francia: ['France'], austria: ['Austria'], liechtenstein: ['Liechtenstein'], italia: ['Italy'] },
  de: { germania: ['Deutschland'], francia: ['Frankreich'], austria: ['Österreich'], liechtenstein: ['Liechtenstein'], italia: ['Italien'] },
  fr: { germania: ['Allemagne'], francia: ['France'], austria: ['Autriche'], liechtenstein: ['Liechtenstein'], italia: ['Italie'] },
};
// Ticino: i tre bacini di confine con una pagina ciascuno, riconosciuti dai luoghi nella frase.
const TICINO_BORDER_PLACES = {
  como: ['Como', 'Chiasso', 'Brogeda', 'Ponte Chiasso', 'Maslianico'],
  varese: ['Varese', 'Stabio', 'Gaggiolo', 'Ponte Tresa', 'Cantello'],
  verbano: ['Verbano', 'Verbania', 'Dirinella'],
};

// ---------------------------------------------------------------- targhe

const PLATE_PHRASES = {
  it: ['asta di targhe', 'aste di targhe', 'asta delle targhe', 'targhe all’asta', 'targhe automobilistiche all’asta', 'targhe personalizzate'],
  en: ['license plate auction', 'license plate auctions', 'number plate auction', 'number plate auctions', 'plate auction', 'plate auctions'],
  de: ['Nummernschilder-Auktion', 'Kontrollschilder-Auktion', 'Autonummern-Auktion', 'Kontrollschilder versteigert', 'Autonummern versteigert', 'Versteigerung von Autonummern'],
  fr: ['enchères de plaques', 'vente aux enchères de plaques', 'plaques d’immatriculation aux enchères'],
};

// ---------------------------------------------------------------- stipendio per professione

const SALARY_HEAD = {
  it: '(?:stipend(?:io|i)|salar(?:io|i)|retribuzion[ei])(?:\\s+(?:medio|medi|mensile|annuo|lordo|netto))?\\s+(?:di|da|del|dello|della|dei|degli|delle|per)\\s+(?:(?:un|uno|una|gli|le|i|l[’\'])\\s*)?',
  de: '(?:Gehalt|Gehälter|Lohn|Löhne|Salär)\\s+(?:von|für|der|des)\\s+(?:(?:den|die|dem)\\s+)?',
  fr: '(?:salaire|salaires|rémunération|rémunérations)\\s+(?:des|de|d[’\'])\\s*(?:(?:l[’\']|les)\\s*)?',
};
const SALARY_TAIL_EN = '[’\']?\\s+(?:salary|salaries|wages?|pay)';
const SALARY_HEAD_EN = '(?:salary|salaries|wages?|pay)\\s+(?:of|for)\\s+(?:the\\s+)?';

// ---------------------------------------------------------------- strutture sanitarie

// slug della pagina -> nomi con cui l'articolo cita la struttura. Il cantone viene dal JSON.
const FACILITY_NAMES = {
  'eoc-ente-ospedaliero-cantonale': ['Ente ospedaliero cantonale', 'EOC'],
  luks: ['Luzerner Kantonsspital', 'LUKS'],
  ksa: ['Kantonsspital Aarau', 'KSA'],
  ksb: ['Kantonsspital Baden'],
  ksw: ['Kantonsspital Winterthur', 'KSW'],
  usz: ['Universitätsspital Zürich', 'USZ'],
  'unispital-basel': ['Universitätsspital Basel', 'Unispital Basel'],
  ukbb: ['UKBB', 'Universitäts-Kinderspital beider Basel'],
  ksbl: ['Kantonsspital Baselland'],
  'kantonsspital-graubuenden-ksgr': ['Kantonsspital Graubünden', 'KSGR'],
  'hopital-du-valais': ['Hôpital du Valais', 'Spital Wallis'],
  'spital-thurgau': ['Spital Thurgau'],
  'spitaeler-schaffhausen': ['Spitäler Schaffhausen'],
  'hfr-hopital-fribourgeois': ['Hôpital fribourgeois', 'Freiburger Spital', 'HFR'],
  'rhne-reseau-hospitalier-neuchatelois': ['Réseau hospitalier neuchâtelois', 'RHNe'],
  'h-ju-hopital-du-jura': ['Hôpital du Jura'],
  'zuger-kantonsspital': ['Zuger Kantonsspital'],
  'spital-schwyz': ['Spital Schwyz'],
  'spital-nidwalden': ['Spital Nidwalden'],
  ksow: ['Kantonsspital Obwalden', 'KSOW'],
  ksgl: ['Kantonsspital Glarus', 'KSGL'],
};

// ---------------------------------------------------------------- pagine del Ticino

const TI_CITIES = ['Lugano', 'Bellinzona', 'Mendrisio', 'Locarno', 'Chiasso'];
const TI_NAME = { it: 'Ticino', en: 'Ticino', de: 'Tessin', fr: 'Tessin' };
const TI_PHRASES = {
  weatherCity: {
    it: (c) => [`previsioni meteo (?:a|per|di|su) ${c}`, `meteo (?:a|di) ${c}`],
    en: (c) => [`weather forecast (?:for|in) ${c}`, `weather in ${c}`],
    de: (c) => [`Wetter in ${c}`, `Wetterprognose für ${c}`],
    fr: (c) => [`météo (?:à|de) ${c}`, `prévisions météo (?:à|pour) ${c}`],
  },
  weatherHub: {
    it: ['previsioni meteo in Ticino', 'meteo in Ticino', 'meteo per i frontalieri'],
    en: ['weather forecast for Ticino', 'weather in Ticino'],
    de: ['Wetter im Tessin', 'Wetterprognose für das Tessin'],
    fr: ['météo au Tessin', 'prévisions météo au Tessin'],
  },
  alerts: {
    it: ['allerta meteo', 'allerte meteo'],
    en: ['weather alert', 'weather alerts', 'weather warning', 'weather warnings'],
    de: ['Wetterwarnung', 'Wetterwarnungen', 'Unwetterwarnung', 'Unwetterwarnungen'],
    fr: ['alerte météo', 'alertes météo'],
  },
  pharmacies: {
    it: ['farmacie di turno', 'farmacia di turno'],
    en: ['on-duty pharmacies', 'on-duty pharmacy', 'duty pharmacies'],
    de: ['Notfallapotheke', 'Notfallapotheken', 'Apothekennotdienst'],
    fr: ['pharmacies de garde', 'pharmacie de garde'],
  },
  holidays: {
    it: ['giorni festivi', 'festività ticinesi', 'festivi in Ticino'],
    en: ['public holidays'],
    de: ['Feiertage'],
    fr: ['jours fériés'],
  },
  schoolHolidays: {
    it: ['vacanze scolastiche', 'calendario scolastico'],
    en: ['school holidays', 'school calendar'],
    de: ['Schulferien', 'Schulkalender'],
    fr: ['vacances scolaires', 'calendrier scolaire'],
  },
  costCity: {
    it: (c) => [`costo della vita (?:a|di|in) ${c}`],
    en: (c) => [`cost of living in ${c}`],
    de: (c) => [`Lebenshaltungskosten in ${c}`],
    fr: (c) => [`coût de la vie à ${c}`],
  },
  costTicino: {
    it: ['costo della vita in Ticino'],
    en: ['cost of living in Ticino'],
    de: ['Lebenshaltungskosten im Tessin'],
    fr: ['coût de la vie au Tessin'],
  },
  diesel: {
    it: ['prezzo del diesel', 'prezzi del diesel', 'prezzo del gasolio', 'prezzi del gasolio'],
    en: ['diesel price', 'diesel prices', 'price of diesel'],
    de: ['Dieselpreis', 'Dieselpreise'],
    fr: ['prix du diesel'],
  },
  petrol: {
    it: ['prezzo della benzina', 'prezzi della benzina'],
    en: ['petrol price', 'petrol prices', 'gasoline price', 'gasoline prices', 'price of petrol'],
    de: ['Benzinpreis', 'Benzinpreise'],
    fr: ['prix de l’essence', 'prix de la benzine'],
  },
};

/** Estrae da `destinations` le tabelle F6.3d come id -> quaterna. */
export function cantonTopicPaths(destinations, locale) {
  const out = {};
  const put = (id, quad) => { if (quad?.[locale]) out[id] = quad[locale]; };
  for (const [code, quad] of Object.entries(destinations.eventsLanding || {})) put(`events:${code}`, quad);
  for (const [key, quad] of Object.entries(destinations.borderTraffic || {})) put(`border:${key}`, quad);
  for (const [code, quad] of Object.entries(destinations.plateAuctions || {})) put(`plates:${code}`, quad);
  for (const [key, quad] of Object.entries(destinations.salaryProfession || {})) put(`salary:${key}`, quad);
  for (const [key, quad] of Object.entries(destinations.facilityLanding || {})) put(`facility:${key}`, quad);
  for (const [key, quad] of Object.entries(destinations.ticinoPages || {})) put(`ti:${key}`, quad);
  return out;
}

const compiled = new Map();

/**
 * Matcher dei temi cantonali: restituisce {id, start, end, target}.
 * `ctx` = { word, alt, cantonNames, sentenceAround, cantonCodes, professionAliases, professionSlugs }.
 */
export function cantonTopicMatches(text, locale, cantonCode, paths, ctx) {
  if (!cantonCode) return [];
  const { word, alt, cantonNames, sentenceAround } = ctx;
  const key = `${locale}:${cantonCode}`;
  if (!compiled.has(key)) {
    const list = (arr) => alt([...arr].sort((a, b) => b.length - a.length));
    const raw = (arr) => [...arr].sort((a, b) => b.length - a.length).join('|');
    const c = {
      own: word(alt(cantonNames(cantonCode, locale))),
      others: ctx.cantonCodes.filter((x) => x !== cantonCode).map((x) => word(alt(cantonNames(x, locale)))),
      events: word([list(EVENT_PHRASES[locale]), EVENT_IN_CANTON[locale](list(cantonNames(cantonCode, locale))), EVENT_COUNT[locale]].filter(Boolean).join('|')),
      border: word(list(BORDER_PHRASES[locale])),
      plates: word(list(PLATE_PHRASES[locale])),
      countries: Object.entries(COUNTRY_KEY[locale]).map(([k, names]) => [k, word(alt(names))]),
      tiPlaces: Object.entries(TICINO_BORDER_PLACES).map(([k, names]) => [k, word(alt(names))]),
      salary: [],
      facilities: Object.entries(FACILITY_NAMES).map(([slug, names]) => [slug, word(alt(names))]),
    };
    for (const slug of ctx.professionSlugs) {
      const names = list(ctx.professionAliases(slug, locale));
      if (locale === 'en') c.salary.push([slug, word(`${SALARY_HEAD_EN}(?:${names})`), word(`(?:${names})${SALARY_TAIL_EN}`)]);
      else c.salary.push([slug, word(`${SALARY_HEAD[locale]}(?:${names})`)]);
    }
    if (cantonCode === 'TI') {
      const phr = (arr) => word(list(arr));
      c.ti = {
        name: word(alt([TI_NAME[locale]])),
        weatherCity: TI_CITIES.map((name) => [name, word(raw(TI_PHRASES.weatherCity[locale](name).map((p) => p.replace(/ /g, '\\s+'))))]),
        costCity: TI_CITIES.map((name) => [name, word(raw(TI_PHRASES.costCity[locale](name).map((p) => p.replace(/ /g, '\\s+'))))]),
        weatherHub: phr(TI_PHRASES.weatherHub[locale]), alerts: phr(TI_PHRASES.alerts[locale]), pharmacies: phr(TI_PHRASES.pharmacies[locale]),
        holidays: phr(TI_PHRASES.holidays[locale]), schoolHolidays: phr(TI_PHRASES.schoolHolidays[locale]),
        costTicino: phr(TI_PHRASES.costTicino[locale]), diesel: phr(TI_PHRASES.diesel[locale]), petrol: phr(TI_PHRASES.petrol[locale]),
      };
    }
    compiled.set(key, c);
  }
  const c = compiled.get(key);
  const out = [];
  const each = (re, fn) => {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) fn(m, m.index, m.index + m[0].length);
  };
  const push = (id, start, end) => { if (paths[id]) out.push({ id, start, end, target: paths[id] }); };
  const test = (re, s) => { re.lastIndex = 0; return re.test(s); };
  // Il cantone della pagina e' quello della sezione: se la frase parla di un altro cantone il tema non e' suo.
  const foreign = (s) => c.others.some((re) => test(re, s));

  // eventi: serve il cantone della sezione nella stessa frase e nessun altro cantone.
  if (paths[`events:${cantonCode}`]) {
    each(c.events, (m, start, end) => {
      const s = sentenceAround(text, start, end);
      if (test(c.own, s) && !foreign(s)) push(`events:${cantonCode}`, start, end);
    });
  }

  // valichi: locuzione di confine; paese (o luogo, per il Ticino) dalla frase, altrimenti hub.
  const borderKeys = Object.keys(paths).filter((k) => k.startsWith(`border:${cantonCode}/`));
  if (borderKeys.length && paths['border:hub']) {
    each(c.border, (m, start, end) => {
      const s = sentenceAround(text, start, end);
      if (!BORDER_CONTEXT[locale].test(s) || foreign(s)) return;
      let target = null;
      if (cantonCode === 'TI') {
        const hits = c.tiPlaces.filter(([, re]) => test(re, s)).map(([k]) => k);
        target = hits.length === 1 ? `border:TI/${hits[0]}` : 'border:hub';
      } else {
        const hits = c.countries.filter(([k, re]) => paths[`border:${cantonCode}/${k}`] && test(re, s)).map(([k]) => k);
        if (hits.length === 1) target = `border:${cantonCode}/${hits[0]}`;
        else if (borderKeys.length === 1 && !c.countries.some(([, re]) => test(re, s))) target = borderKeys[0];
        else target = 'border:hub';
      }
      push(target, start, end);
    });
  }

  // targhe all'asta
  if (paths[`plates:${cantonCode}`]) each(c.plates, (m, start, end) => { if (!foreign(sentenceAround(text, start, end))) push(`plates:${cantonCode}`, start, end); });

  // stipendio per professione, del cantone della sezione
  for (const [slug, ...res] of c.salary) {
    const id = `salary:${cantonCode}/${slug}`;
    if (!paths[id]) continue;
    for (const re of res) each(re, (m, start, end) => { if (!foreign(sentenceAround(text, start, end))) push(id, start, end); });
  }

  // strutture sanitarie del cantone della sezione
  for (const [slug, re] of c.facilities) {
    const id = `facility:${cantonCode}/${slug}`;
    // Un «servizio di soccorso degli Spitäler X» in un rapporto di polizia non e' un rinvio alla pagina di lavoro.
    if (paths[id]) each(re, (m, start, end) => { if (FACILITY_CONTEXT[locale].test(sentenceAround(text, start, end))) push(id, start, end); });
  }

  if (c.ti) {
    for (const [name, re] of c.ti.weatherCity) each(re, (m, s, e) => push(`ti:weather:${name.toLowerCase()}`, s, e));
    each(c.ti.weatherHub, (m, s, e) => push('ti:weather:hub', s, e));
    each(c.ti.alerts, (m, s, e) => push('ti:weather-alerts:hub', s, e));
    each(c.ti.pharmacies, (m, s, e) => push('ti:pharmacies:on-duty', s, e));
    each(c.ti.holidays, (m, s, e) => { if (test(c.ti.name, sentenceAround(text, s, e))) push('ti:holidays:ticino', s, e); });
    each(c.ti.schoolHolidays, (m, s, e) => {
      const year = /(?<!\d)(2027|2028|2029)(?!\d)/.exec(sentenceAround(text, s, e))?.[1];
      if (year) push(`ti:school-holidays:${year}`, s, e);
    });
    for (const [name, re] of c.ti.costCity) each(re, (m, s, e) => push(`ti:cost-of-living:${name.toLowerCase()}`, s, e));
    each(c.ti.costTicino, (m, s, e) => push('ti:cost-of-living:ticino', s, e));
    each(c.ti.diesel, (m, s, e) => push('ti:fuel:diesel', s, e));
    each(c.ti.petrol, (m, s, e) => push('ti:fuel:petrol', s, e));
  }
  return out;
}
