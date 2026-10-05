#!/usr/bin/env node
/**
 * rebase-section-args.mjs — gli argomenti PER SEZIONE di
 * `scripts/lib/rebase-onto-remote.sh`, derivati dal core.
 *
 * `generate-article.yml` dichiarava a mano, per frontaliere e per svizzera,
 * quali file del generatore sono registri append-only (`--merge-registry`),
 * quali ledger si riscrivono per intero (path nudo: prendi upstream) e quali
 * cartelle sono per-articolo (`--take-theirs`). Un elenco scritto a mano nel
 * workflow non vede una sezione nuova del core: il test lo segnalava, ma
 * accendere una sezione voleva dire riscrivere lo YAML. Ora lo YAML passa
 * `--section-surfaces` e l'helper chiede l'elenco qui, che lo deriva da
 * `SECTIONS` di `article-surfaces.mjs` — a sua volta derivato da
 * `ARTICLE_SECTION_CORE` (sezioni ATTIVE).
 *
 * Restano nel workflow solo i path NON di sezione (cache globali, contatori,
 * crediti immagine, immagini hero): non dipendono da quante sezioni esistono.
 *
 * Uscita: un token per riga, nella forma che `rebase-onto-remote.sh` accetta
 * (`--merge-registry <path>`, `--take-theirs <prefisso/>`, path nudo). Esce 1
 * con un messaggio se il core ha una sezione attiva senza superfici di
 * scrittura dichiarate: una sezione non coperta qui farebbe abortire il rebase
 * e perdere un articolo gia' pagato (issue #255/#281/#285).
 *
 * Solo builtin Node, come ogni script di `scripts/ci/`.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Le tre categorie per sezione, in ordine di sezione.
 *
 * @param {Record<string, object>} [sections] `SECTIONS` di article-surfaces (iniettabile nei test)
 * @returns {{ bookkeeping: string[], registries: string[], takeTheirs: string[], counters: string[] }}
 */
export function sectionRebaseSurfaces(sections) {
  const bookkeeping = [];
  const registries = [];
  const takeTheirs = [];
  // Stato globale partizionato per sezione (D18, solo le cantonali): cache
  // riscritte per intero (path nudo) e contatori `path:campo` (--merge-counter).
  const counters = [];
  const entries = Object.entries(sections ?? {});
  if (entries.length === 0) throw new Error('nessuna sezione attiva: niente da dichiarare al rebase');
  for (const [section, cfg] of entries) {
    for (const key of ['sourceLedger', 'sourceQuotaFile', 'registryFile', 'slugDataFile', 'seoWriteFile', 'bodyDir', 'sidecarDir']) {
      if (typeof cfg?.[key] !== 'string' || !cfg[key]) {
        throw new Error(`sezione '${section}': superficie di scrittura '${key}' non dichiarata in article-surfaces.mjs`);
      }
    }
    if (!Array.isArray(cfg.metaFiles) || cfg.metaFiles.length === 0) {
      throw new Error(`sezione '${section}': metaFiles non dichiarati in article-surfaces.mjs`);
    }
    bookkeeping.push(cfg.sourceLedger, cfg.sourceQuotaFile, ...(cfg.stateBookkeeping || []));
    for (const spec of cfg.stateCounters || []) {
      if (!/^[^\s:]+:[A-Za-z_]\w*$/.test(spec)) throw new Error(`sezione '${section}': contatore '${spec}' non nella forma path:campo`);
      counters.push(spec);
    }
    registries.push(
      cfg.registryFile,
      cfg.slugDataFile,
      ...(cfg.idUnionFile ? [cfg.idUnionFile] : []),
      ...cfg.metaFiles,
      cfg.seoWriteFile,
    );
    takeTheirs.push(`${cfg.bodyDir}/`, `${cfg.sidecarDir}/`);
  }
  return { bookkeeping, registries, takeTheirs, counters };
}

/** Gli stessi elenchi, come argomenti per `rebase-onto-remote.sh`. */
export function sectionRebaseArgs(sections) {
  const { bookkeeping, registries, takeTheirs, counters } = sectionRebaseSurfaces(sections);
  return [
    ...bookkeeping,
    ...counters.flatMap((c) => ['--merge-counter', c]),
    ...registries.flatMap((p) => ['--merge-registry', p]),
    ...takeTheirs.flatMap((p) => ['--take-theirs', p]),
  ];
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    const { SECTIONS } = await import('../lib/article-surfaces.mjs');
    process.stdout.write(`${sectionRebaseArgs(SECTIONS).join('\n')}\n`);
  } catch (error) {
    console.error(`::error::rebase-section-args: ${error?.message ?? error}`);
    process.exit(1);
  }
}
