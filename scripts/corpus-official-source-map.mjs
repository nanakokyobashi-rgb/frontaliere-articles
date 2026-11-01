export const VERIFIED_AT = '2026-11-01';

export const CLOSING_LABELS = {
  it: 'Fonti:',
  de: 'Offizielle Quellen:',
  fr: 'Sources officielles :',
  en: 'Official sources:',
};

const source = (names, urls) => ({ names, urls });

export const SOURCES = {
  mineralOilTax: source(
    {
      it: 'Imposta sugli oli minerali (UDSC)',
      de: 'Mineralölsteuer (BAZG)',
      fr: 'Taxe sur les huiles minérales (OFDF)',
      en: 'Mineral oil tax (FOCBS)',
    },
    {
      it: 'https://www.bazg.admin.ch/it/info-imposta-oli-minerali-quadro-giuridico',
      de: 'https://www.bazg.admin.ch/de/mineraloelsteuer-information-bedeutung-rahmenbedingungen',
      fr: 'https://www.bazg.admin.ch/fr/information-taxe-huiles-minerales-cadre-juridique',
      en: 'https://www.bazg.admin.ch/en/mineral-oil-tax-info-legal-framework',
    },
  ),
  roadTraffic: source(
    {
      it: 'Dati sul traffico (USTRA)',
      de: 'Verkehrsdaten (ASTRA)',
      fr: 'Données du trafic (OFROU)',
      en: 'Traffic data (FEDRO)',
    },
    {
      it: 'https://www.astra.admin.ch/it/dati-traffico',
      de: 'https://www.astra.admin.ch/de/verkehrsdaten',
      fr: 'https://www.astra.admin.ch/fr/donnees-trafic',
      en: 'https://www.astra.admin.ch/en/traffic-data',
    },
  ),
  publicTransportTariffs: source(
    {
      it: 'Tariffe dei trasporti pubblici (Alliance SwissPass)',
      de: 'Tarife des öffentlichen Verkehrs (Alliance SwissPass)',
      fr: 'Tarifs des transports publics (Alliance SwissPass)',
    },
    {
      it: 'https://www.allianceswisspass.ch/it/Tariffeprescrizioni/utenti-tp',
      de: 'https://www.allianceswisspass.ch/de/tarife-vorschriften/tarifmassnahmen',
      fr: 'https://www.allianceswisspass.ch/fr/tarifs/Usagers-TP',
    },
  ),
  arcobalenoPasses: source(
    {
      it: 'Abbonamenti Arcobaleno',
      de: 'Arcobaleno-Abonnemente',
      en: 'Arcobaleno travelcards',
    },
    {
      it: 'https://arcobaleno.ch/it/home/abbonamenti',
      de: 'https://arcobaleno.ch/de/home/abonnemente',
      en: 'https://arcobaleno.ch/en/home/travelcards',
    },
  ),
  commuterHealthInsurance: source(
    {
      it: 'Assicurazione malattie dei frontalieri (UFSP)',
      de: 'Krankenversicherung für Grenzgänger (BAG)',
      fr: 'Assurance-maladie des travailleurs frontaliers (OFSP)',
      en: 'Health insurance for cross-border commuters (FOPH)',
    },
    {
      it: 'https://www.bag.admin.ch/it/assicurazione-malattie-lavoratori-frontalieri-in-svizzera',
      de: 'https://www.bag.admin.ch/de/krankenversicherung-grenzgaengerinnen-und-grenzgaenger-in-der-schweiz',
      fr: 'https://www.bag.admin.ch/fr/assurance-maladie-travailleurs-frontaliers-en-suisse',
      en: 'https://www.bag.admin.ch/en/health-insurance-cross-border-commuters-working-in-switzerland',
    },
  ),
  cantonTaxRates: source(
    {
      it: 'Aliquote e tariffe cantonali (AFC)',
      de: 'Steuerfüsse und Tarife der Kantone (ESTV)',
      fr: 'Coefficients et barèmes cantonaux (AFC)',
      en: 'Cantonal tax multipliers and rates (FTA)',
    },
    {
      it: 'https://www.estv.admin.ch/it/aliquote-dimposta-deduzioni-e-tariffe-in-svizzera',
      de: 'https://www.estv.admin.ch/de/steuerfuesse-abzuege-und-tarife-der-schweiz',
      fr: 'https://www.estv.admin.ch/fr/coefficients-dimpot-deductions-et-baremes-en-suisse',
      en: 'https://www.estv.admin.ch/en/tax-multipliers-deductions-and-tax-rates',
    },
  ),
  italySwitzerlandTaxAgreement: source(
    {
      it: 'Accordo fiscale tra Italia e Svizzera (Fedlex)',
      de: 'Steuerabkommen zwischen der Schweiz und Italien (Fedlex)',
      fr: 'Accord fiscal entre la Suisse et l’Italie (Fedlex)',
      en: 'Switzerland–Italy tax agreement (Fedlex)',
    },
    {
      it: 'https://www.fedlex.admin.ch/eli/cc/2023/410/it',
      de: 'https://www.fedlex.admin.ch/eli/cc/2023/410/de',
      fr: 'https://www.fedlex.admin.ch/eli/cc/2023/410/fr',
      en: 'https://www.fedlex.admin.ch/eli/cc/2023/410/en',
    },
  ),
  employmentCode: source(
    {
      it: 'Codice delle obbligazioni, contratto di lavoro (Fedlex)',
      de: 'Obligationenrecht, Arbeitsvertrag (Fedlex)',
      fr: 'Code des obligations, contrat de travail (Fedlex)',
      en: 'Code of Obligations, employment contract (Fedlex)',
    },
    {
      it: 'https://www.fedlex.admin.ch/eli/cc/27/317_321_377/it',
      de: 'https://www.fedlex.admin.ch/eli/cc/27/317_321_377/de',
      fr: 'https://www.fedlex.admin.ch/eli/cc/27/317_321_377/fr',
      en: 'https://www.fedlex.admin.ch/eli/cc/27/317_321_377/en',
    },
  ),
  labourLaw: source(
    {
      it: 'Diritto del lavoro (SECO)',
      de: 'Arbeitsrecht (SECO)',
      fr: 'Droit du travail (SECO)',
    },
    {
      it: 'https://www.seco.admin.ch/it/diritto-del-lavoro',
      de: 'https://www.seco.admin.ch/de/arbeitsrecht',
      fr: 'https://www.seco.admin.ch/fr/droit-du-travail',
    },
  ),
  workingHours: source(
    {
      en: 'Working-time rules (SECO)',
    },
    {
      en: 'https://www.seco.admin.ch/en/posting-regulation-of-working-hours',
    },
  ),
  gPermit: source(
    {
      it: 'Permesso G UE/AELS (SEM)',
      de: 'Ausweis G EU/EFTA (SEM)',
      fr: 'Permis G UE/AELE (SEM)',
      en: 'G permit EU/EFTA (SEM)',
    },
    {
      it: 'https://www.sem.admin.ch/sem/it/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html',
      de: 'https://www.sem.admin.ch/sem/de/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html',
      fr: 'https://www.sem.admin.ch/sem/fr/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html',
      en: 'https://www.sem.admin.ch/sem/en/home/themen/aufenthalt/eu_efta/ausweis_g_eu_efta.html',
    },
  ),
  oldAgeProvision: source(
    {
      it: 'Previdenza per la vecchiaia (UFAS)',
      de: 'Altersvorsorge (BSV)',
      fr: 'Prévoyance vieillesse (OFAS)',
      en: 'Old-age insurance system (FSIO)',
    },
    {
      it: 'https://www.bsv.admin.ch/it/previdenza-per-la-vecchiaia',
      de: 'https://www.bsv.admin.ch/de/altersvorsorge',
      fr: 'https://www.bsv.admin.ch/fr/prevoyance-vieillesse',
      en: 'https://www.bsv.admin.ch/en/old-age-insurance-system',
    },
  ),
  crossBorderCommuterStatistics: source(
    {
      it: 'Statistica dei frontalieri (UST)',
      de: 'Grenzgängerstatistik (BFS)',
      fr: 'Statistique des frontaliers (OFS)',
      en: 'Cross-border commuter statistics (FSO)',
    },
    {
      it: 'https://www.pxweb-admin-a.bfs.admin.ch/pxweb/it/px-x-0302010000_108/-/px-x-0302010000_108.px/',
      de: 'https://www.pxweb-admin-a.bfs.admin.ch/pxweb/de/px-x-0302010000_108/-/px-x-0302010000_108.px/',
      fr: 'https://www.pxweb-admin-a.bfs.admin.ch/pxweb/fr/px-x-0302010000_108/-/px-x-0302010000_108.px/',
      en: 'https://www.pxweb-admin-a.bfs.admin.ch/pxweb/en/px-x-0302010000_108/-/px-x-0302010000_108.px/',
    },
  ),
  municipalityPopulation: source(
    {
      it: 'Popolazione dei comuni (UST)',
      de: 'Bevölkerung der Gemeinden (BFS)',
      fr: 'Population des communes (OFS)',
      en: 'Municipality population (FSO)',
    },
    {
      it: 'https://www.pxweb-admin-a.bfs.admin.ch/pxweb/it/px-x-0102010000_100/-/px-x-0102010000_100.px/',
      de: 'https://www.pxweb-admin-a.bfs.admin.ch/pxweb/de/px-x-0102010000_100/-/px-x-0102010000_100.px/',
      fr: 'https://www.pxweb-admin-a.bfs.admin.ch/pxweb/fr/px-x-0102010000_100/-/px-x-0102010000_100.px/',
      en: 'https://www.pxweb-admin-a.bfs.admin.ch/pxweb/en/px-x-0102010000_100/-/px-x-0102010000_100.px/',
    },
  ),
  consumerPriceIndex: source(
    {
      it: 'Indice nazionale dei prezzi al consumo (UST)',
      de: 'Landesindex der Konsumentenpreise (BFS)',
      fr: 'Indice des prix à la consommation (OFS)',
      en: 'Consumer price index (FSO)',
    },
    {
      it: 'https://lik-app.bfs.admin.ch/it/lik/reihen',
      de: 'https://lik-app.bfs.admin.ch/de/lik/reihen',
      fr: 'https://lik-app.bfs.admin.ch/fr/lik/reihen',
      en: 'https://lik-app.bfs.admin.ch/en/lik/reihen',
    },
  ),
  labourMarketStatistics: source(
    {
      it: 'Statistiche del mercato del lavoro (SECO)',
      de: 'Arbeitsmarktstatistik (SECO)',
      fr: 'Statistiques du marché du travail (SECO)',
      en: 'Labour-market statistics (SECO)',
    },
    {
      it: 'https://www.seco.admin.ch/it/statistiche-mercato-lavoro',
      de: 'https://www.seco.admin.ch/de/arbeitsmarktstatistik-berichte-rechtsgrundlagen',
      fr: 'https://www.seco.admin.ch/fr/statistiques-marche-travail-rapports-bases-legales',
      en: 'https://www.seco.admin.ch/en/labour-market-statistics',
    },
  ),
  salaryCalculator: source(
    {
      it: 'Calcolatore salariale Salarium (UST)',
      de: 'Lohnrechner Salarium (BFS)',
      fr: 'Calculateur de salaire Salarium (OFS)',
      en: 'Salarium salary calculator (FSO)',
    },
    {
      it: 'https://www.salarium.bfs.admin.ch/',
      de: 'https://www.salarium.bfs.admin.ch/',
      fr: 'https://www.salarium.bfs.admin.ch/',
      en: 'https://www.salarium.bfs.admin.ch/',
    },
  ),
  jobRoom: source(
    {
      it: 'Portale di collocamento Job-Room',
      de: 'Stellenportal Job-Room',
      fr: 'Portail emploi Job-Room',
      en: 'Job-Room job portal',
    },
    { it: 'https://www.job-room.ch/home/job-seeker', de: 'https://www.job-room.ch/home/job-seeker', fr: 'https://www.job-room.ch/home/job-seeker', en: 'https://www.job-room.ch/home/job-seeker' },
  ),
};

export const TOPICS = {
  fuelTax: ['mineralOilTax'],
  roadTraffic: ['roadTraffic'],
  transitPasses: ['publicTransportTariffs'],
  arcobaleno: ['arcobalenoPasses'],
  healthInsurance: ['commuterHealthInsurance'],
  cantonTax: ['cantonTaxRates'],
  crossBorderTaxAgreement: ['italySwitzerlandTaxAgreement'],
  employmentContract: ['employmentCode'],
  labourLaw: ['labourLaw'],
  workingHours: ['workingHours'],
  gPermit: ['gPermit'],
  pension: ['oldAgeProvision'],
  crossBorderStatistics: ['crossBorderCommuterStatistics'],
  municipalityPopulation: ['municipalityPopulation'],
  consumerPrices: ['consumerPriceIndex'],
  labourMarketStatistics: ['labourMarketStatistics'],
  salary: ['salaryCalculator'],
  jobListings: ['jobRoom'],
};
