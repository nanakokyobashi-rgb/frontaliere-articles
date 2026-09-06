/**
 * The multi-file registration lock for `registerArticleFiles()` (issue #562).
 *
 * ## Why the writes need it
 *
 * Registering an article touches 9 files (router, blog list, i18n, three
 * locale files, SEO service, sitemap, sitemap-news), each written
 * independently via `create-article.mjs`'s `write()`. `write()` itself is
 * atomic per-target (issue #561, temp+rename), but nothing stopped a kill —
 * or any other failure — from landing BETWEEN two of the nine calls: the
 * corpus would end up with an id registered in some files and not others,
 * and nothing checked the 9 files against each other on the next run to
 * catch it.
 *
 * ## Why this is its own module and not a private function in create-article.mjs
 *
 * That file is 15k+ lines and imports `jsdom` statically, so nothing inside
 * it is reachable by `node --test` without `node_modules` (absent here by
 * default — see AGENTS.md). Pulled out here, the lock mechanism itself is
 * directly testable (`generator/tests/register-lock.test.mjs`) without
 * touching the rest of create-article.mjs.
 *
 * ## Why the marker is PER SECTION and carries a run identity (issue #965)
 *
 * The marker used to be one file for the whole repo. `registerArticleFiles()`
 * is not only called by `create-article.mjs`'s `main()`: the four secondary
 * producers (`generate-daily-brief-article.mjs`,
 * `generate-events-digest-article.mjs`,
 * `generate-border-wait-ranking-article.mjs`,
 * `publish-journalist-article.mjs`) import it directly, all four run as
 * `frontaliere`, and all four run their entry point as a plain step with no
 * `continue-on-error`. A svizzera registration killed mid-write therefore
 * stopped FOUR unrelated publication paths — daily bulletin, weekend digest,
 * border-wait ranking, journalist queue — with a hard job failure and a
 * workflow-failure issue each, over a corpus none of them had touched and
 * none of them could repair: the 11 targets of the two sections are
 * disjoint, so a frontaliere registration cannot make a svizzera split worse
 * (nor the other way round).
 *
 * Scoping the marker by section is what lets the two proceed independently:
 * a run enforces, clears and refuses on the marker of ITS OWN section only,
 * and leaves a foreign one strictly untouched — which is also what preserves
 * the evidence the lock exists for. The pre-#965 single file could not do
 * both: a second section could not open its own marker without clobbering
 * the one already there.
 *
 * A foreign marker being deferred is NOT the split going unnoticed: it stays
 * on disk, tracked, and is fatal for the section that owns it on its very
 * next run.
 *
 * `pid` alone never identified a marker: it does not survive the process, so
 * on a later run — or in a fresh checkout, which is how a committed marker is
 * always seen again — it names some unrelated process or nothing at all.
 * `GITHUB_RUN_ID`/`GITHUB_RUN_ATTEMPT` do survive: they point at the run whose
 * logs explain what interrupted the registration, which is the one thing a
 * human repairing the corpus by hand actually needs.
 */
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-write-json.mjs';

// Deliberately NOT under `.tmp/`, which is gitignored. A run killed mid-write
// leaves its partial writes on disk, and `generate-article.yml` sweeps them
// into a commit with `git add -A` — a lock under `.tmp/` would be the one
// piece of that evidence NOT committed, so the next run (a fresh checkout)
// would inherit the split corpus with nothing left to detect it. Tracked here,
// the registration-in-progress marker travels with the damage it describes.
export const REGISTER_LOCK_DIR = 'generator/data';

// The single-file marker used before #965. Still read (a marker committed by a
// run started before this change is exactly the case the lock exists for), and
// resolved by the section RECORDED INSIDE IT; never written again.
export const LEGACY_REGISTER_LOCK_FILE = `${REGISTER_LOCK_DIR}/register-in-progress.json`;

// The section becomes part of a filename, so it is constrained to the shape the
// two section names actually have rather than merely "non-empty": a value with
// a separator in it would write the marker outside `generator/data/`, where
// `git add -A` would not sweep it into the commit that carries the damage.
const SECTION_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Ogni errore che il lock lancia porta un tipo, non solo un messaggio (issue
 * #964). Chi chiama `registerArticleFiles()` dentro un `try/catch` per-item —
 * `publish-journalist-article.mjs` cicla sulla coda e marca il singolo doc
 * `failed` — deve poter distinguere «questo documento e' malformato» da
 * «il corpus e' SPEZZATO»: il primo riguarda un doc, il secondo riguarda i 9
 * file condivisi e rende privo di senso ogni item successivo del ciclo.
 * Riconoscerlo dal testo del messaggio non e' una sorgente unica (AGENTS.md
 * #6): il messaggio e' scritto per un umano che ripara il corpus a mano e puo'
 * cambiare senza che nessun test se ne accorga.
 */
export class RegisterLockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RegisterLockError';
    // Il flag e non solo `instanceof`: i produttori possono girare con due
    // copie del modulo caricate (import relativo da directory diverse), e
    // `instanceof` fallirebbe fra realm/istanze di modulo distinte proprio nel
    // caso in cui la distinzione conta.
    this.isRegisterLockError = true;
  }
}

/** True se `err` viene dal lock di registrazione — vedi `RegisterLockError`. */
export function isRegisterLockError(err) {
  return err instanceof RegisterLockError || err?.isRegisterLockError === true;
}

function assertSection(section, caller) {
  if (typeof section !== 'string' || !SECTION_RE.test(section)) {
    throw new RegisterLockError(
      `${caller}() requires the article section (got ${JSON.stringify(section)}): the ` +
        'registration targets are section-scoped and cannot be cross-checked on a later run without it.',
    );
  }
}

/** Repo-relative path of the marker for one section. */
export function registerLockFile(section) {
  assertSection(section, 'registerLockFile');
  return `${REGISTER_LOCK_DIR}/register-in-progress-${section}.json`;
}

export function registerLockPath(projectRoot, section) {
  return path.join(projectRoot, registerLockFile(section));
}

/**
 * Human-readable origin of a marker, for the two error messages a human reads
 * while repairing the corpus by hand. `pid` is kept but demoted: it is only
 * meaningful to a process still alive on the same machine.
 */
export function describeLockOrigin(lock) {
  const bits = [];
  if (lock?.runId) bits.push(`run ${lock.runId}${lock.runAttempt ? ` (attempt ${lock.runAttempt})` : ''}`);
  else bits.push('run non identificato (nessun GITHUB_RUN_ID: esecuzione locale o pre-#965)');
  if (lock?.startedAt) bits.push(`iniziata ${lock.startedAt}`);
  if (lock?.pid) bits.push(`pid ${lock.pid}`);
  return bits.join(', ');
}

/**
 * Called before the FIRST of the 9 writes. Throws instead of silently
 * overwriting a lock left by an interrupted registration OF THE SAME SECTION —
 * the corpus may already be inconsistent, and layering a new registration on
 * top would only add a second interleaving nobody could untangle afterwards.
 *
 * `section` is recorded alongside the id (and is the marker's filename) and is
 * NOT optional: the 9 targets are section-scoped (the frontaliere registry,
 * slug map, SEO file and locale chunks are different files from the svizzera
 * ones — the two sections do not share a single target), and
 * `generate-article.yml` alternates the two sections inside the SAME checkout.
 * Resolving the lock against whichever section the NEXT process happens to run
 * as would compare a svizzera id against the frontaliere files, find it in none
 * of them, and clear the lock as "nothing written" over a genuinely split
 * corpus.
 */
export function beginRegisterLock(projectRoot, id, section) {
  assertSection(section, 'beginRegisterLock');
  const lockPath = registerLockPath(projectRoot, section);
  if (existsSync(lockPath)) {
    let stale = lockPath;
    try { stale = readFileSync(lockPath, 'utf-8'); } catch { /* keep path */ }
    throw new RegisterLockError(
      `registration lock still present at ${registerLockFile(section)} — a previous registration ` +
        `was interrupted mid-write and the corpus may have an id registered in some of the 9 ` +
        `files but not others (${stale}). Refusing to start a new registration until the ` +
        'partial write is inspected by hand and the lock file removed.',
    );
  }
  // temp+rename, come ogni altra scrittura della catena di registrazione
  // (`write()` di create-article.mjs, issue #561). Un SIGKILL a meta' di una
  // `writeFileSync` diretta lascerebbe qui un JSON troncato, e un lock
  // illeggibile e' un ARRESTO DURO permanente: `resolveRegisterLock()` lancia
  // finche' qualcuno non cancella il file a mano, anche su un corpus intatto —
  // il kill puo' essere atterrato PRIMA della prima delle 9 scritture, quindi
  // senza nessuno split da riparare. Con il commit via `renameSync` le sole
  // forme osservabili su disco sono «nessun lock» e «lock valido e completo»,
  // e il ramo `unreadable` di `readRegisterLock()` diventa irraggiungibile per
  // costruzione (resta li' come rete, non va rimosso).
  writeJsonAtomic(lockPath, {
    id,
    section,
    pid: process.pid,
    // L'identita' che SOPRAVVIVE al processo e al checkout, a differenza del
    // pid: e' l'unico modo di risalire dal marker ai log del run che lo ha
    // lasciato quando lo si ritrova, giorni dopo, in un checkout diverso.
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    workflow: process.env.GITHUB_WORKFLOW || null,
    startedAt: new Date().toISOString(),
  });
}

/**
 * Called only after the LAST of the 9 writes succeeds — never from a
 * catch/finally, or a kill/throw mid-sequence would clear the very marker
 * meant to survive it for the next invocation to trip on.
 */
export function endRegisterLock(projectRoot, section) {
  try { unlinkSync(registerLockPath(projectRoot, section)); } catch { /* already gone */ }
}

function normaliseLock(parsed) {
  return {
    ...parsed,
    id: typeof parsed?.id === 'string' ? parsed.id : null,
    section: typeof parsed?.section === 'string' && parsed.section !== '' ? parsed.section : null,
    runId: typeof parsed?.runId === 'string' && parsed.runId !== '' ? parsed.runId : null,
    runAttempt: typeof parsed?.runAttempt === 'string' && parsed.runAttempt !== '' ? parsed.runAttempt : null,
  };
}

function readLockAt(absPath) {
  if (!existsSync(absPath)) return null;
  try {
    return normaliseLock(JSON.parse(readFileSync(absPath, 'utf-8')));
  } catch {
    return { id: null, section: null, runId: null, runAttempt: null, unreadable: true };
  }
}

/**
 * Reads the lock left by an interrupted registration of `section`, or `null`
 * when there isn't one. A lock whose JSON is unreadable is still a lock — it is
 * reported with `id: null`, never swallowed as "clean". `id`, `section` and the
 * run identity are normalised AFTER the spread, so a malformed value in the
 * file cannot put itself back through `...parsed`.
 */
export function readRegisterLock(projectRoot, section) {
  return readLockAt(registerLockPath(projectRoot, section));
}

/** The legacy single-file marker (pre-#965), or `null`. Read-only. */
export function readLegacyRegisterLock(projectRoot) {
  return readLockAt(path.join(projectRoot, LEGACY_REGISTER_LOCK_FILE));
}

/**
 * Splits the registration targets into the ones that already carry the id and
 * the ones that don't. `needle === null` means "the file's mere existence is
 * the registration" (the per-article body files), everything else is a
 * substring lookup in the file that was appended to.
 */
export function registrationTargetStatus(targets) {
  const present = [];
  const absent = [];
  for (const t of targets) {
    let has = false;
    if (existsSync(t.absPath)) {
      if (t.needle == null) has = true;
      else {
        try { has = readFileSync(t.absPath, 'utf-8').includes(t.needle); } catch { has = false; }
      }
    }
    (has ? present : absent).push(t.label);
  }
  return { present, absent };
}

/**
 * The startup half of the transaction, called once before the first write of
 * every producer that registers an article — `main()` in create-article.mjs AND
 * `registerArticleFiles()` itself, which is the only entry point the four
 * secondary producers go through.
 *
 * A lock on disk only says a registration *started*; it does not say the
 * corpus is broken. Two of the three possible states are benign and must
 * self-heal, or the generator would brick itself permanently on the first
 * interrupted run and every later run would open a workflow-failure issue for
 * a corpus that is actually fine:
 *
 *  - the id is in NONE of the targets — the kill landed before the first
 *    write, or a later step rolled the article back: nothing to repair;
 *  - the id is in ALL of them — the kill landed after the last write but
 *    before `endRegisterLock()`: the transaction did commit.
 *
 * Only a genuine SPLIT (some targets registered, some not) is the failure
 * this lock exists to catch, and that one throws: continuing would layer a
 * second registration on top of a corpus nobody could untangle afterwards.
 *
 * A marker belonging to ANOTHER section is deferred, never resolved and never
 * removed (issue #965): its 11 targets are disjoint from the ones this run is
 * about to write, so this run can neither worsen it nor repair it, and the
 * section that owns it trips on it on its own next run. Deferrals are returned
 * so the caller can log them — silence would read as "clean".
 *
 * `buildTargets(id, section)` is supplied by the caller because the 9 paths
 * depend on the `--section` config, which lives in create-article.mjs. It is
 * called with the section RECORDED IN THE LOCK, never with the one the
 * current process was launched with: the two differ every time
 * `generate-article.yml` alternates sections in the same checkout, and
 * comparing an id against the other section's files would classify a split
 * corpus as untouched.
 */
export function resolveRegisterLock(projectRoot, buildTargets, section) {
  assertSection(section, 'resolveRegisterLock');
  const deferred = [];
  const resolved = [];
  for (const relPath of [LEGACY_REGISTER_LOCK_FILE, registerLockFile(section)]) {
    const lock = readLockAt(path.join(projectRoot, relPath));
    if (!lock) continue;
    // Un marker dell'ALTRA sezione: lo si lascia esattamente dov'e'. Vale solo
    // per il file legacy, che e' l'unico non gia' scopato dal proprio nome.
    if (lock.section && lock.section !== section) {
      deferred.push({ file: relPath, id: lock.id, section: lock.section, runId: lock.runId, origin: describeLockOrigin(lock) });
      continue;
    }
    // Senza id (o senza sezione, nel file legacy) il marker non e'
    // attribuibile a nessuna sezione: non si puo' nemmeno deferirlo, perche'
    // non si sa a chi. L'unica risposta sicura resta fermarsi.
    if (!lock.id || !lock.section) {
      throw new RegisterLockError(
        `registration lock at ${relPath} is unreadable or missing its ` +
          `${lock.id ? 'section' : 'id'}, so the interrupted registration cannot be located and the ` +
          `9 files cannot be cross-checked (${describeLockOrigin(lock)}). Inspect the corpus by ` +
          'hand and remove the lock file.',
      );
    }
    const { present, absent } = registrationTargetStatus(buildTargets(lock.id, lock.section));
    if (present.length > 0 && absent.length > 0) {
      throw new RegisterLockError(
        `registration of "${lock.id}" (section "${lock.section}", ${describeLockOrigin(lock)}) was ` +
          `interrupted mid-write and left the corpus SPLIT across the ` +
          `registration files: registered in [${present.join(', ')}] but missing from ` +
          `[${absent.join(', ')}]. Refusing to generate on top of an inconsistent corpus — repair the ` +
          `missing entries (or remove the partial ones) by hand, then delete ${relPath}.`,
      );
    }
    try { unlinkSync(path.join(projectRoot, relPath)); } catch { /* already gone */ }
    resolved.push({
      file: relPath,
      state: present.length > 0 ? 'committed' : 'nothing-written',
      id: lock.id,
      section: lock.section,
      runId: lock.runId,
    });
  }
  const last = resolved[resolved.length - 1];
  return last
    ? { state: last.state, id: last.id, section: last.section, resolved, deferred }
    : { state: 'clean', resolved, deferred };
}
