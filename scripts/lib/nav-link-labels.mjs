/**
 * Canonical translations for visible labels on article nav links.
 *
 * Keys are normalized Italian labels, not targets. The snapshot contains every
 * Italian label occurring at least twice in blog-body or blog-body-ch, plus
 * labels observed in hybrid forms containing Tessin/Schweiz/Suisse/Italien/Italie.
 * Runtime localization never reads content.
 */

import {
  withoutOfficialNameWords,
  withoutUrls,
} from '../../generator/scripts/lib/localized-toponyms.mjs';

const NAV_LINK_LABELS_RAW = {
  "📊 confronto stipendi netti tra ticino e lombardia": {
    "de": "📊 Vergleich der Nettolöhne zwischen Tessin und Lombardei",
    "fr": "📊 comparaison des salaires nets entre le Tessin et la Lombardie",
    "en": "📊 comparison of net salaries between Ticino and Lombardy"
  },
  "agenzia delle dogane": {
    "de": "agenzia delle dogane",
    "fr": "Agence des douanes",
    "en": "Customs Agency"
  },
  "agenzia delle entrate ticino": {
    "de": "Steuerbehörde Tessin",
    "fr": "administration fiscale du Tessin",
    "en": "Ticino tax authority"
  },
  "annunci di lavoro": {
    "de": "Stellenanzeigen",
    "fr": "offres d'emploi",
    "en": "job listings"
  },
  "annunci di lavoro in svizzera": {
    "de": "Jobangebote in der Schweiz",
    "fr": "annonces d'emploi en Suisse",
    "en": "Job Listings in Switzerland"
  },
  "annunci di lavoro svizzeri": {
    "de": "Schweizer Stellenanzeigen",
    "fr": "annonces d'emploi suisses",
    "en": "Swiss job listings"
  },
  "annunci lavoro": {
    "de": "Stellenangebote",
    "fr": "annonces d'emploi",
    "en": "job listings"
  },
  "app della protezione civile ticino": {
    "de": "App des Zivilschutzes im Tessin",
    "fr": "application de la protection civile du Tessin",
    "en": "Ticino civil protection app"
  },
  "approfondisci il calcolo della tua rendita nel nostro calcolatore avs →": {
    "de": "approfondisci il calcolo della tua rendita nel nostro calcolatore avs →",
    "fr": "approfondisci il calcolo della tua rendita nel nostro calcolatore avs →",
    "en": "approfondisci il calcolo della tua rendita nel nostro calcolatore avs →"
  },
  "asili nido": {
    "de": "Kinderkrippen",
    "fr": "asiles-nourrices",
    "en": "nurseries"
  },
  "asilo nido": {
    "de": "Kinderkrippe",
    "fr": "crèche",
    "en": "nursery"
  },
  "assicurazione": {
    "de": "Versicherung",
    "fr": "assurance",
    "en": "insurance"
  },
  "assicurazione lamal": {
    "de": "Krankenversicherung KVG",
    "fr": "assicurazione lamal",
    "en": "LAMal health insurance"
  },
  "assicurazione malattia": {
    "de": "Krankenversicherung",
    "fr": "assurance maladie",
    "en": "health insurance"
  },
  "assicurazione malattia (lamal)": {
    "de": "Krankenversicherung (KVG)",
    "fr": "assurance maladie (LAMal)",
    "en": "compulsory health insurance (LAMal)"
  },
  "assicurazione malattia lamal": {
    "de": "Krankenversicherung LAMal",
    "fr": "assurance maladie LAMal",
    "en": "LAMal health insurance"
  },
  "assicurazione malattia obbligatoria": {
    "de": "obligatorische Krankenversicherung",
    "fr": "assurance maladie obligatoire",
    "en": "compulsory health insurance"
  },
  "assicurazione malattia svizzera (lamal)": {
    "de": "schweizerische Krankenversicherung (KVG)",
    "fr": "assurance maladie suisse (LAMal)",
    "en": "Swiss health insurance (LAMal)"
  },
  "assicurazione malattie per frontalieri": {
    "de": "Krankenversicherung für Grenzgänger",
    "fr": "Assurance maladie pour frontaliers",
    "en": "Health insurance for cross-border workers"
  },
  "assicurazione sanitaria": {
    "de": "Krankenversicherung",
    "fr": "assurance maladie",
    "en": "health insurance"
  },
  "assicurazioni sanitarie": {
    "de": "Krankenversicherungen",
    "fr": "assurances maladie",
    "en": "health insurance"
  },
  "assistenza legale": {
    "de": "Rechtliche Unterstützung",
    "fr": "Assistance juridique",
    "en": "Legal assistance"
  },
  "assistenza sanitaria": {
    "de": "Gesundheitsversorgung",
    "fr": "Assistance sanitaire",
    "en": "Health care"
  },
  "avs": {
    "de": "AHV",
    "fr": "avs",
    "en": "AHV"
  },
  "avs e lpp": {
    "de": "AHV und BVG",
    "fr": "AVS et LPP",
    "en": "AHV and BVG"
  },
  "avs e rendita": {
    "de": "avs e rendita",
    "fr": "avs e rendita",
    "en": "avs e rendita"
  },
  "avs/ahv": {
    "de": "AHV/AVS",
    "fr": "avs/ahv",
    "en": "avs/ahv"
  },
  "avs/ai/ipg": {
    "de": "Rentenplaner",
    "fr": "AVS/AI/APG",
    "en": "avs/ai/ipg"
  },
  "avs/lpp": {
    "de": "AHV/BVG",
    "fr": "avs/lpp",
    "en": "AHV/BVG"
  },
  "avs/lpp e rendita": {
    "de": "AHV/BVG und Rente",
    "fr": "AVS/LPP et rente",
    "en": "AVS/LPP and pension"
  },
  "avs/lpp/rendita": {
    "de": "AHV/BVG/Rente",
    "fr": "AVS/LPP/rente",
    "en": "AVS/LPP/pension"
  },
  "aziende": {
    "de": "Unternehmen",
    "fr": "entreprises",
    "en": "companies"
  },
  "aziende che assumono": {
    "de": "einstellenden Unternehmen",
    "fr": "entreprises qui recrutent",
    "en": "hiring companies"
  },
  "aziende che assumono frontalieri": {
    "de": "Unternehmen überprüfen, die Grenzgänger einstellen",
    "fr": "entreprises qui recrutent des frontaliers",
    "en": "companies hiring cross-border workers"
  },
  "aziende svizzere": {
    "de": "aziende svizzere",
    "fr": "aziende svizzere",
    "en": "aziende svizzere"
  },
  "bacheca lavoro": {
    "de": "Jobbörse",
    "fr": "bourse de l'emploi",
    "en": "bacheca lavoro"
  },
  "banche": {
    "de": "Banken",
    "fr": "banques",
    "en": "banks"
  },
  "banche in svizzera": {
    "de": "banche in svizzera",
    "fr": "banche in svizzera",
    "en": "Swiss banks"
  },
  "banche locali": {
    "de": "lokale Banken",
    "fr": "banques locales",
    "en": "local banks"
  },
  "banche per frontalieri": {
    "de": "Banken für Grenzgänger",
    "fr": "banques pour frontaliers",
    "en": "banks for cross-border workers"
  },
  "banche svizzere": {
    "de": "Schweizer Banken",
    "fr": "banques suisses",
    "en": "Swiss banks"
  },
  "blog di frontaliere ticino": {
    "de": "Blog von Frontaliere Ticino",
    "fr": "blog de Frontalier Ticino",
    "en": "Frontaliere Ticino blog"
  },
  "border": {
    "de": "Grenze",
    "fr": "frontière",
    "en": "border"
  },
  "border map": {
    "de": "Grenzübersicht",
    "fr": "carte des frontières",
    "en": "border map"
  },
  "border-map": {
    "de": "Border-Map-Vergleich",
    "fr": "border-map",
    "en": "border-map comparator"
  },
  "brogeda": {
    "de": "brogeda",
    "fr": "brogeda",
    "en": "brogeda"
  },
  "busta paga": {
    "de": "Lohnabrechnung",
    "fr": "fiche de paie",
    "en": "payslip"
  },
  "busta paga netta": {
    "de": "Netto-Gehaltsabrechnung",
    "fr": "fiche de paie nette",
    "en": "net payslip"
  },
  "busta paga svizzera": {
    "de": "Schweizer Lohnabrechnung",
    "fr": "bulletin de salaire suisse",
    "en": "Swiss payslip"
  },
  "calcola il tuo netto frontaliere": {
    "de": "Berechne dein Nettoeinkommen als Grenzgänger",
    "fr": "Calculez votre net frontalier",
    "en": "Calculate your net cross-border income"
  },
  "calcola il tuo stipendio": {
    "de": "Berechne dein Gehalt",
    "fr": "Calculez votre salaire",
    "en": "Calculate your salary"
  },
  "calcola il tuo stipendio e le imposte": {
    "de": "berechnen Sie Ihr Gehalt und Ihre Steuern",
    "fr": "calcule ton salaire et tes impôts",
    "en": "calculate your salary and taxes"
  },
  "calcola il tuo stipendio netto": {
    "de": "Berechnen Sie Ihr Nettoeinkommen",
    "fr": "Calculez votre salaire net",
    "en": "Calculate your net salary"
  },
  "calcola il tuo stipendio netto in svizzera": {
    "de": "Berechnen Sie Ihr Nettoeinkommen in der Schweiz",
    "fr": "Calculez votre salaire net en Suisse",
    "en": "Calculate your net salary in Switzerland"
  },
  "calcola il tuo stipendio netto in ticino e ottimizza la busta paga": {
    "de": "Berechne dein Nettogehalt im Tessin und optimiere deine Lohnabrechnung",
    "fr": "calculez votre salaire net au Tessin et optimisez votre fiche de paie",
    "en": "calculate your net salary in Ticino and optimize your payslip"
  },
  "calcola il tuo stipendio netto ora": {
    "de": "Berechne dein Nettogehalt jetzt",
    "fr": "Calculez votre salaire net maintenant",
    "en": "Calculate your net salary now"
  },
  "calcola le tue imposte": {
    "de": "Berechne deine Steuern",
    "fr": "Calculez vos impôts",
    "en": "Calculate your taxes"
  },
  "calcola le tue tasse": {
    "de": "Berechne deine Steuern",
    "fr": "Calculez vos impôts",
    "en": "Calculate your taxes"
  },
  "calcola lo stipendio netto": {
    "de": "Lohnrechner",
    "fr": "calculateur salaire",
    "en": "calculate your net salary"
  },
  "calcolare il tuo risparmio fiscale": {
    "de": "berechnen können",
    "fr": "calculer votre économie fiscale",
    "en": "calculate your tax savings"
  },
  "calcolatore": {
    "de": "Rechner",
    "fr": "calculateur",
    "en": "calculator"
  },
  "calcolatore assicurativo": {
    "de": "Versicherungsrechner",
    "fr": "calculateur d'assurance",
    "en": "insurance calculator"
  },
  "calcolatore assicurazione auto": {
    "de": "Autoversicherungsrechner",
    "fr": "calculateur d'assurance auto",
    "en": "car insurance calculator"
  },
  "calcolatore assicurazione malattie": {
    "de": "Krankenversicherungsrechner",
    "fr": "calculateur d'assurance maladie",
    "en": "health insurance calculator"
  },
  "calcolatore avs": {
    "de": "AVS-Rechner",
    "fr": "calculateur AVS",
    "en": "AVS calculator"
  },
  "calcolatore avs e lpp": {
    "de": "AHV- und BVG-Rechner",
    "fr": "calculateur AVS et LPP",
    "en": "AVS and LPP calculator"
  },
  "calcolatore avs/lpp": {
    "de": "AVS/LPP-Rechner",
    "fr": "calculateur AVS/LPP",
    "en": "AVS/LPP calculator"
  },
  "calcolatore busta paga": {
    "de": "Gehaltsrechner",
    "fr": "calculateur de fiche de paie",
    "en": "payslip calculator"
  },
  "calcolatore cambio valuta": {
    "de": "Währungsrechner",
    "fr": "calcolatore cambio valuta",
    "en": "currency exchange calculator"
  },
  "calcolatore carburante": {
    "de": "Kraftstoffrechner",
    "fr": "calculateur de carburant",
    "en": "fuel calculator"
  },
  "calcolatore congedo": {
    "de": "Elternzeitrechner",
    "fr": "calculateur congé",
    "en": "leave calculator"
  },
  "calcolatore costi auto": {
    "de": "Auto-Kostenrechner",
    "fr": "calculateur coûts auto",
    "en": "car cost calculator"
  },
  "calcolatore costi di vita": {
    "de": "Kostenrechner für Lebenshaltungskosten",
    "fr": "Calculateur des coûts de la vie",
    "en": "Cost of living calculator"
  },
  "calcolatore costi immobiliari in ticino": {
    "de": "Immobilienkostenrechner im Tessin",
    "fr": "calculateur des coûts immobiliers au Tessin",
    "en": "real estate cost calculator in Ticino"
  },
  "calcolatore costi viaggio": {
    "de": "Reisekostenrechner",
    "fr": "calculateur de coûts de voyage",
    "en": "travel cost calculator"
  },
  "calcolatore costo della vita": {
    "de": "Lebenshaltungskostenrechner",
    "fr": "calculateur du coût de la vie",
    "en": "cost of living calculator"
  },
  "calcolatore costo della vita ticino vs italia": {
    "de": "Lebenshaltungskostenrechner im Tessin vs. Italien",
    "fr": "calculateur du coût de la vie au Tessin vs. Italie",
    "en": "cost of living calculator in Ticino vs Italy"
  },
  "calcolatore dedicato": {
    "de": "dedizierten Rechner",
    "fr": "calculateur dédié",
    "en": "dedicated calculator"
  },
  "calcolatore degli assegni familiari": {
    "de": "Rechner für Familienleistungen",
    "fr": "calculateur des allocations familiales",
    "en": "family allowances calculator"
  },
  "calcolatore degli eventi": {
    "de": "Eventkalender",
    "fr": "calculateur d'événements",
    "en": "event calculator"
  },
  "calcolatore degli orari": {
    "de": "Fahrplankalkulator",
    "fr": "calculateur d'horaires",
    "en": "schedule calculator"
  },
  "calcolatore degli stipendi": {
    "de": "Lohnrechner",
    "fr": "calculateur de salaires",
    "en": "salary calculator"
  },
  "calcolatore dei costi": {
    "de": "Kostenrechner",
    "fr": "calculateur de coûts",
    "en": "cost calculator"
  },
  "calcolatore dei costi assicurativi": {
    "de": "Krankenkassenkostenrechner",
    "fr": "calculateur des coûts d’assurance",
    "en": "insurance cost calculator"
  },
  "calcolatore dei costi auto": {
    "de": "Autokostenrechner",
    "fr": "calculateur de coûts automobiles",
    "en": "car cost calculator"
  },
  "calcolatore dei costi di trasporto": {
    "de": "Transportkostenrechner",
    "fr": "calculateur des coûts de transport",
    "en": "transport cost calculator"
  },
  "calcolatore dei costi di vita": {
    "de": "Lebenshaltungskostenrechner",
    "fr": "calculateur des coûts de la vie",
    "en": "cost of living calculator"
  },
  "calcolatore dei netti frontaliere": {
    "de": "calcolatore dei netti frontaliere",
    "fr": "calculateur des nettes frontalières",
    "en": "Frontier Net Calculator"
  },
  "calcolatore dei premi assicurativi sanitari": {
    "de": "Rechner für Krankenversicherungsprämien",
    "fr": "calculateur des primes d'assurance maladie",
    "en": "health insurance premium calculator"
  },
  "calcolatore dei ristorni": {
    "de": "Rückerstattungsrechner",
    "fr": "calculateur des ristournes",
    "en": "refund calculator"
  },
  "calcolatore dei tempi di attraversamento": {
    "de": "Durchgangszeit-Rechner",
    "fr": "calculateur des temps de traversée",
    "en": "crossing time calculator"
  },
  "calcolatore del costo del carburante": {
    "de": "Kraftstoffkostenrechner",
    "fr": "calculateur du coût du carburant",
    "en": "fuel cost calculator"
  },
  "calcolatore del costo dell'energia": {
    "de": "Energiekostenrechner",
    "fr": "calculateur du coût de l'énergie",
    "en": "energy cost calculator"
  },
  "calcolatore del costo della vita": {
    "de": "Lebenshaltungskostenrechner",
    "fr": "calculateur du coût de la vie",
    "en": "cost of living calculator"
  },
  "calcolatore del costo della vita in ticino": {
    "de": "Lebenshaltungskostenrechner für das Tessin",
    "fr": "calculateur du coût de la vie au Tessin",
    "en": "Calculator of the cost of living in Ticino"
  },
  "calcolatore del livello del lago": {
    "de": "Seespiegelrechner",
    "fr": "calculateur du niveau du lac",
    "en": "lake level calculator"
  },
  "calcolatore del lutto": {
    "de": "Trauerkostenrechner",
    "fr": "calculateur de deuil",
    "en": "grief calculator"
  },
  "calcolatore del percorso": {
    "de": "Streckenrechner",
    "fr": "calculateur d'itinéraire",
    "en": "route calculator"
  },
  "calcolatore del rumore": {
    "de": "Lärmrechner",
    "fr": "calculateur de bruit",
    "en": "noise calculator"
  },
  "calcolatore del salario netto": {
    "de": "Nettolohnrechner",
    "fr": "calculateur du salaire net",
    "en": "net salary calculator"
  },
  "calcolatore del sito": {
    "de": "Website-Rechner",
    "fr": "calculateur du site",
    "en": "site calculator"
  },
  "calcolatore del tempo di viaggio": {
    "de": "Reisezeitrechner",
    "fr": "calculateur de temps de trajet",
    "en": "travel time calculator"
  },
  "calcolatore del traffico": {
    "de": "Verkehrsrechner",
    "fr": "calculateur de trafic",
    "en": "traffic calculator"
  },
  "calcolatore della busta paga": {
    "de": "Gehaltsrechner",
    "fr": "calculateur de la fiche de paie",
    "en": "paycheck calculator"
  },
  "calcolatore della cassa malati": {
    "de": "Krankenkassenrechner",
    "fr": "calculateur de la caisse maladie",
    "en": "health insurance calculator"
  },
  "calcolatore della pensione": {
    "de": "Rentenrechner",
    "fr": "calculateur de retraite",
    "en": "pension calculator"
  },
  "calcolatore della previdenza": {
    "de": "Rentenrechner",
    "fr": "calculateur de prévoyance",
    "en": "pension calculator"
  },
  "calcolatore della rendita": {
    "de": "calcolatore della rendita",
    "fr": "calcolatore della rendita",
    "en": "annuity calculator"
  },
  "calcolatore della rendita avs": {
    "de": "calcolatore della rendita avs",
    "fr": "calculateur de pension AVS",
    "en": "calcolatore della rendita avs"
  },
  "calcolatore delle assicurazioni": {
    "de": "Versicherungsrechner",
    "fr": "calculateur des assurances",
    "en": "insurance calculator"
  },
  "calcolatore delle calorie": {
    "de": "Kalorienrechner",
    "fr": "calculateur de calories",
    "en": "calorie calculator"
  },
  "calcolatore delle casse malati": {
    "de": "Krankenkassenrechner",
    "fr": "calculateur des caisses maladie",
    "en": "health insurance calculator"
  },
  "calcolatore delle competenze": {
    "de": "Fähigkeitenrechner",
    "fr": "calculateur de compétences",
    "en": "skills calculator"
  },
  "calcolatore delle condizioni meteo": {
    "de": "Wetterbedingungen-Rechner",
    "fr": "calculateur des conditions météo",
    "en": "weather conditions calculator"
  },
  "calcolatore delle donazioni": {
    "de": "Spendenrechner",
    "fr": "calculateur de dons",
    "en": "donation calculator"
  },
  "calcolatore delle elezioni": {
    "de": "Wahlrechner",
    "fr": "calculateur des élections",
    "en": "election calculator"
  },
  "calcolatore delle emissioni di co2": {
    "de": "CO2-Emissionen-Rechner",
    "fr": "calculateur des émissions de CO2",
    "en": "CO2 emissions calculator"
  },
  "calcolatore delle imposte": {
    "de": "Steuerrechner",
    "fr": "calculateur des impôts",
    "en": "tax calculator"
  },
  "calcolatore delle imposte cantonali": {
    "de": "calcolatore delle imposte cantonali",
    "fr": "calcolatore delle imposte cantonali",
    "en": "calcolatore delle imposte cantonali"
  },
  "calcolatore delle imposte federali": {
    "de": "Bundessteuerkalkulator",
    "fr": "calculateur d'impôts fédéraux",
    "en": "federal tax calculator"
  },
  "calcolatore delle imposte per frontalieri": {
    "de": "Steuerrechner für Grenzgänger",
    "fr": "calculateur des impôts pour frontaliers",
    "en": "calculator for frontier workers' taxes"
  },
  "calcolatore delle opportunità di volontariato": {
    "de": "Berechner für Freiwilligenmöglichkeiten",
    "fr": "calculateur des opportunités de bénévolat",
    "en": "volunteering opportunities calculator"
  },
  "calcolatore delle partite": {
    "de": "Spielrechner",
    "fr": "calculateur de matchs",
    "en": "match calculator"
  },
  "calcolatore delle pensioni": {
    "de": "Rentenrechner",
    "fr": "calculateur de pensions",
    "en": "pension calculator"
  },
  "calcolatore delle probabilità di vittoria": {
    "de": "Siegwahrscheinlichkeitsrechner",
    "fr": "calculateur des probabilités de victoire",
    "en": "win probability calculator"
  },
  "calcolatore delle risorse idriche": {
    "de": "Wasserressourcenrechner",
    "fr": "calculateur des ressources en eau",
    "en": "water resource calculator"
  },
  "calcolatore delle spese mediche": {
    "de": "Kostenrechner für medizinische Ausgaben",
    "fr": "calculateur des frais médicaux",
    "en": "medical expenses calculator"
  },
  "calcolatore delle spese sanitarie": {
    "de": "Gesundheitskostenrechner",
    "fr": "calculateur des dépenses de santé",
    "en": "healthcare cost calculator"
  },
  "calcolatore delle tasse": {
    "de": "Steuerrechner",
    "fr": "calculateur des impôts",
    "en": "tax calculator"
  },
  "calcolatore delle tasse comunali": {
    "de": "Gemeindesteuerrechner",
    "fr": "calculateur des impôts communaux",
    "en": "municipal tax calculator"
  },
  "calcolatore dello stipendio": {
    "de": "Lohnrechner",
    "fr": "calculateur de salaire",
    "en": "salary calculator"
  },
  "calcolatore dello stipendio e delle imposte": {
    "de": "Lohn- und Steuerrechner",
    "fr": "calculateur de salaire et d'impôts",
    "en": "salary and tax calculator"
  },
  "calcolatore dello stipendio netto": {
    "de": "Nettolohnrechner",
    "fr": "calculateur du salaire net",
    "en": "net salary calculator"
  },
  "calcolatore dello stipendio netto frontaliere": {
    "de": "Grenzgänger-Nettoeinkommensrechner",
    "fr": "calculateur de salaire net frontalier",
    "en": "cross-border net salary calculator"
  },
  "calcolatore dello stipendio per frontalieri": {
    "de": "Gehaltsrechner für Grenzgänger",
    "fr": "calculateur de salaire pour frontaliers",
    "en": "cross-border commuter salary calculator"
  },
  "calcolatore di allenamento": {
    "de": "Trainingsrechner",
    "fr": "calculateur d'entraînement",
    "en": "training calculator"
  },
  "calcolatore di appuntamenti": {
    "de": "Terminrechner",
    "fr": "calculateur de rendez-vous",
    "en": "appointment calculator"
  },
  "calcolatore di assicurazione": {
    "de": "Versicherungsrechner",
    "fr": "calculateur d'assurance",
    "en": "insurance calculator"
  },
  "calcolatore di assicurazione sanitaria": {
    "de": "Krankenversicherungsrechner",
    "fr": "calculateur d'assurance maladie",
    "en": "health insurance calculator"
  },
  "calcolatore di assistenza legale": {
    "de": "calcolatore di assistenza legale",
    "fr": "calculateur d'assistance juridique",
    "en": "legal assistance calculator"
  },
  "calcolatore di attraversamento": {
    "de": "Grenzübertrittsrechner",
    "fr": "calculateur de passage",
    "en": "crossing calculator"
  },
  "calcolatore di attraversamento frontiera": {
    "de": "Grenzübergangsrechner",
    "fr": "calculateur de traversée frontalière",
    "en": "border crossing calculator"
  },
  "calcolatore di autorizzazioni": {
    "de": "Genehmigungsrechner",
    "fr": "calculateur d'autorisations",
    "en": "authorization calculator"
  },
  "calcolatore di borse di studio": {
    "de": "Stipendienrechner",
    "fr": "calculateur de bourses d’études",
    "en": "scholarship calculator"
  },
  "calcolatore di budget": {
    "de": "Budgetrechner",
    "fr": "calculateur de budget",
    "en": "budget calculator"
  },
  "calcolatore di busta paga": {
    "de": "Lohnrechner",
    "fr": "calculateur de bulletin de salaire",
    "en": "pay slip calculator"
  },
  "calcolatore di busta paga (nav:calculator)": {
    "de": "Lohnrechner (nav:calculator)",
    "fr": "calculateur de paie (nav:calculator)",
    "en": "pay slip calculator (nav:calculator)"
  },
  "calcolatore di busta paga frontaliere": {
    "de": "Frontalier-Bonus-Rechner",
    "fr": "calcolatore di busta paga frontaliere",
    "en": "frontiersman pay slip calculator"
  },
  "calcolatore di conformità": {
    "de": "Konformitätsrechner",
    "fr": "calculateur de conformité",
    "en": "compliance calculator"
  },
  "calcolatore di confronto": {
    "de": "Vergleichstool",
    "fr": "outil de comparaison",
    "en": "comparison tool"
  },
  "calcolatore di confronto banche": {
    "de": "Bankvergleich",
    "fr": "outil de comparaison des banques",
    "en": "bank comparison tool"
  },
  "calcolatore di confronto costi": {
    "de": "Kostenvergleich",
    "fr": "outil de comparaison des coûts",
    "en": "cost comparison tool"
  },
  "calcolatore di confronto normative": {
    "de": "Vergleich von Vorschriften",
    "fr": "outil de comparaison des réglementations",
    "en": "regulatory comparison tool"
  },
  "calcolatore di confronto prodotti": {
    "de": "Produktvergleich",
    "fr": "outil de comparaison de produits",
    "en": "product comparison tool"
  },
  "calcolatore di consumo idrico": {
    "de": "Wasserverbrauchsrechner",
    "fr": "calculateur de consommation d'eau",
    "en": "water consumption calculator"
  },
  "calcolatore di convenienza": {
    "de": "Vergleichsrechner",
    "fr": "calculateur de convenance",
    "en": "convenience calculator"
  },
  "calcolatore di conversione valuta": {
    "de": "Währungsumrechner",
    "fr": "calculateur de conversion de devises",
    "en": "currency conversion calculator"
  },
  "calcolatore di copertura": {
    "de": "Abdeckungsrechner",
    "fr": "calculateur de couverture",
    "en": "coverage calculator"
  },
  "calcolatore di costi": {
    "de": "Kostenrechner",
    "fr": "calculateur de coûts",
    "en": "cost calculator"
  },
  "calcolatore di costi auto": {
    "de": "Auto-Kostenrechners",
    "fr": "calculateur de coûts automobiles",
    "en": "car cost calculator"
  },
  "calcolatore di costi aziendali": {
    "de": "Unternehmenskostenrechner",
    "fr": "calculateur de coûts d'entreprise",
    "en": "business cost calculator"
  },
  "calcolatore di costi di viaggio": {
    "de": "Reisekostenrechner",
    "fr": "calculateur de coûts de voyage",
    "en": "travel cost calculator"
  },
  "calcolatore di costi di vita": {
    "de": "Kostenrechner",
    "fr": "calculateur de coût de la vie",
    "en": "cost of living calculator"
  },
  "calcolatore di costi funerari": {
    "de": "Bestattungskostenrechner",
    "fr": "calculateur de coûts funéraires",
    "en": "funeral cost calculator"
  },
  "calcolatore di costi sanitari": {
    "de": "Kostenrechner für Gesundheitsleistungen",
    "fr": "calculateur de coûts de santé",
    "en": "healthcare cost calculator"
  },
  "calcolatore di costo dei programmi": {
    "de": "Programmkostenrechner",
    "fr": "calculateur de coût des programmes",
    "en": "program cost calculator"
  },
  "calcolatore di costo del carburante": {
    "de": "Kraftstoffkostenrechner",
    "fr": "calculateur de coût du carburant",
    "en": "fuel cost calculator"
  },
  "calcolatore di costo del viaggio": {
    "de": "Reisekostenrechner",
    "fr": "calculateur de coût de trajet",
    "en": "travel cost calculator"
  },
  "calcolatore di costo della vita": {
    "de": "Lebenshaltungskostenrechner",
    "fr": "calculateur de coût de la vie",
    "en": "cost of living calculator"
  },
  "calcolatore di costo della vita in ticino": {
    "de": "Lebenshaltungskostenrechner im Tessin",
    "fr": "calculateur du coût de la vie au Tessin",
    "en": "cost of living calculator in Ticino"
  },
  "calcolatore di costo vita": {
    "de": "Lebenshaltungskostenrechner",
    "fr": "calculateur de coût de la vie",
    "en": "cost of living calculator"
  },
  "calcolatore di disoccupazione": {
    "de": "Arbeitslosenrechner",
    "fr": "calculateur de chômage",
    "en": "unemployment calculator"
  },
  "calcolatore di donazioni": {
    "de": "Spendenrechner",
    "fr": "calculateur de dons",
    "en": "donation calculator"
  },
  "calcolatore di emergenza": {
    "de": "Notfallrechner",
    "fr": "calculateur d'urgence",
    "en": "emergency calculator"
  },
  "calcolatore di escursioni": {
    "de": "Wanderrechner",
    "fr": "calculateur de randonnées",
    "en": "hiking calculator"
  },
  "calcolatore di eventi": {
    "de": "Event-Rechner",
    "fr": "calculateur d'événements",
    "en": "event calculator"
  },
  "calcolatore di eventi insoliti": {
    "de": "Rechner für ungewöhnliche Ereignisse",
    "fr": "calculateur d'événements inhabituels",
    "en": "unusual events calculator"
  },
  "calcolatore di frontaliere ticino": {
    "de": "Rechner von Frontaliere Ticino",
    "fr": "calculateur de Frontalier Ticino",
    "en": "Frontaliere Ticino calculator"
  },
  "calcolatore di frontalieri": {
    "de": "Grenzgängerrechner",
    "fr": "calculateur de frontalier",
    "en": "cross-border worker calculator"
  },
  "calcolatore di igiene": {
    "de": "Hygienerechner",
    "fr": "calculateur d'hygiène",
    "en": "hygiene calculator"
  },
  "calcolatore di impatto": {
    "de": "Auswirkungsrechner",
    "fr": "calculateur d'impact",
    "en": "impact calculator"
  },
  "calcolatore di impatto ambientale": {
    "de": "Umweltauswirkungsrechner",
    "fr": "calculateur d'impact environnemental",
    "en": "environmental impact calculator"
  },
  "calcolatore di imposta alla fonte": {
    "de": "Quellensteuerrechner",
    "fr": "calculateur d'impôt à la source",
    "en": "withholding tax calculator"
  },
  "calcolatore di imposte": {
    "de": "Steuerrechner",
    "fr": "calculateur d'impôts",
    "en": "tax calculator"
  },
  "calcolatore di indennizzo": {
    "de": "Entschädigungsrechner",
    "fr": "calculateur d'indemnisation",
    "en": "compensation calculator"
  },
  "calcolatore di investimento": {
    "de": "Investitionsrechner",
    "fr": "calculateur d'investissement",
    "en": "investment calculator"
  },
  "calcolatore di iscrizione": {
    "de": "Anmelderechner",
    "fr": "calculateur d'inscription",
    "en": "registration calculator"
  },
  "calcolatore di mobilità": {
    "de": "Mobilitätsrechner",
    "fr": "calculateur de mobilité",
    "en": "mobility calculator"
  },
  "calcolatore di multa": {
    "de": "Bussenrechner",
    "fr": "calculateur d'amende",
    "en": "fine calculator"
  },
  "calcolatore di mutui": {
    "de": "Hypothekenrechner",
    "fr": "calculateur de prêts hypothécaires",
    "en": "mortgage calculator"
  },
  "calcolatore di mutuo": {
    "de": "Hypothekenrechner",
    "fr": "calculateur de prêt hypothécaire",
    "en": "mortgage calculator"
  },
  "calcolatore di mutuo ipotecario": {
    "de": "Hypothekenrechner",
    "fr": "calculateur de prêt hypothécaire",
    "en": "mortgage calculator"
  },
  "calcolatore di opportunità": {
    "de": "Chancenrechner",
    "fr": "calculateur d'opportunités",
    "en": "opportunity calculator"
  },
  "calcolatore di orari": {
    "de": "Zeitrechner",
    "fr": "calculateur d'horaires",
    "en": "schedule calculator"
  },
  "calcolatore di orari dei trasporti": {
    "de": "Fahrplanrechner für den öffentlichen Verkehr",
    "fr": "calculateur d'horaires des transports",
    "en": "transport schedule calculator"
  },
  "calcolatore di parcheggi": {
    "de": "Parkplatzrechner",
    "fr": "calculateur de parkings",
    "en": "parking calculator"
  },
  "calcolatore di pensione": {
    "de": "Rentenrechner",
    "fr": "calculateur de pension",
    "en": "pension calculator"
  },
  "calcolatore di pensioni": {
    "de": "Rentenrechner",
    "fr": "calculateur de pensions",
    "en": "pension calculator"
  },
  "calcolatore di percorrenza": {
    "de": "Streckenrechner",
    "fr": "calculateur de trajet",
    "en": "route calculator"
  },
  "calcolatore di percorso": {
    "de": "Streckenrechner",
    "fr": "calculateur d'itinéraire",
    "en": "route calculator"
  },
  "calcolatore di permessi": {
    "de": "Berechnungsrechner für Bewilligungen",
    "fr": "calculateur de permis",
    "en": "permit calculator"
  },
  "calcolatore di prenotazione": {
    "de": "Buchungsrechner",
    "fr": "calculateur de réservation",
    "en": "booking calculator"
  },
  "calcolatore di prestazioni": {
    "de": "Leistungsrechner",
    "fr": "calculateur de performances",
    "en": "performance calculator"
  },
  "calcolatore di previdenza": {
    "de": "Vorsorge-Rechner",
    "fr": "calculateur de prévoyance",
    "en": "pension calculator"
  },
  "calcolatore di rate": {
    "de": "Ratenrechner",
    "fr": "calculateur de mensualités",
    "en": "installment calculator"
  },
  "calcolatore di rendita pensionistica": {
    "de": "Rentenrechner",
    "fr": "calculateur de rente de vieillesse",
    "en": "pension annuity calculator"
  },
  "calcolatore di retribuzione": {
    "de": "Gehaltsrechner",
    "fr": "calculateur de rémunération",
    "en": "salary calculator"
  },
  "calcolatore di risarcimento": {
    "de": "Entschädigungsrechner",
    "fr": "calculateur d'indemnisation",
    "en": "compensation calculator"
  },
  "calcolatore di rischio": {
    "de": "Risikorechner",
    "fr": "calculateur de risque",
    "en": "risk calculator"
  },
  "calcolatore di rischio furto": {
    "de": "Diebstahlrisiko-Rechner",
    "fr": "calculateur de risque de vol",
    "en": "theft risk calculator"
  },
  "calcolatore di rischio incendio": {
    "de": "Brandrisikorechner",
    "fr": "calculateur de risque d'incendie",
    "en": "fire risk calculator"
  },
  "calcolatore di rischio sanitario": {
    "de": "Gesundheitsrisiko-Rechner",
    "fr": "calculateur de risque sanitaire",
    "en": "health risk calculator"
  },
  "calcolatore di rischio sanzioni": {
    "de": "Sanktionen-Risikorechner",
    "fr": "calculateur de risque de sanctions",
    "en": "sanctions risk calculator"
  },
  "calcolatore di rischio sismico": {
    "de": "Erdbebenrisiko-Rechner",
    "fr": "calculateur de risque sismique",
    "en": "seismic risk calculator"
  },
  "calcolatore di rischio truffe": {
    "de": "Betrugsrisiko-Rechner",
    "fr": "calculateur de risque d'escroquerie",
    "en": "scam risk calculator"
  },
  "calcolatore di risparmio": {
    "de": "Sparrechner",
    "fr": "calculateur d'économies",
    "en": "savings calculator"
  },
  "calcolatore di risparmio carburante": {
    "de": "Spritkostenrechner",
    "fr": "calculateur d'économie de carburant",
    "en": "fuel savings calculator"
  },
  "calcolatore di risparmio carpooling": {
    "de": "Carpooling-Einsparungsrechner",
    "fr": "calculateur d'économies de covoiturage",
    "en": "carpooling savings calculator"
  },
  "calcolatore di risparmio energetico": {
    "de": "Energiesparrechner",
    "fr": "calculateur d'économies énergétiques",
    "en": "energy savings calculator"
  },
  "calcolatore di ristorni": {
    "de": "Quellensteuerrückerstattungsrechner",
    "fr": "calculateur de remboursement d'impôt",
    "en": "Tax refund calculator"
  },
  "calcolatore di risultati": {
    "de": "Ergebnisrechner",
    "fr": "calculateur de résultats",
    "en": "results calculator"
  },
  "calcolatore di rumore": {
    "de": "Lärmrechner",
    "fr": "calculateur de bruit",
    "en": "noise calculator"
  },
  "calcolatore di salute": {
    "de": "Gesundheitsrechner",
    "fr": "calculateur de santé",
    "en": "health calculator"
  },
  "calcolatore di scadenze": {
    "de": "Fristenrechner",
    "fr": "calculateur de dates d'expiration",
    "en": "deadline calculator"
  },
  "calcolatore di sicurezza": {
    "de": "Sicherheitsrechner",
    "fr": "calculateur de sécurité",
    "en": "safety calculator"
  },
  "calcolatore di sicurezza aerea": {
    "de": "Luftfahrt-Sicherheitsrechner",
    "fr": "calculateur de sécurité aérienne",
    "en": "air safety calculator"
  },
  "calcolatore di sicurezza auto": {
    "de": "Auto-Sicherheitsrechner",
    "fr": "calculateur de sécurité auto",
    "en": "car security calculator"
  },
  "calcolatore di sicurezza balneare": {
    "de": "Badesicherheitsrechner",
    "fr": "calculateur de sécurité balnéaire",
    "en": "beach safety calculator"
  },
  "calcolatore di sicurezza informatica": {
    "de": "Cybersicherheitsrechner",
    "fr": "calculateur de sécurité informatique",
    "en": "cybersecurity calculator"
  },
  "calcolatore di sicurezza stradale": {
    "de": "Verkehrssicherheitsrechner",
    "fr": "calculateur de sécurité routière",
    "en": "road safety calculator"
  },
  "calcolatore di sicurezza sul lavoro": {
    "de": "Arbeitssicherheitsrechner",
    "fr": "calculateur de sécurité au travail",
    "en": "workplace safety calculator"
  },
  "calcolatore di sostenibilità": {
    "de": "Nachhaltigkeitsrechner",
    "fr": "calculateur de durabilité",
    "en": "sustainability calculator"
  },
  "calcolatore di sostenibilità del mutuo": {
    "de": "Darlehenssoll-Vermögenswertrechner",
    "fr": "Calculateur de sostenibilité du prêt",
    "en": "mortgage sustainability calculator"
  },
  "calcolatore di spesa": {
    "de": "Kostenrechner",
    "fr": "calculateur de dépenses",
    "en": "cost calculator"
  },
  "calcolatore di spesa carburante": {
    "de": "Kraftstoffkostenrechners",
    "fr": "calculateur de dépenses de carburant",
    "en": "fuel cost calculator"
  },
  "calcolatore di spesa mensile": {
    "de": "Monatsausgabenrechner",
    "fr": "calculateur de dépenses mensuelles",
    "en": "monthly expense calculator"
  },
  "calcolatore di spesa per il carburante": {
    "de": "Kraftstoffkostenrechner",
    "fr": "calculateur de dépenses de carburant",
    "en": "fuel expense calculator"
  },
  "calcolatore di spesa per trasporti pubblici": {
    "de": "Kostenrechner für öffentliche Verkehrsmittel",
    "fr": "calculateur de dépenses pour les transports publics",
    "en": "public transport cost calculator"
  },
  "calcolatore di spese": {
    "de": "Kostenrechner",
    "fr": "calculateur de dépenses",
    "en": "expense calculator"
  },
  "calcolatore di spese bancarie": {
    "de": "Bankgebührenrechner",
    "fr": "calculateur de frais bancaires",
    "en": "bank fee calculator"
  },
  "calcolatore di spese di viaggio": {
    "de": "Reisekostenrechner",
    "fr": "calculateur de frais de voyage",
    "en": "travel expense calculator"
  },
  "calcolatore di spese mediche": {
    "de": "Gesundheitskostenrechner",
    "fr": "calculateur de frais médicaux",
    "en": "medical expenses calculator"
  },
  "calcolatore di spese sanitarie": {
    "de": "Kalkulator für Gesundheitskosten",
    "fr": "calculateur de dépenses de santé",
    "en": "healthcare cost calculator"
  },
  "calcolatore di stipendi": {
    "de": "Gehaltsrechner",
    "fr": "calculateur de salaires",
    "en": "salary calculator"
  },
  "calcolatore di stipendi e imposte": {
    "de": "Lohn- und Steuerrechner",
    "fr": "calculateur de salaires et d'impôts",
    "en": "salary and tax calculator"
  },
  "calcolatore di stipendio": {
    "de": "Lohnrechner",
    "fr": "calculateur de salaire",
    "en": "salary calculator"
  },
  "calcolatore di stipendio di frontaliere ticino": {
    "de": "Gehaltsrechner von Frontaliere Ticino",
    "fr": "calculateur de salaire de Frontaliere Ticino",
    "en": "Frontaliere Ticino salary calculator"
  },
  "calcolatore di stipendio e imposte": {
    "de": "Lohn- und Steuerrechner",
    "fr": "calculateur de salaire et d'impôts",
    "en": "salary and tax calculator"
  },
  "calcolatore di stipendio frontaliere": {
    "de": "Grenzgänger-Gehaltsrechner",
    "fr": "calculateur de salaire frontalier",
    "en": "cross-border salary calculator"
  },
  "calcolatore di stipendio lordo-netto": {
    "de": "Bruttolohn-Nettolohn-Rechner",
    "fr": "calculateur de salaire brut-net",
    "en": "gross-net salary calculator"
  },
  "calcolatore di stipendio netto": {
    "de": "Nettolohnrechner",
    "fr": "calculateur de salaire net",
    "en": "net salary calculator"
  },
  "calcolatore di stipendio netto frontaliere": {
    "de": "Nettolohnrechner für Frontalier",
    "fr": "calculateur de salaire net frontalier",
    "en": "border worker net salary calculator"
  },
  "calcolatore di sussidi": {
    "de": "Zuschussrechner",
    "fr": "calculateur de subventions",
    "en": "subsidy calculator"
  },
  "calcolatore di sviluppo urbano": {
    "de": "Stadtentwicklungsrechner",
    "fr": "calculateur de développement urbain",
    "en": "urban development calculator"
  },
  "calcolatore di tasse": {
    "de": "Steuerrechner",
    "fr": "calculateur d'impôts",
    "en": "tax calculator"
  },
  "calcolatore di tassi di interesse": {
    "de": "Zinsrechner",
    "fr": "calculateur de taux d'intérêt",
    "en": "interest rate calculator"
  },
  "calcolatore di tempo di attraversamento": {
    "de": "Durchfahrtszeit-Rechner",
    "fr": "calculateur de temps de traversée",
    "en": "crossing time calculator"
  },
  "calcolatore di traffico": {
    "de": "Verkehrsrechner",
    "fr": "calculateur de trafic",
    "en": "traffic calculator"
  },
  "calcolatore di trasporti": {
    "de": "Transportrechner",
    "fr": "calculateur de transports",
    "en": "transport calculator"
  },
  "calcolatore di trasporto": {
    "de": "Transportrechner",
    "fr": "calculateur de transport",
    "en": "transport calculator"
  },
  "calcolatore di trasporto per pendolari": {
    "de": "Pendler-Transport-Rechner",
    "fr": "calculateur de transport pour navetteurs",
    "en": "commuter transport calculator"
  },
  "calcolatore di trasporto pubblico": {
    "de": "Öffentlichen Verkehrsrechner",
    "fr": "calculateur de transport public",
    "en": "public transport calculator"
  },
  "calcolatore di traversate": {
    "de": "Reisezeitrechner",
    "fr": "calculateur de traversées",
    "en": "crossing calculator"
  },
  "calcolatore di trenord": {
    "de": "Trenord-Rechner",
    "fr": "calculateur de Trenord",
    "en": "Trenord calculator"
  },
  "calcolatore di velocità": {
    "de": "Geschwindigkeitsrechner",
    "fr": "calculateur de vitesse",
    "en": "speed calculator"
  },
  "calcolatore di verifica delle qualifiche": {
    "de": "Qualifikationsprüfer",
    "fr": "calculateur de vérification des qualifications",
    "en": "qualification verification calculator"
  },
  "calcolatore di viaggio": {
    "de": "Rechner",
    "fr": "calculateur de voyage",
    "en": "travel calculator"
  },
  "calcolatore doganale": {
    "de": "Zollrechner",
    "fr": "calculateur douanier",
    "en": "customs calculator"
  },
  "calcolatore economico": {
    "de": "Wirtschaftsrechner",
    "fr": "calculateur économique",
    "en": "economic calculator"
  },
  "calcolatore energetico": {
    "de": "Energiekalkulator",
    "fr": "calculateur énergétique",
    "en": "energy calculator"
  },
  "calcolatore finanziario": {
    "de": "Finanzrechner",
    "fr": "calculateur financier",
    "en": "financial calculator"
  },
  "calcolatore fiscale": {
    "de": "Steuerrechner",
    "fr": "calculateur fiscal",
    "en": "tax calculator"
  },
  "calcolatore fiscale dello stipendio": {
    "de": "Steuerrechner für das Gehalt",
    "fr": "calculateur fiscal du salaire",
    "en": "salary tax calculator"
  },
  "calcolatore fiscale di frontaliere ticino": {
    "de": "Steuerrechner von Frontaliere Ticino",
    "fr": "Calculateur fiscal de Frontaliere Ticino",
    "en": "Frontaliere Ticino tax calculator"
  },
  "calcolatore fiscale frontaliere": {
    "de": "Steuerrechner für Grenzgänger",
    "fr": "calculateur fiscal frontalier",
    "en": "cross-border tax calculator"
  },
  "calcolatore fiscale frontalieri": {
    "de": "Steuerkalkulator für Grenzgänger",
    "fr": "calculateur fiscal pour frontaliers",
    "en": "cross-border tax calculator"
  },
  "calcolatore fiscale per frontalieri": {
    "de": "Steuerrechner für Grenzgänger",
    "fr": "calculateur fiscal pour frontaliers",
    "en": "tax calculator for cross-border workers"
  },
  "calcolatore frontaliere": {
    "de": "Grenzgänger-Rechner",
    "fr": "calculateur frontalier",
    "en": "cross-border calculator"
  },
  "calcolatore imposte": {
    "de": "Steuerrechner",
    "fr": "calculateur d'impôts",
    "en": "tax calculator"
  },
  "calcolatore interattivo": {
    "de": "interaktiven Rechner",
    "fr": "calculateur interactif",
    "en": "interactive calculator"
  },
  "calcolatore irpef": {
    "de": "Irpef-Rechner",
    "fr": "calculateur IRPEF",
    "en": "Irpef calculator"
  },
  "calcolatore lamal": {
    "de": "LAMal-Rechner",
    "fr": "calculateur LAMal",
    "en": "LAMal calculator"
  },
  "calcolatore mutui": {
    "de": "Kreditrechner",
    "fr": "calculateur de prêts",
    "en": "mortgage calculator"
  },
  "calcolatore mutuo": {
    "de": "Hypothekenrechner",
    "fr": "calculateur de prêt hypothécaire",
    "en": "mortgage calculator"
  },
  "calcolatore mutuo ipotecario": {
    "de": "calcolatore mutuo ipotecario",
    "fr": "calculateur de prêt hypothécaire",
    "en": "mortgage calculator"
  },
  "calcolatore online": {
    "de": "Online-Rechner",
    "fr": "calculateur en ligne",
    "en": "online calculator"
  },
  "calcolatore orari valichi ticino-italia": {
    "de": "Rechner für die Fahrzeiten an den Grenzübergängen Tessin-Italien",
    "fr": "calculateur des horaires aux postes-frontières entre le Tessin et l’Italie",
    "en": "border crossing schedule calculator for Ticino-Italy"
  },
  "calcolatore pensione": {
    "de": "Altersvorsorge-Rechner",
    "fr": "calculateur de retraite",
    "en": "pension calculator"
  },
  "calcolatore pensione avs/lpp": {
    "de": "AVS/BVG-Rentenrechner",
    "fr": "calculateur de retraite AVS/LPP",
    "en": "AVS/LPP pension calculator"
  },
  "calcolatore pensioni": {
    "de": "Rentenrechner",
    "fr": "calculateur de pensions",
    "en": "pension calculator"
  },
  "calcolatore pensionistico": {
    "de": "Rentenrechner",
    "fr": "calculateur de pension",
    "en": "pension calculator"
  },
  "calcolatore per frontalieri": {
    "de": "Grenzarbeiter-Rechner",
    "fr": "calculateur pour frontaliers",
    "en": "cross-border calculator"
  },
  "calcolatore per la pensione": {
    "de": "Rentenrechner",
    "fr": "calculateur de pension",
    "en": "pension calculator"
  },
  "calcolatore premi assicurazione": {
    "de": "Prämienrechner Versicherung",
    "fr": "calculateur de primes d'assurance",
    "en": "insurance premium calculator"
  },
  "calcolatore premi lamal": {
    "de": "LAMal-Prämienrechner",
    "fr": "calculateur de primes LAMal",
    "en": "LAMal premium calculator"
  },
  "calcolatore salariale": {
    "de": "Lohnrechner",
    "fr": "calculateur salarial",
    "en": "salary calculator"
  },
  "calcolatore salute": {
    "de": "Gesundheitsrechner",
    "fr": "calculateur santé",
    "en": "health calculator"
  },
  "calcolatore stipendi": {
    "de": "Gehaltsrechner",
    "fr": "calculateur de salaires",
    "en": "salary calculator"
  },
  "calcolatore stipendi e imposte": {
    "de": "Lohn- und Steuerrechner",
    "fr": "calculateur de salaires et d'impôts",
    "en": "salary and tax calculator"
  },
  "calcolatore stipendi frontalieri": {
    "de": "Frontalier-Stipendengerechner",
    "fr": "calculateur de salaires frontaliers",
    "en": "cross-border salary calculator"
  },
  "calcolatore stipendiale": {
    "de": "Gehaltrechner",
    "fr": "calculateur de salaire",
    "en": "salary calculator"
  },
  "calcolatore stipendio": {
    "de": "Lohnrechner",
    "fr": "calculateur de salaire",
    "en": "salary calculator"
  },
  "calcolatore stipendio di frontaliere ticino": {
    "de": "Lohnrechner von Frontaliere Ticino",
    "fr": "calculateur de salaire de Frontaliere Ticino",
    "en": "Frontaliere Ticino salary calculator"
  },
  "calcolatore stipendio e imposte": {
    "de": "Lohn- und Steuerrechner",
    "fr": "calculateur de salaire et d'impôts",
    "en": "salary and tax calculator"
  },
  "calcolatore stipendio frontaliere": {
    "de": "Grenzgänger-Lohnrechner",
    "fr": "calculateur de salaire frontalier",
    "en": "cross-border salary calculator"
  },
  "calcolatore stipendio frontalieri": {
    "de": "Gehaltssimulator für Grenzgänger",
    "fr": "calculateur de salaire des frontaliers",
    "en": "cross-border salary calculator"
  },
  "calcolatore stipendio netto": {
    "de": "Nettolohnrechner",
    "fr": "calculateur de salaire net",
    "en": "net salary calculator"
  },
  "calcolatore stipendio netto frontaliere": {
    "de": "Nettoeinkommensrechner für Grenzgänger",
    "fr": "Calculateur de salaire net frontalier",
    "en": "Net salary calculator for cross-border workers"
  },
  "calcolatore stipendio netto per frontalieri": {
    "de": "Nettolohnrechner für Grenzgänger",
    "fr": "calculateur de salaire net pour frontaliers",
    "en": "net salary calculator for cross-border workers"
  },
  "calcolatore stipendio netto svizzero": {
    "de": "calcolatore stipendio netto svizzero",
    "fr": "Calculateur de salaire net suisse",
    "en": "calcolatore stipendio netto svizzero"
  },
  "calcolatore stipendio netto ticino": {
    "de": "Lohnrechner Netto Tessin",
    "fr": "calculateur de salaire net Tessin",
    "en": "Ticino net salary calculator"
  },
  "calcolatore stipendio netto ticino vs lombardia": {
    "de": "Nettolohnrechner Tessin vs. Lombardei",
    "fr": "calculateur de salaire net au Tessin vs. en Lombardie",
    "en": "net salary calculator for Ticino vs Lombardy"
  },
  "calcolatore stipendio per frontalieri": {
    "de": "Lohnrechner für Grenzgänger",
    "fr": "calculateur de salaire pour frontaliers",
    "en": "cross-border worker salary calculator"
  },
  "calcolatore stipendio svizzero": {
    "de": "Schweizer Gehaltsrechner",
    "fr": "calculateur de salaire suisse",
    "en": "Swiss salary calculator"
  },
  "calcolatore stipendio/imposte": {
    "de": "Lohn-/Steuerrechner",
    "fr": "calculateur salaire/impôts",
    "en": "salary/tax calculator"
  },
  "calcolatore tasse": {
    "de": "Steuerrechner",
    "fr": "Calculateur d'impôts",
    "en": "Tax calculator"
  },
  "calcolatore tax-free": {
    "de": "Tax-Free-Rechner",
    "fr": "calculateur tax-free",
    "en": "tax-free calculator"
  },
  "calcolatore terzo pilastro 3a": {
    "de": "Säule 3a Rechner",
    "fr": "calculateur troisième pilier 3a",
    "en": "third pillar 3a calculator"
  },
  "calcolatore trasporto pendolari": {
    "de": "Pendlertransport-Rechner",
    "fr": "Calculateur transport pendulaires",
    "en": "Commuter Transport Calculator"
  },
  "calcolatori": {
    "de": "Rechner",
    "fr": "calculateur",
    "en": "calculators"
  },
  "calcolatori di stipendio": {
    "de": "Gehaltsrechner",
    "fr": "calculateurs de salaire",
    "en": "salary calculators"
  },
  "calcolatori online": {
    "de": "Online-Rechner",
    "fr": "calculateurs en ligne",
    "en": "online calculators"
  },
  "calcolo dello stipendio": {
    "de": "Gehaltsrechner",
    "fr": "calcul du salaire",
    "en": "salary calculation"
  },
  "calcolo dello stipendio netto": {
    "de": "Berechnung des Nettolohns",
    "fr": "calcul du salaire net",
    "en": "net salary calculation"
  },
  "calculator": {
    "de": "Reisezeitberechner",
    "fr": "calculateur",
    "en": "calculator"
  },
  "calendario": {
    "de": "Kalender",
    "fr": "calendrier",
    "en": "calendar"
  },
  "calendario degli eventi": {
    "de": "Veranstaltungskalender",
    "fr": "calendrier des événements",
    "en": "event calendar"
  },
  "calendario dei lavori": {
    "de": "Baukalender",
    "fr": "calendrier des travaux",
    "en": "work calendar"
  },
  "calendario dei passi alpini": {
    "de": "Alpenpass-Kalender",
    "fr": "calendrier des cols alpins",
    "en": "alpine passes calendar"
  },
  "calendario delle chiusure stradali": {
    "de": "Straßensperrkalender",
    "fr": "calendrier des fermetures routières",
    "en": "road closure calendar"
  },
  "calendario delle festività": {
    "de": "Feiertagskalender",
    "fr": "calendrier des jours fériés",
    "en": "public holidays calendar"
  },
  "calendario delle scadenze": {
    "de": "Fristenkalender",
    "fr": "calendrier des échéances",
    "en": "deadline calendar"
  },
  "calendario delle scadenze fiscali": {
    "de": "Kalender der steuerlichen Fristen",
    "fr": "calendrier des échéances fiscales",
    "en": "tax calendar"
  },
  "calendario elettorale": {
    "de": "Wahlkalenders",
    "fr": "calendrier électoral",
    "en": "electoral calendar"
  },
  "calendario eventi": {
    "de": "Veranstaltungskalender",
    "fr": "calendrier des événements",
    "en": "event calendar"
  },
  "calendario fiscale": {
    "de": "Steuerkalender",
    "fr": "calendrier fiscal",
    "en": "tax calendar"
  },
  "calendario ufficiale": {
    "de": "offiziellen Kalender",
    "fr": "calendrier officiel",
    "en": "official calendar"
  },
  "cambio": {
    "de": "CHF-EUR-Wechselvergleich",
    "fr": "change CHF-EUR",
    "en": "CHF-EUR exchange comparator"
  },
  "cambio chf-eur": {
    "de": "CHF-EUR-Wechseloptionen",
    "fr": "change CHF-EUR",
    "en": "CHF-EUR exchange options"
  },
  "cambio valuta": {
    "de": "Währungsrechner",
    "fr": "change de devises",
    "en": "currency exchange"
  },
  "cantone ticino": {
    "de": "Kanton Tessin",
    "fr": "canton du Tessin",
    "en": "Ticino canton"
  },
  "car-cost": {
    "de": "car-cost",
    "fr": "car-cost",
    "en": "car-cost"
  },
  "cassa malati": {
    "de": "Krankenkasse",
    "fr": "caisse maladie",
    "en": "health insurance"
  },
  "cassa malati (lamal)": {
    "de": "obligatorischen Krankenkasse (KVG)",
    "fr": "assurance maladie (LAMal)",
    "en": "health insurance (LAMal)"
  },
  "cassa malati lamal": {
    "de": "Krankenkasse KVG",
    "fr": "caisse-maladie LAMal",
    "en": "LAMal health insurance"
  },
  "cerca lavoro in ticino": {
    "de": "Jobsuche im Tessin",
    "fr": "recherchez un emploi au Tessin",
    "en": "find a job in Ticino"
  },
  "checklist primo giorno": {
    "de": "Checkliste erster Tag",
    "fr": "checklist premier jour",
    "en": "first day checklist"
  },
  "comparator di cambio": {
    "de": "Wechselkursvergleich",
    "fr": "comparateur de change",
    "en": "exchange rate comparator"
  },
  "comparatore": {
    "de": "Vergleich",
    "fr": "comparateur",
    "en": "comparison tool"
  },
  "comparatore asili nido": {
    "de": "Kindertagesstätten-Vergleich",
    "fr": "Comparateur crèches",
    "en": "Daycare Center Comparison Tool"
  },
  "comparatore assicurativo": {
    "de": "Versicherungsvergleich",
    "fr": "comparateur d'assurances",
    "en": "insurance comparator"
  },
  "comparatore assicurazione malattia": {
    "de": "Krankenkassenvergleich",
    "fr": "comparateur assurance maladie",
    "en": "health insurance comparator"
  },
  "comparatore assicurazioni": {
    "de": "Versicherungsvergleich",
    "fr": "comparateur d'assurances",
    "en": "insurance comparator"
  },
  "comparatore assicurazioni lamal": {
    "de": "LAMal-Versicherungsvergleich",
    "fr": "comparateur d'assurances LAMal",
    "en": "LAMal Insurance Comparator"
  },
  "comparatore assicurazioni malattia": {
    "de": "Krankenversicherungsvergleich",
    "fr": "comparateur d'assurances maladie",
    "en": "health insurance comparator"
  },
  "comparatore busta paga": {
    "de": "Lohnzettel-Vergleich",
    "fr": "comparateur de fiche de paie",
    "en": "payslip comparator"
  },
  "comparatore cambio": {
    "de": "Wechselkursvergleich",
    "fr": "comparateur de change",
    "en": "exchange comparator"
  },
  "comparatore cambio chf-eur": {
    "de": "CHF-EUR-Wechselvergleich",
    "fr": "comparateur de change CHF-EUR",
    "en": "CHF-EUR exchange comparator"
  },
  "comparatore cambio chf/eur": {
    "de": "CHF/EUR Wechselkursvergleich",
    "fr": "comparateur de change CHF/EUR",
    "en": "CHF/EUR exchange rate comparator"
  },
  "comparatore cambio valuta": {
    "de": "Wechselkursvergleich",
    "fr": "comparateur de change",
    "en": "currency exchange comparator"
  },
  "comparatore casse malati": {
    "de": "Krankenkassenvergleich",
    "fr": "Comparateur de caisses maladie",
    "en": "health insurance comparator"
  },
  "comparatore chf/eur": {
    "de": "CHF/EUR-Vergleich",
    "fr": "comparateur CHF/EUR",
    "en": "CHF/EUR comparator"
  },
  "comparatore conti bancari": {
    "de": "Bankenkonten-Vergleich",
    "fr": "comparateur de comptes bancaires",
    "en": "bank account comparator"
  },
  "comparatore costi": {
    "de": "Kostenvergleich",
    "fr": "comparateur de coûts",
    "en": "cost comparator"
  },
  "comparatore costi della vita": {
    "de": "Lebenshaltungskosten-Vergleich",
    "fr": "comparateur de coût de la vie",
    "en": "cost of living comparator"
  },
  "comparatore costi della vita ticino vs italia": {
    "de": "Vergleich der Lebenshaltungskosten im Tessin vs. Italien",
    "fr": "comparateur du coût de la vie au Tessin vs. en Italie",
    "en": "cost of living comparator for Ticino vs Italy"
  },
  "comparatore costo della vita": {
    "de": "Lebenshaltungskostenvergleich",
    "fr": "comparateur coût de la vie",
    "en": "cost of living comparator"
  },
  "comparatore costo della vita ticino-italia": {
    "de": "Lebenshaltungskostenvergleich Tessin-Italien",
    "fr": "comparateur du coût de la vie Tessin-Italie",
    "en": "cost of living comparator for Ticino-Italy"
  },
  "comparatore dei permessi": {
    "de": "Permit-Vergleichs-Tool",
    "fr": "comparateur des permis",
    "en": "comparator of permits"
  },
  "comparatore del costo della vita": {
    "de": "Lebenshaltungskosten-Vergleich",
    "fr": "comparateur du coût de la vie",
    "en": "cost of living comparator"
  },
  "comparatore delle assicurazioni sanitarie": {
    "de": "Vergleich der Krankenversicherungen",
    "fr": "comparateur des assurances maladie",
    "en": "health insurance comparator"
  },
  "comparatore delle casse malati": {
    "de": "Vergleich der Krankenkassen",
    "fr": "comparateur des caisses maladie",
    "en": "health insurance comparator"
  },
  "comparatore delle previsioni meteo": {
    "de": "Wettervorhersage-Vergleich",
    "fr": "comparateur des prévisions météo",
    "en": "weather forecast comparator"
  },
  "comparatore di assicurazioni": {
    "de": "Versicherungsvergleich",
    "fr": "comparateur d'assurances",
    "en": "insurance comparator"
  },
  "comparatore di assicurazioni di viaggio": {
    "de": "Reiseversicherungsvergleich",
    "fr": "comparateur d'assurances voyage",
    "en": "travel insurance comparator"
  },
  "comparatore di assicurazioni malattia": {
    "de": "Krankenversicherungsvergleich",
    "fr": "comparateur d'assurances maladie",
    "en": "health insurance comparator"
  },
  "comparatore di assicurazioni sanitarie": {
    "de": "Vergleich von Krankenversicherungen",
    "fr": "comparateur d'assurances maladie",
    "en": "health insurance comparator"
  },
  "comparatore di biglietti": {
    "de": "Ticketvergleich",
    "fr": "comparateur de billets",
    "en": "ticket comparator"
  },
  "comparatore di cambio": {
    "de": "Währungsvergleich",
    "fr": "comparateur de change",
    "en": "exchange rate comparator"
  },
  "comparatore di cambio eur/chf": {
    "de": "Wechselkursvergleicher EUR/CHF",
    "fr": "comparateur de change EUR/CHF",
    "en": "EUR/CHF exchange rate comparator"
  },
  "comparatore di cambio valuta": {
    "de": "Wechselkursvergleich",
    "fr": "comparateur de change",
    "en": "currency exchange comparator"
  },
  "comparatore di comuni": {
    "de": "Gemeindenvergleich",
    "fr": "comparateur de communes",
    "en": "municipality comparator"
  },
  "comparatore di costi": {
    "de": "Kostenvergleicher",
    "fr": "comparateur de coûts",
    "en": "cost comparator"
  },
  "comparatore di costi di vita": {
    "de": "Lebenshaltungskostenvergleich",
    "fr": "comparateur de coût de la vie",
    "en": "cost of living comparator"
  },
  "comparatore di costo della vita": {
    "de": "Lebenshaltungskostenvergleich",
    "fr": "comparateur de coût de la vie",
    "en": "cost of living comparator"
  },
  "comparatore di cv": {
    "de": "Lebenslaufvergleicher",
    "fr": "comparateur de CV",
    "en": "CV comparator"
  },
  "comparatore di impatto economico": {
    "de": "Wirtschaftsfolgenvergleicher",
    "fr": "comparateur d'impact économique",
    "en": "economic impact comparator"
  },
  "comparatore di imposte": {
    "de": "Steuervergleich",
    "fr": "comparateur d'impôts",
    "en": "tax comparator"
  },
  "comparatore di investimenti": {
    "de": "Investitionsvergleicher",
    "fr": "comparateur d'investissements",
    "en": "investment comparator"
  },
  "comparatore di locali": {
    "de": "Lokalvergleich",
    "fr": "comparateur de locaux",
    "en": "venue comparator"
  },
  "comparatore di mezzi pubblici": {
    "de": "Vergleich der öffentlichen Verkehrsmittel",
    "fr": "comparateur de transports publics",
    "en": "public transport comparator"
  },
  "comparatore di mutui": {
    "de": "Hypothekenvergleich",
    "fr": "comparateur de prêts hypothécaires",
    "en": "mortgage comparator"
  },
  "comparatore di orari": {
    "de": "Fahrplanvergleich",
    "fr": "comparateur d'horaires",
    "en": "schedule comparator"
  },
  "comparatore di pensioni": {
    "de": "Rentenvergleich",
    "fr": "comparateur de pensions",
    "en": "pension comparator"
  },
  "comparatore di percorsi": {
    "de": "Streckenvergleicher",
    "fr": "comparateur d'itinéraires",
    "en": "route comparator"
  },
  "comparatore di permessi": {
    "de": "Vergleich von Bewilligungen",
    "fr": "comparateur de permis",
    "en": "permit comparator"
  },
  "comparatore di permessi di soggiorno": {
    "de": "Vergleich der Aufenthaltsbewilligungen",
    "fr": "comparateur de permis de séjour",
    "en": "residence permit comparator"
  },
  "comparatore di polizze": {
    "de": "Polizzenvergleich",
    "fr": "comparateur de polices",
    "en": "policy comparator"
  },
  "comparatore di premi assicurativi": {
    "de": "Vergleich der Versicherungsprämien",
    "fr": "comparateur de primes d'assurance",
    "en": "health insurance premium comparator"
  },
  "comparatore di prestazioni": {
    "de": "Leistungsvergleicher",
    "fr": "comparateur de performances",
    "en": "benefits comparator"
  },
  "comparatore di previdenza": {
    "de": "Vergleich der Vorsorge",
    "fr": "comparateur de prévoyance",
    "en": "pension comparator"
  },
  "comparatore di prezzi": {
    "de": "Preisvergleich",
    "fr": "comparateur de prix",
    "en": "price comparator"
  },
  "comparatore di prezzi dei carburanti": {
    "de": "Kraftstoffpreisvergleich",
    "fr": "comparateur de prix des carburants",
    "en": "fuel price comparator"
  },
  "comparatore di prezzi del carburante": {
    "de": "Kraftstoffpreisvergleicher",
    "fr": "comparateur de prix du carburant",
    "en": "fuel price comparator"
  },
  "comparatore di prodotti": {
    "de": "Produktvergleicher",
    "fr": "comparateur de produits",
    "en": "product comparator"
  },
  "comparatore di progetti": {
    "de": "Projektvergleicher",
    "fr": "comparateur de projets",
    "en": "project comparator"
  },
  "comparatore di salari": {
    "de": "Gehaltsvergleichstool",
    "fr": "comparateur de salaires",
    "en": "salary comparator"
  },
  "comparatore di servizi di trasporto": {
    "de": "Vergleichsdienst für Verkehrsmittel",
    "fr": "comparateur de services de transport",
    "en": "transport service comparator"
  },
  "comparatore di servizi fiscali": {
    "de": "Steuerdienst-Vergleich",
    "fr": "comparateur de services fiscaux",
    "en": "tax service comparator"
  },
  "comparatore di squadre": {
    "de": "Vergleich der Teams",
    "fr": "comparateur d'équipes",
    "en": "team comparator"
  },
  "comparatore di stipendi": {
    "de": "Lohnvergleicher",
    "fr": "comparateur de salaires",
    "en": "salary comparator"
  },
  "comparatore di telefonia": {
    "de": "Mobilfunkvergleich",
    "fr": "comparateur de téléphonie",
    "en": "mobile phone comparator"
  },
  "comparatore di titoli": {
    "de": "Wertpapiervergleicher",
    "fr": "comparateur de titres",
    "en": "securities comparator"
  },
  "comparatore di trasporti": {
    "de": "Verkehrsvergleich",
    "fr": "comparateur de transports",
    "en": "transport comparator"
  },
  "comparatore di valuta": {
    "de": "Währungskomparator",
    "fr": "comparateur de devises",
    "en": "currency comparator"
  },
  "comparatore di voli": {
    "de": "Vergleichsdienst für Flüge",
    "fr": "comparateur de vols",
    "en": "flight comparator"
  },
  "comparatore fiscale": {
    "de": "Steuervergleich",
    "fr": "comparateur fiscal",
    "en": "tax comparator"
  },
  "comparatore lamal": {
    "de": "LAMal-Vergleich",
    "fr": "comparateur LAMal",
    "en": "LAMal comparator"
  },
  "comparatore offerte di lavoro": {
    "de": "Jobangebotvergleich",
    "fr": "Comparateur d'offres d'emploi",
    "en": "Job Offer Comparator"
  },
  "comparatore pensioni": {
    "de": "Rentenvergleicher",
    "fr": "comparateur de pensions",
    "en": "pension comparator"
  },
  "comparatore permessi": {
    "de": "Vergleich der Bewilligungen",
    "fr": "comparateur de permis",
    "en": "permit comparator"
  },
  "comparatore permessi g vs b": {
    "de": "Vergleicher G- vs. B-Bewilligung",
    "fr": "comparateur permis G vs B",
    "en": "comparator G vs B permits"
  },
  "comparatore permesso g vs b": {
    "de": "G-Bewilligung-Vergleich",
    "fr": "comparateur Permis G vs B",
    "en": "G Permit vs B Permit comparator"
  },
  "comparatore ristorni": {
    "de": "Rückerstattungsvergleicher",
    "fr": "comparateur de remboursements",
    "en": "refund comparator"
  },
  "comparatore salari": {
    "de": "Lohnvergleich",
    "fr": "comparateur de salaires",
    "en": "salary comparator"
  },
  "comparatore salute": {
    "de": "Gesundheitsvergleich",
    "fr": "comparateur santé",
    "en": "health comparator"
  },
  "comparatore stipendi": {
    "de": "Lohnvergleicher",
    "fr": "comparateur de salaires",
    "en": "salary comparator"
  },
  "comparatore valuta": {
    "de": "Währungsvergleich",
    "fr": "comparateur de devises",
    "en": "currency comparator"
  },
  "confronta i conti bancari": {
    "de": "vergleichen Sie Bankkonten",
    "fr": "comparez les comptes bancaires",
    "en": "compare bank accounts"
  },
  "confronta il costo della vita": {
    "de": "Lebenskosten",
    "fr": "comparer le coût de la vie",
    "en": "compare the cost of living"
  },
  "confronta offerte di lavoro in ticino": {
    "de": "Vergleiche Stellenangebote im Tessin",
    "fr": "comparez les offres d’emploi au Tessin",
    "en": "compare job offers in Ticino"
  },
  "confrontatore di alloggi": {
    "de": "Unterkunftsvergleich",
    "fr": "comparateur d'hébergements",
    "en": "accommodation comparator"
  },
  "confronto costi della vita": {
    "de": "Vergleich der Lebenshaltungskosten",
    "fr": "Comparaison du coût de la vie",
    "en": "confronto costi della vita"
  },
  "confronto costi vita": {
    "de": "Kostenvergleich",
    "fr": "Comparaison du coût de la vie",
    "en": "cost of living comparison"
  },
  "confronto costo della vita": {
    "de": "Lebenshaltungskostenvergleich",
    "fr": "comparaison du coût de la vie",
    "en": "cost of living comparison"
  },
  "confronto dei prezzi dei carburanti": {
    "de": "Kraftstoffpreisvergleich",
    "fr": "Comparaison des prix des carburants",
    "en": "Fuel price comparison"
  },
  "confronto del costo della vita": {
    "de": "Lebenshaltungskostenvergleich",
    "fr": "comparaison du coût de la vie",
    "en": "cost of living comparison"
  },
  "confronto del costo della vita in svizzera": {
    "de": "Vergleich der Lebenshaltungskosten in der Schweiz",
    "fr": "confronto del costo della vita in svizzera",
    "en": "confronto del costo della vita in svizzera"
  },
  "confronto della cassa malati": {
    "de": "confronto della cassa malati",
    "fr": "Comparatif assurance maladie",
    "en": "health insurance comparison"
  },
  "confronto delle tasse tra ticino e italia": {
    "de": "Steuervergleich zwischen Tessin und Italien",
    "fr": "comparaison des impôts entre le Tessin et l’Italie",
    "en": "comparison of taxes between Ticino and Italy"
  },
  "confronto lamal e cassa malati": {
    "de": "confronto lamal e cassa malati",
    "fr": "confronto lamal e cassa malati",
    "en": "confronto lamal e cassa malati"
  },
  "confronto lamal vs cmi": {
    "de": "LAMal vs. CMI Vergleich",
    "fr": "comparateur LAMal vs CMI",
    "en": "LAMal vs CMI comparison"
  },
  "confronto permessi": {
    "de": "Vergleich der Bewilligungen",
    "fr": "Comparaison des permis",
    "en": "Permit comparison"
  },
  "confronto stipendi": {
    "de": "Lohnvergleich",
    "fr": "Comparaison des salaires",
    "en": "Salary comparison"
  },
  "confronto sui ristorni ticino-italia": {
    "de": "Vergleich der Rückerstattungen Tessin-Italien",
    "fr": "comparaison des ristournes Tessin-Italie",
    "en": "comparison of tax refunds between Ticino and Italy"
  },
  "congedo parentale": {
    "de": "Elternurlaub",
    "fr": "congé parental",
    "en": "parental leave"
  },
  "consulta gli annunci di lavoro": {
    "de": "Sehen Sie sich die Stellenanzeigen an",
    "fr": "Consultez les offres d'emploi",
    "en": "Check job listings"
  },
  "consulta gli annunci di lavoro attivi": {
    "de": "konsultiere die aktiven Stellenanzeigen",
    "fr": "consulte les annonces d'emploi actives",
    "en": "consult the active job listings"
  },
  "consulta il calcolatore del costo della vita": {
    "de": "Konsultieren Sie den Lebenshaltungskosten-Rechner",
    "fr": "Consultez le calculateur du coût de la vie",
    "en": "Consult the cost of living calculator"
  },
  "consulta il calcolatore delle imposte": {
    "de": "besuchen Sie den Steuerrechner",
    "fr": "consultez le calculateur d'impôts",
    "en": "consult the tax calculator"
  },
  "consulta il calcolatore fiscale": {
    "de": "Klicken Sie hier, um den Steuerrechner zu nutzen",
    "fr": "Consultez le calculateur fiscal",
    "en": "Consult the tax calculator"
  },
  "consulta il calcolatore stipendio": {
    "de": "Konsultieren Sie den Gehaltsrechner",
    "fr": "Consultez le calculateur de salaire",
    "en": "Check the salary calculator"
  },
  "consulta il nostro calcolatore": {
    "de": "konsultieren Sie unseren Rechner",
    "fr": "consultez notre calculateur",
    "en": "consult our calculator"
  },
  "consulta il nostro calcolatore di stipendio e imposte": {
    "de": "konsultieren Sie unseren Gehalt- und Steuerkalkulator",
    "fr": "consultez notre calculateur de salaire et d'impôts",
    "en": "consult our salary and tax calculator"
  },
  "consulta il nostro calcolatore stipendio": {
    "de": "Nutzen Sie unseren Gehaltsrechner",
    "fr": "Consultez notre calculateur de salaire",
    "en": "Consult our salary calculator"
  },
  "consulta il nostro strumento di analisi del costo della vita in svizzera": {
    "de": "konsultieren Sie unseren Lebenshaltungskosten-Analysetool in der Schweiz",
    "fr": "consultez notre outil d'analyse du coût de la vie en Suisse",
    "en": "consult our cost of living analysis tool in Switzerland"
  },
  "consulta le offerte di lavoro disponibili": {
    "de": "Konsultieren Sie die verfügbaren Stellenangebote",
    "fr": "Consulte les offres d'emploi disponibles",
    "en": "Check available job offers"
  },
  "conti bancari": {
    "de": "Bankkonten",
    "fr": "comptes bancaires",
    "en": "bank accounts"
  },
  "conti bancari in svizzera": {
    "de": "Bankkonten in der Schweiz",
    "fr": "comptes bancaires en Suisse",
    "en": "bank accounts in Switzerland"
  },
  "conti bancari per frontalieri": {
    "de": "conti bancari per frontalieri",
    "fr": "conti bancari per frontalieri",
    "en": "conti bancari per frontalieri"
  },
  "cost-of-living": {
    "de": "Lebenshaltungskosten",
    "fr": "coût de la vie",
    "en": "cost-of-living"
  },
  "costi auto pendolare": {
    "de": "Autofahrtkosten für Pendler",
    "fr": "coûts voiture frontalier",
    "en": "commuting car costs"
  },
  "costi della vita": {
    "de": "Lebenshaltungskosten",
    "fr": "coûts de la vie",
    "en": "cost of living"
  },
  "costi di vita in ticino": {
    "de": "Lebenshaltungskosten im Tessin",
    "fr": "coûts de la vie en Suisse",
    "en": "cost of living in Ticino"
  },
  "costo auto pendolare": {
    "de": "Kosten des Pendlerautos",
    "fr": "coût de la voiture pour les navetteurs",
    "en": "commuter car cost"
  },
  "costo della vita": {
    "de": "Lebenshaltungskosten",
    "fr": "coût de la vie",
    "en": "cost of living"
  },
  "costo della vita complessivo": {
    "de": "gesamten Lebenshaltungskosten",
    "fr": "coût de la vie global",
    "en": "overall cost of living"
  },
  "costo della vita in svizzera": {
    "de": "Lebenshaltungskosten in der Schweiz",
    "fr": "coût de la vie en Suisse",
    "en": "cost of living in Switzerland"
  },
  "costo della vita in ticino": {
    "de": "Lebenshaltungskosten im Tessin",
    "fr": "coût de la vie au Tessin",
    "en": "cost of living in Ticino"
  },
  "costo della vita in ticino e in italia": {
    "de": "Lebenshaltungskosten im Tessin und in Italien",
    "fr": "coût de la vie au Tessin et en Italie",
    "en": "cost of living in Ticino and Italy"
  },
  "costo della vita per cantone": {
    "de": "Lebenshaltungskosten pro Kanton",
    "fr": "coût de la vie par canton",
    "en": "cost of living per canton"
  },
  "costo della vita svizzero": {
    "de": "costo della vita svizzero",
    "fr": "coût de la vie en Suisse",
    "en": "Swiss cost of living"
  },
  "costo della vita ticino vs italia": {
    "de": "Lebenshaltungskosten im Tessin vs. Italien",
    "fr": "coût de la vie au Tessin vs. Italie",
    "en": "cost of living in Ticino vs Italy"
  },
  "costo della vita ticino-italia": {
    "de": "costo della vita ticino-italia",
    "fr": "costo della vita ticino-italia",
    "en": "costo della vita ticino-italia"
  },
  "database immobiliare engel & völkers ticino": {
    "de": "Immobiliendatenbank Engel & Völkers Tessin",
    "fr": "base de données immobilière Engel & Völkers Tessin",
    "en": "Engel & Völkers Ticino real estate database"
  },
  "dati sul costo della vita in svizzera": {
    "de": "Daten zu den Lebenshaltungskosten in der Schweiz",
    "fr": "données sur le coût de la vie en Suisse",
    "en": "data on the cost of living in Switzerland"
  },
  "dfe": {
    "de": "dfe",
    "fr": "dfe",
    "en": "dfe"
  },
  "dfe ticino": {
    "de": "DAE Tessin",
    "fr": "dfe ticino",
    "en": "dfe ticino"
  },
  "dichiarazione 730": {
    "de": "Steuererklärung 730",
    "fr": "déclaration 730",
    "en": "730 declaration"
  },
  "dichiarazione dei redditi": {
    "de": "Steuererklärung",
    "fr": "déclaration des revenus",
    "en": "tax return"
  },
  "dichiarazione delle imposte": {
    "de": "Steuererklärung",
    "fr": "déclaration d'impôts",
    "en": "tax return"
  },
  "dichiarazione fiscale": {
    "de": "Steuererklärung",
    "fr": "déclaration fiscale",
    "en": "tax return"
  },
  "dichiarazione imposte": {
    "de": "dichiarazione imposte",
    "fr": "déclaration d'impôts",
    "en": "dichiarazione imposte"
  },
  "dichiarazione redditi": {
    "de": "Steuererklärung",
    "fr": "déclaration de revenus",
    "en": "tax return"
  },
  "dichiarazione redditi frontalieri": {
    "de": "Grenzgänger-Steuererklärung",
    "fr": "déclaration de revenus frontalier",
    "en": "cross-border tax returns"
  },
  "dipartimento del territorio": {
    "de": "Departements des Territoriums",
    "fr": "Département du territoire",
    "en": "Department of Territory"
  },
  "dipartimento della sanità e della socialità": {
    "de": "Departements für Gesundheit und Soziales",
    "fr": "Département de la santé et de la socialité",
    "en": "Department of Health and Social Affairs"
  },
  "disoccupazione": {
    "de": "Arbeitslosigkeit",
    "fr": "chômage",
    "en": "unemployment"
  },
  "disoccupazione dei frontalieri": {
    "de": "Arbeitslosigkeit von Grenzgängern",
    "fr": "chômage des frontaliers",
    "en": "cross-border unemployment"
  },
  "disoccupazione frontalieri": {
    "de": "Arbeitslosigkeit für Grenzgänger",
    "fr": "disoccupazione frontalieri",
    "en": "cross-border unemployment"
  },
  "disoccupazione per frontalieri": {
    "de": "Arbeitslosigkeit für Grenzgänger",
    "fr": "disoccupazione per frontalieri",
    "en": "disoccupazione per frontalieri"
  },
  "doppia imposizione": {
    "de": "Doppelbesteuerung",
    "fr": "double imposition",
    "en": "double taxation"
  },
  "dss ticino": {
    "de": "DSS Tessin",
    "fr": "DSS Tessin",
    "en": "DSS Ticino"
  },
  "engel & völkers ticino - proprietà in vendita": {
    "de": "Engel & Völkers Tessin – Immobilien zum Verkauf",
    "fr": "Engel & Völkers Tessin – biens immobiliers à vendre",
    "en": "Engel & Völkers Ticino – properties for sale"
  },
  "fiscale": {
    "de": "steuerlichen",
    "fr": "fiscale",
    "en": "tax"
  },
  "frontaliere": {
    "de": "Grenzgänger",
    "fr": "frontalier",
    "en": "cross-border workers"
  },
  "frontaliere con permesso g": {
    "de": "Grenzgänger mit G-Berechtigung",
    "fr": "frontalier avec permis G",
    "en": "cross-border worker with permit G"
  },
  "frontaliere ticino": {
    "de": "frontaliere ticino",
    "fr": "Frontalier Ticino",
    "en": "frontaliere ticino"
  },
  "frontaliereticino.ch": {
    "de": "frontaliereticino.ch",
    "fr": "frontaliereticino.ch",
    "en": "frontaliereticino.ch"
  },
  "gli annunci di lavoro": {
    "de": "die Stellenausschreibungen",
    "fr": "les offres d'emploi",
    "en": "job postings"
  },
  "google maps": {
    "de": "google maps",
    "fr": "google maps",
    "en": "google maps"
  },
  "gran consiglio": {
    "de": "Grossen Rates",
    "fr": "Grand Conseil",
    "en": "Grand Council"
  },
  "guida": {
    "de": "Anleitung",
    "fr": "guide",
    "en": "guide"
  },
  "guida ad avs e lpp": {
    "de": "Leitfaden zu AHV und BVG",
    "fr": "guide sur l'AVS et la LPP",
    "en": "guida ad avs e lpp"
  },
  "guida agli investimenti": {
    "de": "Anlageführer",
    "fr": "Guide des investissements",
    "en": "Investment guide"
  },
  "guida ai diritti dei lavoratori": {
    "de": "Arbeitsrechts-Leitfaden",
    "fr": "guide des droits des travailleurs",
    "en": "guide to workers' rights"
  },
  "guida ai mezzi pubblici": {
    "de": "guida ai mezzi pubblici",
    "fr": "guida ai mezzi pubblici",
    "en": "guida ai mezzi pubblici"
  },
  "guida ai permessi": {
    "de": "Leitfaden zu Bewilligungen",
    "fr": "guide des permis",
    "en": "permits guide"
  },
  "guida ai permessi di lavoro": {
    "de": "Arbeitsbewilligungsführer",
    "fr": "guide des permis de travail",
    "en": "work permit guide"
  },
  "guida ai permessi di lavoro in ticino": {
    "de": "Leitfaden zu Arbeitsbewilligungen im Tessin",
    "fr": "guide des permis de travail au Tessin",
    "en": "guide to work permits in Ticino"
  },
  "guida ai permessi di soggiorno": {
    "de": "Anleitung zu Aufenthaltsbewilligungen",
    "fr": "guide des permis de séjour",
    "en": "guide to residence permits"
  },
  "guida ai permessi frontalieri": {
    "de": "Anleitung für Frontaliergenehmigungen",
    "fr": "guide aux permis frontaliers",
    "en": "cross-border permits guide"
  },
  "guida ai ristorni": {
    "de": "Rückerstattungsanleitung",
    "fr": "guide aux retours",
    "en": "guide to refunds"
  },
  "guida ai ristorni frontalieri": {
    "de": "Anleitung zu den Grenzübergangsgrenzen",
    "fr": "guide aux remboursements frontaliers",
    "en": "guide to cross-border refunds"
  },
  "guida ai servizi sanitari": {
    "de": "Anleitung zu den Gesundheitsdiensten",
    "fr": "guide des services de santé",
    "en": "Guide to Health Services"
  },
  "guida ai sussidi sanitari in ticino": {
    "de": "Leitfaden zu Gesundheitszuschüssen im Tessin",
    "fr": "guide des aides sanitaires au Tessin",
    "en": "guide to healthcare subsidies in Ticino"
  },
  "guida ai trasporti": {
    "de": "Transportführer",
    "fr": "guide des transports",
    "en": "transport guide"
  },
  "guida ai trasporti tra ticino e lombardia": {
    "de": "Leitfaden für den Verkehr zwischen Tessin und Lombardei",
    "fr": "guide des transports entre le Tessin et la Lombardie",
    "en": "guide to transport between Ticino and Lombardy"
  },
  "guida ai valichi di frontiera tra ticino e lombardia": {
    "de": "Leitfaden zu den Grenzübergängen zwischen Tessin und Lombardei",
    "fr": "guide des postes-frontières entre le Tessin et la Lombardie",
    "en": "guide to border crossings between Ticino and Lombardy"
  },
  "guida al costo della vita": {
    "de": "Kosten des Lebens",
    "fr": "guide au coût de la vie",
    "en": "guide to the cost of living"
  },
  "guida al costo della vita in svizzera": {
    "de": "Leitfaden zu den Lebenshaltungskosten in der Schweiz",
    "fr": "guide du coût de la vie en Suisse",
    "en": "guide to the cost of living in Switzerland"
  },
  "guida al permesso g/b": {
    "de": "Leitfaden zur G/B-Bewilligung",
    "fr": "guide du Permis G/B",
    "en": "guida al permesso g/b"
  },
  "guida al telelavoro": {
    "de": "Leitfaden für Telearbeit",
    "fr": "Guide du télétravail",
    "en": "Guide to remote work"
  },
  "guida al terzo pilastro": {
    "de": "guida al terzo pilastro",
    "fr": "guida al terzo pilastro",
    "en": "guida al terzo pilastro"
  },
  "guida al terzo pilastro 3a": {
    "de": "Leitfaden zur Säule 3a",
    "fr": "guida al terzo pilastro 3a",
    "en": "guida al terzo pilastro 3a"
  },
  "guida all’acquisto immobiliare in ticino": {
    "de": "Leitfaden zum Immobilienkauf im Tessin",
    "fr": "guide d’acquisition immobilière au Tessin",
    "en": "guide to buying property in Ticino"
  },
  "guida all’acquisto immobiliare in ticino - supsi": {
    "de": "Leitfaden zum Immobilienkauf im Tessin – SUPSI",
    "fr": "guide d’acquisition immobilière au Tessin – SUPSI",
    "en": "guide to buying property in Ticino – SUPSI"
  },
  "guida all'assicurazione malattia": {
    "de": "Anleitung zur Krankenversicherung",
    "fr": "guide d'assurance maladie",
    "en": "health insurance guide"
  },
  "guida alla busta paga svizzera": {
    "de": "Anleitung zum schweizerischen Lohnausweis",
    "fr": "guide sur la fiche de paie suisse",
    "en": "guide to the Swiss payslip"
  },
  "guida alla cassa malati": {
    "de": "guida alla cassa malati",
    "fr": "guida alla cassa malati",
    "en": "guida alla cassa malati"
  },
  "guida alla dichiarazione dei redditi": {
    "de": "Anleitung zur Steuererklärung",
    "fr": "guide de déclaration fiscale",
    "en": "tax-return guide"
  },
  "guida alla dichiarazione delle imposte": {
    "de": "Anleitung zur Steuererklärung",
    "fr": "guide de déclaration des impôts",
    "en": "tax return guide"
  },
  "guida alla dichiarazione fiscale svizzera": {
    "de": "Anleitung zur Schweizer Steuererklärung",
    "fr": "guide de la déclaration fiscale suisse",
    "en": "guide to the Swiss tax return"
  },
  "guida alla disoccupazione dei frontalieri": {
    "de": "Leitfaden zur Arbeitslosigkeit von Grenzgängern",
    "fr": "guida alla disoccupazione dei frontalieri",
    "en": "guida alla disoccupazione dei frontalieri"
  },
  "guida alla disoccupazione per frontalieri": {
    "de": "guida alla disoccupazione per frontalieri",
    "fr": "guida alla disoccupazione per frontalieri",
    "en": "guida alla disoccupazione per frontalieri"
  },
  "guida alla gestione delle prescrizioni": {
    "de": "Anleitung zur Verwaltung von Verschreibungen",
    "fr": "guide de gestion des prescriptions",
    "en": "prescription management guide"
  },
  "guida alla lamal per frontalieri": {
    "de": "Leitfaden zum KVG für Grenzgänger",
    "fr": "Guide de la LAMal pour les frontaliers",
    "en": "Guide to LAMal for cross-border workers"
  },
  "guida alla pensione": {
    "de": "Rentenführer",
    "fr": "guide de la retraite",
    "en": "pension guide"
  },
  "guida alla previdenza professionale": {
    "de": "Anleitung zur beruflichen Vorsorge",
    "fr": "guide à la prévoyance professionnelle",
    "en": "Guide to professional pension schemes"
  },
  "guida alla residenza": {
    "de": "Wohnsitzführer",
    "fr": "Guide de résidence",
    "en": "Residency guide"
  },
  "guida alla rottamazione-quinquies": {
    "de": "Anleitung zur Rottamazione-quinquies",
    "fr": "guide de la régularisation-quinquies",
    "en": "guide to rottamazione-quinquies"
  },
  "guida alla salute": {
    "de": "Gesundheitsführer",
    "fr": "Guide de la santé",
    "en": "Health guide"
  },
  "guida alla sicurezza": {
    "de": "Sicherheitsleitfaden",
    "fr": "guide de sécurité",
    "en": "safety guide"
  },
  "guida alle assicurazioni": {
    "de": "Leitfaden zu Versicherungen",
    "fr": "Guide des assurances",
    "en": "Health insurance guide"
  },
  "guida alle assicurazioni sanitarie": {
    "de": "Leitfaden zu Krankenversicherungen",
    "fr": "guide des assurances santé",
    "en": "guide to health insurance"
  },
  "guida alle borse di studio": {
    "de": "Führer zu Stipendien",
    "fr": "guide des bourses d'études",
    "en": "scholarship guide"
  },
  "guida alle deduzioni fiscali": {
    "de": "Anleitung zu Steuerabzügen",
    "fr": "Guide des déductions fiscales",
    "en": "Guide to tax deductions"
  },
  "guida alle politiche energetiche svizzere": {
    "de": "Leitfaden zu den Schweizer Energiepolitiken",
    "fr": "guide des politiques énergétiques suisses",
    "en": "guide to Swiss energy policies"
  },
  "guida alle rendite avs": {
    "de": "guida alle rendite avs",
    "fr": "guida alle rendite avs",
    "en": "guida alle rendite avs"
  },
  "guida alle tutele per caregiver": {
    "de": "Leitfaden zu Schutzmaßnahmen für Pflegepersonen",
    "fr": "guide des protections pour aidants",
    "en": "guide to protections for caregivers"
  },
  "guida avs e lpp": {
    "de": "Leitfaden AHV und BVG",
    "fr": "guide AVS et LPP",
    "en": "AVS and LPP guide"
  },
  "guida avs/lpp": {
    "de": "AHV/BVG-Leitfaden",
    "fr": "guide AVS/LPP",
    "en": "OASI/BVG guide"
  },
  "guida avs/lpp e rendita": {
    "de": "guida avs/lpp e rendita",
    "fr": "guida avs/lpp e rendita",
    "en": "guida avs/lpp e rendita"
  },
  "guida dichiarazione dei redditi": {
    "de": "Leitfaden zur Einkommensteuererklärung",
    "fr": "guide déclaration des revenus",
    "en": "tax return guide"
  },
  "guida dichiarazione imposte": {
    "de": "Leitfaden zur Steuererklärung",
    "fr": "guide déclaration d'impôts",
    "en": "tax declaration guide"
  },
  "guida dichiarazione redditi": {
    "de": "Leitfaden zur Steuererklärung",
    "fr": "guide déclaration fiscale",
    "en": "tax return guide"
  },
  "guida disoccupazione": {
    "de": "Leitfaden Arbeitslosigkeit",
    "fr": "guide chomage",
    "en": "unemployment guide"
  },
  "guida fiscale": {
    "de": "Steuerleitfaden",
    "fr": "guide fiscal",
    "en": "tax guide"
  },
  "guida fiscale per frontalieri": {
    "de": "Steuerleitfaden für Grenzgänger",
    "fr": "Guide fiscal pour frontaliers",
    "en": "Tax guide for cross-border workers"
  },
  "guida lamal": {
    "de": "KVG-Ratgeber",
    "fr": "guide LAMal",
    "en": "LAMal guide"
  },
  "guida lamal e cassa malati": {
    "de": "Leitfaden KVG und Krankenkasse",
    "fr": "guida lamal e cassa malati",
    "en": "guida lamal e cassa malati"
  },
  "guida lamal per frontalieri": {
    "de": "LAMal-Leitfaden für Grenzgänger",
    "fr": "guide LAMal pour frontaliers",
    "en": "LAMal guide for cross-border workers"
  },
  "guida permessi g e b": {
    "de": "Anleitung für G- und B-Bewilligungen",
    "fr": "guide des permis G et B",
    "en": "G and B permit guide"
  },
  "guida pratica": {
    "de": "praktischer Leitfaden",
    "fr": "guide pratique",
    "en": "practical guide"
  },
  "guida sul costo della vita": {
    "de": "guida sul costo della vita",
    "fr": "guide sur le coût de la vie",
    "en": "cost of living guide"
  },
  "guida sul terzo pilastro 3a": {
    "de": "Leitfaden zur Säule 3a",
    "fr": "guide sur le troisième pilier 3a",
    "en": "guida sul terzo pilastro 3a"
  },
  "guida sulla pensione": {
    "de": "guida sulla pensione",
    "fr": "guida sulla pensione",
    "en": "guida sulla pensione"
  },
  "guida sulla rendita avs": {
    "de": "Leitfaden zur AHV-Rente",
    "fr": "guida sulla rendita avs",
    "en": "guida sulla rendita avs"
  },
  "guide per frontalieri": {
    "de": "Leitfäden für Grenzgänger",
    "fr": "guides pour frontaliers",
    "en": "guides for cross-border workers"
  },
  "guide per l'acquisto di veicoli elettrici": {
    "de": "Führer für den Kauf von Elektrofahrzeugen",
    "fr": "Guides pour l'achat de véhicules électriques",
    "en": "Guides for purchasing electric vehicles"
  },
  "guide pratiche": {
    "de": "praktischen Leitfäden",
    "fr": "guides pratiques",
    "en": "practical guides"
  },
  "health": {
    "de": "health",
    "fr": "health",
    "en": "health"
  },
  "i mezzi pubblici disponibili in ticino": {
    "de": "die verfügbaren öffentlichen Verkehrsmittel im Tessin",
    "fr": "les transports publics disponibles au Tessin",
    "en": "the public transport available in Ticino"
  },
  "il calcolatore": {
    "de": "Rechner",
    "fr": "le calculateur",
    "en": "calculator"
  },
  "il calcolatore delle imposte": {
    "de": "Steuerrechner",
    "fr": "le calculateur d'impôts",
    "en": "the tax calculator"
  },
  "il calcolatore di imposte": {
    "de": "dem Steuerschätzer",
    "fr": "calculateur d'impôts",
    "en": "the tax calculator"
  },
  "il calcolatore di stipendio": {
    "de": "den Gehaltsrechner",
    "fr": "le calculateur de salaire",
    "en": "salary calculator"
  },
  "il calcolatore di stipendio netto": {
    "de": "den Nettolohnrechner",
    "fr": "le calculatrice de salaire net",
    "en": "the net salary calculator"
  },
  "il calcolatore di stipendio svizzero": {
    "de": "den Schweizer Lohnrechner",
    "fr": "le calculateur de salaire suisse",
    "en": "Swiss salary calculator"
  },
  "il calcolatore online": {
    "de": "Online-Rechners",
    "fr": "le calculateur en ligne",
    "en": "dedicated online calculator"
  },
  "il calcolatore stipendio": {
    "de": "Lohnrechner",
    "fr": "le calculateur de salaire",
    "en": "Frontaliere Ticino's salary calculator"
  },
  "il calcolatore stipendio e imposte": {
    "de": "den Lohn- und Steuerrechner",
    "fr": "la calculatrice salaire et impôts",
    "en": "net salary calculator"
  },
  "il nostro calcolatore": {
    "de": "unseren Rechner",
    "fr": "notre calculateur",
    "en": "our calculator"
  },
  "il nostro calcolatore di stipendio": {
    "de": "unseren Gehaltsrechner",
    "fr": "notre calculateur de salaire",
    "en": "our salary calculator"
  },
  "il nostro calcolatore stipendio": {
    "de": "unseren Gehaltsrechner",
    "fr": "notre calculateur de salaire",
    "en": "our salary calculator"
  },
  "imposta alla fonte": {
    "de": "Quellensteuer",
    "fr": "impôt à la source",
    "en": "withholding tax"
  },
  "informazioni sui ristorni ticino-italia": {
    "de": "Informationen zu den Rückerstattungen Tessin-Italien",
    "fr": "informations sur les ristournes Tessin-Italie",
    "en": "information on tax refunds between Ticino and Italy"
  },
  "istituti bancari": {
    "de": "istituti bancari",
    "fr": "instituts bancaires",
    "en": "istituti bancari"
  },
  "job board": {
    "de": "Jobportal",
    "fr": "job board",
    "en": "job board"
  },
  "jobs": {
    "de": "jobs",
    "fr": "emplois",
    "en": "jobs"
  },
  "la nostra sezione dedicata": {
    "de": "unseren dedizierten Abschnitt",
    "fr": "notre section dédiée",
    "en": "our dedicated section"
  },
  "lamal": {
    "de": "KVG",
    "fr": "assurance maladie",
    "en": "KVG"
  },
  "lamal (assicurazione malattia obbligatoria)": {
    "de": "KBVG (obligatorische Krankenpflegeversicherung)",
    "fr": "LAMal (assurance maladie obligatoire)",
    "en": "LAMal (mandatory health insurance)"
  },
  "lamal (assicurazione malattia svizzera)": {
    "de": "KVG (schweizerische Krankenversicherung)",
    "fr": "LAMal (assurance maladie suisse)",
    "en": "LAMal (Swiss health insurance)"
  },
  "lamal assicurazione malattia": {
    "de": "KVG Krankenversicherung",
    "fr": "LAMal assurance-maladie",
    "en": "LAMal health insurance"
  },
  "lamal e assicurazione malattia": {
    "de": "LAMal- und Krankenversicherungsoptionen",
    "fr": "LAMal et assurance maladie",
    "en": "LAMal and health insurance"
  },
  "lamal e cassa malati": {
    "de": "KVG und Krankenkasse",
    "fr": "LAMal et caisse-maladie",
    "en": "KVG/LAMal and health insurance"
  },
  "lamal svizzera": {
    "de": "LAMal Schweiz",
    "fr": "LAMal Suisse",
    "en": "Swiss LAMal"
  },
  "lamal/cassa malati": {
    "de": "KVG/Krankenkasse",
    "fr": "LAMal/caisse-maladie",
    "en": "LAMal/health insurance"
  },
  "lamal/cmi": {
    "de": "lamal/cmi",
    "fr": "lamal/cmi",
    "en": "lamal/cmi"
  },
  "lamal/cmi assicurazione malattia": {
    "de": "KVG/KVK Krankenversicherung",
    "fr": "LAMal/CMI assurance maladie",
    "en": "lamal/cmi assicurazione malattia"
  },
  "lamal/kvg": {
    "de": "KVG",
    "fr": "lamal/kvg",
    "en": "lamal/kvg"
  },
  "lavorare in svizzera": {
    "de": "Arbeiten in der Schweiz",
    "fr": "Travail en Suisse",
    "en": "Working in Switzerland"
  },
  "lavoro": {
    "de": "Arbeit",
    "fr": "emploi",
    "en": "jobs"
  },
  "lavoro transfrontaliero": {
    "de": "grenzüberschreitenden Arbeiten",
    "fr": "travail transfrontalier",
    "en": "cross-border work"
  },
  "le offerte di lavoro in ticino": {
    "de": "Stellenangebote im Tessin",
    "fr": "les offres d'emploi au Tessin",
    "en": "jobs in Ticino"
  },
  "linee guida supsi": {
    "de": "linee guida supsi",
    "fr": "lignes directrices de la SUPSI",
    "en": "SUPSI guidelines"
  },
  "link": {
    "de": "link",
    "fr": "lien",
    "en": "link"
  },
  "lpp": {
    "de": "lpp",
    "fr": "lpp",
    "en": "BVG"
  },
  "lpp/bvg": {
    "de": "BVG/LPP",
    "fr": "lpp/bvg",
    "en": "lpp/bvg"
  },
  "mappa dei campus ef": {
    "de": "EF-Campus-Karte",
    "fr": "carte des campus EF",
    "en": "EF campus map"
  },
  "mappa dei comuni": {
    "de": "Karte der Gemeinden",
    "fr": "carte des communes",
    "en": "municipality map"
  },
  "mappa dei comuni ticinesi": {
    "de": "Karte der Tessiner Gemeinden",
    "fr": "carte des communes tessinoises",
    "en": "map of Ticino municipalities"
  },
  "mappa dei confini": {
    "de": "Grenzkarte",
    "fr": "carte des frontières",
    "en": "border map"
  },
  "mappa dei sentieri": {
    "de": "Wegkarte",
    "fr": "carte des sentiers",
    "en": "trail map"
  },
  "mappa dei trasporti": {
    "de": "Karte der Verkehrsmittel",
    "fr": "carte des transports",
    "en": "transport map"
  },
  "mappa dei trasporti pubblici": {
    "de": "Karte der öffentlichen Verkehrsmittel",
    "fr": "carte des transports publics",
    "en": "public transport map"
  },
  "mappa dei valichi": {
    "de": "Karte der Grenzübergänge",
    "fr": "carte des postes-frontières",
    "en": "map of border crossings"
  },
  "mappa dei valichi di confine": {
    "de": "Karte der Grenzübergänge",
    "fr": "Carte des postes-frontière",
    "en": "Border crossing map"
  },
  "mappa dei valichi di frontiera": {
    "de": "Karte der Grenzübergänge",
    "fr": "Carte des postes frontaliers",
    "en": "border crossing map"
  },
  "mappa dei valichi frontalieri": {
    "de": "mappa dei valichi frontalieri",
    "fr": "mappa dei valichi frontalieri",
    "en": "mappa dei valichi frontalieri"
  },
  "mappa del confine": {
    "de": "Grenzkarte",
    "fr": "carte de la frontière",
    "en": "border map"
  },
  "mappa distributori ticino": {
    "de": "Karte der Tankstellen im Tessin",
    "fr": "carte des stations-service du Tessin",
    "en": "map of fuel stations in Ticino"
  },
  "mappa interattiva": {
    "de": "interaktive Karte",
    "fr": "carte interactive",
    "en": "interactive map"
  },
  "mappa interattiva dei comuni di frontiera": {
    "de": "Interaktive Karte der Grenzgemeinden",
    "fr": "carte interactive des communes frontalières",
    "en": "interactive map of border municipalities"
  },
  "mappa interattiva dei comuni ticinesi": {
    "de": "Interaktive Karte der Tessiner Gemeinden",
    "fr": "mappa interattiva dei comuni ticinesi",
    "en": "interactive map of Ticino municipalities"
  },
  "mappa interattiva dei valichi": {
    "de": "interaktive Grenzübergangskarte",
    "fr": "carte interactive des points de passage",
    "en": "interactive border crossing map"
  },
  "mappa valichi": {
    "de": "Grenzübergangskarte",
    "fr": "carte des passages",
    "en": "border crossings map"
  },
  "mercati del lavoro svizzeri": {
    "de": "Schweizer Arbeitsmärkte",
    "fr": "marchés du travail suisses",
    "en": "Swiss labor markets"
  },
  "mercato del lavoro": {
    "de": "Arbeitsmarkt",
    "fr": "marché du travail",
    "en": "labor market"
  },
  "mercato del lavoro svizzero": {
    "de": "Schweizer Arbeitsmarkt",
    "fr": "marché du travail suisse",
    "en": "Swiss job market"
  },
  "mezzi pubblici": {
    "de": "öffentlichen Verkehrsmittel",
    "fr": "transports publics",
    "en": "public transport"
  },
  "mezzi pubblici in svizzera": {
    "de": "mezzi pubblici in svizzera",
    "fr": "moyens de transport publics en Suisse",
    "en": "public transport in Switzerland"
  },
  "mezzi pubblici in ticino": {
    "de": "öffentlichen Verkehrsmitteln im Tessin",
    "fr": "transports publics au Tessin",
    "en": "public transport in Ticino"
  },
  "mezzi pubblici ticino": {
    "de": "öffentlichen Verkehrsmittel Tessin",
    "fr": "transports publics du Tessin",
    "en": "Ticino public transport"
  },
  "mobilità": {
    "de": "Mobilität",
    "fr": "mobilité",
    "en": "mobility"
  },
  "mobilità transfrontaliera": {
    "de": "grenzüberschreitenden Mobilität",
    "fr": "mobilité transfrontalière",
    "en": "cross-border mobility"
  },
  "modello 730": {
    "de": "Steuergutschrift",
    "fr": "double imposition",
    "en": "model 730"
  },
  "modello 730 italiano": {
    "de": "italienische Formular 730",
    "fr": "modèle 730 italien",
    "en": "Italian 730 form"
  },
  "nav:calculator": {
    "de": "nav:calculator",
    "fr": "calculateur de salaire net",
    "en": "net salary calculator"
  },
  "nav:jobs": {
    "de": "nav:jobs",
    "fr": "nav:jobs",
    "en": "nav:jobs"
  },
  "normative": {
    "de": "Vorschriften",
    "fr": "réglementation",
    "en": "regulations"
  },
  "nostri strumenti": {
    "de": "unsere Tools",
    "fr": "nos outils",
    "en": "our tools"
  },
  "offerte di impiego": {
    "de": "Stellenangebote",
    "fr": "offres d'emploi",
    "en": "job offers"
  },
  "offerte di lavoro": {
    "de": "Stellenangebote",
    "fr": "offres d'emploi",
    "en": "job offers"
  },
  "offerte di lavoro in svizzera": {
    "de": "Stellenangebote in der Schweiz",
    "fr": "offres d'emploi en Suisse",
    "en": "job offers in Switzerland"
  },
  "offerte di lavoro in ticino": {
    "de": "Stellenangebote im Tessin",
    "fr": "offres d'emploi au Tessin",
    "en": "Ticino job offers"
  },
  "opportunità di lavoro": {
    "de": "Arbeitsmöglichkeiten",
    "fr": "opportunités d'emploi",
    "en": "job opportunities"
  },
  "opportunità di lavoro in svizzera": {
    "de": "opportunità di lavoro in svizzera",
    "fr": "opportunità di lavoro in svizzera",
    "en": "opportunità di lavoro in svizzera"
  },
  "payslip": {
    "de": "Nettolohnrechner",
    "fr": "payslip",
    "en": "payslip"
  },
  "pension": {
    "de": "Altersvorsorge",
    "fr": "retraite",
    "en": "pension"
  },
  "pensione": {
    "de": "Pension",
    "fr": "pension",
    "en": "pension"
  },
  "pensione avs/lpp": {
    "de": "pensione avs/lpp",
    "fr": "pensione avs/lpp",
    "en": "pensione avs/lpp"
  },
  "pensioni": {
    "de": "Renten",
    "fr": "les pensions",
    "en": "pensions"
  },
  "permessi": {
    "de": "Bewilligungen",
    "fr": "permis",
    "en": "permits"
  },
  "permessi di lavoro": {
    "de": "Arbeitsbewilligungen",
    "fr": "permis de travail",
    "en": "work permits"
  },
  "permessi di soggiorno": {
    "de": "Aufenthaltsbewilligungen",
    "fr": "permis de séjour",
    "en": "residence permits"
  },
  "permessi frontalieri": {
    "de": "Grenzgängergenehmigungen",
    "fr": "permis frontaliers",
    "en": "frontier permits"
  },
  "permesso": {
    "de": "Arbeitsgenehmigungs",
    "fr": "permis",
    "en": "permit"
  },
  "permesso compare": {
    "de": "Permit Compare",
    "fr": "comparateur de permis",
    "en": "permit compare"
  },
  "permesso g": {
    "de": "G-Bewilligung",
    "fr": "permis G",
    "en": "G permit"
  },
  "permesso g (frontaliere)": {
    "de": "G-Genehmigung (Grenzgänger)",
    "fr": "Permis G (frontalier)",
    "en": "G permit (cross-border commuter)"
  },
  "permesso g e b": {
    "de": "Bewilligung G und B",
    "fr": "permis G et B",
    "en": "G and B permits"
  },
  "permesso g vs b": {
    "de": "Anleitung",
    "fr": "permis G vs B",
    "en": "G permit vs B permit"
  },
  "permesso g/b": {
    "de": "G/B-Bewilligung",
    "fr": "permis G/B",
    "en": "Permit G/B"
  },
  "permit-compare": {
    "de": "permit-compare",
    "fr": "comparateur de permis",
    "en": "permit-compare"
  },
  "permits": {
    "de": "Bewilligungen",
    "fr": "permis",
    "en": "permits"
  },
  "pianificatore pensionistico": {
    "de": "Rentenplaner",
    "fr": "planificateur retraite",
    "en": "pension planner"
  },
  "pianificatore pensionistico avs/lpp": {
    "de": "AHV/BVG-Pensionsplaner",
    "fr": "Planificateur de retraite AVS/LPP",
    "en": "AVS/LPP Pension Planner"
  },
  "pianificazione pensionistica": {
    "de": "Vorsorgeplanung",
    "fr": "planification de la retraite",
    "en": "pension planning"
  },
  "pilastro 3a": {
    "de": "Säule 3a",
    "fr": "pilier 3a",
    "en": "pillar 3a"
  },
  "polizia cantonale del ticino": {
    "de": "Kantonspolizei Tessin",
    "fr": "police cantonale du Tessin",
    "en": "Ticino cantonal police"
  },
  "portale annunci di lavoro": {
    "de": "Jobportal",
    "fr": "portail d'annonces d'emploi",
    "en": "job listing portal"
  },
  "portale di ricerca annunci": {
    "de": "Stellensuchportal",
    "fr": "portail de recherche d'annonces",
    "en": "job search portal"
  },
  "posti di lavoro": {
    "de": "posti di lavoro",
    "fr": "posti di lavoro",
    "en": "work in Switzerland"
  },
  "premi lamal delle casse malati": {
    "de": "LAMal-Prämien der Krankenkassen",
    "fr": "primes LAMal",
    "en": "LAMal health insurance premiums"
  },
  "previdenza": {
    "de": "Vorsorge",
    "fr": "prévoyance",
    "en": "pension"
  },
  "previdenza avs": {
    "de": "previdenza avs",
    "fr": "previdenza avs",
    "en": "previdenza avs"
  },
  "previdenza da frontaliere": {
    "de": "Grenzgänger-Vorsorge",
    "fr": "prévoyance frontalier",
    "en": "cross-border pension"
  },
  "previdenza e pensione": {
    "de": "Vorsorge und Pensionsleistung",
    "fr": "prévoyance et retraite",
    "en": "pension and retirement"
  },
  "previdenza professionale": {
    "de": "berufliche Vorsorge",
    "fr": "prévoyance professionnelle",
    "en": "Professional pension"
  },
  "previdenza professionale lpp": {
    "de": "Rentenplaner",
    "fr": "planificateur retraite",
    "en": "pension planner"
  },
  "previdenza sociale": {
    "de": "Altersvorsorge‐",
    "fr": "prévoyance sociale",
    "en": "social security"
  },
  "primo giorno": {
    "de": "ersten Arbeitstag",
    "fr": "premier jour",
    "en": "first day"
  },
  "quadro ce del 730": {
    "de": "Rahmens CE der Erklärung 730",
    "fr": "section CE du 730",
    "en": "section CE of form 730"
  },
  "qualità della vita": {
    "de": "Lebensqualität",
    "fr": "qualité de vie",
    "en": "quality of life"
  },
  "qui": {
    "de": "hier",
    "fr": "ici",
    "en": "here"
  },
  "rendita pensionistica": {
    "de": "Altersrente",
    "fr": "rente de retraite",
    "en": "pension"
  },
  "ristorni": {
    "de": "Rückerstattungen",
    "fr": "ristournes",
    "en": "refunds"
  },
  "ristorni fiscali": {
    "de": "Steuerabzugsleitlinie",
    "fr": "ristorni fiscaux",
    "en": "fiscal refunds"
  },
  "ristorni per frontalieri": {
    "de": "Grenzgänger-Rückerstattungen",
    "fr": "compensations pour frontaliers",
    "en": "commuter refunds"
  },
  "ristorni ticino-italia": {
    "de": "Rückerstattungen Tessin-Italien",
    "fr": "ristournes Tessin-Italie",
    "en": "Ticino-Italy tax rebates"
  },
  "ristorni ticino-italia 2024": {
    "de": "Rückerstattungen Tessin-Italien 2024",
    "fr": "ristournes Tessin-Italie 2024",
    "en": "tax refunds between Ticino and Italy 2024"
  },
  "ristorno": {
    "de": "Rückerstattung",
    "fr": "ristourne",
    "en": "refund"
  },
  "salari": {
    "de": "Gehälter",
    "fr": "salaires",
    "en": "salaries"
  },
  "salary-compare": {
    "de": "salary-compare",
    "fr": "salary-compare",
    "en": "salary-compare"
  },
  "salute": {
    "de": "Gesundheit",
    "fr": "salute",
    "en": "salute"
  },
  "scadenze fiscali": {
    "de": "Steuerfristen",
    "fr": "échéances fiscales",
    "en": "tax deadlines"
  },
  "scopri come calcolare il costo della vita in ticino": {
    "de": "Erfahre, wie du die Lebenshaltungskosten im Tessin berechnest",
    "fr": "découvrez comment calculer le coût de la vie au Tessin",
    "en": "discover how to calculate the cost of living in Ticino"
  },
  "scopri come calcolare il tuo stipendio netto in ticino e confrontare le differenze con la lombardia": {
    "de": "Erfahre, wie du dein Nettogehalt im Tessin berechnest und die Unterschiede zur Lombardei vergleichst",
    "fr": "découvrez comment calculer votre salaire net au Tessin et comparer les différences avec la Lombardie",
    "en": "discover how to calculate your net salary in Ticino and compare the differences with Lombardy"
  },
  "scopri come ottimizzare la tua busta paga in ticino": {
    "de": "Erfahren Sie, wie Sie Ihren Lohnabrechnung im Tessin optimieren",
    "fr": "scopri come ottimizzare la tua busta paga in ticino",
    "en": "Discover how to optimize your payslip in Ticino"
  },
  "scopri come verificare le offerte di lavoro in ticino che assumono frontalieri": {
    "de": "Erfahre, wie du Stellenangebote im Tessin für Grenzgänger prüfst",
    "fr": "découvrez comment vérifier les offres d’emploi au Tessin pour frontaliers",
    "en": "discover how to check job offers in Ticino that hire cross-border workers"
  },
  "scopri di più": {
    "de": "Erfahren Sie mehr",
    "fr": "En savoir plus",
    "en": "Find out more"
  },
  "scopri di più sui vantaggi fiscali per i frontalieri in ticino": {
    "de": "Erfahren Sie mehr über die steuerlichen Vorteile für Grenzgänger im Tessin",
    "fr": "Découvrez-en plus sur les avantages fiscaux pour les frontaliers en Suisse",
    "en": "Learn more about the tax benefits for cross-border workers in Ticino"
  },
  "scopri di più sul calcolatore di stipendio": {
    "de": "Erfahren Sie mehr über den Gehaltsrechner",
    "fr": "En savoir plus sur le calculateur de salaire",
    "en": "Learn more about the salary calculator"
  },
  "scopri di più sul calcolatore fiscale": {
    "de": "Erfahren Sie mehr über den Steuerrechner",
    "fr": "Découvrez-en plus sur le calculateur fiscal",
    "en": "Learn more about the tax calculator"
  },
  "scopri di più sul calcolatore stipendio": {
    "de": "Erfahren Sie mehr über den Lohnrechner",
    "fr": "En savoir plus sur le calculateur de salaire",
    "en": "Learn more about the salary calculator"
  },
  "scopri di più sul costo della vita in svizzera": {
    "de": "Erfahren Sie mehr über die Lebenshaltungskosten in der Schweiz",
    "fr": "scopri di più sul costo della vita in svizzera",
    "en": "Learn more about the cost of living in Switzerland"
  },
  "scopri di più sul costo della vita in ticino": {
    "de": "Erfahre mehr über die Lebenshaltungskosten im Tessin",
    "fr": "Découvrez plus sur le coût de la vie au Tessin",
    "en": "Discover more about the cost of living in Ticino"
  },
  "scopri di più sulla sicurezza sul lavoro in svizzera": {
    "de": "Erfahren Sie mehr über die Arbeitssicherheit in der Schweiz",
    "fr": "En savoir plus sur la sécurité au travail en Suisse",
    "en": "Learn more about workplace safety in Switzerland"
  },
  "scopri il calcolatore stipendio e imposte": {
    "de": "entdecken Sie den Lohn- und Steuerrechner",
    "fr": "découvrez le calculateur de salaire et d'impôts",
    "en": "discover the salary and tax calculator"
  },
  "scopri il calcolatore stipendio ticino": {
    "de": "Entdecken Sie den Lohnrechner Tessin",
    "fr": "Découvrez le calculateur de salaire Tessin",
    "en": "Discover the Ticino salary calculator"
  },
  "scoprire quali sono i mezzi pubblici più convenienti": {
    "de": "scoprire quali sono i mezzi pubblici più convenienti",
    "fr": "découvrir quels sont les transports publics les plus pratiques",
    "en": "scoprire quali sono i mezzi pubblici più convenienti"
  },
  "seco": {
    "de": "seco",
    "fr": "seco",
    "en": "admin.ch"
  },
  "secondo pilastro": {
    "de": "zweiten Säule",
    "fr": "deuxième pilier",
    "en": "second pillar"
  },
  "secondo pilastro lpp": {
    "de": "zweiten Pfeiler LPP",
    "fr": "secondo pilastro lpp",
    "en": "second pillar LPP"
  },
  "servizi di trasporto pubblico": {
    "de": "Dienste des öffentlichen Verkehrs",
    "fr": "services de transport public",
    "en": "public transport services"
  },
  "servizi sanitari": {
    "de": "Gesundheitsdienste",
    "fr": "services de santé",
    "en": "health services"
  },
  "servizio di consulenza fiscale per stranieri - dfe ticino": {
    "de": "Steuerberatungsdienst für Ausländer – DFE Tessin",
    "fr": "service de conseil fiscal pour étrangers – DFE Tessin",
    "en": "tax advisory service for foreigners – DFE Ticino"
  },
  "simula il tuo stipendio netto": {
    "de": "Simulieren Sie Ihr Nettoeinkommen",
    "fr": "Simulez votre salaire net",
    "en": "Simulate your net salary"
  },
  "simula la tua busta paga": {
    "de": "Lohnabrechnung simulieren",
    "fr": "simulez votre bulletin de salaire",
    "en": "simulate your pay slip"
  },
  "simula la tua pensione": {
    "de": "Simulieren Sie Ihre Rente",
    "fr": "planificateur retraite",
    "en": "Simulate your pension"
  },
  "simulatore 3° pilastro": {
    "de": "Säule-3-Simulator",
    "fr": "simulateur 3e pilier",
    "en": "pillar 3 simulator"
  },
  "simulatore busta paga": {
    "de": "Lohnabrechnungs-Simulator",
    "fr": "simulateur de fiche de paie",
    "en": "payslip simulator"
  },
  "simulatore busta paga ticino": {
    "de": "Lohnabrechnungssimulator Tessin",
    "fr": "simulateur de fiche de paie Tessin",
    "en": "Ticino payslip simulator"
  },
  "simulatore della busta paga": {
    "de": "Lohnabrechnungs-Simulator",
    "fr": "simulateur de fiche de salaire",
    "en": "payslip simulator"
  },
  "simulatore di busta paga": {
    "de": "Lohnabrechnungssimulator",
    "fr": "simulateur de fiche de paie",
    "en": "payslip simulator"
  },
  "simulatore di previdenza": {
    "de": "Rentenplaner",
    "fr": "planificateur retraite",
    "en": "pension planner"
  },
  "simulatore dichiarazione": {
    "de": "Steuererklärung",
    "fr": "simulateur déclaration",
    "en": "simulatore dichiarazione"
  },
  "simulatore pensione": {
    "de": "Rentenrechner",
    "fr": "simulateur de retraite",
    "en": "pension simulator"
  },
  "simulatore residenza": {
    "de": "Residencesimulator",
    "fr": "simulateur de résidence",
    "en": "residency simulator"
  },
  "sito delle ffs": {
    "de": "Baustellenkarte",
    "fr": "sito delle ffs",
    "en": "sito delle ffs"
  },
  "sito ufficiale": {
    "de": "Offizielle Website",
    "fr": "Site officiel",
    "en": "Official website"
  },
  "sito ufficiale slowup ticino": {
    "de": "Offizielle slowUp-Website Tessin",
    "fr": "site officiel slowUp Tessin",
    "en": "official slowUp Ticino website"
  },
  "stipendio": {
    "de": "Gehalt",
    "fr": "salaire",
    "en": "salary"
  },
  "stipendio lordo": {
    "de": "Nettolohn",
    "fr": "salaire net",
    "en": "net salary"
  },
  "stipendio netto": {
    "de": "Netto-Gehalt",
    "fr": "salaire net",
    "en": "net salary"
  },
  "storico del traffico": {
    "de": "storico del traffico",
    "fr": "storico del traffico",
    "en": "storico del traffico"
  },
  "storico del traffico ai valichi": {
    "de": "Verkehrsverlauf an den Grenzübergängen",
    "fr": "storico del traffico ai valichi",
    "en": "traffic history at border crossings"
  },
  "storico del traffico e delle code": {
    "de": "storico del traffico e delle code",
    "fr": "storico del traffico e delle code",
    "en": "storico del traffico e delle code"
  },
  "storico del traffico e delle code ai valichi": {
    "de": "Verkehrshistorie und Warteschlangen an den Grenzübergängen",
    "fr": "historique du trafic et des files aux postes-frontières",
    "en": "traffic history and queues at border crossings"
  },
  "storico traffico": {
    "de": "Verkehrsverlauf",
    "fr": "historique du trafic",
    "en": "traffic history"
  },
  "storico traffico ai valichi": {
    "de": "Verkehrshistorie an den Grenzübergängen",
    "fr": "historique du trafic aux postes-frontières",
    "en": "traffic history at border crossings"
  },
  "storico traffico e code ai valichi": {
    "de": "Verkehrshistorie und Warteschlangen an den Grenzübergängen",
    "fr": "historique du trafic et des files aux postes-frontières",
    "en": "traffic history and queues at border crossings"
  },
  "storico traffico frontaliero": {
    "de": "historischen Grenzverkehr",
    "fr": "historique du trafic frontalier",
    "en": "cross-border traffic history"
  },
  "storico traffico/code ai valichi": {
    "de": "storico traffico/code ai valichi",
    "fr": "storico traffico/code ai valichi",
    "en": "storico traffico/code ai valichi"
  },
  "sulla sicurezza nei trasporti": {
    "de": "zur Sicherheit im Verkehr",
    "fr": "sur la sécurité dans les transports",
    "en": "on transport safety"
  },
  "supporto psicologico": {
    "de": "Psychologische Unterstützung",
    "fr": "Soutien psychologique",
    "en": "Psychological support"
  },
  "svizzera": {
    "de": "Schweiz",
    "fr": "Suisse",
    "en": "Switzerland"
  },
  "tasso di cambio chf/eur": {
    "de": "CHF/EUR-Wechselkurs",
    "fr": "taux CHF/EUR",
    "en": "CHF/EUR exchange rate"
  },
  "tax-return": {
    "de": "Steuererklärung",
    "fr": "tax-return",
    "en": "tax-return"
  },
  "telefonia mobile": {
    "de": "telefonia mobile",
    "fr": "telefonia mobile",
    "en": "telefonia mobile"
  },
  "tempi attesa valichi": {
    "de": "Pass-Wartezeiten",
    "fr": "délai d'attente des laissez-passer",
    "en": "waiting times at borders"
  },
  "tempi di attesa": {
    "de": "Wartezeiten",
    "fr": "temps d'attente",
    "en": "waiting times"
  },
  "tempi di attesa ai valichi": {
    "de": "Wartezeiten an den Grenzübergängen",
    "fr": "temps d'attente aux postes-frontière",
    "en": "border crossing wait times"
  },
  "tempi di attesa ai valichi ticino-italia": {
    "de": "Wartezeiten an den Grenzübergängen Tessin-Italien",
    "fr": "temps d’attente aux postes-frontières Tessin-Italie",
    "en": "waiting times at the Ticino-Italy border crossings"
  },
  "terzo pilastro": {
    "de": "dritte Säule",
    "fr": "troisième pilier",
    "en": "third pillar"
  },
  "terzo pilastro (3a)": {
    "de": "dritte Säule (3a)",
    "fr": "troisième pilier (3a)",
    "en": "third pillar (3a)"
  },
  "terzo pilastro 3a": {
    "de": "Säule 3a",
    "fr": "troisième pilier 3a",
    "en": "third pillar 3a"
  },
  "testo": {
    "de": "Text",
    "fr": "testo",
    "en": "text"
  },
  "ticino": {
    "de": "Tessin",
    "fr": "Tessin",
    "en": "Ticino"
  },
  "ticino traffic live": {
    "de": "Ticino Traffic Live",
    "fr": "trafic en direct au Tessin",
    "en": "Ticino Traffic Live"
  },
  "tool costo della vita": {
    "de": "Tool Lebenshaltungskosten",
    "fr": "outil coût de la vie",
    "en": "cost of living tool"
  },
  "tracker ristorni fiscali": {
    "de": "Tracker für Steuerrückerstattungen",
    "fr": "suivi des remboursements fiscaux",
    "en": "tax equalization payments tracker"
  },
  "traffic history": {
    "de": "Verkehrsarchiv",
    "fr": "historique du trafic",
    "en": "traffic history"
  },
  "traffic-history": {
    "de": "traffic-history",
    "fr": "traffic-history",
    "en": "traffic history"
  },
  "transport": {
    "de": "Verkehrsmittel",
    "fr": "transport",
    "en": "transport"
  },
  "trasport": {
    "de": "transport",
    "fr": "trasport",
    "en": "trasport"
  },
  "trasporti": {
    "de": "Transport",
    "fr": "transports",
    "en": "transport"
  },
  "trasporti pubblici": {
    "de": "öffentlichen Verkehrsmittel",
    "fr": "transports publics",
    "en": "public transport"
  },
  "trasporti pubblici in ticino": {
    "de": "öffentlicher Verkehr im Tessin",
    "fr": "transports publics au Tessin",
    "en": "public transport in Ticino"
  },
  "trasporto": {
    "de": "Transport",
    "fr": "transport",
    "en": "public"
  },
  "trasporto pubblico": {
    "de": "öffentliche Verkehr",
    "fr": "transport public",
    "en": "public transport"
  },
  "trenitalia.com": {
    "de": "trenitalia.com",
    "fr": "trenitalia.com",
    "en": "trenitalia.com"
  },
  "trova annunci di lavoro che assumono frontalieri in ticino": {
    "de": "Finde Stellenangebote im Tessin, die Grenzgänger einstellen",
    "fr": "trouvez des offres d’emploi au Tessin qui recrutent des frontaliers",
    "en": "find job postings in Ticino that hire cross-border workers"
  },
  "un calcolatore di stipendio netto": {
    "de": "einen Nettolohnrechner",
    "fr": "un calculateur de salaire net",
    "en": "a net salary calculator"
  },
  "un calcolatore stipendio": {
    "de": "Lohnrechner",
    "fr": "un calculateur de salaire",
    "en": "a salary calculator"
  },
  "usa il calcolatore stipendio": {
    "de": "benutze den Gehaltsrechner",
    "fr": "utilisez le calculateur de salaire",
    "en": "use the salary calculator"
  },
  "usa il nostro calcolatore": {
    "de": "verwenden Sie unseren Rechner",
    "fr": "utilisez notre calculateur",
    "en": "use our calculator"
  },
  "usa il nostro calcolatore di imposte": {
    "de": "verwende unseren Steuerrechner",
    "fr": "utilisez notre calculateur d'impôts",
    "en": "use our tax calculator"
  },
  "usa il nostro comparatore di annunci lavoro in ticino": {
    "de": "Nutze unseren Stellenvergleich im Tessin",
    "fr": "utilisez notre comparateur d’annonces d’emploi au Tessin",
    "en": "use our job listing comparator in Ticino"
  },
  "utilizza il calcolatore stipendio": {
    "de": "benutzen Sie den Lohnrechner",
    "fr": "Utilisez le calculateur de salaire",
    "en": "Use the salary calculator"
  },
  "utilizza il nostro calcolatore": {
    "de": "nutze unseren Rechner",
    "fr": "utilisez notre calculateur",
    "en": "use our calculator"
  },
  "utilizza il nostro calcolatore di stipendio": {
    "de": "Verwenden Sie unseren Stipendienberechnungsassistenten",
    "fr": "utilisez notre calculateur de salaire",
    "en": "use our salary calculator"
  },
  "utilizza il nostro calcolatore stipendio": {
    "de": "nutzen Sie unseren Löhne-Computer",
    "fr": "utilisez notre calculateur de salaire",
    "en": "use our salary calculator"
  },
  "verifica il tuo netto con il calcolatore": {
    "de": "Überprüfen Sie Ihr netto mit dem Rechner",
    "fr": "Vérifiez votre net avec le calculateur",
    "en": "Check your net with the calculator"
  },
  "verifica il tuo stipendio netto": {
    "de": "Lohnrechner",
    "fr": "calculateur salaire",
    "en": "check your net salary"
  },
  "verifica ora gli impatti sul tuo stipendio": {
    "de": "Überprüfen Sie jetzt die Auswirkungen auf Ihr Gehalt",
    "fr": "Vérifiez maintenant les impacts sur votre salaire",
    "en": "Check the impact on your salary now"
  },
  "vivere in svizzera": {
    "de": "Leben in der Schweiz",
    "fr": "vivre en Suisse",
    "en": "living in Switzerland"
  },
  "vivere in ticino": {
    "de": "Im Tessin leben",
    "fr": "Vivre dans le Tessin",
    "en": "Living in Ticino"
  },
  "www.caseificiaperti.ch": {
    "de": "www.caseificiaperti.ch",
    "fr": "www.fromageriesouvertes.ch",
    "en": "www.caseificiaperti.ch"
  },
  "www.ch.ch": {
    "de": "www.ch.ch",
    "fr": "www.ch.ch",
    "en": "www.ch.ch"
  },
  "www.corrida.ch": {
    "de": "www.corrida.ch",
    "fr": "www.corrida.ch",
    "en": "www.corrida.ch"
  },
  "www.giubiasco-carena.ch": {
    "de": "www.giubiasco-carena.ch",
    "fr": "www.giubiasco-carena.ch",
    "en": "www.giubiasco-carena.ch"
  },
  "www.giuliettaallago.it": {
    "de": "www.giuliettaallago.it",
    "fr": "www.giuliettaallago.it",
    "en": "www.giuliettaallago.it"
  },
  "www.lipupaludebrabbia.it": {
    "de": "www.lipupaludebrabbia.it",
    "fr": "www.lipupaludebrabbia.it",
    "en": "www.lipupaludebrabbia.it"
  },
  "www.museivarese.it": {
    "de": "www.museivarese.it",
    "fr": "www.museivarese.it",
    "en": "www.museivarese.it"
  },
  "www.schermalocarno.ch": {
    "de": "www.schermalocarno.ch",
    "fr": "www.schermalocarno.ch",
    "en": "www.schermalocarno.ch"
  },
  "www.seco.admin.ch": {
    "de": "www.seco.admin.ch",
    "fr": "www.seco.admin.ch",
    "en": "www.agenziaentrate.gov.it"
  },
  "www.springgiubiasco.ch": {
    "de": "www.springgiubiasco.ch",
    "fr": "www.springgiubiasco.ch",
    "en": "www.springgiubiasco.ch"
  },
  "www.suva.ch": {
    "de": "www.suva.ch",
    "fr": "www.suva.ch",
    "en": "www.seco.admin.ch"
  },
  "www.ti.ch/lavoro": {
    "de": "www.ti.ch/lavoro",
    "fr": "www.ti.ch/lavoro",
    "en": "www.ti.ch/lavoro"
  },
  "calcola il tuo stipendio netto svizzero": {
    "de": "Berechne dein Schweizer Nettogehalt",
    "fr": "calculez votre salaire net suisse",
    "en": "calculate your Swiss net salary"
  },
  "calcola ora": {
    "de": "Jetzt berechnen",
    "fr": "calculez maintenant",
    "en": "calculate now"
  },
  "confronta": {
    "de": "Vergleichen",
    "fr": "comparez",
    "en": "compare"
  },
  "guida all'assicurazione sanitaria": {
    "de": "Leitfaden zur Krankenversicherung",
    "fr": "guide de l’assurance maladie",
    "en": "health insurance guide"
  }
};

// Review manuale delle voci per cui il corpus non offre una traduzione
// sufficiente: il significato resta esplicito anche quando una lingua non ha
// ancora una coppia tradotta correttamente.
Object.assign(NAV_LINK_LABELS_RAW, {
  "agenzia delle dogane": {
    "de": "Zollbehörde",
    "fr": "administration des douanes",
    "en": "customs authority"
  },
  "approfondisci il calcolo della tua rendita nel nostro calcolatore avs →": {
    "de": "Vertiefe die Berechnung deiner Rente mit unserem AHV-Rechner →",
    "fr": "approfondissez le calcul de votre rente avec notre calculateur AVS →",
    "en": "learn more about calculating your pension with our AVS calculator →"
  },
  "avs e rendita": {
    "de": "AHV und Rente",
    "fr": "AVS et rente",
    "en": "AVS and pension"
  },
  "aziende svizzere": {
    "de": "Schweizer Unternehmen",
    "fr": "entreprises suisses",
    "en": "Swiss companies"
  },
  "banche in svizzera": {
    "de": "Banken in der Schweiz",
    "fr": "banques en Suisse",
    "en": "banks in Switzerland"
  },
  "calcolatore dei netti frontaliere": {
    "de": "Nettolohnrechner für Grenzgänger",
    "fr": "calculateur du salaire net des frontaliers",
    "en": "cross-border net salary calculator"
  },
  "calcolatore della rendita": {
    "de": "Rentenrechner",
    "fr": "calculateur de rente",
    "en": "pension calculator"
  },
  "calcolatore della rendita avs": {
    "de": "AHV-Rentenrechner",
    "fr": "calculateur de rente AVS",
    "en": "AVS pension calculator"
  },
  "calcolatore delle imposte cantonali": {
    "de": "Kantonssteuerrechner",
    "fr": "calculateur des impôts cantonaux",
    "en": "cantonal tax calculator"
  },
  "calcolatore di assistenza legale": {
    "de": "Rechner für Rechtshilfe",
    "fr": "calculateur d’assistance juridique",
    "en": "legal assistance calculator"
  },
  "calcolatore mutuo ipotecario": {
    "de": "Hypothekenrechner",
    "fr": "calculateur de prêt hypothécaire",
    "en": "mortgage calculator"
  },
  "calcolatore stipendio netto svizzero": {
    "de": "Schweizer Nettolohnrechner",
    "fr": "calculateur de salaire net suisse",
    "en": "Swiss net salary calculator"
  },
  "confronto della cassa malati": {
    "de": "Krankenkassenvergleich",
    "fr": "comparaison des caisses-maladie",
    "en": "health insurance comparison"
  },
  "confronto lamal e cassa malati": {
    "de": "LAMal- und Krankenkassenvergleich",
    "fr": "comparaison LAMal et caisse-maladie",
    "en": "LAMal and health insurance comparison"
  },
  "conti bancari per frontalieri": {
    "de": "Bankkonten für Grenzgänger",
    "fr": "comptes bancaires pour frontaliers",
    "en": "bank accounts for cross-border workers"
  },
  "costo della vita svizzero": {
    "de": "Lebenshaltungskosten in der Schweiz",
    "fr": "coût de la vie en Suisse",
    "en": "cost of living in Switzerland"
  },
  "costo della vita ticino-italia": {
    "de": "Lebenshaltungskosten Tessin-Italien",
    "fr": "coût de la vie Tessin-Italie",
    "en": "cost of living Ticino-Italy"
  },
  "dichiarazione imposte": {
    "de": "Steuererklärung",
    "fr": "déclaration d’impôts",
    "en": "tax return"
  },
  "frontaliere ticino": {
    "de": "Grenzgänger im Tessin",
    "fr": "frontalier au Tessin",
    "en": "cross-border worker in Ticino"
  },
  "guida ai mezzi pubblici": {
    "de": "Leitfaden zum öffentlichen Verkehr",
    "fr": "guide des transports publics",
    "en": "public transport guide"
  },
  "guida al terzo pilastro": {
    "de": "Leitfaden zur dritten Säule",
    "fr": "guide du troisième pilier",
    "en": "third pillar guide"
  },
  "guida alla cassa malati": {
    "de": "Leitfaden zur Krankenversicherung",
    "fr": "guide de la caisse-maladie",
    "en": "health insurance guide"
  },
  "guida alla disoccupazione per frontalieri": {
    "de": "Leitfaden zur Arbeitslosigkeit für Grenzgänger",
    "fr": "guide du chômage pour les frontaliers",
    "en": "unemployment guide for cross-border workers"
  },
  "guida alle rendite avs": {
    "de": "Leitfaden zu AHV-Renten",
    "fr": "guide des rentes AVS",
    "en": "AVS pension guide"
  },
  "guida avs/lpp e rendita": {
    "de": "AHV/BVG- und Rentenleitfaden",
    "fr": "guide AVS/LPP et rente",
    "en": "AVS/LPP and pension guide"
  },
  "guida sul costo della vita": {
    "de": "Leitfaden zu den Lebenshaltungskosten",
    "fr": "guide sur le coût de la vie",
    "en": "cost of living guide"
  },
  "guida sulla pensione": {
    "de": "Leitfaden zur Rente",
    "fr": "guide sur la retraite",
    "en": "pension guide"
  },
  "istituti bancari": {
    "de": "Bankinstitute",
    "fr": "établissements bancaires",
    "en": "banking institutions"
  },
  "mappa dei valichi frontalieri": {
    "de": "Karte der Grenzübergänge",
    "fr": "carte des postes-frontières",
    "en": "map of border crossings"
  },
  "mezzi pubblici in svizzera": {
    "de": "öffentlicher Verkehr in der Schweiz",
    "fr": "transports publics en Suisse",
    "en": "public transport in Switzerland"
  },
  "opportunità di lavoro in svizzera": {
    "de": "Arbeitsmöglichkeiten in der Schweiz",
    "fr": "possibilités d’emploi en Suisse",
    "en": "job opportunities in Switzerland"
  },
  "pensione avs/lpp": {
    "de": "AHV/BVG-Rente",
    "fr": "rente AVS/LPP",
    "en": "AVS/LPP pension"
  },
  "posti di lavoro": {
    "de": "Arbeitsplätze",
    "fr": "postes de travail",
    "en": "jobs"
  },
  "previdenza avs": {
    "de": "AHV-Vorsorge",
    "fr": "prévoyance AVS",
    "en": "AVS pension provision"
  },
  "scoprire quali sono i mezzi pubblici più convenienti": {
    "de": "herausfinden, welche öffentlichen Verkehrsmittel am günstigsten sind",
    "fr": "découvrir quels sont les transports publics les plus avantageux",
    "en": "find the most cost-effective public transport"
  },
  "storico del traffico": {
    "de": "Verkehrshistorie",
    "fr": "historique du trafic",
    "en": "traffic history"
  },
  "storico del traffico e delle code": {
    "de": "Verkehrshistorie und Warteschlangen",
    "fr": "historique du trafic et des files d’attente",
    "en": "traffic history and queues"
  },
  "storico traffico/code ai valichi": {
    "de": "Verkehrshistorie und Warteschlangen an den Grenzübergängen",
    "fr": "historique du trafic et des files aux postes-frontières",
    "en": "traffic history and queues at border crossings"
  },
  "telefonia mobile": {
    "de": "Mobilfunk",
    "fr": "téléphonie mobile",
    "en": "mobile telephony"
  }
});

Object.assign(NAV_LINK_LABELS_RAW, {
  "linee guida supsi": {
    "de": "SUPSI-Leitlinien",
    "fr": "directives de la SUPSI",
    "en": "SUPSI guidelines"
  },
  "assicurazione lamal": {
    "de": "LAMal-Versicherung",
    "fr": "assurance LAMal",
    "en": "LAMal insurance"
  },
  "calcolatore cambio valuta": {
    "de": "Währungsrechner",
    "fr": "calculateur de change",
    "en": "currency exchange calculator"
  },
  "calcolatore di busta paga frontaliere": {
    "de": "Lohnabrechnungsrechner für Grenzgänger",
    "fr": "calculateur de fiche de paie pour frontaliers",
    "en": "payslip calculator for cross-border workers"
  },
  "confronto del costo della vita in svizzera": {
    "de": "Vergleich der Lebenshaltungskosten in der Schweiz",
    "fr": "comparaison du coût de la vie en Suisse",
    "en": "comparison of the cost of living in Switzerland"
  },
  "disoccupazione frontalieri": {
    "de": "Arbeitslosigkeit von Grenzgängern",
    "fr": "chômage des frontaliers",
    "en": "unemployment of cross-border workers"
  },
  "disoccupazione per frontalieri": {
    "de": "Arbeitslosigkeit für Grenzgänger",
    "fr": "chômage pour les frontaliers",
    "en": "unemployment for cross-border workers"
  },
  "guida al terzo pilastro 3a": {
    "de": "Leitfaden zur Säule 3a",
    "fr": "guide du troisième pilier 3a",
    "en": "third pillar 3a guide"
  },
  "guida alla disoccupazione dei frontalieri": {
    "de": "Leitfaden zur Arbeitslosigkeit von Grenzgängern",
    "fr": "guide du chômage des frontaliers",
    "en": "guide to cross-border unemployment"
  },
  "guida lamal e cassa malati": {
    "de": "Leitfaden zu LAMal und Krankenversicherung",
    "fr": "guide LAMal et caisse-maladie",
    "en": "LAMal and health insurance guide"
  },
  "guida sulla rendita avs": {
    "de": "Leitfaden zur AHV-Rente",
    "fr": "guide de la rente AVS",
    "en": "AVS pension guide"
  },
  "mappa interattiva dei comuni ticinesi": {
    "de": "interaktive Karte der Tessiner Gemeinden",
    "fr": "carte interactive des communes tessinoises",
    "en": "interactive map of Ticino municipalities"
  },
  "scopri come ottimizzare la tua busta paga in ticino": {
    "de": "Entdecke, wie du deine Lohnabrechnung im Tessin optimierst",
    "fr": "découvrez comment optimiser votre fiche de paie au Tessin",
    "en": "discover how to optimize your payslip in Ticino"
  },
  "scopri di più sul costo della vita in svizzera": {
    "de": "Erfahre mehr über die Lebenshaltungskosten in der Schweiz",
    "fr": "en savoir plus sur le coût de la vie en Suisse",
    "en": "learn more about the cost of living in Switzerland"
  },
  "secondo pilastro lpp": {
    "de": "zweite Säule LPP",
    "fr": "deuxième pilier LPP",
    "en": "second pillar LPP"
  },
  "sito delle ffs": {
    "de": "SBB-Website",
    "fr": "site des CFF",
    "en": "SBB website"
  },
  "storico del traffico ai valichi": {
    "de": "Verkehrshistorie an den Grenzübergängen",
    "fr": "historique du trafic aux postes-frontières",
    "en": "traffic history at border crossings"
  },
  "testo": {
    "de": "Text",
    "fr": "texte",
    "en": "text"
  },
  "bacheca lavoro": {
    "de": "Jobbörse",
    "fr": "bourse d’emploi",
    "en": "job board"
  },
  "confronto costi della vita": {
    "de": "Vergleich der Lebenshaltungskosten",
    "fr": "comparaison des coûts de la vie",
    "en": "cost of living comparison"
  },
  "guida ad avs e lpp": {
    "de": "AHV- und BVG-Leitfaden",
    "fr": "guide AVS et LPP",
    "en": "AVS and LPP guide"
  },
  "guida al permesso g/b": {
    "de": "Leitfaden zur G/B-Bewilligung",
    "fr": "guide du permis G/B",
    "en": "G/B permit guide"
  },
  "guida sul terzo pilastro 3a": {
    "de": "Leitfaden zur Säule 3a",
    "fr": "guide du troisième pilier 3a",
    "en": "guide to the third pillar 3a"
  },
  "salute": {
    "de": "Gesundheit",
    "fr": "santé",
    "en": "health"
  },
  "simulatore dichiarazione": {
    "de": "Steuererklärungssimulator",
    "fr": "simulateur de déclaration fiscale",
    "en": "tax return simulator"
  },
  "trasport": {
    "de": "Transport",
    "fr": "transport",
    "en": "transport"
  }
});

Object.assign(NAV_LINK_LABELS_RAW, {
  "scopri di più su play svizzera": {
    "de": "Erfahren Sie mehr über Play Suisse",
    "fr": "En savoir plus sur Play Suisse",
    "en": "Learn more about Play Suisse"
  },
  "asili nido": {
    "de": "Kinderkrippen",
    "fr": "crèches",
    "en": "nurseries"
  },
  "assistenza sanitaria": {
    "de": "Gesundheitsversorgung",
    "fr": "soins de santé",
    "en": "health care"
  },
  "avs": {
    "de": "AHV",
    "fr": "AVS",
    "en": "OASI"
  },
  "avs/ai/ipg": {
    "de": "AHV/IV/EO",
    "fr": "AVS/AI/APG",
    "en": "OASI/DI/IC"
  },
  "costi di vita in ticino": {
    "de": "Lebenshaltungskosten im Tessin",
    "fr": "coût de la vie au Tessin",
    "en": "cost of living in Ticino"
  },
  "fiscale": {
    "de": "steuerlich",
    "fr": "fiscal",
    "en": "tax"
  },
  "il calcolatore di stipendio netto": {
    "de": "der Nettolohnrechner",
    "fr": "le calculateur de salaire net",
    "en": "the net salary calculator"
  },
  "il calcolatore stipendio e imposte": {
    "de": "der Lohn- und Steuerrechner",
    "fr": "le calculateur de salaire et d’impôts",
    "en": "the salary and tax calculator"
  },
  "ristorni fiscali": {
    "de": "Steuererstattungen",
    "fr": "ristournes fiscales",
    "en": "tax refunds"
  },
  "lamal/cmi assicurazione malattia": {
    "de": "LAMal/CMI-Krankenversicherung",
    "fr": "assurance maladie LAMal/CMI",
    "en": "LAMal/CMI health insurance"
  },
  "verifica il tuo netto con il calcolatore": {
    "de": "Überprüfen Sie Ihr Nettoeinkommen mit dem Rechner",
    "fr": "Vérifiez votre salaire net avec le calculateur",
    "en": "Check your net salary with the calculator"
  },
  "calcolatore terzo pilastro 3a": {
    "de": "Rechner für die Säule 3a",
    "fr": "calculateur du troisième pilier 3a",
    "en": "third pillar 3a calculator"
  },
  "guida al costo della vita": {
    "de": "Leitfaden zu den Lebenshaltungskosten",
    "fr": "guide du coût de la vie",
    "en": "guide to the cost of living"
  },
  "costo della vita per cantone": {
    "de": "Lebenshaltungskosten pro Kanton",
    "fr": "coût de la vie par canton",
    "en": "cost of living by canton"
  },
  "calcolatore di frontaliere ticino": {
    "de": "Frontaliere-Ticino-Rechner",
    "fr": "calculateur de Frontaliere Ticino",
    "en": "Frontaliere Ticino calculator"
  },
  "calcolatore di stipendio di frontaliere ticino": {
    "de": "Frontaliere-Ticino-Gehaltsrechner",
    "fr": "calculateur de salaire de Frontaliere Ticino",
    "en": "Frontaliere Ticino salary calculator"
  },
  "calcolatore fiscale di frontaliere ticino": {
    "de": "Frontaliere-Ticino-Steuerrechner",
    "fr": "calculateur fiscal de Frontaliere Ticino",
    "en": "Frontaliere Ticino tax calculator"
  },
  "calcolatore stipendio di frontaliere ticino": {
    "de": "Frontaliere-Ticino-Gehaltsrechner",
    "fr": "calculateur de salaire de Frontaliere Ticino",
    "en": "Frontaliere Ticino salary calculator"
  },
  "calcolatore stipendio netto ticino": {
    "de": "Nettolohnrechner für das Tessin",
    "fr": "calculateur de salaire net au Tessin",
    "en": "Ticino net salary calculator"
  },
  "costi della vita": {
    "de": "Lebenshaltungskosten",
    "fr": "coût de la vie",
    "en": "cost of living"
  },
  "confronto costi vita": {
    "de": "Vergleich der Lebenshaltungskosten",
    "fr": "comparaison du coût de la vie",
    "en": "cost of living comparison"
  },
  "guida ai ristorni": {
    "de": "Leitfaden zu den Rückerstattungen",
    "fr": "guide des ristournes",
    "en": "guide to refunds"
  },
  "guida ai ristorni frontalieri": {
    "de": "Leitfaden zu den Rückerstattungen für Grenzgänger",
    "fr": "guide aux remboursements frontaliers",
    "en": "guide to cross-border refunds"
  },
  "calcolatore di viaggio": {
    "de": "Reiserechner",
    "fr": "calculateur de voyage",
    "en": "travel calculator"
  },
  "mappa valichi": {
    "de": "Grenzübergangskarte",
    "fr": "carte des postes-frontières",
    "en": "border crossings map"
  },
  "simulatore di previdenza": {
    "de": "Vorsorgesimulator",
    "fr": "simulateur de prévoyance",
    "en": "pension provision simulator"
  },
  "utilizza il nostro calcolatore di stipendio": {
    "de": "Verwenden Sie unseren Gehaltsrechner",
    "fr": "utilisez notre calculateur de salaire",
    "en": "use our salary calculator"
  },
  "utilizza il nostro calcolatore stipendio": {
    "de": "Nutzen Sie unseren Gehaltsrechner",
    "fr": "utilisez notre calculateur de salaire",
    "en": "use our salary calculator"
  },
  "comparatore dei permessi": {
    "de": "Vergleich der Bewilligungen",
    "fr": "comparateur des permis",
    "en": "permit comparator"
  },
  "guida alle assicurazioni": {
    "de": "Leitfaden zu Versicherungen",
    "fr": "guide des assurances",
    "en": "insurance guide"
  },
  "guida avs/lpp": {
    "de": "AHV/BVG-Leitfaden",
    "fr": "guide AVS/LPP",
    "en": "AVS/LPP guide"
  },
  "guida alla pensione": {
    "de": "Leitfaden zur Rente",
    "fr": "guide de la retraite",
    "en": "pension guide"
  },
  "guida alla salute": {
    "de": "Gesundheitsleitfaden",
    "fr": "guide de la santé",
    "en": "health guide"
  },
  "guida ai servizi sanitari": {
    "de": "Leitfaden zu Gesundheitsdiensten",
    "fr": "guide des services de santé",
    "en": "guide to health services"
  },
  "mezzi pubblici": {
    "de": "öffentliche Verkehrsmittel",
    "fr": "transports publics",
    "en": "public transport"
  },
  "storico traffico frontaliero": {
    "de": "Verkehrshistorie des Grenzverkehrs",
    "fr": "historique du trafic frontalier",
    "en": "cross-border traffic history"
  },
  "calcola lo stipendio netto": {
    "de": "Berechne dein Nettogehalt",
    "fr": "Calculez votre salaire net",
    "en": "calculate your net salary"
  },
  "confronta il costo della vita": {
    "de": "Vergleiche die Lebenshaltungskosten",
    "fr": "comparer le coût de la vie",
    "en": "compare the cost of living"
  },
  "verifica il tuo stipendio netto": {
    "de": "Überprüfe dein Nettogehalt",
    "fr": "Vérifiez votre salaire net",
    "en": "check your net salary"
  },
  "simula la tua pensione": {
    "de": "Simulieren Sie Ihre Rente",
    "fr": "Simulez votre retraite",
    "en": "Simulate your pension"
  },
  "premi lamal delle casse malati": {
    "de": "LAMal-Prämien der Krankenkassen",
    "fr": "primes LAMal des caisses-maladie",
    "en": "LAMal health insurance premiums"
  },
  "le offerte di lavoro in ticino": {
    "de": "Stellenangebote im Tessin",
    "fr": "les offres d'emploi au Tessin",
    "en": "job offers in Ticino"
  },
  "calcolatore di busta paga": {
    "de": "Lohnabrechnungsrechner",
    "fr": "calculateur de fiche de paie",
    "en": "payslip calculator"
  },
  "calcolatore della busta paga": {
    "de": "Lohnabrechnungsrechner",
    "fr": "calculateur de fiche de paie",
    "en": "payslip calculator"
  },
  "calcolatore di busta paga (nav:calculator)": {
    "de": "Lohnabrechnungsrechner (nav:calculator)",
    "fr": "calculateur de fiche de paie (nav:calculator)",
    "en": "payslip calculator (nav:calculator)"
  },
  "calcolare il tuo risparmio fiscale": {
    "de": "Berechne deine Steuerersparnis",
    "fr": "calculer votre économie fiscale",
    "en": "calculate your tax savings"
  }
});

function freezeNavEntry(entry) {
  return Object.freeze({ ...entry });
}

export const NAV_LINK_LABELS = Object.freeze(
  Object.fromEntries(
    Object.entries(NAV_LINK_LABELS_RAW).map(([label, entry]) => [label, freezeNavEntry(entry)]),
  ),
);

export function normalizeNavLinkLabel(value) {
  return String(value ?? "")
    .normalize("NFC")
    .toLocaleLowerCase("it")
    .replace(/\btessin\b/gu, "ticino")
    .replace(/\bschweiz\b/gu, "svizzera")
    .replace(/\bsuisse\b/gu, "svizzera")
    .replace(/\bitalien\b/gu, "italia")
    .replace(/\bitalie\b/gu, "italia")
    .replace(/\s+/gu, " ")
    .trim();
}

const ITALIAN_WORDS = new Set([
  "calcolatore", "calcolatori", "calcolatrice", "calcolo", "cambio", "cassa",
  "comuni", "congedo", "costi", "costo", "dichiarazione", "dichiarazioni",
  "disoccupazione", "frontaliera", "frontaliere", "frontalieri",
  "guida", "imposte", "infanzia", "iniziative", "lavoro", "malati", "mappa", "mercato",
  "mezzi", "nido", "offerte", "paga", "pensionistico", "permesso", "permessi",
  "pilastro", "primo", "pubblici", "redditi", "residenza", "ristorni", "ristrutturazione",
  "salari", "scadenze", "simulatore", "stipendi", "stipendio", "tasse",
  "telefonia", "tempi", "trasporti", "traffico", "valichi", "vita", "vivibilità",
  "aziende", "banche", "banca", "busta", "comparatore", "confronto", "della", "delle",
  "degli", "dichiarazione", "fondo", "pianificatore", "pensioni", "pubblico", "sanitarie",
  "assicurazione", "assicurazioni", "attesa", "attese",
  "calendario", "carburante", "comunali", "dati", "eventi", "lavorare", "municipio",
  "parentale", "pensione", "pratica", "scolastici", "servizi", "sicurezza", "telefoniche",
  "terzo", "uffici", "veicolo", "sconosciuta",
]);

const ITALIAN_WORDS_BY_LOCALE = Object.freeze({
  de: new Set([...ITALIAN_WORDS, "fiscale", "fiscali"]),
  en: new Set([...ITALIAN_WORDS, "fiscale", "fiscali"]),
  fr: ITALIAN_WORDS,
  it: ITALIAN_WORDS,
});

const NAV_LINK_RE = /\[([^\]\n]+)\]\((nav:([a-z0-9-]+)[^)]*)\)/giu;

const BRAND_RE = /\b(?:frontaliere\s+ticino|frontaliereticino(?:\.ch)?)\b/giu;
const CAPITALIZED_BRAND_RE = /\bFrontaliere\b/gu;

function withoutCapitalizedBrand(value, locale) {
  const vocabulary = ITALIAN_WORDS_BY_LOCALE[locale] ?? ITALIAN_WORDS;
  return String(value).replace(CAPITALIZED_BRAND_RE, (match, offset, source) => {
    const suffix = source.slice(Number(offset) + match.length);
    if (/^[-/]/u.test(suffix)) return ' ';
    const nextWord = /^\s+([\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*)/u.exec(suffix)?.[1];
    if (!nextWord || vocabulary.has(nextWord.toLocaleLowerCase('it'))) {
      return nextWord ? match : ' ';
    }
    return ' ';
  });
}

function normalizedWords(value, locale = "it") {
  return withoutCapitalizedBrand(
    withoutOfficialNameWords(withoutUrls(String(value ?? "").normalize("NFKC")))
      .replace(BRAND_RE, " "),
    locale,
  )
    .normalize("NFKC")
    .toLocaleLowerCase("it")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function italianWords(value, locale = "it") {
  const vocabulary = ITALIAN_WORDS_BY_LOCALE[locale] ?? ITALIAN_WORDS;
  return new Set(normalizedWords(value, locale).filter((word) => vocabulary.has(word)));
}

function sourceItalianWordsByTarget(itBody) {
  const wordsByTarget = new Map();
  if (!itBody) return wordsByTarget;
  for (const match of String(itBody).matchAll(NAV_LINK_RE)) {
    const target = match[3].toLowerCase();
    const words = italianWords(match[1], "it");
    if (!words.size) continue;
    if (!wordsByTarget.has(target)) wordsByTarget.set(target, new Set());
    for (const word of words) wordsByTarget.get(target).add(word);
  }
  return wordsByTarget;
}

function isItalianNavLabel(label, target, sourceWordsByTarget, locale) {
  const normalized = normalizeNavLinkLabel(label);
  const normalizedLabelWords = normalizedWords(label, locale);
  const canonical = NAV_LINK_LABELS[normalized];
  if (canonical && normalizeNavLinkLabel(canonical[locale]) === normalized) return false;
  if (canonical && normalizedLabelWords.length > 0) return true;
  if (italianWords(label, locale).size) return true;
  const sourceWords = sourceWordsByTarget.get(target);
  return Boolean(sourceWords?.size && normalizedLabelWords.some((word) => sourceWords.has(word)));
}

/**
 * Returns Italian-looking labels in a translated body. Unknown labels are
 * reported with canonicalLabel null; they are never replaced by a target fallback.
 */
export function findItalianNavLinkLabels(markdown, locale, { itBody = "" } = {}) {
  if (locale === "it") return [];
  const sourceWordsByTarget = sourceItalianWordsByTarget(itBody);
  const hits = [];
  for (const match of String(markdown ?? "").matchAll(NAV_LINK_RE)) {
    const target = match[3].toLowerCase();
    if (!isItalianNavLabel(match[1], target, sourceWordsByTarget, locale)) continue;
    const normalized = normalizeNavLinkLabel(match[1]);
    hits.push({
      index: match.index ?? 0,
      label: match[1],
      target,
      canonicalLabel: NAV_LINK_LABELS[normalized]?.[locale] ?? null,
    });
  }
  return hits;
}

/**
 * Replace a known Italian label only when its normalized label is in the
 * canonical map. Target syntax is copied byte-for-byte; target never chooses
 * the translation, and an unknown label is deliberately left untouched.
 */
export function localizeNavLinkLabels(markdown, locale, { itBody = "" } = {}) {
  const source = String(markdown ?? "");
  if (locale === "it") return source;
  const sourceWordsByTarget = sourceItalianWordsByTarget(itBody);
  return source.replace(NAV_LINK_RE, (whole, label, targetSyntax, target) => {
    const canonical = NAV_LINK_LABELS[normalizeNavLinkLabel(label)]?.[locale];
    if (
      !canonical
      || !isItalianNavLabel(label, target.toLowerCase(), sourceWordsByTarget, locale)
      || (
        normalizeNavLinkLabel(canonical) === normalizeNavLinkLabel(label)
        && !/\b(?:tessin|schweiz|suisse|italien|italie)\b/iu.test(`${label} ${canonical}`)
      )
    ) return whole;
    return "[" + canonical + "](" + targetSyntax + ")";
  });
}
