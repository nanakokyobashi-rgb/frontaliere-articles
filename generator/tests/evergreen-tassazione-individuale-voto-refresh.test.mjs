import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Refresh #1788 e #1789 (sito #9629): i due articoli presentavano ancora al
// futuro la votazione federale dell'8 marzo 2026 sull'imposizione individuale.
// Stessi valori e fonti della PR corpus #1765:
// https://www.estv.admin.ch/it/imposizione-individuale (esito 54,23% di sì) e
// https://www.admin.ch/de/newnsb/khPH1Sn08Zr6iGZYe4tsB (entrata in vigore
// 1.1.2032, Consiglio federale 19.8.2026).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SLUGS = ['tassazione-individuale-svizzera', 'tassazione-individuale-lavoro-donne'];
const LOCALES = ['it', 'en', 'de', 'fr'];
const REFRESHED_ON = '2026-09-24';

const FUTURE_VOTE = [
  /sarà chiamato/, /si preannuncia/, /Il prossimo 8 marzo/, /prevista per l\\'8 marzo/,
  /se passa(?:sse)? /, /se questa riforma passasse/,
  /wird das Schweizer Volk/, /stimmt am 8\. März/, /falls diese Reform angenommen wird/, /durchgeht/,
  /sera appelé/, /8 mars prochain/, /8 mars 2025/, /s\\'annonce crucial/, /si adoptée/, /était adoptée/, /est adoptée\?/,
  /will vote/, /Vote scheduled/, /Swiss vote on March 8/, /if this reform passes/, /reform[^"]{0,60} passes\?/,
];
const IMMEDIATE_BENEFIT = /vantaggi fiscali immediati|sofortige steuerliche Vorteile|avantages fiscaux immédiats|Avantages fiscaux immédiats|immediate tax advantages/;

function bodySource(slug, locale) {
  return fs.readFileSync(path.join(ROOT, 'content', 'blog-body', locale, `${slug}.ts`), 'utf8');
}

for (const slug of SLUGS) {
  test(`${slug}: la voce del registro porta la data del refresh fattuale`, () => {
    const registry = fs.readFileSync(path.join(ROOT, 'content', 'blog-articles-data.ts'), 'utf8');
    assert.match(registry, new RegExp(`id: '${slug}'[\\s\\S]{0,220}updatedAt: '${REFRESHED_ON}'`));
  });

  for (const locale of LOCALES) {
    test(`${slug} ${locale}: esito del voto, entrata in vigore e fonti ufficiali`, () => {
      const source = bodySource(slug, locale);
      assert.match(source, /54[.,]23\s?%/, 'percentuale dei sì');
      assert.match(source, /45[.,]77\s?%/, 'percentuale dei no');
      assert.match(source, /1(?:°|er)? (?:gennaio|Januar|janvier) 2032|January 1, 2032|1\. Januar 2032/, 'data di entrata in vigore');
      assert.match(source, /19\.? (?:agosto|August|août) 2026/, 'data della decisione del Consiglio federale');
      assert.match(source, /estv\.admin\.ch\/it\/imposizione-individuale/);
      assert.match(source, /admin\.ch\/de\/newnsb\/khPH1Sn08Zr6iGZYe4tsB/);
    });

    test(`${slug} ${locale}: niente voto al futuro né effetti fiscali immediati`, () => {
      const source = bodySource(slug, locale);
      for (const pattern of FUTURE_VOTE) assert.doesNotMatch(source, pattern);
      assert.doesNotMatch(source, IMMEDIATE_BENEFIT, 'la riforma entra in vigore nel 2032');
    });
  }
}
