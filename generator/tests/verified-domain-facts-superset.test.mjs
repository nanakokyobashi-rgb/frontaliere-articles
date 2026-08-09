/**
 * verified-domain-facts-superset.test.mjs — issue #96 review follow-up, PR #108.
 *
 * `VERIFIED_DOMAIN_FACTS` (create-article.mjs) NON è section-branched come
 * `EVERGREEN_FACTS_BRIEF`/`_CH`: `llmFactCheck` inietta lo stesso foglio per
 * gli articoli `frontaliere` E `svizzera`. Il prompt istruisce il modello a
 * segnalare come sospetto qualsiasi acronimo istituzionale NON presente nella
 * whitelist di quel foglio ("ISTITUZIONI E ENTI"). Se un'istituzione svizzera
 * nazionale legittima manca dalla lista, un articolo `svizzera` corretto viene
 * segnalato come fabbricazione — la stessa classe di falso-blocco che #96
 * chiudeva sul gate deterministico, riaperta sul percorso LLM.
 *
 * Pinna che la whitelist resti un SUPERSET: contiene le istituzioni nazionali
 * che il resto del file (buildDynamicEvergreenTopicsSvizzera, i prompt di
 * rilevanza della sezione `svizzera`, EVERGREEN_FACTS_BRIEF_CH) tratta come
 * argomenti legittimi per quella sezione.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CREATE_ARTICLE = path.resolve(HERE, '../scripts/create-article.mjs');

function extractVerifiedDomainFacts(src) {
  const start = src.indexOf('const VERIFIED_DOMAIN_FACTS = `');
  assert.ok(start !== -1, 'VERIFIED_DOMAIN_FACTS non trovato — aggiornare i delimitatori di questo test');
  const bodyStart = start + 'const VERIFIED_DOMAIN_FACTS = `'.length;
  const end = src.indexOf('`;', bodyStart);
  assert.ok(end !== -1, 'fine di VERIFIED_DOMAIN_FACTS non trovata — aggiornare i delimitatori di questo test');
  return src.slice(bodyStart, end);
}

test('la whitelist istituzioni di VERIFIED_DOMAIN_FACTS include le istituzioni nazionali svizzere usate altrove nel file', () => {
  const src = readFileSync(CREATE_ARTICLE, 'utf-8');
  const facts = extractVerifiedDomainFacts(src);

  // AFC/ESTV (fisco federale) e BNS/SNB (banca nazionale) sono trattate come
  // istituzioni valide per la sezione `svizzera` altrove nel file (v. i
  // prompt di scope/rilevanza nazionale), ma erano assenti da questa
  // whitelist condivisa — un articolo `svizzera` che le cita veniva segnalato
  // come "acronimo NON presente nella lista" da llmFactCheck.
  for (const ente of ['AFC/ESTV', 'BNS/SNB']) {
    assert.ok(
      facts.includes(ente),
      `VERIFIED_DOMAIN_FACTS non nomina ${ente}: llmFactCheck lo segnalerebbe come sospetto su un articolo svizzero corretto`,
    );
  }
});

test('VERIFIED_DOMAIN_FACTS resta iniettato senza branch di sezione (non regredire silenziosamente su questo bug)', () => {
  const src = readFileSync(CREATE_ARTICLE, 'utf-8');
  // Chiamata unica, dentro llmFactCheck: se in futuro qualcuno la duplica per
  // ramo di sezione, questo test smette semplicemente di applicarsi (bene) —
  // ma finché resta un'unica interpolazione, la lista DEVE coprire entrambe
  // le sezioni, che è ciò che il test sopra verifica.
  const occurrences = (src.match(/\$\{VERIFIED_DOMAIN_FACTS\}/g) || []).length;
  assert.equal(occurrences, 1, 'VERIFIED_DOMAIN_FACTS iniettato in più punti: aggiornare il commento e questo test');
});
