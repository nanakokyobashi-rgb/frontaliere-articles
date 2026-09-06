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
//
// `retranslate-blocking-bodies.mjs` sta qui pur non avendo (ancora) un
// workflow, e la scelta e' deliberata. La lista comoda sarebbe
// NOT_WORKFLOW_DRIVEN — anche lui e' un riparatore che si lancia a mano — ma
// quella nota dice che il censimento lo rimette in gioco «solo se lo si toglie
// da qui, deliberatamente»: cioe' il giorno in cui la bonifica prendesse un
// workflow, NIENTE diventerebbe rosso. Sarebbe un silenzio armato in anticipo,
// ed e' il piano dichiarato nel body della PR che lo introduce («una volta
// deciso dove farlo girare»). Il costo di tenerlo qui e' zero, perche' e' gia'
// atomico e le due prove di forma passano senza toccarne una riga; il costo di
// tenerlo fra le eccezioni si paga una volta sola, in silenzio. Vale anche
// senza workflow: la run dura circa un'ora su rete e riscrive centinaia di
// body in place, quindi un'interruzione a meta' scrittura non ha bisogno di
// `timeout-minutes` per esistere.
const CHOKE_POINTS = [
  ['generator/scripts/lib/article-meta-refresh.mjs', 'generate-daily-brief.yml'],
  ['generator/scripts/lib/evergreen-article-refresh.mjs', 'refresh-events-digest.yml'],
  ['generator/scripts/fix-faq-locales.mjs', 'batch-faq-articles.yml'],
  ['generator/scripts/generate-daily-brief-article.mjs', 'generate-daily-brief.yml'],
  ['generator/scripts/generate-events-digest-article.mjs', 'refresh-events-digest.yml'],
  ['generator/scripts/generate-border-wait-ranking-article.mjs', 'generate-border-wait-ranking-weekly.yml'],
  ['generator/scripts/batch-add-faq-to-articles.mjs', 'batch-faq-articles.yml'],
  ['generator/scripts/generate-journalist-image-catalog.mjs', 'generate-article.yml'],
  ['generator/scripts/retranslate-blocking-bodies.mjs', 'nessun workflow: bonifica lanciata a mano'],
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
// Scrivono sotto `generator/scripts` un artefatto che il criterio del censimento
// intercetta, ma NON riscrivono in place qualcosa che un altro processo
// consuma senza poterlo rigenerare: sono contatori di stato e cache. Un
// troncamento qui si ricostruisce al giro dopo — verificato leggendo cosa
// scrive (`article-topic-selector`: tracker e contatori JSON). Resta elencato
// perche' il censimento non lo perda di vista: toglierlo da qui e' l'unico modo
// per rimetterlo in gioco.
// `generator/scripts/lib/run-card.mjs` NON sta in nessuna di queste liste, ed
// e' la risposta giusta invece della piu' comoda. Ci era finito per un giro,
// perche' il criterio girava anche sui COMMENTI e la prosa di `writeRunCard()`
// nominava un letterale che `PUBLISHED` cerca — per spiegare perche' NON lo
// usa. Dichiararlo qui avrebbe reso verde il censimento affermando una cosa
// falsa (che scriva un artefatto pubblicato). Ora il criterio guarda il CODICE
// (vedi `codeOnly()` piu' sotto), quindi il caso non si pone piu' — ne' per
// quel modulo ne' per gli altri sei punti in `lib/` dove una radice pubblicata
// compare in un commento.
// `refresh-events-dataset.mjs` stava qui per lo stesso motivo e non ci sta
// piu': il suo unico match era la prosa che racconta cosa scrive
// `assemble-events-dataset.mjs` NEL REPO DEL SITO. Quel file scrive solo la
// cache della fetch, e una voce che non corrisponde a nessun match e' peggio
// che inutile — scusa in anticipo un write futuro nello stesso file, senza che
// nessuna assertion lo dica. Se un giorno tocchera' davvero `public/data`, il
// censimento lo ritrova dal codice.
const REGENERABLE_STATE = [
  'generator/scripts/lib/article-topic-selector.mjs',
];

const NOT_WORKFLOW_DRIVEN = [
  'generator/scripts/repair-mangled-chars.mjs',
  'generator/scripts/repair-prompt-placeholders.mjs',
  'generator/scripts/repair-source-echo.mjs',
];

for (const [rel, workflow] of CHOKE_POINTS) {
  const file = path.join(root, rel);

  test(`${rel} ha accesso a renameSync e unlinkSync`, () => {
    const src = fs.readFileSync(file, 'utf-8');
    // Due forme in circolazione nel repo: named import da 'fs'/'node:fs', e
    // default import usato come `fs.renameSync`. Pretenderne una sola
    // trasformerebbe il test in una richiesta di stile invece che di sostanza.
    const namedLine = src.split('\n').find((l) => /^import \{[^}]*\} from '(?:node:)?fs'/.test(l)) || '';
    const hasDefaultFs = /^import \w+ from '(?:node:)?fs'/m.test(src);
    for (const fn of ['renameSync', 'unlinkSync']) {
      const ok = new RegExp(`\\b${fn}\\b`).test(namedLine)
        || (hasDefaultFs && new RegExp(`\\bfs\\.${fn}\\(`).test(src));
      assert.ok(ok,
        `${rel}: ${fn} non e' raggiungibile. `
        + (fn === 'renameSync'
          ? "e' il syscall atomico su cui si basa il commit"
          : 'senza, il temp resta a terra quando il rename fallisce'));
    }
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

test("l'elenco dei choke-point copre ogni scrittura di un artefatto pubblicato", () => {
  // Il difetto vero del round 1 non e' stato il codice: e' stato un audit a
  // mano che ha mancato meta' della classe. La prima stesura di questo
  // censimento ne ha mancata un'altra fetta, perche' cercava la stringa
  // `blog-body` — e il write su `public/data/border-wait-ranking.json`, nello
  // stesso file gia' corretto, non la contiene. Un criterio che nomina UN
  // percorso non e' un censimento: e' l'elenco di prima scritto in un altro
  // modo.
  //
  // Ora il criterio e' l'ARTEFATTO: qualunque file che scrive e che nomina una
  // radice pubblicata — il corpus, il registro degli articoli, `public/data`,
  // `dist/api`. Chi entra in quel gruppo o e' atomico, o sta in una delle due
  // liste di esclusione, che sono il posto dove la ragione e' scritta.
  //
  // #571: un choke-point puo' scrivere un path che non nomina mai, perche' lo
  // importa da un modulo condiviso (`import { X } from './lib/paths.mjs'`) —
  // il criterio sopra e' un match sul TESTO del singolo file, quindi in quel
  // caso non troverebbe nulla in silenzio. Per questo il match non gira solo
  // sul file, ma sulla sua sorgente PIU' quella di ogni modulo che importa con
  // uno specificatore relativo, seguito ricorsivamente: se il path e' definito
  // in un modulo importato — come gia' avviene per `corpusPath` via
  // `lib/corpus-paths.mjs` — quel modulo entra comunque nel testo controllato.
  //
  // #902 round 2: il criterio e' testuale di proposito — grossolano e difficile
  // da aggirare per sbaglio — ma il testo di un COMMENTO non e' mai il target
  // di un write. Sei moduli sotto `lib/` nominano una radice pubblicata solo
  // per raccontare cosa fa qualcun altro (`ai-models`, `prompt-placeholder-
  // guard`, `article-free-mt`, `daily-brief-content`, `daily-brief-data`,
  // `run-card`), e siccome il match gira sulla sorgente RAGGIUNGIBILE quella
  // prosa non falliva addosso a loro: falliva addosso al primo file futuro che
  // li importasse scrivendo qualcosa, con un messaggio che parla di artefatti
  // pubblicati mentre il vero motivo e' una parola in una prosa altrui. Per
  // cinque dei sei non esisteva nemmeno un carattere da togliere: `corpusPath\(`
  // e' l'unica alternativa che chiede una parentesi, `blog-body` e `dist/api`
  // sono substring nude. Quindi la riparazione sta qui, nel criterio.
  //
  // `codeOnly()` toglie SOLO i commenti che occupano la riga intera (`//` a
  // inizio riga e blocchi `/* … */` aperti a inizio riga). Deliberatamente
  // conservativo: un commento in coda a una riga di codice resta dentro, e con
  // lui il falso positivo, perche' il costo dei due errori non e' simmetrico —
  // togliere troppo perde un choke-point vero in silenzio, togliere troppo poco
  // lascia solo il rumore che c'era prima. L'assertion in fondo pinna la
  // direzione pericolosa: se lo stripping mangiasse codice, i choke-point noti
  // smetterebbero di matchare e la suite diventa rossa.
  const codeOnly = (src) => {
    const out = [];
    let inBlock = false;
    for (const line of src.split('\n')) {
      const t = line.trim();
      if (inBlock) {
        const end = line.indexOf('*/');
        if (end === -1) { out.push(''); continue; }
        inBlock = false;
        out.push(line.slice(end + 2));
        continue;
      }
      if (t.startsWith('//')) { out.push(''); continue; }
      if (t.startsWith('/*')) {
        if (!t.includes('*/')) inBlock = true;
        out.push('');
        continue;
      }
      out.push(line);
    }
    return out.join('\n');
  };

  const PUBLISHED = /blog-body|blog-articles-data|corpusPath\(|'public',\s*'data'|public\/data|dist\/api/;
  const dir = path.join(root, 'generator', 'scripts');

  const importSourceCache = new Map();
  const resolveRelativeImport = (fromFile, spec) => {
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const candidate of [base, `${base}.mjs`, `${base}.js`, path.join(base, 'index.mjs'), path.join(base, 'index.js')]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    return null;
  };
  // Sorgente raggiungibile da `file` seguendo solo import relativi ('./', '../'),
  // cosi' i pacchetti npm e i builtin di Node restano fuori. `ancestors` e' lo
  // STACK del ramo di ricorsione corrente (rimosso al backtrack): evita di
  // rientrare in un ciclo import senza inquinare la cache, che invece e'
  // globale e vive tra choke-point diversi. Se `ancestors` fosse un set che
  // cresce solo (o venisse controllato prima della cache), un modulo condiviso
  // raggiunto da due rami fratelli (A importa B e C, entrambi importano D)
  // risulterebbe troncato sul secondo ramo: la ricorsione su D vedrebbe D gia'
  // "visitato" dal primo ramo e tornerebbe '' anche se la cache aveva gia' il
  // valore giusto, e quel '' verrebbe cacheato per il choke-point del secondo
  // ramo — perdendo silenziosamente il contenuto di D per lui.
  const reachableSource = (file, ancestors = new Set()) => {
    if (importSourceCache.has(file)) return importSourceCache.get(file);
    if (ancestors.has(file)) return ''; // ciclo genuino nel ramo corrente: non cacheare
    ancestors.add(file);
    let src;
    try { src = codeOnly(fs.readFileSync(file, 'utf-8')); } catch { ancestors.delete(file); return ''; }
    let combined = src;
    for (const m of src.matchAll(/\bfrom\s+'(\.[^']+)'/g)) {
      const resolved = resolveRelativeImport(file, m[1]);
      if (resolved) combined += `\n${reachableSource(resolved, ancestors)}`;
    }
    ancestors.delete(file);
    importSourceCache.set(file, combined);
    return combined;
  };

  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.mjs')) continue;
      const src = codeOnly(fs.readFileSync(p, 'utf-8'));
      if (/writeFileSync\(/.test(src) && PUBLISHED.test(reachableSource(p))) {
        found.push(path.relative(root, p));
      }
    }
  };
  walk(dir);

  const listed = new Set([
    ...CHOKE_POINTS.map(([rel]) => rel),
    ...COVERED_ELSEWHERE,
    ...REGENERABLE_STATE,
    ...NOT_WORKFLOW_DRIVEN,
  ]);
  // La contro-prova dello stripping, nella direzione che fa danno in silenzio:
  // se `codeOnly()` mangiasse codice — un template literal le cui righe
  // iniziano con `*`, per dire — il censimento smetterebbe di vedere i write
  // veri e `missing` resterebbe vuoto per il motivo sbagliato. I choke-point
  // gia' noti devono continuare a matchare il criterio: sono l'unico campione
  // di cui sappiamo con certezza la risposta giusta.
  const blind = [...CHOKE_POINTS.map(([rel]) => rel), ...COVERED_ELSEWHERE]
    .filter((rel) => !found.includes(rel));
  assert.deepEqual(blind, [],
    "il criterio non vede piu' questi choke-point noti: "
    + `${blind.join(', ')}. Se non li hai appena tolti dalla lista, e' `
    + "`codeOnly()` che sta togliendo codice invece di soli commenti: il "
    + 'censimento sarebbe verde perche\' cieco.');

  const missing = found.filter((f) => !listed.has(f));
  assert.deepEqual(missing, [],
    'questi file scrivono un artefatto pubblicato ma non sono censiti: '
    + `${missing.join(', ')}. Rendili atomici e aggiungili a CHOKE_POINTS, oppure `
    + "mettili in REGENERABLE_STATE / NOT_WORKFLOW_DRIVEN con la ragione — "
    + "e' esattamente il buco che le due review del round 2 hanno trovato.");
});

test('nel file del ranking sono atomici ENTRAMBI i choke-point, non solo il body', () => {
  // Il secondo write dello stesso file — `public/data/border-wait-ranking.json`
  // — era sfuggito sia all'audit sia alla prima stesura del censimento, che
  // ragiona per FILE e quindi si ferma al primo write corretto che trova.
  // Questo caso vale una verifica sua: `scripts/build-api.mjs` ripubblica quel
  // JSON verbatim e ne fa `JSON.parse` senza catch, quindi un file troncato non
  // ferma la sola ranking chart — interrompe l'intero build-api, e manifest,
  // articles.json, feed e meta restano alla versione precedente.
  const src = fs.readFileSync(
    path.join(root, 'generator/scripts/generate-border-wait-ranking-article.mjs'), 'utf-8');
  assert.doesNotMatch(src, /writeFileSync\(\s*\n?\s*RANKING_JSON_PATH\s*,/,
    'writeFileSync scrive direttamente su RANKING_JSON_PATH: sotto '
    + 'generate-border-wait-ranking-weekly.yml (timeout-minutes → SIGKILL) quel JSON '
    + "resta troncato, e build-api.mjs muore sul JSON.parse trascinandosi dietro "
    + "tutta la superficie che quel run avrebbe ripubblicato.");
  assert.match(src, /renameSync\(\s*rankingTmp\s*,\s*RANKING_JSON_PATH\s*\)/,
    'il commit su RANKING_JSON_PATH deve passare da renameSync(rankingTmp, RANKING_JSON_PATH)');
});
