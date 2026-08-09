/**
 * loop-sync-manifest-scope.test.mjs — il manifest deve dichiarare COSA HA
 * GUARDATO, non solo cosa ha trovato.
 *
 * ## Il buco che chiude, che e' una classe e non una lista
 *
 * `loop-drift-check.mjs` confronta i file del manifest **uno per uno**. E'
 * preciso su cio' che gli si da', e completamente cieco su cio' che non gli si
 * da'. Finche' l'unica cosa dichiarata sono i file registrati, la frase «non e'
 * nel manifest» resta ambigua fra due cose opposte:
 *
 *   · il file non ha un gemello sul sito, quindi non c'e' niente da sorvegliare;
 *   · nessuno ha guardato.
 *
 * La seconda non lascia traccia, e per questo si ripete. E' successa tre volte
 * in tre giorni, sempre uguale:
 *
 *   · `generator/scripts/create-article.mjs` era un fork non registrato. La fix
 *     del sito sul cap della meta description (valerielinc-ops#5360) non e' mai
 *     scesa e il difetto e' tornato identico il giorno dopo — issue #81, chiusa
 *     registrando il file (#82).
 *   · #82 aveva ELENCATO altri sette gemelli sotto `generator/scripts/` e li
 *     aveva lasciati fuori, rimandandoli a una issue che nessuno ha aperto.
 *     Li ha registrati la #92, dieci giorni dopo.
 *   · sotto `generator/scripts/lib/` — le librerie che quegli stessi entry
 *     point importano — le voci erano **zero**, su 65 file di cui 55
 *     byte-identici a `scripts/lib/` del sito (issue #97).
 *
 * Registrare i 65 file di oggi non chiude niente: chiude i 65 file di oggi. Il
 * difetto e' che l'assenza non e' osservabile, e la cura e' dichiarare gli
 * ALBERI censiti — `scope.roots` — e pretendere che sotto un albero censito ogni
 * file abbia un mode. Cosi' il 66esimo file non entra in silenzio: entra rosso.
 *
 * ## Perche' la parte forte gira OFFLINE
 *
 * La domanda «questo file ha un gemello sul sito?» ha bisogno del sito. La
 * domanda «questo file e' stato classificato?» no — e' la seconda a chiudere la
 * classe, perche' e' quella che si pone al momento in cui il file viene
 * aggiunto. Il censimento di rete (sotto, opt-in) serve a scoprire alberi NUOVI
 * che nessuno ha ancora dichiarato, ed e' un lavoro da schedule, non da unit
 * test: chiede l'API git/trees dei due repo, che senza token vale 60 richieste
 * l'ora per IP — condivise fra tutti i runner GitHub. Un guard che dipende da
 * quella quota non e' un guard, e' un flake che qualcuno finira' per spegnere.
 *
 * ## REQUIRED_ROOTS, ovvero: la via d'uscita facile e' sbarrata
 *
 * Un test che legge i propri confini dal file che sorveglia si disarma
 * togliendo una riga a quel file. `REQUIRED_ROOTS` sta QUI, nel test: togliere
 * un albero dal censimento diventa una modifica al codice del guard, che in
 * review si vede. E' la stessa ragione per cui `loop-references-exist.test.mjs`
 * pretende che una dichiarazione stale venga rimossa invece di lasciarla
 * scadere da sola.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST_PATH = path.join(ROOT, 'scripts/ci/loop-sync-manifest.json');
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

/** I quattro mode che `loop-drift-check.mjs:classify()` sa trattare. */
const MODES = new Set(['identical', 'adapted', 'corpus-only', 'not-ported']);

/**
 * Gli alberi che DEVONO restare censiti. Vedi l'intestazione: sta qui e non nel
 * manifest apposta, perche' un guard i cui confini vivono nel dato che sorveglia
 * si spegne cancellando una riga di dato.
 */
const REQUIRED_ROOTS = ['scripts/ci', 'scripts/lib', 'generator/scripts/lib', 'host'];

/**
 * Artefatto di Finder, non un file del repo. E' l'unica esclusione: qualunque
 * altra va dichiarata nel manifest, che e' il punto di tutto il test.
 */
const IGNORED_BASENAMES = new Set(['.DS_Store']);

const byPath = new Map(manifest.files.map((f) => [f.path, f]));
const roots = (manifest.scope?.roots || []).map((r) => r.path);

/** Tutti i file sotto `rel`, ricorsivo, path relativi alla radice del repo. */
function walk(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (IGNORED_BASENAMES.has(entry.name)) continue;
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(walk(child) || []));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

test('scope: gli alberi obbligatori sono dichiarati', () => {
  assert.ok(manifest.scope, 'il manifest non ha un blocco `scope`');
  for (const required of REQUIRED_ROOTS) {
    assert.ok(
      roots.includes(required),
      `\`${required}\` non e' piu' in scope.roots. Toglierlo rende invisibile l'intero albero: ` +
        'e\' esattamente il difetto della issue #97. Se e\' voluto, va tolto ANCHE da REQUIRED_ROOTS ' +
        'in questo file, e quella riga si vede in review.',
    );
  }
});

test('scope: ogni root esiste e ogni regola porta una ragione scritta', () => {
  for (const r of manifest.scope.roots) {
    assert.ok(walk(r.path) !== null, `scope.roots[].path inesistente: ${r.path}`);
    assert.ok((r.reason || '').trim().length > 0, `scope.roots[${r.path}] senza \`reason\``);
  }
  for (const x of manifest.scope.outOfScope || []) {
    assert.ok((x.prefix || '').length > 0, 'scope.outOfScope[] senza `prefix`');
    assert.ok((x.reason || '').trim().length > 0, `scope.outOfScope[${x.prefix}] senza \`reason\``);
  }
});

/**
 * IL GUARD. Sotto un albero censito, un file senza voce di manifest non passa.
 *
 * Non chiede che il file sia `identical`, ne' che abbia un gemello: chiede che
 * qualcuno abbia SCELTO un mode. `corpus-only` e' una risposta perfettamente
 * valida — e' la mancanza della risposta a essere il difetto.
 */
test('scope: sotto un albero censito nessun file resta senza mode', () => {
  const missing = [];
  for (const root of roots) {
    for (const file of walk(root) || []) {
      if (!byPath.has(file)) missing.push(file);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `${missing.length} file sotto un albero censito non hanno una voce nel manifest.\n` +
      'Ognuno va classificato: `identical` (deve restare uguale al sito, la fix si fa la\'),\n' +
      '`adapted` (diverso di proposito, con `reason`), `corpus-only` (non esiste sul sito),\n' +
      `\`not-ported\` (il sito ce l'ha, qui deliberatamente no).\n  ${missing.join('\n  ')}`,
  );
});

test('files: schema, mode noti, nessun path duplicato', () => {
  const seen = new Set();
  for (const f of manifest.files) {
    assert.equal(typeof f.path, 'string', `voce senza path: ${JSON.stringify(f)}`);
    assert.ok(!seen.has(f.path), `path duplicato nel manifest: ${f.path}`);
    seen.add(f.path);
    assert.ok(MODES.has(f.mode), `mode sconosciuto su ${f.path}: ${f.mode}`);
    assert.ok(f.baseline, `${f.path}: manca \`baseline\``);
  }
});

test('files: ogni mode diverso da identical porta una ragione', () => {
  for (const f of manifest.files) {
    if (f.mode === 'identical') continue;
    assert.ok(
      (f.reason || '').trim().length > 0,
      `${f.path} e' \`${f.mode}\` senza \`reason\`. Un file diverso dal sito senza una ragione ` +
        "scritta e' indistinguibile da uno andato alla deriva: e' la ragione a rendere " +
        'rileggibile la scelta fra sei mesi.',
    );
  }
});

test('files: sitePath e baseline coerenti col mode', () => {
  for (const f of manifest.files) {
    if (f.sitePath !== undefined) {
      assert.notEqual(
        f.sitePath,
        f.path,
        `${f.path}: \`sitePath\` identico a \`path\` — ridondante, loop-drift-check usa gia' ` +
          '`entry.sitePath || rel`.',
      );
    }
    if (f.mode === 'corpus-only') {
      assert.equal(f.sitePath, undefined, `${f.path}: \`corpus-only\` non puo' avere un \`sitePath\``);
      assert.equal(
        f.baseline.site,
        null,
        `${f.path}: \`corpus-only\` con \`baseline.site\` non nullo. loop-drift-check non lo ` +
          'legge mai per questo mode, quindi il valore e\' solo un\'affermazione falsa.',
      );
    } else {
      assert.ok(f.baseline.site, `${f.path}: \`${f.mode}\` senza \`baseline.site\``);
    }
    if (f.mode !== 'not-ported') {
      assert.ok(f.baseline.corpus, `${f.path}: manca \`baseline.corpus\``);
    }
  }
});

/**
 * Una voce che punta a un file inesistente non e' innocua: `classify()` la
 * traduce in `missing-here` (se il sito ce l'ha) o in `assente su entrambi i
 * lati`, cioe' in una riga di report che nessuno puo' azionare. Meglio romperla
 * qui, dove il path sbagliato e' ancora sotto gli occhi di chi lo ha scritto.
 *
 * `not-ported` e' l'eccezione per definizione: dichiara un file che il sito ha e
 * questo repo no.
 */
test('files: ogni voce non `not-ported` punta a un file che esiste qui', () => {
  const ghosts = manifest.files
    .filter((f) => f.mode !== 'not-ported')
    .map((f) => f.path)
    .filter((p) => !fs.existsSync(path.join(ROOT, p)));
  assert.deepEqual(ghosts, [], `voci di manifest che puntano a file inesistenti:\n  ${ghosts.join('\n  ')}`);
});

/**
 * Il censimento di rete. Opt-in con LOOP_TWIN_CENSUS=1.
 *
 * Risponde alla domanda che la parte offline non puo' porsi: esiste un albero
 * NUOVO, mai dichiarato, i cui file sono byte-identici a file del sito? Il
 * confronto e' sullo sha del blob git, che e' l'hash del CONTENUTO: due file
 * identici hanno lo stesso sha anche in repo diversi, quindi bastano due
 * chiamate git/trees e zero download.
 *
 * Fuori dal `node --test` di CI per la ragione nell'intestazione (quota API
 * senza token). La forma giusta e' uno step di `.github/workflows/loop-drift-check.yml`,
 * che gira una volta al giorno e ha gia' GH_TOKEN in env.
 */
test('censimento: nessun gemello byte-identico fuori da roots, files e outOfScope', { skip: process.env.LOOP_TWIN_CENSUS !== '1' && 'LOOP_TWIN_CENSUS!=1 (richiede rete: vedi intestazione)' }, async () => {
  const SITE_REPO = process.env.SITE_REPO || 'valerielinc-ops/frontaliere-si-o-no';
  const SELF_REPO = process.env.GITHUB_REPOSITORY || 'nanakokyobashi-rgb/frontaliere-articles';
  const headers = { 'User-Agent': 'loop-sync-manifest-scope', Accept: 'application/vnd.github+json' };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const tree = async (repo) => {
    const res = await fetch(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`, { headers });
    assert.ok(res.ok, `GET tree ${repo} → HTTP ${res.status}`);
    const body = await res.json();
    // Un albero troncato darebbe un verdetto costruito su meta' dei dati, che e'
    // peggio di nessun verdetto: meglio fallire dicendo perche'.
    assert.equal(body.truncated, false, `l'albero di ${repo} e' troncato: il censimento non e' affidabile`);
    return body.tree.filter((e) => e.type === 'blob');
  };

  const [mine, theirs] = await Promise.all([tree(SELF_REPO), tree(SITE_REPO)]);
  const siteShas = new Set(theirs.map((e) => e.sha));
  const outOfScope = (manifest.scope.outOfScope || []).map((x) => x.prefix);

  const covered = (p) =>
    byPath.has(p) ||
    roots.some((r) => p.startsWith(`${r}/`)) ||
    outOfScope.some((x) => p.startsWith(x));

  const undeclared = mine.filter((e) => siteShas.has(e.sha) && !covered(e.path)).map((e) => e.path);
  assert.deepEqual(
    undeclared,
    [],
    `${undeclared.length} file byte-identici a un file del sito non sono ne' registrati, ne' sotto ` +
      "un albero censito, ne' dichiarati fuori scope. Ognuno e' un canale di discesa che nessuno " +
      `sorveglia:\n  ${undeclared.join('\n  ')}`,
  );

  // Una regola `outOfScope` che non copre piu' niente e' l'elenco delle scuse di
  // ieri: se l'albero e' sparito, la riga va tolta.
  const dead = outOfScope.filter((x) => !mine.some((e) => e.path.startsWith(x)));
  assert.deepEqual(dead, [], `regole scope.outOfScope che non coprono piu' nessun file:\n  ${dead.join('\n  ')}`);
});
