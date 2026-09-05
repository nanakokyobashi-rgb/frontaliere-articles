/**
 * loop-manifest-identical-unmirrorable.test.mjs — una voce `identical` non
 * puo' importare un modulo che il sito non ha (issue #892).
 * Run with `node --test generator/tests/loop-manifest-identical-unmirrorable.test.mjs`.
 *
 * ## La contraddizione che il manifest sa dichiarare senza accorgersene
 *
 * Ogni voce e' letta DA SOLA. `identical` dice «il file la' e' lo stesso,
 * quindi e' copiabile nei due versi»; `corpus-only` dice «questo non esiste
 * sul sito, ed e' giusto cosi'». Entrambe possono essere vere una per una e
 * false INSIEME, appena la prima importa la seconda: copiare il file verbatim
 * porterebbe sul sito un `import` che li' non risolve, cioe' un
 * `ERR_MODULE_NOT_FOUND` a carico dei suoi consumer.
 *
 * Il caso reale, misurato il 2026-09-05: dopo #878
 * `generator/scripts/lib/article-free-mt.mjs` (`identical`) importa
 * `hasUsableTranslatedText`/`hasUsableContentText` da
 * `generator/scripts/lib/body2-payload-verdict.mjs`, che e' `corpus-only` e sul
 * sito risponde 404. Il drift check lo mostrava come `corpus-ahead` —
 * «modificato qui, candidato a risalire al sito» — che e' esattamente la riga
 * che invita alla riparazione impossibile.
 *
 * ## Perche' solo `identical`
 *
 * `adapted` DICHIARA gia' di differire, e una dipendenza corpus-only e' uno dei
 * modi legittimi di differire: sulla stessa misura le voci `adapted` con almeno
 * un import assente sul sito erano 27, tutte sane. Un guard che le segnalasse
 * produrrebbe 27 righe di rumore, e una lista che nessuno legge non e' un
 * guard.
 *
 * ## Perche' e' OFFLINE
 *
 * La domanda «il sito ce l'ha?» ha gia' una risposta nel manifest, dichiarata a
 * mano nel `mode`. Non serve la rete, quindi questo guard non dipende dalle 60
 * richieste/ora per IP anonimo che tengono fuori dai test il censimento dei
 * gemelli — stessa ragione di `loop-manifest-corpus-only-twin.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unmirrorableDepsVerdict, resolvedLocalImports, classify } from '../../scripts/ci/loop-drift-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/loop-sync-manifest.json'), 'utf8'));
const MODE_OF = new Map(MANIFEST.files.map((f) => [f.path, f.mode]));

const FREE_MT = 'generator/scripts/lib/article-free-mt.mjs';
const VERDICT = 'generator/scripts/lib/body2-payload-verdict.mjs';

// ── 1. Il verdetto puro ────────────────────────────────────────────────────

test("IL CASO: `identical` che importa un `corpus-only` e' bloccato, e la dipendenza viene NOMINATA", () => {
  const v = unmirrorableDepsVerdict({ mode: 'identical', deps: [{ path: VERDICT, mode: 'corpus-only' }] });
  assert.equal(v.blocked, true);
  assert.deepEqual(v.deps.map((d) => d.path), [VERDICT]);
});

test('anche `corpus-only-pending` blocca: il gemello non e\' ancora atterrato', () => {
  // «Arrivera'» non e' «c'e'»: finche' non atterra, la copia sul sito non si
  // carica esattamente come per un `corpus-only` semplice.
  const v = unmirrorableDepsVerdict({ mode: 'identical', deps: [{ path: 'x.mjs', mode: 'corpus-only-pending' }] });
  assert.equal(v.blocked, true);
});

test('`not-ported` NON blocca: e\' il sito ad averlo, non noi', () => {
  const v = unmirrorableDepsVerdict({ mode: 'identical', deps: [{ path: 'x.mjs', mode: 'not-ported' }] });
  assert.equal(v.blocked, false);
});

test('nessun mode oltre `identical` viene rivendicato', () => {
  // I 27 `adapted` con una dipendenza corpus-only della misura del 2026-09-05:
  // dichiarano gia' di differire, segnalarli sarebbe rumore.
  for (const mode of ['adapted', 'corpus-only', 'corpus-only-pending', 'not-ported']) {
    assert.equal(
      unmirrorableDepsVerdict({ mode, deps: [{ path: VERDICT, mode: 'corpus-only' }] }).blocked,
      false,
      `${mode} non deve diventare identical-unmirrorable`,
    );
  }
});

test('dipendenze assenti o non dichiarate → mai un verdetto (fail-open)', () => {
  // Un file illeggibile, un import che non risolve o un modulo fuori manifest
  // non devono produrre un rosso: un dato mancante non e' una prova. Stessa
  // scelta di `ghostVerdict` e `corpusOnlyTwinVerdict`.
  assert.equal(unmirrorableDepsVerdict({ mode: 'identical' }).blocked, false);
  assert.equal(unmirrorableDepsVerdict({ mode: 'identical', deps: [] }).blocked, false);
  assert.equal(unmirrorableDepsVerdict({ mode: 'identical', deps: [{ path: 'x.mjs', mode: undefined }] }).blocked, false);
  assert.equal(unmirrorableDepsVerdict({ mode: 'identical', deps: [{ path: 'y.mjs', mode: 'identical' }] }).blocked, false);
});

// ── 2. L'estrazione degli import ───────────────────────────────────────────

const known = (c) => ['a/b/dep.mjs', 'a/b/braced.mjs', 'a/b/star.mjs', 'a/b/noext.mjs'].includes(c);

test('un import BRACED SU PIU\' RIGHE viene visto', () => {
  // La forma su cui `loop-scripts-closure.test.mjs` era cieco prima della sua
  // fix: con `.*?` (che non attraversa i newline) la dipendenza non esisteva.
  const src = "import {\n  uno,\n  due,\n} from './braced.mjs';\n";
  assert.deepEqual(resolvedLocalImports('a/b/x.mjs', src, known), ['a/b/braced.mjs']);
});

test("`export ... from` e' una dipendenza quanto un `import`", () => {
  assert.deepEqual(resolvedLocalImports('a/b/x.mjs', "export * from './star.mjs';\n", known), ['a/b/star.mjs']);
});

test('una riga di PROSA che cita un import non e\' una dipendenza', () => {
  // Falso positivo prodotto davvero dal porting: un commento che cita uno
  // specificatore. L'ancora `^[ \t]*` lo esclude.
  const src = "/**\n * Vedi `import { x } from './dep.mjs'` nel sito.\n */\nconst a = 1;\n";
  assert.deepEqual(resolvedLocalImports('a/b/x.mjs', src, known), []);
});

test('gli import di PACCHETTO non hanno un gemello da dichiarare', () => {
  assert.deepEqual(resolvedLocalImports('a/b/x.mjs', "import fs from 'node:fs';\nimport z from 'zod';\n", known), []);
});

test('lo specificatore senza estensione risolve come in Node', () => {
  // engine/ e host/ usano la forma senza estensione: se non la si prova, la
  // dipendenza sparisce e il guard e' verde su un legame che esiste.
  assert.deepEqual(resolvedLocalImports('a/b/x.mjs', "import q from './noext';\n", known), ['a/b/noext.mjs']);
});

test('`..` risolve fuori dalla directory del file', () => {
  const src = "import d from '../dep.mjs';\n";
  assert.deepEqual(resolvedLocalImports('a/b/sub/x.mjs', src, known), ['a/b/dep.mjs']);
});

// ── 3. `classify()`: il verdetto arriva al report ──────────────────────────

test("classify() dice `identical-unmirrorable` invece di `corpus-ahead`", () => {
  // Lo stato esatto della issue #892: solo il corpus si e' mosso, quindi senza
  // questo ramo la riga sarebbe «modificato qui, candidato a risalire al
  // sito» — l'invito alla copia che sul sito non si carica.
  const entry = { path: 'finto/none.mjs', mode: 'identical' };
  const now = { site: 'AA', corpus: 'BB' };
  const base = { site: 'AA', corpus: 'AA' };
  assert.equal(classify(entry, now, base, []).state, 'corpus-ahead', 'premessa: senza dipendenze bloccanti resta corpus-ahead');
  const v = classify(entry, now, base, [{ path: VERDICT, mode: 'corpus-only' }]);
  assert.equal(v.state, 'identical-unmirrorable');
  assert.equal(v.actionable, true);
  assert.match(v.detail, /body2-payload-verdict\.mjs/, 'la dipendenza va NOMINATA, non solo contata');
});

test('il verdetto non copre una voce che qui non esiste piu\'', () => {
  // `missing-here` viene prima: un file assente non ha import da leggere, e
  // l'azione da fare e' un'altra.
  const entry = { path: 'finto/none.mjs', mode: 'identical' };
  const v = classify(entry, { site: 'AA', corpus: null }, { site: 'AA', corpus: 'AA' }, [{ path: VERDICT, mode: 'corpus-only' }]);
  assert.equal(v.state, 'missing-here');
});

test("`corpus-ahead` su una voce `adapted` stampa la sua `reason`", () => {
  // L'altra meta' della issue #892: anche dopo la riclassificazione la riga
  // resta `corpus-ahead`, e senza la `reason` il consiglio generico («vale la
  // pena proporlo al sito») invita a una risalita che il sito non puo'
  // ricevere. `site-ahead` la stampa gia'; questo verso no.
  const entry = { path: 'finto/none.mjs', mode: 'adapted', reason: 'dipende da un modulo corpus-only' };
  const v = classify(entry, { site: 'AA', corpus: 'BB' }, { site: 'AA', corpus: 'AA' }, []);
  assert.equal(v.state, 'corpus-ahead');
  assert.match(v.detail, /dipende da un modulo corpus-only/);
});

// ── 4. Il manifest committato ──────────────────────────────────────────────

test('IL FATTO: article-free-mt.mjs importa un modulo che il sito non ha', () => {
  // La premessa della issue. Se un giorno l'import sparisce (o
  // `body2-payload-verdict.mjs` atterra sul sito), questo test lo dice e la
  // voce puo' tornare `identical`.
  const src = fs.readFileSync(path.join(ROOT, FREE_MT), 'utf8');
  const deps = resolvedLocalImports(FREE_MT, src, (c) => MODE_OF.has(c));
  assert.ok(deps.includes(VERDICT), `atteso l'import di ${VERDICT}, trovati: ${deps.join(', ') || '(nessuno)'}`);
  assert.equal(MODE_OF.get(VERDICT), 'corpus-only');
  assert.notEqual(MODE_OF.get(FREE_MT), 'identical', 'una voce con una dipendenza corpus-only non puo\' dirsi `identical`');
});

test('NESSUNA voce `identical` del manifest importa un modulo assente dal sito', () => {
  // Il guard di classe: chiude la contraddizione per tutte le 157 voci
  // `identical`, non solo per quella che l'ha fatta scoprire.
  const offenders = [];
  for (const entry of MANIFEST.files) {
    if (entry.mode !== 'identical') continue;
    const abs = path.join(ROOT, entry.path);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    let src;
    try {
      src = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // fail-open, come il verdetto
    }
    const deps = resolvedLocalImports(entry.path, src, (c) => MODE_OF.has(c)).map((p) => ({ path: p, mode: MODE_OF.get(p) }));
    const v = unmirrorableDepsVerdict({ mode: entry.mode, deps });
    if (v.blocked) offenders.push(`${entry.path} → ${v.deps.map((d) => `${d.path} (${d.mode})`).join(', ')}`);
  }
  assert.deepEqual(
    offenders,
    [],
    'una voce `identical` con una dipendenza assente sul sito non e\' mirrorabile: portala sul sito, ' +
      'riclassifica la voce `adapted` con la ragione, o estrai la parte condivisa in un modulo terzo.\n' +
      offenders.join('\n'),
  );
});
