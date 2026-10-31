#!/usr/bin/env node
/**
 * link-editorial-sources.mjs — collega alla fonte primaria le frasi canoniche
 * scritte da repair-editorial-claims.mjs. Solo URL letti il 31/10/2026: Fedlex per
 * l'Accordo, Normattiva per la L. 213/2023, FAQ SEM e Sezione della popolazione
 * per il permesso G. Un link per fonte, per articolo e per lingua, solo nei body:
 * il box «fonti linkate» del sito compare quando un link vero c'e'.
 *
 * Uso: node generator/scripts/link-editorial-sources.mjs [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const check = process.argv.includes('--check');
const SEM = (locale) => `https://www.sem.admin.ch/sem/${locale}/home/themen/fza_schweiz-eu-efta/eu-efta_buerger_schweiz/faq.html`;
const FEDLEX = (locale) => `https://www.fedlex.admin.ch/eli/cc/2023/410/${locale}`;
const NORMATTIVA = 'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:2023-12-30;213~art1!vig=2026-10-31';
const TI_G = 'https://www4.ti.ch/index.php?id=122090';

// Testi come appaiono nel sorgente TS, con l'apostrofo escapato.
const LINKS = {
  it: [
    ["art. 9 dell\\'Accordo del 2020", FEDLEX('it')],
    ['legge 213/2023', NORMATTIVA],
    ['Il permesso G vale cinque anni', SEM('it')],
    ['il permesso G non richiede la residenza in una zona di frontiera', SEM('it')],
    ['Ufficio della migrazione', TI_G],
  ],
  en: [
    ['Art. 9 of the 2020 Agreement', FEDLEX('it')],
    ['Law 213/2023', NORMATTIVA],
    ['The G permit is valid for five years', SEM('en')],
    ['the G permit does not require residence in a border zone', SEM('en')],
    ['Migration Office', TI_G],
  ],
  de: [
    ['Art. 9 des Abkommens von 2020', FEDLEX('de')],
    ['Gesetz 213/2023', NORMATTIVA],
    ['Die G-Bewilligung gilt fünf Jahre', SEM('de')],
    ['setzt die G-Bewilligung keinen Wohnsitz in einer Grenzzone voraus', SEM('de')],
    ['Migrationsamt', TI_G],
  ],
  fr: [
    ["art. 9 de l\\'Accord de 2020", FEDLEX('fr')],
    ['loi 213/2023', NORMATTIVA],
    ['Le permis G est valable cinq ans', SEM('fr')],
    ['le permis G n’exige pas de résider dans une zone frontalière', SEM('fr')],
    ['Office de la migration', TI_G],
  ],
};

let linked = 0;
let files = 0;
for (const section of ['blog-body', 'blog-body-ch']) {
  for (const [locale, rules] of Object.entries(LINKS)) {
    const dir = path.join(ROOT, 'content', section, locale);
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      const file = path.join(dir, name);
      let source = fs.readFileSync(file, 'utf8');
      const faqStart = source.search(/\.faq['"]\s*:/);
      const limit = () => (faqStart === -1 ? source.length : source.search(/\.faq['"]\s*:/));
      let changed = false;
      const usedUrls = new Set();
      for (const [phrase, url] of rules) {
        if (usedUrls.has(url) || source.includes(`](${url})`)) continue;
        const at = source.indexOf(phrase);
        if (at === -1 || at > limit()) continue;
        const before = source[at - 1];
        if (before === '[') continue;
        source = `${source.slice(0, at)}[${phrase}](${url})${source.slice(at + phrase.length)}`;
        usedUrls.add(url);
        changed = true;
        linked += 1;
      }
      if (changed) {
        files += 1;
        if (!check) fs.writeFileSync(file, source);
      }
    }
  }
}
console.log(JSON.stringify({ linked, files }));
