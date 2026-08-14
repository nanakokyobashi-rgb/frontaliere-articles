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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { expect } from './lib/expect-shim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCALES = ['it', 'de', 'en', 'fr'];

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
    slug: 'telelavoro-frontalieri',
    ref: 'corpus#261',
    citations: ['LTL 1995', 'LF 1995', 'OTC 2001', '(LFW)', '(LPS)', 'BG 1995'],
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
];

async function loadBody(slug, locale) {
  const url = new URL(`../../content/blog-body/${locale}/${slug}.ts`, import.meta.url);
  const mod = await import(url.href);
  return mod.default;
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
