/**
 * Refresh evergreen di `bonus-famiglia-frontalieri-2026` (corpus #1807).
 *
 * Quasi tutti i fatti dell'articolo erano sbagliati. Il test fissa nelle
 * quattro lingue quelli verificati il 2026-09-25 e fallisce se tornano i
 * valori smentiti dalle fonti ufficiali:
 *  - assegni familiari Ticino 2026: CHF 215 per figli e CHF 268 di formazione,
 *    cioe' CHF 2'580-3'216 l'anno (IAS Ticino), non "3.600-4.200 CHF/anno";
 *  - nessuna scadenza al 31 marzo: gli arretrati si chiedono fino a 5 anni
 *    (promemoria AVS/AI 6.08);
 *  - il "bonus nido fino al 40%" del DFE per frontalieri non esiste: gli
 *    aiuti ticinesi ai nidi sono per le famiglie residenti in Ticino, il bonus
 *    asilo nido INPS 2026 arriva a 3.600 euro (circolare INPS 29/2026);
 *  - la detrazione di 950 euro vale solo per i figli a carico tra 21 e 29
 *    anni (circolare AdE 4/E/2025); sotto i 21 anni c'e' l'assegno unico,
 *    coordinato con gli assegni svizzeri (circolare INPS 81/2026);
 *  - il datore di lavoro svizzero rilascia il certificato di salario, non la
 *    CU; 730 entro il 30 settembre 2026, Redditi PF entro il 2 novembre 2026;
 *  - la citazione attribuita a Norman Gobbi, a sostegno di misure che non
 *    esistono, e la fonte "DFE, ottobre 2023" non tornano.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUG = 'bonus-famiglia-frontalieri-2026';
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-25';
const SOURCES = [
  'https://m4.ti.ch/fileadmin/DSS/IAS/pdf/informazioni_periodiche/2026_Info_periodiche_AF.pdf',
  'https://www.ahv-iv.ch/p/6.08.',
  'https://www4.ti.ch/dss/dasf/temi/famiglia-e-figli/aiuti-economici/contributi-economici-per-la-conciliabilita-famiglia-e-lavoro-formazione',
  'circolare-numero-29-del-27-03-2026',
  'circolare-numero-81-del-24-07-2026',
  'Circolare+lavoro+dipendente+LB2025+DD+IRPEF+n.+4+del+16+maggio+2025.pdf',
  'quando-e-come-presentare-il-730-2026',
  'quando-e-come-presentare-il-modello-redditi-persone-fisiche',
];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('il registry porta updatedAt del refresh fattuale', () => {
  const registry = read('content/blog-articles-data.ts');
  assert.match(registry, new RegExp(`id: '${SLUG}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
});

for (const locale of LOCALES) {
  test(`${locale}: assegni, bonus nido, detrazioni e scadenze verificati con fonte`, () => {
    const source = read(`content/blog-body/${locale}/${SLUG}.ts`);
    assert.match(source, /CHF 215/, 'assegno per figli 2026');
    assert.match(source, /CHF 268/, 'assegno di formazione 2026');
    assert.match(source, /2[.,' ]580/, 'assegno per figli annuo');
    assert.match(source, /3[.,' ]216/, 'assegno di formazione annuo');
    assert.doesNotMatch(source, /3[.,  ]?600[^€]{0,6}(?:-|–|à|to|bis)\s*4[.,  ]?200|4[.,  ]?200 CHF/, 'importi annui inventati');
    assert.match(source, /3[.,  ]600 €|€3,600/, 'bonus asilo nido INPS 2026');
    assert.doesNotMatch(source, /40 ?%/, 'bonus nido del 40% inesistente');
    assert.match(source, /\b21\b[^.]{0,20}\b29\b/, 'detrazione solo tra 21 e 29 anni');
    assert.match(source, /assegno unico/, 'assegno unico INPS');
    assert.match(source, /883\/2004/, 'coordinamento UE');
    assert.match(source, /Lohnausweis/, 'certificato di salario svizzero');
    assert.doesNotMatch(source, /\bCU\b/, 'CU attribuita al datore svizzero');
    assert.doesNotMatch(source, /31\.? (?:marzo|March|März|mars) 2026/, 'scadenza assegni inventata');
    assert.match(source, /\b5\b (?:anni|years|Jahre|ans)/, 'arretrati fino a 5 anni');
    assert.match(source, /30\.? (?:settembre|September|septembre) 2026/, 'scadenza 730');
    assert.match(source, /\b2\.? (?:novembre|November) 2026/, 'scadenza Redditi PF');
    assert.doesNotMatch(source, /(?:maggio e giugno|May and June|Mai und Juni|mai et juin) 2026/, 'finestra dichiarativa superata');
    assert.doesNotMatch(source, /Gobbi/, 'citazione non verificabile a sostegno di misure inesistenti');
    assert.doesNotMatch(source, /(?:ottobre|October|Oktober|octobre) 2023/, 'fonte DFE 2023');
    for (const url of SOURCES) assert.ok(source.includes(url), `fonte ${url}`);
  });
}

test("l'ogDescription SEO non promette assegni fino a 4.200 CHF", () => {
  const seo = read('content/seo/seo-blog.ts');
  const start = seo.indexOf(`'blog-${SLUG}': {`);
  assert.ok(start >= 0, 'voce SEO presente');
  const og = seo.slice(start).split('\n').find((l) => l.includes('ogDescription'));
  assert.match(og, /3\.216/);
  assert.doesNotMatch(og, /4\.200/);
});
