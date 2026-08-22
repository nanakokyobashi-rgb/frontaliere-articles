// issue #561, round 2 — la CLASSE dei choke-point che riscrivono il corpus.
//
// Il round 1 ha reso atomico `write()` in create-article.mjs e i tre
// `writeCorpusFile()` gemelli, e li ha dichiarati "sweepati". La review ha
// dimostrato che non lo erano: tre call-site — quelli che CHIAMANO
// `writeCorpusFile` — riscrivevano `content/services/locales/blog-body/
// <locale>/<id>.ts` con un `writeFileSync` diretto sul path finale, ognuno
// sotto lo stesso workflow con `timeout-minutes` citato nel body come motivo
// per fixare il gemello due righe sopra.
//
// L'audit era stato fatto a mano e ha mancato la meta' della classe. Questo
// test la enumera per intero e ne pinna la forma, cosi' il prossimo choke-point
// che nasce nella stessa classe trova un rosso invece di una review.
//
// By-construction e non comportamentale, come create-article-write-atomic:
// queste funzioni chiudono su helper interni non esportati, quindi la prova che
// conta e' sulla FORMA della scrittura.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');

// Ogni file che scrive un `content/**` GIA' ESISTENTE da un processo che un
// workflow con `timeout-minutes` puo' uccidere con SIGKILL.
const CHOKE_POINTS = [
  ['generator/scripts/lib/article-meta-refresh.mjs', 'generate-daily-brief.yml'],
  ['generator/scripts/lib/evergreen-article-refresh.mjs', 'refresh-events-digest.yml'],
  ['generator/scripts/fix-faq-locales.mjs', 'batch-faq-articles.yml'],
  ['generator/scripts/generate-daily-brief-article.mjs', 'generate-daily-brief.yml'],
  ['generator/scripts/generate-events-digest-article.mjs', 'refresh-events-digest.yml'],
  ['generator/scripts/generate-border-wait-ranking-article.mjs', 'generate-border-wait-ranking-weekly.yml'],
  ['generator/scripts/batch-add-faq-to-articles.mjs', 'batch-faq-articles.yml'],
];

// `create-article.mjs` e' nella classe ed e' gia' atomico dal round 1, ma la
// sua `write(rel, content)` risolve il target da `rel` invece di riceverlo:
// la forma e' diversa e ha gia' il suo test dedicato
// (create-article-write-atomic.test.mjs), quindi qui vale solo per il
// censimento di completezza in fondo, non per il controllo di forma.
const COVERED_ELSEWHERE = ['generator/scripts/create-article.mjs'];

// Scrivono sotto blog-body ma NON sono nella classe: nessun workflow li
// invoca (verificato con un grep su .github/workflows/), quindi non esiste il
// SIGKILL da `timeout-minutes` che rende il troncamento possibile. Sono
// riparatori che si lanciano a mano, dove un'interruzione la vede la persona
// che l'ha causata. Se domani un workflow ne chiama uno, il censimento in
// fondo lo rimette in gioco solo se lo si toglie da qui — deliberatamente.
const NOT_WORKFLOW_DRIVEN = [
  'generator/scripts/repair-mangled-chars.mjs',
  'generator/scripts/repair-prompt-placeholders.mjs',
  'generator/scripts/repair-source-echo.mjs',
];

for (const [rel, workflow] of CHOKE_POINTS) {
  const file = path.join(root, rel);

  test(`${rel} importa renameSync e unlinkSync da node:fs`, () => {
    const src = fs.readFileSync(file, 'utf-8');
    const importLine = src.split('\n').find((l) => /from '(?:node:)?fs'/.test(l));
    assert.ok(importLine, `import di node:fs non trovato in ${rel}`);
    assert.match(importLine, /\brenameSync\b/,
      `renameSync deve essere importato in ${rel}: e' il syscall atomico su cui si basa il commit`);
    assert.match(importLine, /\bunlinkSync\b/,
      `unlinkSync deve essere importato in ${rel}: senza, il temp resta a terra quando il rename fallisce`);
  });

  test(`${rel} non scrive mai il corpus direttamente sul path finale (${workflow})`, () => {
    const src = fs.readFileSync(file, 'utf-8');

    // Il nome della variabile-target resta libero: i file della classe la
    // chiamano `file` o `filePath`, e pinnare un nome renderebbe il test una
    // trappola per il prossimo che ne usa un terzo.
    const m = src.match(/const tmp = `\$\{(\w+)\}\.\$\{process\.pid\}\.\$\{writeTmpSeq\+\+\}\.tmp`/);
    assert.ok(m, `${rel}: atteso un path temporaneo accanto al target `
      + '(`${<target>}.${process.pid}.${writeTmpSeq++}.tmp`), cosi\' il rename non '
      + 'attraversa un confine di filesystem');
    const target = m[1];

    // La forma del difetto: writeFileSync che riceve il path finale invece del
    // temp. Il temp non matcha, perche' li' la variabile sta dentro un template
    // literal e non come argomento.
    assert.doesNotMatch(src, new RegExp(`writeFileSync\\(\\s*${target}\\s*[,)]`),
      `${rel}: writeFileSync scrive direttamente su \`${target}\` (il path finale). `
      + `Sotto ${workflow} (timeout-minutes → SIGKILL) quel file resta troncato a meta'. `
      + 'Scrivi su un temp accanto al target e committa con renameSync.');
    assert.doesNotMatch(src, /writeFileSync\(\s*resolve\(/,
      `${rel}: writeFileSync non deve risolvere inline il path finale: `
      + 'quel path va raggiunto solo via renameSync');

    assert.match(src, /writeFileSync\(\s*tmp\s*,/,
      `${rel}: writeFileSync deve scrivere sul temp`);
    assert.match(src, new RegExp(`renameSync\\(\\s*tmp\\s*,\\s*${target}\\s*\\)`),
      `${rel}: il commit sul path finale deve passare da renameSync(tmp, ${target})`);
    assert.match(src, /catch[\s\S]{0,120}unlinkSync\(\s*tmp\s*\)/,
      `${rel}: il fallimento deve ripulire il temp prima di rilanciare`);
  });
}

test("l'elenco dei choke-point copre ogni scrittura di blog-body in generator/scripts", () => {
  // Il difetto vero del round 1 non e' stato il codice: e' stato un audit a
  // mano che ha mancato meta' della classe. Qui l'elenco sopra viene
  // confrontato con cio' che il repo contiene DAVVERO, cosi' un file nuovo che
  // scrive il corpus non puo' restare fuori dalla copertura in silenzio.
  const dir = path.join(root, 'generator', 'scripts');
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.mjs')) continue;
      const src = fs.readFileSync(p, 'utf-8');
      if (/blog-body/.test(src) && /writeFileSync\(/.test(src)) {
        found.push(path.relative(root, p));
      }
    }
  };
  walk(dir);

  const listed = new Set([
    ...CHOKE_POINTS.map(([rel]) => rel),
    ...COVERED_ELSEWHERE,
    ...NOT_WORKFLOW_DRIVEN,
  ]);
  const missing = found.filter((f) => !listed.has(f));
  assert.deepEqual(missing, [],
    `questi file scrivono sotto blog-body ma non sono nell'elenco CHOKE_POINTS: `
    + `${missing.join(', ')}. Aggiungili (e rendili atomici) invece di lasciarli scoperti — `
    + `e' esattamente il buco che la review del round 2 ha trovato.`);
});
