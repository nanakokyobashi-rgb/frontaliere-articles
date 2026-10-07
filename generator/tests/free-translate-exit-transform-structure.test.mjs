/**
 * La trasformazione d'uscita della cascata di traduzione non puo' togliere a
 * una traduzione la struttura di righe che aveva.
 *
 * `tryTier` accetta l'uscita di un motore solo se ha le righe della sorgente
 * (`hasSameLineStructure`). Subito dopo, pero', `_finalizeEngineOutput` e
 * `translateFieldFreeMt` passavano quel testo a `balanceMarkdownMarkers`, il
 * cui primo passo toglieva i grassetti «vuoti» con una sola regex sul testo
 * intero: `**` … `**` con in mezzo solo spazi o punteggiatura. Quella forma e'
 * anche lo spazio fra la fine di un grassetto e l'inizio del successivo, e
 * `\s` attraversa gli a capo: una voce d'elenco che finisce in grassetto
 * inghiottiva la voce dopo. Nessun controllo guardava le righe dopo quel punto.
 *
 * Misura sul corpus (4.199 body italiani, 12.692 campi, traduzione identica
 * riga per riga): 109 campi in 99 articoli uscivano con meno righe della
 * sorgente; con questa correzione zero. L'ultimo test rifa' la misura a ogni
 * giro.
 */
import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_KEYS = [
  'CODEX_AUTH_BROKER_SOCKET',
  'FREE_TRANSLATE_CODEX_TIER',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GSC_CLIENT_ID',
  'GSC_CLIENT_SECRET',
  'GSC_REFRESH_TOKEN',
  'HF_TOKEN',
  'HUGGINGFACE_API_KEY',
  'LIBRETRANSLATE_SELF_HOSTED_URL',
  'MT_LOCAL_OPUSMT',
  'DEEPL_API_KEY',
  'AZURE_TRANSLATOR_KEY',
  'VITEST',
];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of ENV_KEYS) delete process.env[key];
process.env.DEEPL_API_KEY = 'exit-transform-test-deepl';
process.env.AZURE_TRANSLATOR_KEY = 'exit-transform-test-azure';
process.env.VITEST = '1';

const {
  balanceMarkdownMarkers,
  freeTranslate,
  getCascadeStats,
  hasSameLineSkeleton,
} = await import('../scripts/lib/free-translate.mjs');
const { translateFieldFreeMt } = await import('../scripts/lib/article-free-mt.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const lineCount = (value) => String(value).split('\n').length;

/** Un motore che traduce riga per riga e conserva i marcatori (MyMemory). */
function stubLinePreservingEngine() {
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes('api-free.deepl.com')) return { ok: false, status: 503, json: async () => ({}) };
    if (value.includes('api.cognitive.microsofttranslator.com')) return { ok: false, status: 503, text: async () => '' };
    if (!value.includes('api.mymemory.translated.net')) throw new Error('offline nel test');
    const query = new URL(value).searchParams.get('q') || '';
    const translated = query.split('\n').map((line) => {
      if (!line || /^[\s_\-=*•·~]{3,}$/.test(line)) return line;
      const match = line.match(/^(\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+))(.*)$/u);
      return match ? `${match[1]}T ${match[2]}` : `T ${line}`;
    }).join('\n');
    return { ok: true, json: async () => ({ responseData: { translatedText: translated, match: 1 } }) };
  };
}

// ── il bilanciatore ──────────────────────────────────────────────────────────

test('voci d elenco che finiscono in grassetto non inghiottono la voce successiva', () => {
  const text = [
    '- **AVS**: 22 anni su 44 → circa **1.260 CHF/mese**',
    '- **LPP**: capitale di 280.000 CHF × 6,8% = **1.587 CHF/mese**',
    '- **Pilastro 3a**: capitale di 180.000 CHF',
  ].join('\n');
  assert.equal(balanceMarkdownMarkers(text), text);
});

test('un titoletto in grassetto seguito da una voce con etichetta in grassetto resta su due righe', () => {
  const text = '💡 **Consigli pratici:**\n- **Monitorare la situazione:** tenersi informati.';
  assert.equal(balanceMarkdownMarkers(text), text);
  const withBlank = '**Totale mensile**: circa **2.847 CHF**\n\n**Nota**: valori indicativi';
  assert.equal(balanceMarkdownMarkers(withBlank), withBlank);
});

test('due grassetti vicini sulla stessa riga restano due', () => {
  for (const text of [
    'I tre pilastri: **AVS**, **LPP** e 3a.',
    '**Quando:** **18 febbraio 2026**, dalle **10:15** alle **11:30**.',
    '**Etichetta**: **valore**',
  ]) {
    assert.equal(balanceMarkdownMarkers(text), text);
  }
});

test('i grassetti davvero vuoti vengono ancora tolti', () => {
  assert.equal(balanceMarkdownMarkers('prima ** ** dopo'), 'prima dopo');
  assert.equal(balanceMarkdownMarkers('prima ** : ** dopo'), 'prima dopo');
  assert.equal(balanceMarkdownMarkers('prima **** dopo'), 'prima dopo');
  assert.equal(balanceMarkdownMarkers('- **Voce** ** - ** testo'), '- **Voce** testo');
});

test('un numero dispari di marcatori toglie ancora tutti i grassetti', () => {
  assert.equal(balanceMarkdownMarkers('testo **senza chiusura\n- **voce** intera'), 'testo senza chiusura\n- voce intera');
});

test('una riga di soli separatori e decorazione, salvo quando e della sorgente', () => {
  const source = 'Primo paragrafo.\n\n---\n\nSecondo paragrafo.';
  const translated = 'Erster Absatz.\n\n---\n\nZweiter Absatz.';
  // Senza sorgente: comportamento di sempre (decorazione tolta, righe vuote compattate).
  assert.equal(balanceMarkdownMarkers(translated), 'Erster Absatz.\n\nZweiter Absatz.');
  // Con la sorgente allineata riga per riga: il filetto e' struttura e resta.
  assert.equal(balanceMarkdownMarkers(translated, { sourceText: source }), translated);
  // Se alla stessa posizione la sorgente ha testo, quella riga non e' sua.
  const decorated = 'Erster Absatz.\n=====\nZweiter Absatz.';
  assert.equal(
    balanceMarkdownMarkers(decorated, { sourceText: 'Primo paragrafo.\nRiga di mezzo.\nSecondo paragrafo.' }),
    'Erster Absatz.\nZweiter Absatz.',
  );
  // Sorgente non allineata (righe diverse): nessun allineamento, comportamento di sempre.
  assert.equal(balanceMarkdownMarkers(translated, { sourceText: 'Una riga sola.' }), 'Erster Absatz.\n\nZweiter Absatz.');
});

test('hasSameLineSkeleton guarda righe e marcatori, non il testo', () => {
  assert.equal(hasSameLineSkeleton('## Titolo\n- uno\n- due', '## Titel\n- eins\n- zwei'), true);
  assert.equal(hasSameLineSkeleton('## Titolo\n- uno\n- due', '## Titel\n- eins zwei'), false);
  assert.equal(hasSameLineSkeleton('Testo\n\n---\n\nAltro', 'Text\n\n\n\nMehr'), false);
  assert.equal(hasSameLineSkeleton('Cuoco (m/w/d) a Lugano', 'Koch (m/f/d) in Lugano'), true);
});

// ── la cascata ───────────────────────────────────────────────────────────────

test('freeTranslate rende le stesse righe per un elenco con grassetti in coda e un filetto', async () => {
  stubLinePreservingEngine();
  const text = [
    '## Quanto prenderò di pensione',
    '',
    '- **AVS**: 22 anni su 44 → circa **1.260 CHF/mese**',
    '- **LPP**: capitale di 280.000 CHF × 6,8% = **1.587 CHF/mese**',
    '- **Pilastro 3a**: capitale di 180.000 CHF',
    '',
    '---',
    '',
    '**Totale mensile**: circa **2.847 CHF**',
    '**Nota**: valori indicativi per un caso tipo.',
  ].join('\n');
  const before = getCascadeStats().tierStructureFailures.exitTransformBroke?.exit || 0;
  const translated = await freeTranslate({ text, sourceLang: 'it', targetLang: 'de', fieldType: 'description' });
  assert.equal(lineCount(translated), lineCount(text));
  assert.equal(hasSameLineSkeleton(text, translated), true);
  const lines = translated.split('\n');
  assert.match(lines[2], /^- T \*\*AVS\*\*: .*\*\*1\.260 CHF\/mese\*\*$/);
  assert.match(lines[3], /^- T \*\*LPP\*\*: /);
  assert.equal(lines[6], '---');
  assert.match(lines[9], /^T \*\*Nota\*\*: /);
  assert.equal(getCascadeStats().tierStructureFailures.exitTransformBroke?.exit || 0, before);
});

test('se l uscita toglie comunque lo scheletro di righe il campo e un MISS contato', async () => {
  // Un segnaposto di template che la sorgente stessa contiene viene tolto in
  // uscita, e la pulizia degli spazi che ne segue svuota la riga del filetto:
  // la traduzione aveva la struttura, l'uscita gliela toglie.
  stubLinePreservingEngine();
  const text = 'Offerta di {COMPANY} a Lugano\n\n---\n\nDettagli del ruolo da definire.';
  const before = getCascadeStats().tierStructureFailures.exitTransformBroke?.exit || 0;
  const translated = await freeTranslate({ text, sourceLang: 'it', targetLang: 'de', fieldType: 'description' });
  assert.equal(translated, '');
  assert.equal(getCascadeStats().tierStructureFailures.exitTransformBroke.exit, before + 1);
});

// ── il campo articolo ────────────────────────────────────────────────────────

test('translateFieldFreeMt conserva le righe con il bilanciatore di produzione', async () => {
  const text = '## Esempio\n\n- **AVS**: circa **1.260 CHF/mese**\n- **LPP**: circa **1.587 CHF/mese**\n\n---\n\n**Totale**: **2.847 CHF**\n**Nota**: valori indicativi.';
  const out = await translateFieldFreeMt({
    text,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
    fieldName: 'body3',
    translate: async ({ text: source }) => source.split('\n').map((line) => (
      /^[-#]|^\*\*/.test(line) ? line.replace(/(\*\*: )/, '$1X ') : line
    )).join('\n'),
    balanceMarkdown: balanceMarkdownMarkers,
  });
  assert.equal(lineCount(out), lineCount(text));
  assert.equal(hasSameLineSkeleton(text, out), true);
});

test('translateFieldFreeMt rifiuta un campo a cui la riparazione ha tolto righe', async () => {
  const events = [];
  const text = '- prima voce tradotta bene\n- seconda voce tradotta bene\n- terza voce tradotta bene';
  const out = await translateFieldFreeMt({
    text,
    sourceLang: 'it',
    targetLang: 'de',
    fieldType: 'description',
    fieldName: 'body1',
    translate: async ({ text: source }) => source.replace(/voce tradotta bene/g, 'Punkt gut übersetzt'),
    // Una riparazione che fonde le righe, come faceva il bilanciatore.
    balanceMarkdown: (value) => value.replace(/\n- /, ' '),
    onUnusableOutput: (event) => events.push(event.reason),
  });
  assert.equal(out, '');
  assert.deepEqual(events, ['markdown-repair-changed-lines']);
});

// ── l'osservatore sul corpus ─────────────────────────────────────────────────

test('nessun body italiano perde righe passando dal bilanciatore', (t) => {
  const dir = path.join(ROOT, 'content/blog-body/it');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((file) => file.endsWith('.ts')).sort() : [];
  // In CI il checkout e' completo. Un worktree sparse senza i body non puo'
  // dire nulla: fuori dalla CI il test si dichiara saltato, in CI e' un rosso.
  if (files.length < 1000) {
    if (process.env.CI) assert.fail(`content/blog-body/it ha ${files.length} file: checkout incompleto`);
    t.skip(`content/blog-body/it non materializzato (${files.length} file)`);
    return;
  }
  const offenders = [];
  let fields = 0;
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of raw.matchAll(/'([^'\n]+\.body\d+)':\s*(?:'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g)) {
      let value;
      if (match[3] !== undefined) value = match[3].replace(/\\`/g, '`');
      else {
        try { value = JSON.parse(`"${match[2].replace(/\\'/g, "'").replace(/"/g, '\\"')}"`); } catch { continue; }
      }
      const text = value.trim();
      if (!text) continue;
      fields += 1;
      const balanced = balanceMarkdownMarkers(text, { sourceText: text });
      if (lineCount(balanced) !== lineCount(text) || !hasSameLineSkeleton(text, balanced)) {
        offenders.push(`${file} ${match[1].split('.').pop()}: ${lineCount(text)} → ${lineCount(balanced)} righe`);
      }
    }
  }
  assert.ok(fields > 3000, `solo ${fields} campi letti: il lettore dei body non funziona piu`);
  assert.deepEqual(offenders.slice(0, 10), [], `${offenders.length} campi su ${fields} perdono la struttura di righe`);
});
