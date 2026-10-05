/**
 * ── LE INTESTAZIONI-ETICHETTA DEL PROMPT CAMBIANO SOLO NEL CASING ──────────
 *
 * `normalizePromptSectionHeadings` e' il secondo punto (dopo la riga
 * `TITOLO ARTICOLO`) in cui la bonifica dello stock modifica un body italiano
 * pubblicato senza passare dalla cascata MT (decisione del proprietario del
 * 2026-10-05, «Titoli normali»). Il test diventa rosso se:
 *   - una riga che non e' un'intestazione `##`-`####` con un'etichetta del
 *     prompt tutta maiuscola viene toccata;
 *   - un'intestazione cambia in qualcosa di diverso dal solo casing;
 *   - un'etichetta dell'elenco non viene piu' dalle sorgenti dei prompt del
 *     generatore (o dalla decisione del proprietario) e l'elenco si allarga
 *     a parole inventate;
 *   - la prova del diff accetta una modifica che non e' quella conversione.
 *
 * La fixture `PIASTRELLISTA_BODY2` e' la sequenza reale delle intestazioni di
 * `content/blog-body/it/frontaliere-piastrellista-ticino-stipendio-requisiti.ts`
 * (body2, il caso noto), con la prosa sostituita da frasi neutre.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROMPT_SECTION_LABELS,
  normalizePromptSectionHeadings,
  sentenceCaseItalian,
  applyConvertedHeadings,
} from '../scripts/lib/normalize-prompt-section-headings.mjs';
import { detectLeakedScaffolding } from '../scripts/lib/article-factuality-gates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GENERATOR = path.resolve(HERE, '..');

const PROSE = 'Il frontaliere che lavora in Ticino deve dichiarare il reddito in Italia.';

const PIASTRELLISTA_BODY2 = [
  '## Fatti chiave',
  '- **Professione**: piastrellista',
  '',
  '## INTRODUZIONE',
  PROSE,
  '',
  '## STIPENDIO E REQUISITI',
  PROSE,
  '',
  '## RICONOSCIMENTO DEL TITOLO',
  PROSE,
  '',
  '## ESEMPIO CONCRETO',
  PROSE,
  '',
  '## CHECKLIST OPERATIVE',
  '- Verifica il permesso G.',
  '',
  '## CONFRONTO TRA SCENARI PRATICI',
  PROSE,
  '',
  '## CONCLUSIONE',
  PROSE,
  '',
  '## Tool utili per massimizzare il netto',
  '- [Calcolatore](/calcolatore)',
].join('\n');

test('il caso piastrellista: le sette intestazioni-etichetta diventano titoli normali, nient\'altro', () => {
  // Il gate lo segnala prima (ESEMPIO CONCRETO) e non piu' dopo.
  assert.equal(detectLeakedScaffolding(PIASTRELLISTA_BODY2).length, 1);
  const out = normalizePromptSectionHeadings(PIASTRELLISTA_BODY2);
  assert.deepEqual(out.skipped, []);
  assert.deepEqual(out.converted.map((c) => [c.from, c.to]), [
    ['## INTRODUZIONE', '## Introduzione'],
    ['## STIPENDIO E REQUISITI', '## Stipendio e requisiti'],
    ['## RICONOSCIMENTO DEL TITOLO', '## Riconoscimento del titolo'],
    ['## ESEMPIO CONCRETO', '## Esempio concreto'],
    ['## CHECKLIST OPERATIVE', '## Checklist operative'],
    ['## CONFRONTO TRA SCENARI PRATICI', '## Confronto tra scenari pratici'],
    ['## CONCLUSIONE', '## Conclusione'],
  ]);
  const oldLines = PIASTRELLISTA_BODY2.split('\n');
  const newLines = out.value.split('\n');
  assert.equal(newLines.length, oldLines.length);
  const changed = oldLines.flatMap((line, i) => (line === newLines[i] ? [] : [i]));
  assert.equal(changed.length, 7);
  for (const i of changed) {
    assert.match(oldLines[i], /^## [A-Z ]+$/);
    assert.equal(newLines[i].toLowerCase(), oldLines[i].toLowerCase(), 'solo il casing');
  }
  assert.deepEqual(detectLeakedScaffolding(out.value), []);
  assert.equal(applyConvertedHeadings(PIASTRELLISTA_BODY2, out.converted), out.value);
});

test('livelli ### e ####, due punti finali e spazi multipli dopo i # sono preservati', () => {
  const text = `### ESEMPI CONCRETI:\n${PROSE}\n####  NORMATIVE CON DATE E IMPORTI\n${PROSE}`;
  const out = normalizePromptSectionHeadings(text);
  assert.equal(out.value, `### Esempi concreti:\n${PROSE}\n####  Normative con date e importi\n${PROSE}`);
  assert.deepEqual(out.skipped, []);
});

test('le etichette dei due rami di expandEnrichmentLine (frontaliere e nazionale) si convertono', () => {
  const text = `## RIFERIMENTI A COMUNI TICINESI SPECIFICI\n${PROSE}\n## RIFERIMENTI A CANTONI O CITTÀ SVIZZERE PERTINENTI AL TEMA\n${PROSE}\n## ESEMPIO CONCRETO\n${PROSE}`;
  const out = normalizePromptSectionHeadings(text);
  assert.equal(
    out.value,
    `## Riferimenti a comuni ticinesi specifici\n${PROSE}\n## Riferimenti a cantoni o città svizzere pertinenti al tema\n${PROSE}\n## Esempio concreto\n${PROSE}`,
  );
  assert.deepEqual(out.skipped, []);
});

test('un testo senza etichette, o con etichette gia\' normali, esce identico', () => {
  for (const text of [
    '',
    PROSE,
    `## Esempio concreto\n${PROSE}`,
    // Tutte maiuscole ma non etichette del prompt: sigle e titoli veri restano.
    `## FAQ\n### CTA\n## LEAD\n## IVA\n## OBIETTIVI\n${PROSE}`,
    // Etichetta seguita da altro testo: non e' l'etichetta.
    `## ESEMPIO CONCRETO DI CALCOLO\n${PROSE}`,
    // Minuscola o mista dentro l'intestazione.
    `## ESEMPIO concreto\n${PROSE}`,
  ]) {
    assert.deepEqual(normalizePromptSectionHeadings(text), { value: text, converted: [], skipped: [] }, JSON.stringify(text));
  }
});

test('le forme che non sono un\'intestazione ##-#### non si toccano e finiscono in skipped', () => {
  const cases = [
    { text: `${PROSE}\nESEMPIO CONCRETO\n${PROSE}`, re: /^etichetta-senza-intestazione: ESEMPIO CONCRETO$/ },
    { text: `${PROSE}\nESEMPIO CONCRETO:\n${PROSE}`, re: /^etichetta-senza-intestazione: / },
    { text: `# ESEMPIO CONCRETO\n${PROSE}`, re: /^livello-intestazione: # ESEMPIO CONCRETO$/ },
    { text: `##### CONCLUSIONE\n${PROSE}`, re: /^livello-intestazione: / },
    { text: `  ## ESEMPIO CONCRETO\n${PROSE}`, re: /^intestazione-rientrata: / },
    { text: `##ESEMPIO CONCRETO\n${PROSE}`, re: /^intestazione-senza-spazio: / },
  ];
  for (const { text, re } of cases) {
    const out = normalizePromptSectionHeadings(text);
    assert.equal(out.value, text, `non deve editare: ${JSON.stringify(text)}`);
    assert.deepEqual(out.converted, []);
    assert.equal(out.skipped.length, 1, JSON.stringify(out.skipped));
    assert.match(out.skipped[0], re);
  }
});

test('una intestazione convertibile e una forma non riconosciuta nello stesso campo', () => {
  const text = `## INTRODUZIONE\n${PROSE}\nESEMPIO CONCRETO:\n${PROSE}`;
  const out = normalizePromptSectionHeadings(text);
  assert.equal(out.value, `## Introduzione\n${PROSE}\nESEMPIO CONCRETO:\n${PROSE}`);
  assert.equal(out.converted.length, 1);
  assert.equal(out.skipped.length, 1);
});

test('CR finali e newline: il terminatore di ogni riga resta identico', () => {
  const text = `## CONCLUSIONE\r\n${PROSE}\r\n`;
  const out = normalizePromptSectionHeadings(text);
  assert.equal(out.value, `## Conclusione\r\n${PROSE}\r\n`);
});

test('sentence case italiano: prima lettera maiuscola, sigle preservate', () => {
  assert.equal(sentenceCaseItalian('ESEMPIO CONCRETO'), 'Esempio concreto');
  assert.equal(sentenceCaseItalian('STIPENDIO E REQUISITI'), 'Stipendio e requisiti');
  assert.equal(sentenceCaseItalian('CONTRIBUTI AVS E LPP IN CH'), 'Contributi AVS e LPP in CH');
  assert.equal(sentenceCaseItalian('IVA E SECO NELLA UE'), 'IVA e SECO nella UE');
  assert.equal(sentenceCaseItalian('CITTÀ DI CONFINE'), 'Città di confine');
  // Ogni etichetta dell'elenco: solo casing, prima lettera maiuscola.
  for (const { label } of PROMPT_SECTION_LABELS) {
    const out = sentenceCaseItalian(label);
    assert.equal(out.toLowerCase(), label.toLowerCase());
    assert.equal(out[0], label[0]);
    assert.notEqual(out, label);
  }
});

test('ogni etichetta viene dalle sorgenti del prompt o dalla decisione del proprietario', () => {
  const sources = {
    'create-article:expandEnrichmentLine': fs.readFileSync(path.join(GENERATOR, 'scripts/create-article.mjs'), 'utf8'),
    'evergreen-topic-generator:buildProfessionEvergreenTopics': fs.readFileSync(path.join(GENERATOR, 'scripts/lib/evergreen-topic-generator.mjs'), 'utf8'),
  };
  assert.ok(PROMPT_SECTION_LABELS.length > 0);
  for (const { label, source, phrase } of PROMPT_SECTION_LABELS) {
    assert.equal(label, label.toUpperCase(), `${label}: l'etichetta e' la forma tutta maiuscola`);
    if (source === 'decisione-proprietario-2026-10-05') {
      assert.ok(['INTRODUZIONE', 'CONCLUSIONE'].includes(label), `${label}: la decisione nomina solo INTRODUZIONE e CONCLUSIONE fuori dai prompt`);
      continue;
    }
    assert.ok(sources[source], `${label}: sorgente sconosciuta ${source}`);
    assert.ok(sources[source].includes(phrase), `${label}: la frase «${phrase}» non e' piu' nel prompt (${source})`);
  }
});

test('applyConvertedHeadings: rifiuta conversioni non in ordine, non solo casing o non intestazioni', () => {
  const text = `## INTRODUZIONE\n${PROSE}\n## CONCLUSIONE`;
  const ok = [{ from: '## INTRODUZIONE', to: '## Introduzione' }, { from: '## CONCLUSIONE', to: '## Conclusione' }];
  assert.equal(applyConvertedHeadings(text, ok), `## Introduzione\n${PROSE}\n## Conclusione`);
  assert.equal(applyConvertedHeadings(PROSE, []), PROSE, 'niente da convertire: identita\'');
  assert.equal(applyConvertedHeadings(text, []), null, 'etichette presenti ma conversioni non dichiarate');
  assert.equal(applyConvertedHeadings(text, [...ok].reverse()), null, 'ordine');
  assert.equal(applyConvertedHeadings(text, [{ from: '## INTRODUZIONE', to: '## Premessa' }]), null, 'non solo casing');
  assert.equal(applyConvertedHeadings(`INTRODUZIONE\n${PROSE}`, [{ from: 'INTRODUZIONE', to: 'Introduzione' }]), null, 'non intestazione');
  assert.equal(applyConvertedHeadings(text, [{ from: '## OBIETTIVI', to: '## Obiettivi' }]), null, 'riga assente');
  // Una seconda occorrenza non dichiarata della stessa etichetta: la
  // conversione dichiarata e' incompleta.
  assert.equal(applyConvertedHeadings(`## CONCLUSIONE\n## CONCLUSIONE`, [ok[1]]), null, 'occorrenza non dichiarata');
});
