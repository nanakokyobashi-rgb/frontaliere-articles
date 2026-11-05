#!/usr/bin/env node
/**
 * merge-counter-conflict.mjs — risolve un conflitto di rebase su un file
 * CONTATORE sommando gli incrementi dei due lati, invece di sceglierne uno.
 *
 * Uso (durante un rebase fermo su un conflitto, dalla radice del repo):
 *   node scripts/lib/merge-counter-conflict.mjs <path>:<campo>
 *
 * Exit 0 = il file in working tree e' stato riscritto col valore fuso (il
 *          chiamante puo' fare `git add`). Exit 1 = fusione non dimostrabile:
 *          il file NON e' stato toccato e il chiamante decide (in
 *          `rebase-onto-remote.sh` ricade su «prendi upstream», cioe' sul
 *          comportamento che questi file avevano prima). In `--reconcile`,
 *          exit 1 invece blocca il commit quando una spec non e' dimostrabile.
 *          Exit 2 = uso errato.
 *
 * ── Perche' una quarta categoria (D18, PR «P1» delle sezioni cantonali) ─────
 *
 * `rebase-onto-remote.sh` conosceva tre risoluzioni: prendi upstream (cache di
 * bookkeeping), unisci i record (registri append-only), prendi il commit
 * rigiocato (file per-articolo). Nessuna e' giusta per un CONTATORE:
 *
 *   · `data/topic-candidates-{experimental,evergreen}-counter.json` (`count`) e
 *     `data/quota-state.json` (`runCounter`) sono riscritti per intero a ogni
 *     run che pubblica, con il valore letto a inizio run piu' uno. Due run
 *     partiti dalla stessa base scrivono lo STESSO numero: il conflitto
 *     testuale c'e' solo se il valore differisce, e quando c'e' entrambi i
 *     lati hanno contato qualcosa che l'altro non ha visto.
 *   · «prendi upstream» perde l'incremento di questo run; «prendi il commit
 *     rigiocato» (`--take-theirs`) perde TUTTI gli incrementi atterrati
 *     upstream nel frattempo, che con molti scrittori paralleli sono piu' d'uno.
 *     Entrambe fanno derivare la rotazione 1-su-N che i contatori governano
 *     (`shouldUseExperimentalTier`, `shouldForceEvergreen`, `decideSlot`).
 *
 * La risoluzione corretta e' il merge a tre vie di un contatore:
 *
 *     valore = upstream + (rigiocato − base)
 *
 * cioe' la copia upstream con sopra l'incremento che QUESTO commit ha fatto
 * rispetto alla sua base. Ogni altro campo del documento resta quello di
 * upstream, come per una cache di bookkeeping: in `quota-state.json`
 * `currentQuota`/`lastTune`/`history` non sono scritti da create-article, e
 * se lo fossero upstream e' la vista piu' recente.
 *
 * ── Quando NON si fonde ────────────────────────────────────────────────────
 *
 *   · un lato illeggibile o col campo non intero non negativo;
 *   · un incremento NEGATIVO del commit rigiocato (un reset): sommarlo
 *     cancellerebbe incrementi altrui, e il «prendi upstream» del ripiego e'
 *     la stessa decisione che si prendeva prima di questo file.
 *
 * Senza base (add/add: il file e' nato su entrambi i lati) l'incremento del
 * commit rigiocato non e' misurabile: si tiene il MASSIMO dei due lati, che
 * non conta mai due volte e perde al piu' gli incrementi del lato minore.
 *
 * Nota sui lati: durante un rebase lo stage 2 (`--ours`) e' UPSTREAM e lo
 * stage 3 (`--theirs`) e' il commit RIGIOCATO, l'inverso di un merge.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function parseCounterDoc(text, field, label) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { error: `${label}: JSON illeggibile (${e.message})` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { error: `${label}: non e' un oggetto JSON` };
  }
  const value = doc[field];
  if (!Number.isInteger(value) || value < 0) {
    return { error: `${label}: il campo '${field}' non e' un intero non negativo (${JSON.stringify(value)})` };
  }
  return { doc, value };
}

/**
 * Fonde un contatore a tre vie. Pura: i tre lati arrivano come testo.
 *
 * @param {{base: string|null, upstream: string, replayed: string, field: string}} sides
 *        `base` null = file assente nella base comune (add/add).
 * @returns {{ok: true, merged: string, value: number, rule: string}|{ok: false, reason: string}}
 */
export function mergeCounterDocuments({ base, upstream, replayed, field }) {
  if (typeof field !== 'string' || !field) return { ok: false, reason: 'campo contatore non indicato' };
  const up = parseCounterDoc(upstream, field, 'upstream');
  if (up.error) return { ok: false, reason: up.error };
  const mine = parseCounterDoc(replayed, field, 'commit rigiocato');
  if (mine.error) return { ok: false, reason: mine.error };

  let value;
  let rule;
  if (base == null) {
    value = Math.max(up.value, mine.value);
    rule = `max(${up.value}, ${mine.value}) — nessuna base comune`;
  } else {
    const b = parseCounterDoc(base, field, 'base');
    if (b.error) return { ok: false, reason: b.error };
    const delta = mine.value - b.value;
    if (delta < 0) {
      return { ok: false, reason: `il commit rigiocato ha decrementato '${field}' (${b.value} → ${mine.value})` };
    }
    value = up.value + delta;
    rule = `${up.value} + (${mine.value} − ${b.value})`;
  }

  // Lo spread conserva l'ordine delle chiavi di upstream e la riassegnazione
  // tiene il campo al suo posto: il diff contro upstream e' una riga sola.
  const merged = `${JSON.stringify({ ...up.doc, [field]: value }, null, 2)}\n`;
  return { ok: true, merged, value, rule };
}

/** Splitta `<path>:<campo>` sull'ULTIMO `:`. */
export function parseCounterSpec(spec) {
  const at = String(spec ?? '').lastIndexOf(':');
  if (at <= 0 || at === spec.length - 1) return null;
  return { path: spec.slice(0, at), field: spec.slice(at + 1) };
}

/** Il blob di uno stage dell'indice, o null se quello stage non c'e'. */
function readStage(stage, path) {
  try {
    return execFileSync('git', ['show', `:${stage}:${path}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Il blob di `path` a `rev`; null solo se il path non c'e'. */
function readAt(rev, path) {
  if (!git(['ls-tree', '--name-only', rev, '--', path]).trim()) return null;
  return git(['show', `${rev}:${path}`]);
}

function reconciliationFailure(category) {
  const error = new Error(category);
  error.reconciliationCategory = category;
  return error;
}

/**
 * Riconciliazione DOPO un rebase riuscito: il conflitto non e' l'unico modo
 * di perdere un incremento. Due run partiti da N che scrivono entrambi N+1
 * producono lo STESSO blob, git non vede nessun conflitto e il rebase finisce
 * con N+1 invece di N+2. Qui si ricalcola, per ogni contatore, il valore che
 * il commit rigiocato deve portare — upstream + (pre-rebase − base comune) —
 * e si riscrive in working tree quello che differisce. Stampa su stdout un
 * path per riga, uno per file riscritto; il chiamante fa `git add` + amend.
 *
 * Tutte le spec si verificano prima di scrivere. Una spec non dimostrabile
 * rende l'intero comando non-zero, cosi' il chiamante non puo' committare una
 * riconciliazione parziale. Una spec assente da base, upstream, commit rigiocato
 * e working tree e' un no-op verificato: nessun contatore esiste da fondere.
 * Se invece il contatore esisteva nella base, la sua assenza da un lato e'
 * un errore.
 */
export function reconcileCounters(preRebase, upstream, specs, { log = console.log, warn = console.error } = {}) {
  let base;
  try {
    base = git(['merge-base', preRebase, upstream]).trim();
  } catch {
    throw reconciliationFailure('merge-base');
  }
  if (!base) throw reconciliationFailure('merge-base');

  const currentDocs = new Map();
  const originalTexts = new Map();
  const rewritten = new Set();
  for (const raw of specs) {
    const spec = parseCounterSpec(raw);
    if (!spec) throw reconciliationFailure('invalid-spec');

    let mine;
    let up;
    let baseText;
    try {
      mine = readAt(preRebase, spec.path);
      up = readAt(upstream, spec.path);
      baseText = readAt(base, spec.path);
    } catch {
      throw reconciliationFailure('revision-read');
    }

    if (baseText == null && mine == null && up == null) {
      if (existsSync(spec.path)) throw reconciliationFailure('working-tree-counter-without-history');
      continue;
    }
    if (baseText == null && mine == null) mine = up;
    if (baseText == null && up == null) up = mine;
    if (baseText != null && (mine == null || up == null)) {
      throw reconciliationFailure('missing-revision-file');
    }

    const result = mergeCounterDocuments({
      base: baseText,
      upstream: up,
      replayed: mine,
      field: spec.field,
    });
    if (!result.ok) throw reconciliationFailure('counter-not-reconcilable');

    let current = currentDocs.get(spec.path);
    if (!current) {
      let text;
      try {
        text = readFileSync(spec.path, 'utf8');
      } catch {
        throw reconciliationFailure('working-tree-read');
      }
      const parsed = parseCounterDoc(text, spec.field, 'working tree');
      if (parsed.error) throw reconciliationFailure('working-tree-counter');
      current = parsed.doc;
      currentDocs.set(spec.path, current);
      originalTexts.set(spec.path, text);
    } else if (parseCounterDoc(JSON.stringify(current), spec.field, 'working tree').error) {
      throw reconciliationFailure('working-tree-counter');
    }

    if (current[spec.field] !== result.value) {
      current[spec.field] = result.value;
      rewritten.add(spec.path);
    }
  }

  try {
    for (const p of rewritten) {
      writeFileSync(p, `${JSON.stringify(currentDocs.get(p), null, 2)}\n`);
    }
  } catch {
    for (const p of [...rewritten].reverse()) {
      try {
        writeFileSync(p, originalTexts.get(p));
      } catch {
        // The caller still fails closed; it never commits after this error.
      }
    }
    throw reconciliationFailure('working-tree-write');
  }

  for (const p of rewritten) {
    warn(`riconciliazione contatore completata: ${p} (dettagli numerici omessi)`);
    log(p);
  }
  return [...rewritten];
}

function main(argv) {
  if (argv[0] === '--reconcile') {
    const [, preRebase, upstream, ...specs] = argv;
    if (!preRebase || !upstream || specs.length === 0) {
      console.error('uso: merge-counter-conflict.mjs --reconcile <pre-rebase> <upstream> <path>:<campo>...');
      return 2;
    }
    try {
      reconcileCounters(preRebase, upstream, specs);
      return 0;
    } catch (error) {
      console.error(`::error::counter reconciliation failed; category=${error.reconciliationCategory || 'counter-data'}`);
      return 1;
    }
  }
  if (argv.length !== 1) {
    console.error('uso: merge-counter-conflict.mjs <path>:<campo>');
    return 2;
  }
  const spec = parseCounterSpec(argv[0]);
  if (!spec) {
    console.error(`uso: merge-counter-conflict.mjs <path>:<campo> (ricevuto '${argv[0]}')`);
    return 2;
  }
  const upstream = readStage(2, spec.path);
  const replayed = readStage(3, spec.path);
  if (upstream == null || replayed == null) {
    console.error(`::warning::${spec.path}: contatore senza una delle due copie (upstream o commit rigiocato) — non lo fondo`);
    return 1;
  }
  const result = mergeCounterDocuments({ base: readStage(1, spec.path), upstream, replayed, field: spec.field });
  if (!result.ok) {
    console.error(`::warning::${spec.path}: merge del contatore non dimostrabile — ${result.reason}`);
    return 1;
  }
  writeFileSync(spec.path, result.merged);
  console.log(`merge contatore: ${spec.path} ${spec.field}=${result.value} (${result.rule})`);
  return 0;
}

const invokedDirectly = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
