/**
 * Guardia di corpus sulla TERZA spelling del marker C0 — issue #345 item 2.
 * `node --test`.
 *
 * COS'E' LA TERZA SPELLING
 *
 * Le prime due sono il byte C0 grezzo e la sua forma escapata `\u00XX`/`\b`/`\f`.
 * La terza e' il TAB (0x09) usato come marker e poi scritto escapato: `\t`
 * incollato a una cifra, dentro una parola. Nessun oracolo la contava, e per
 * una ragione buona — TAB e' un carattere LEGALE in XML 1.0 e in JSON, quindi
 * un filtro per codice carattere marcherebbe sporco ogni a-capo escapato
 * legittimo. Il criterio giusto e' ancorato al RESIDUO, non al codice:
 * `\t` seguito subito da una cifra.
 *
 * PERCHE' UNA GUARDIA E NON UN RIPARATORE
 *
 * Le 7 occorrenze sono state corrette A MANO, una per una, ed e' una decisione,
 * non una scorciatoia: la stessa coppia (marker, coda) sta al posto di cose
 * DIVERSE in locali diversi, perche' il difetto nasce nell'italiano e il
 * traduttore lo propaga verbatim come token intraducibile. Misurato sulle
 * quattro copie di `cure-a-domicilio-tassa-ticino`, `\t2` vale «è» in italiano
 * («e da quando è applicata?»), «wann» in tedesco, «when» in inglese e «quand»
 * in francese — un carattere in un caso, una parola negli altri tre. E su
 * `cpi-caso-hospita-rivalutazione-periti`, `\t3e` dopo l'apostrofo vale «è» in
 * `Cos'è il significato` e «s» in `What's the meaning`.
 *
 * Un'euristica di riparazione su questa famiglia non dedurrebbe: tradurrebbe a
 * occhio. E' la forma esatta del difetto che in un giro precedente ha DISTRUTTO
 * i titoli — un detector che sbagliava un terzo delle volte e poi «riparava»
 * partendo dalla lingua sbagliata, cosi' che parte del guasto era fabbricata e
 * non subita, con un test che ne codificava la scappatoia.
 *
 * Quindi qui non c'e' niente da riparare: c'e' da accorgersi se torna. Questo
 * test e' l'osservatore, e la sua unica asserzione e' ZERO.
 *
 * IL RILEVATORE E' ALTROVE. `scripts/find-dirty-content-ids.mjs` porta il
 * detector di questa spelling (`findEscapedTabResidues`, PR #352): quello
 * decide quali id sono sporchi e va tenuto uno solo. Questo file non lo
 * duplica — guarda lo STATO DEL CORPUS su disco, che e' una domanda diversa e
 * che nessun oracolo di id puo' porre, perche' un corpo articolo senza id
 * associato uscirebbe comunque dal suo perimetro.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RADICE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTENUTI = path.join(RADICE, 'content');

/**
 * Le DUE scritture della stessa cosa, e cercarne una sola vuol dire concludere
 * «zero» a torto: sul disco il TAB puo' essere il byte 0x09 (un corpo scritto
 * cosi' rende `grep` binario e senza `-a` non stampa niente) oppure la
 * sequenza `\t` escapata — con uno o due backslash, perche' il JSON del campo
 * `.faq` sta dentro un letterale TS che lo riescapa.
 */
const MARKER_TAB = /\t[0-9]|\\+t[0-9]/g;

function fileDiContenuto(dir, acc = []) {
  for (const v of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, v.name);
    if (v.isDirectory()) fileDiContenuto(p, acc);
    else if (/\.(ts|tsx|json)$/.test(v.name)) acc.push(p);
  }
  return acc;
}

test('content/: nessun marker TAB incollato a una cifra, in nessuna delle due scritture', () => {
  const file = fileDiContenuto(CONTENUTI);

  // Anti-vacuita'. Un test che scandisce `content/` diventa verde per ASSENZA
  // in ogni checkout che non lo materializza, e allora non sta provando niente:
  // e' la stessa trappola per cui in questo repo un `loadBody()` puntato sulla
  // cartella sbagliata non ha mai guardato dove stavano le occorrenze.
  assert.ok(file.length > 1000, `content/ sembra vuoto o non materializzato: ${file.length} file`);

  const trovati = [];
  for (const p of file) {
    const testo = fs.readFileSync(p, 'utf8');
    for (const m of testo.matchAll(MARKER_TAB)) {
      trovati.push(`${path.relative(RADICE, p)}: ${JSON.stringify(testo.slice(Math.max(0, m.index - 50), m.index + 50))}`);
    }
  }

  assert.deepEqual(trovati, [], `marker TAB+cifra tornati in content/:\n  ${trovati.join('\n  ')}`);
});

/**
 * Le 7 frasi riparate a mano, con dentro la parola che ci e' stata rimessa.
 * Non e' una ripetizione del test qui sopra: quello dice «il marker non c'e'»,
 * questo dice «al suo posto c'e' la cosa giusta». Un ri-generatore che
 * riscrivesse questi corpi senza il difetto ma anche senza la frase — o con la
 * parola di un'altra lingua, che e' il modo in cui questa famiglia si rompe —
 * passerebbe il primo e cadrebbe qui.
 */
const RIPARATE_A_MANO = [
  ['blog-body/it/cure-a-domicilio-tassa-ticino.ts', 'e da quando è applicata?'],
  ['blog-body/de/cure-a-domicilio-tassa-ticino.ts', 'und seit wann angewendet?'],
  ['blog-body/en/cure-a-domicilio-tassa-ticino.ts', 'and since when applied?'],
  ['blog-body/fr/cure-a-domicilio-tassa-ticino.ts', 'et depuis quand appliquée?'],
  ['blog-body/it/cpi-caso-hospita-rivalutazione-periti.ts', "Cos\\'è il significato"],
  ['blog-body/it/permessi-dimora-diversi-opinioni.ts', "Cos\\'è il diritto"],
  ['blog-body/en/cpi-caso-hospita-rivalutazione-periti.ts', "What\\'s the meaning"],
];

for (const [relativo, frase] of RIPARATE_A_MANO) {
  test(`riparato a mano: ${relativo} porta ${JSON.stringify(frase)}`, () => {
    const p = path.join(CONTENUTI, relativo);
    assert.ok(fs.existsSync(p), `${relativo} non esiste: il corpus e' stato spostato, non riparato`);
    const testo = fs.readFileSync(p, 'utf8');
    assert.ok(testo.includes(frase), `${relativo} non porta piu' la frase riparata`);
  });
}
