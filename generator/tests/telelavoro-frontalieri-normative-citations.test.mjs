/**
 * Regressione mirata per corpus#261 (follow-up di #259).
 *
 * `telelavoro-frontalieri.ts` (it/de/en/fr) conteneva citazioni normative con
 * acronimo+anno inventati: `LTL 1995`, `LF 1995`, `OTC 2001` (le tre già note
 * da #259/#261), più due trovate in estensione nel corpo IT (`LFW`, `LPS`,
 * senza anno ma stesso schema di acronimo-legge inventato) e una variante
 * indipendente solo nel corpo DE (`BG 1995`, un acronimo diverso da `LF 1995`
 * per la stessa frase — le traduzioni non sono derivate meccanicamente
 * dall'italiano, possono allucinare per conto proprio). Le traduzioni DE/EN/FR
 * portavano ANCHE `LTL 1995`, mai raggiunte dal fix IT di #259: il sync
 * traduzione↔sorgente qui non esiste, quindi un fix sul solo corpo IT non
 * basta a chiudere l'incidente sugli altri locali.
 *
 * PERCHÉ QUESTO FILE E NON `article-fabrication-guard.test.mjs`: quel guard è
 * `adapted` nel manifest del ciclo (`scripts/ci/loop-sync-manifest.json`) con
 * il vincolo che i PATTERN restino byte-identici al sito — un'aggiunta qui
 * verrebbe sovrascritta al prossimo riallineamento e comunque non è la sede
 * giusta per un pattern non ancora esteso lì. Vedi il PR body per il perché
 * non è stato aggiunto anche un gate generale (acronimo+anno non in
 * allowlist): campionato sull'intero corpus, quel pattern è raro (41 hit su
 * 16.676 file) ma ambiguo — cattura istituzioni reali citate come fonte dati
 * (`SECO 2024`), leggi reali (`KVG 2023`), e sigle non normative (`SCP 2026`,
 * il nome di una scuola) tanto quanto citazioni sospette. Costruire
 * un'allowlist affidabile richiederebbe verificare online le norme citate nel
 * resto del corpus, fuori mandato per questo task e per questo file.
 *
 * Questo test copre invece SOLO l'articolo appena riparato, con un confronto
 * a stringa esatta (nessuna euristica, quindi nessun falso positivo
 * possibile su contenuto legittimo altrove nel corpus): se una qualunque
 * delle sei citazioni fabbricate note ricompare in uno qualunque dei 4
 * locali, il test fallisce.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { expect } from './lib/expect-shim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCALES = ['it', 'de', 'en', 'fr'];
// I corpi stanno in DUE radici, non una: `content/blog-body/` e
// `content/blog-body-ch/` (stessa mappa di generator/scripts/lib/corpus-paths.mjs
// e di article-fabrication-guard.test.mjs).
const BODY_ROOTS = ['blog-body', 'blog-body-ch'];

// Byte-exact strings observed live in the corpus before each fix.
// Case-insensitive because the DE body carried a lowercase variant of one of
// them ("otc 2001") — the fabrication survives casing changes, the check
// should too.
//
// Una TABELLA per slug e non un file per slug (esteso il 2026-08-14 con
// `infernieri-frontalieri-ticino`, follow-up #317 punto 2): la forma del test
// e' identica, cambiano solo lo slug e le stringhe, e un file nuovo per ogni
// articolo riparato moltiplicherebbe la stessa intestazione senza aggiungere
// copertura. Il vincolo di merito resta quello sopra: SOLO stringhe osservate
// dal vivo nell'articolo che il fix ha toccato, mai un'euristica.
const SLUGS = [
  {
    // `(Sozialgesetz)` aggiunto da #323: e' la stessa citazione fabbricata del
    // corpo IT (`(LPS)`), ma nel corpo DE sopravviveva SCIOLTA — l'acronimo
    // inventato sostituito da un titolo breve altrettanto inventato («das
    // Bundesgesetz über die soziale Sicherheit (Sozialgesetz)»), che nessuna
    // delle sei stringhe di #261 poteva intercettare. Le altre tre lingue
    // avevano gia' la forma senza parentesi dopo #306: era rimasto vivo in una
    // lingua sola, che e' il modo in cui `LTL 1995` era sopravvissuto a #259.
    slug: 'telelavoro-frontalieri',
    ref: 'corpus#261',
    citations: ['LTL 1995', 'LF 1995', 'OTC 2001', '(LFW)', '(LPS)', 'BG 1995', '(Sozialgesetz)'],
  },
  {
    // #317 punto 2. Le due identita' normative erano inventate di sana pianta
    // (nessuna «Legge federale sulla tassazione degli stranieri», nessuna
    // «Ordinanza sul credito d'imposta per gli stranieri»): rimosse, non
    // sostituite — stessa scelta di #306, perche' una citazione «giusta» al
    // loro posto sposterebbe soltanto il punto in cui si inventa.
    // `25 giugno 1978` invece era la data SBAGLIATA di una Convenzione che
    // esiste davvero, ed e' l'unico caso corretto e non rimosso: il repo ha
    // gia' il proprio oracolo verificato — `create-article.mjs` ripete in
    // quattro punti «Convenzione italo-svizzera: firmata 9 DICEMBRE 1976» e
    // `article-fabrication-guard.test.mjs` ne fa un pattern bloccante.
    slug: 'infernieri-frontalieri-ticino',
    ref: 'corpus#317',
    citations: ['TF 1992', 'OD 1993', '25 giugno 1978'],
  },
  {
    // #332. Stessa frase-fonte "legge sul soggiorno degli stranieri, 2005"
    // allucinata con un acronimo diverso per locale (`LSS` in it/en/fr,
    // `BWG` in de — quest'ultimo aggiunto alla denylist corpus-wide sotto
    // perche' l'UNICA altra occorrenza, in `permesso-l-canton-lucerna-
    // validita-e-proroga` DE, era la stessa fabbricazione). `LSS` invece
    // NON e' bannabile corpus-wide: sopravvive altrove con significati
    // reali/non verificati (23 file, fuori scope per questo item), quindi
    // qui si blocca solo la stringa esatta osservata in questo articolo.
    slug: 'permesso-l-di-breve-durata-canton-berna',
    ref: 'corpus#332',
    citations: ['(LSS) del 2005', '(LSS) of 2005', '(LSS) de 2005', '(BWG) von 2005'],
  },
  {
    // #332. «Regolamento sul permesso di soggiorno (RPS)» inventato per il
    // permesso G, nella stessa frase di «Legge sul lavoro» (LSt) — diverso
    // dall'uso reale di `RPS` (Registro delle professioni sanitarie) che
    // sopravvive altrove nel corpus e non va toccato: per questo `RPS` non
    // e' nella denylist corpus-wide sotto, solo questa stringa esatta lo e'.
    slug: 'frontaliere-meccanico-ticino-stipendio-requisiti',
    ref: 'corpus#332',
    citations: ['Regolamento sul permesso di soggiorno" (RPS) del 2019'],
  },
  {
    // #556 review round 2. Il corpo IT/FR aveva gia' la forma senza sigla
    // ("legge federale sul contrasto alla criminalita' organizzata"), ma DE e
    // EN portavano ciascuno un acronimo inventato PROPRIO — `(Bekämpfungsgesetz)`
    // in DE, `(OCA)` in EN — mai raggiunti dal fix `(LCO)` di questa stessa PR
    // perche' il denylist byte-exact di CORPUS_WIDE_FABRICATED cerca solo
    // `lco`/`lcl`. Stesso schema di `(Sozialgesetz)` sopra: una traduzione puo'
    // allucinare un proprio acronimo indipendente dall'originale IT.
    // `(OCA)` non e' promuovibile a CORPUS_WIDE_FABRICATED: collide byte-exact
    // con una citazione preesistente e non correlata in
    // `franchigia-doganale-acquisti-svizzera.ts` (IT), fuori scope di questa PR.
    slug: 'infiltrazioni-criminali-ticino-grigioni',
    ref: '#556',
    citations: ['(OCA)', '(Bekämpfungsgesetz)'],
  },
];

// Fino a #323 questa funzione era hardcoded su `content/blog-body/` e non
// guardava MAI `content/blog-body-ch/`: la tabella qui sopra era quindi cieca
// su meta' corpus, ed e' il motivo per cui `(LFW)` e `(LPS)` — gia' presenti
// nella denylist di #261 — sono sopravvissuti a #306 in 29 file. Tutte e 12 le
// `LFW` e 24 delle 31 `LPS` misurate in #323 stavano sotto `blog-body-ch/`.
// Se lo slug non esiste in nessuna delle due radici si alza: un guard che non
// trova il corpo non deve passare in silenzio.
async function loadBody(slug, locale) {
  const tried = [];
  for (const root of BODY_ROOTS) {
    const file = path.join(ROOT, 'content', root, locale, `${slug}.ts`);
    tried.push(file);
    if (!fs.existsSync(file)) continue;
    const mod = await import(pathToFileURL(file).href);
    return mod.default;
  }
  throw new Error(`corpo non trovato per ${slug}/${locale}; cercato in:\n  ${tried.join('\n  ')}`);
}

for (const { slug, ref, citations } of SLUGS) {
  describe(`${slug}: nessuna citazione normativa fabbricata nota`, () => {
    for (const locale of LOCALES) {
      it(`[${locale}] non contiene nessuna delle citazioni rimosse da ${ref}`, async () => {
        const body = await loadBody(slug, locale);
        const fullText = Object.values(body).join('\n');
        expect(fullText.length).toBeGreaterThan(100);

        const offenders = citations.filter(
          (needle) => fullText.toLowerCase().includes(needle.toLowerCase()),
        );
        expect(offenders).toEqual([]);
      });
    }
  });
}

/**
 * ───────────────────────────────────────────────────────────────────────────
 * corpus#323 — le stesse sigle, ma su TUTTO il corpus e su ENTRAMBE le radici.
 *
 * La tabella per slug qui sopra riparava l'articolo appena toccato; il difetto
 * di #323 e' che nessuno guardava gli ALTRI articoli. `(LFW)` e `(LPS)` erano
 * nella denylist dal 2026-08-… (#261) e sono comunque ricomparsi in 29 file su
 * 11 slug e 4 locali, perche' il generatore li rifabbrica e il guard era
 * scoped a un solo slug per di piu' in una sola radice.
 *
 * Questo blocco e' un test SUI DATI: byte-exact, nessuna euristica, nessun
 * pattern di forma «acronimo + anno» (scartato in #261 con la misura: 41 hit
 * su 16.676 file, per lo piu' norme e istituzioni VERE). Solo le sei stringhe
 * gia' osservate dal vivo, cercate ovunque.
 *
 * Perche' non in `article-fabrication-guard.test.mjs`, che gia' scandisce
 * tutto il corpus: quel file e' `adapted` nel manifest del ciclo con il
 * vincolo esplicito «i PATTERN restano byte-identici al sito, nuove voci si
 * aggiungono prima la' e si ricopiano qui». Una voce aggiunta li' da questo
 * repo verrebbe sovrascritta al prossimo riallineamento. Questo file invece
 * non e' nel manifest: nessun vincolo di lockstep, la sede giusta finche' le
 * sigle non sono state promosse sul sito.
 *
 * Le sigle nude sono cercate con un confine di parola perche' il corpus
 * contiene due famiglie di sottostringhe che sono norme VERE e vanno
 * preservate: `MLPS` (Ministero del Lavoro e delle Politiche Sociali) e
 * `TULPS` (Testo Unico Leggi Pubblica Sicurezza, 1931). Misurato al momento
 * del fix: 16 occorrenze fra le due, tutte legittime, tutte fuori match.
 *
 * `LSO` e `BWG` aggiunte da corpus#332 (follow-up di #323): a differenza di
 * `RPS`/`LSS`, ogni occorrenza misurata sull'intero corpus era fabbricata
 * (nessun ente o legge reale usa questi acronimi qui), quindi possono stare
 * nella denylist corpus-wide invece che nella tabella per-slug sopra. `LSO`
 * citava DUE leggi inventate diverse a seconda dell'articolo (permesso di
 * soggiorno vs. diritto societario) — la sigla e' fabbricata in entrambi i
 * casi, il contenuto dietro no.
 */
// LCL e LCO aggiunte da #545 (follow-up di #526/#461): le 6 occorrenze note
// (2 file `LCL` in blog-body-ch/it, 4 file `LCO` — le 4 traduzioni di
// infiltrazioni-criminali-ticino-grigioni) sono state bonificate nella stessa
// PR, scansione a confine di parola per non riprendere il falso positivo
// bare-substring di `calcolatore` (con*LCO*latore). `LCL` è anche il nome di
// una banca francese vera: qui non serve il context-guard di
// article-factuality-gates.mjs perché il confronto è byte-exact contro un
// corpus già bonificato, non un guard generativo — se una futura menzione
// legittima della banca dovesse far fallire questo test, e' un segnale che
// il corpus ha una nuova occorrenza da verificare, non un falso positivo da
// silenziare.
//
// LFD aggiunta da #557 (follow-up di #545/#556): 7 occorrenze in 6 corpi
// (blog-body-ch/it/cerca-lavoro-svizzera-dal-estero, blog-body/it/
// frontalieri-ticino-diminuzione, blog-body/it/podologo-frontaliere-ticino-
// guadagna, blog-body/{it,en,fr}/franchigia-doganale-acquisti-svizzera — il
// corpo IT di quest'ultimo la portava due volte), ciascuna con soggetto/anno
// diverso, stesso schema di acronimo-legge inventato. Bonificate rimuovendo,
// non sostituendo (stesso standard di LCL/LCO): nel corpo IT/EN/FR di
// franchigia-doganale la citazione era annidata in una frase che introduceva
// anche la tariffa reale del 10%, gia' ristabilita altrove nello stesso
// corpo, quindi la rimozione della frase-citazione non lascia il fatto
// orfano.
const CORPUS_WIDE_FABRICATED = [
  { label: 'LTL 1995', re: /ltl 1995/i },
  { label: 'LF 1995', re: /lf 1995/i },
  { label: 'OTC 2001', re: /otc 2001/i },
  { label: 'BG 1995', re: /bg 1995/i },
  { label: 'LFW', re: /(?<![a-z])lfw(?![a-z])/i },
  { label: 'LPS', re: /(?<![a-z])lps(?![a-z])/i },
  { label: 'LSO', re: /(?<![a-z])lso(?![a-z])/i },
  { label: 'BWG', re: /(?<![a-z])bwg(?![a-z])/i },
  { label: 'LCL', re: /(?<![a-z])lcl(?![a-z])/i },
  { label: 'LCO', re: /(?<![a-z])lco(?![a-z])/i },
  { label: 'LFD', re: /(?<![a-z])lfd(?![a-z])/i },
];

function allBodyFiles() {
  const files = [];
  for (const root of BODY_ROOTS) {
    for (const locale of LOCALES) {
      const dir = path.join(ROOT, 'content', root, locale);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.ts')) files.push({ id: `${root}/${locale}/${name}`, file: path.join(dir, name) });
      }
    }
  }
  return files;
}

describe('corpus#323: nessuna sigla normativa fabbricata nota, in nessun articolo', () => {
  const files = allBodyFiles();

  it('scandisce entrambe le radici e tutti i locali (niente falso verde su sparse checkout)', () => {
    // In un worktree sparse `content/` puo' non esistere: un gate che passa su
    // zero file scanditi e' il falso verde piu' facile da produrre qui.
    // Misurato al momento del fix: 16.800 corpi.
    expect(files.length).toBeGreaterThan(3000);
    const roots = new Set(files.map((f) => f.id.split('/')[0]));
    expect([...roots].sort()).toEqual(['blog-body', 'blog-body-ch']);
  });

  for (const { label, re } of CORPUS_WIDE_FABRICATED) {
    it(`nessuna occorrenza di «${label}»`, () => {
      const offenders = [];
      for (const { id, file } of files) {
        if (re.test(fs.readFileSync(file, 'utf8'))) offenders.push(id);
      }
      expect(offenders).toEqual([]);
    });
  }
});
