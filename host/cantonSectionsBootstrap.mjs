/**
 * Bootstrap dell'engine mirrorato per il corpus.
 *
 * Lo stato `enabled` appartiene a `generator/data/canton-sections.json`.
 * `sections/registry.json` resta invece il registro dello stato servito
 * (draft/live/retired). Ogni entrypoint che usa l'engine importa questo modulo
 * prima dei propri consumer: cosi' il core, i descrittori, i feed e le pagine
 * vedono lo stesso insieme attivo nello stesso processo.
 */
import { configureCorpusActiveSections } from '../scripts/lib/corpus-sections.mjs';

export const ACTIVE_CORPUS_SECTIONS = configureCorpusActiveSections();
