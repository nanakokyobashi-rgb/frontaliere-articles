/**
 * agents-md-no-absent-tooling.test.mjs — `AGENTS.md` non puo' ordinare agli
 * agenti di usare strumenti che in CI non esistono.
 *
 * ## Il caso, misurato
 *
 * Il 2026-09-03 alle 11:56 un blocco di 49 righe e' finito su `main` in
 * `AGENTS.md` con un commit diretto (`docs(agents): add GitNexus
 * code-intelligence block`), scritto da un hook locale, non da una decisione.
 * Il blocco dice — in maiuscolo, come «MUST» — di invocare tool MCP
 * (`impact`, `detect_changes`, `query`) e di lanciare `npx gitnexus analyze`
 * prima di ogni modifica.
 *
 * `.gitnexus/` non e' tracciato in questo repo. Su una macchina che ce l'ha il
 * blocco e' vero; in CI e' un ordine verso il nulla, e chi lo esegue e'
 * `issue-fix` o `pr-redcheck-fixer`, che hanno un cap di due round e un budget
 * di turni: turni spesi a inseguire tool assenti sono turni tolti al fix, sulla
 * quota Max CONDIVISA col sito. Un install globale tentato in CI con
 * `GITHUB_PAT_NANAKO` in ambiente e' peggio che inutile.
 *
 * Il difetto NON e' GitNexus: e' che un file letto da ogni agente del ciclo
 * possa acquisire istruzioni operative senza che nessuno le abbia decise. Lo
 * ha trovato la review automatica su una PR che non c'entrava — cioe' per
 * fortuna. Questo test lo rende una costruzione.
 *
 * ## Cosa NON fa
 *
 * Non vieta di documentare uno strumento. Vieta di ORDINARNE l'uso quando il
 * repo non lo porta: se un giorno `.gitnexus/` viene committato qui, l'assert
 * si spegne da solo, ed e' esattamente la condizione che lo rende legittimo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AGENTS = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');

/** True se git traccia almeno un file sotto `rel`; un probe fallito è esplicito. */
function isTracked(rel, exec = execFileSync) {
  try {
    const out = exec('git', ['-C', ROOT, 'ls-files', '--', rel], { encoding: 'utf8' });
    return out.trim().length > 0;
  } catch (error) {
    throw new Error(`Impossibile determinare se git traccia '${rel}'.`, { cause: error });
  }
}

const OPERATIONAL_ORDER = /\b(?:must|should|need\s+to|use|run|invoke|launch|execute|before|prima|usa|usare|utilizza|lancia|lanciare|esegui|eseguire|invoca|invocare)\b/i;
const NEGATED_ORDER = /\b(?:do\s+not|don't|never|must\s+not|should\s+not|non)\s+(?:use|run|invoke|launch|execute|usa|usare|utilizza|lancia|esegui|invoca)\b/i;

/**
 * Cerca ordini operativi nelle sole righe Markdown attive.
 *
 * Un riferimento descrittivo, un blockquote o un esempio fenced non ordina
 * all'agente di usare lo strumento e non deve quindi accendere il guard.
 */
function hasOperationalMention(markdown, tooling) {
  let fenced = false;
  return markdown.split(/\r?\n/).some((line) => {
    if (/^\s*(```+|~~~+)/.test(line)) {
      fenced = !fenced;
      return false;
    }
    if (fenced || /^\s*>/.test(line)) return false;
    if (!tooling.mentions.some((re) => re.test(line))) return false;
    if (NEGATED_ORDER.test(line)) return false;
    return OPERATIONAL_ORDER.test(line);
  });
}

/**
 * Strumenti che `AGENTS.md` puo' ORDINARE di usare solo se il repo li porta.
 *
 * `probe` si verifica su cio' che git TRACCIA, non su cio' che sta sul disco, e
 * la differenza e' il punto: `.gitnexus/` esisteva nel checkout principale di
 * quella macchina e non nei worktree ne' in CI. Un probe su `existsSync` darebbe
 * quindi risposte diverse a seconda di DOVE gira — verde dove nessuno guarda e
 * rosso altrove, che e' il modo piu' rapido per far disattivare un guard.
 */
const TOOLING = [
  {
    name: 'GitNexus',
    // Il marker che l'hook scrive, piu' i nomi dei suoi tool: un blocco
    // riscritto a mano senza i marker resterebbe altrimenti invisibile.
    mentions: [/<!--\s*gitnexus:start\s*-->/i, /\bgitnexus\b/i, /\bdetect_changes\(/],
    probe: '.gitnexus',
  },
];

test('AGENTS.md non ordina strumenti che il repo non porta', () => {
  const offenders = [];
  for (const t of TOOLING) {
    const cited = hasOperationalMention(AGENTS, t);
    if (!cited) continue;
    if (isTracked(t.probe)) continue;
    offenders.push(
      `${t.name}: AGENTS.md lo nomina, ma git non traccia '${t.probe}'. ` +
        'In CI quell\'istruzione manda gli agenti del ciclo a cercare tool assenti, ' +
        'spendendo turni su una quota condivisa. Toglilo da AGENTS.md (il posto ' +
        'giusto e\' CLAUDE.md, che qui e\' gitignorato perche\' e\' config di macchina), ' +
        'oppure porta lo strumento nel repo.',
    );
  }
  assert.deepEqual(offenders, [], `Strumenti ordinati ma assenti:\n  ${offenders.join('\n  ')}`);
});

test('il guard vede il blocco anche senza i suoi marker', () => {
  // Se l'assert sopra dipendesse dal solo commento `<!-- gitnexus:start -->`,
  // basterebbe incollare le stesse istruzioni senza marker per aggirarlo — e
  // il prossimo hook che riscrive il blocco in un formato diverso lo farebbe
  // senza volerlo. Qui si verifica che la rilevazione regga sul TESTO.
  const senzaMarker = 'Usa i tool GitNexus per capire il codice.\n';
  const t = TOOLING[0];
  assert.ok(
    hasOperationalMention(senzaMarker, t),
    'La rilevazione deve riconoscere un ordine operativo anche senza marker HTML.',
  );
});

test('il guard ignora citazioni descrittive, blockquote ed esempi fenced', () => {
  const t = TOOLING[0];
  const descriptive = [
    'Questo test documenta il nome GitNexus senza ordinarne l\'uso.',
    '> Usa GitNexus prima di ogni modifica.',
    '```md',
    'Usa GitNexus prima di ogni modifica.',
    '```',
  ].join('\n');
  assert.equal(hasOperationalMention(descriptive, t), false);
});

test('un errore del probe git non viene trasformato in un falso verde', () => {
  assert.throws(
    () => isTracked('.gitnexus', () => {
      throw new Error('git missing');
    }),
    (error) => error instanceof Error
      && error.message.includes("Impossibile determinare se git traccia '.gitnexus'.")
      && error.cause?.message === 'git missing',
  );
});
