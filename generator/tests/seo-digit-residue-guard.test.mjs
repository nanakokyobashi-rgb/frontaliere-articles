/**
 * seo-digit-residue-guard.test.mjs — nessun residuo cifra-lettera pubblicato
 * nei campi SEO (o propagato altrove per lo stesso articolo). Issue #222,
 * #220. `node --test`.
 *
 * ## Il difetto che sorveglia
 *
 * Il titolo SEO di `trump-intesa-o-inferno` ha pubblicato `sar0` al posto di
 * `sarò` — un byte di controllo C0 che ha perso il marker lasciando la cifra
 * orfana in `content/seo/seo-blog-4.ts`. Cercando altre occorrenze della
 * stessa FORMA (issue #222) e' saltato fuori un caso live, non ipotetico:
 * `lavena-ponte-tresa-territorio-poroso` porta `<C0>3territorio` /
 * `poroso<C0>3` ancora col byte in `content/blog-body/it/…ts` e in
 * `content/seo/seo-blog-3.ts` — ma la STESSA coppia, senza un solo byte C0,
 * anche in `content/blog-meta-it.ts`. Quel file non porta NESSUN altro C0, e
 * senza il residuo propagato (`scripts/find-dirty-content-ids.mjs`, issue
 * #220) il passo 1 lo salta per intero: e' esattamente la classe che questo
 * banco difende dal ricomparire sotto CI verde.
 *
 * Il gate riusa `scanContentForDirtyIds` — la STESSA funzione che pilota
 * `republish-dirty-content.yml` — invece di ridefinire il criterio qui: due
 * definizioni di «residuo» divergerebbero il giorno che una delle due cambia.
 *
 * NON e' un elenco di stringhe viste una volta: `scanContentForDirtyIds`
 * marca un residuo solo se un byte C0 REALE lo conferma da qualche parte nel
 * corpus (vedi la sua intestazione, sezione «RESIDUO PROPAGATO») — zero nuovi
 * falsi positivi possibili strutturalmente, quindi questo gate puo' restare
 * a zero tolleranza.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanContentForDirtyIds } from '../../scripts/find-dirty-content-ids.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('corpus pubblicato — nessun residuo cifra-lettera nei campi SEO', () => {
  it('i file SEO sono davvero sul disco (un worktree sparse non materializza content/)', () => {
    const dir = path.join(ROOT, 'content', 'seo');
    assert.ok(fs.existsSync(dir), 'content/seo assente: il gate passerebbe a vuoto');
    const seoFiles = fs.readdirSync(dir).filter((n) => n.endsWith('.ts'));
    assert.ok(seoFiles.length >= 8, `solo ${seoFiles.length} file SEO letti`);
  });

  it('zero candidati del detector hanno una fonte sotto content/seo/ (C0 grezzo o residuo)', () => {
    const { ids } = scanContentForDirtyIds(ROOT);
    const offenders = [];
    for (const entry of ids) {
      for (const src of entry.sources) {
        if (src.startsWith('content/seo/')) offenders.push(`${entry.section}/${entry.id} ← ${src}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'un file SEO porta un byte C0 o un residuo cifra-lettera: e\' la forma del difetto sar0 (#222). ' +
        'Riparalo a mano (il canale automatico non ricostruisce punteggiatura/lettere accentate senza prova) ' +
        'e verifica con: npx -y tsx@4 scripts/find-dirty-content-ids.mjs --out /tmp/r.json --skip-live',
    );
  });

  it('zero residui propagati (C0 confermato altrove ma sparito in QUESTA superficie, issue #220) su tutto il corpus', () => {
    const { ids } = scanContentForDirtyIds(ROOT);
    const offenders = ids
      .filter((e) => e.sources.some((s) => s.includes('residuo propagato')))
      .map((e) => `${e.section}/${e.id} ← ${e.sources.filter((s) => s.includes('residuo propagato')).join(', ')}`);
    assert.deepEqual(
      offenders,
      [],
      'un residuo confermato da C0 in un file compare, senza piu\' il marker, in un\'altra superficie dello stesso articolo',
    );
  });
});
