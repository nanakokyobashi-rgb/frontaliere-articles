/**
 * api-manifest.mjs — dichiarare in `manifest.files` un artefatto scritto DOPO
 * `build-api.mjs`, e rivalidare subito il manifest contro il disco.
 *
 * PERCHE' ESISTE
 * ──────────────
 * `manifest.json` e' il primo file che un consumer legge: `counts` gli permette
 * di rifiutare un set troncato *prima* di usarlo, `files` di rifiutare un
 * singolo payload troncato confrontando i byte dichiarati con quelli ricevuti.
 * Il set troncato e' il caso peggiore proprio perche' non fallisce da solo
 * (AGENTS.md), e il sito non ribuilda quando questo repo pubblica.
 *
 * Ma `manifest.json` viene scritto per ultimo DA `build-api.mjs`, e registra
 * solo cio' che `build-api.mjs` ha scritto. Gli shard
 * `dist/api/data/blog-index-*.json` — cioe' esattamente i file da cui il sito
 * rende le liste (hub, archivio, homepage) — li scrive `build-blog-index.mjs`,
 * in uno step successivo di `publish-api.yml`. Restavano quindi fuori da
 * `files`: difesi solo dai pavimenti del proprio produttore, e senza nessuna
 * rete lato consumer. Una lista troncata o di forma diversa e' precisamente il
 * caso che il sito accetta e mostra, senza errori, con meno articoli di quelli
 * che ci sono.
 *
 * COME
 * ────
 * Il produttore chiama `declareApiArtifacts()` dopo aver scritto i suoi file:
 * il manifest viene riletto dal disco, arricchito, riscritto, e SUBITO
 * rivalidato — tutte le voci, non solo quelle nuove, come fa il gate finale di
 * `build-api.mjs`. La rivalidazione e' dal disco per lo stesso motivo per cui
 * lo e' quella li': un gate che ricontrolla la variabile che ha appena scritto
 * verifica se stesso e non puo' fallire.
 *
 * Le chiavi sono POSIX-relative a `dist/api/` (`data/blog-index-...json`), che
 * e' anche il path servito: la stessa convenzione delle voci top-level, estesa
 * di una cartella.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Byte UTF-8, non code unit UTF-16 — vedi `build-api.mjs` (#905). */
export const byteSize = (text) => Buffer.byteLength(text, 'utf-8');

/**
 * Dichiara `entries` (`{ <path relativo a apiRoot>: byte }`) in
 * `manifest.files`, poi rivalida l'intero manifest contro il disco.
 *
 * Lancia se il manifest non esiste: un produttore che scrive nella superficie
 * pubblicata senza che `build-api.mjs` sia passato pubblicherebbe file che
 * nessun manifest descrive — che e' il buco che questo modulo chiude. Il
 * chiamante che gira legittimamente fuori da `dist/api/` (un `--out` di
 * comodo, un test) deve non chiamarla affatto.
 */
export function declareApiArtifacts(apiRoot, entries) {
  const manifestPath = path.join(apiRoot, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `${manifestPath} not found: cannot declare ${Object.keys(entries).length} artifact(s) written into ` +
        'the published surface — run scripts/build-api.mjs first',
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  if (!manifest.files || typeof manifest.files !== 'object') {
    throw new Error(`${manifestPath} has no \`files\` map — refusing to publish an undescribed surface`);
  }
  for (const [rel, size] of Object.entries(entries)) {
    if (!Number.isInteger(size) || size < 0) {
      throw new Error(`declareApiArtifacts: ${rel} declared as ${size}, which is not a byte count`);
    }
    manifest.files[rel] = size;
  }
  // `manifest.json` non descrive se stesso — ne' prima ne' dopo questa
  // riscrittura — quindi riscriverlo non invalida nessuna voce.
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  const mismatches = [];
  for (const [rel, size] of Object.entries(manifest.files)) {
    const abs = path.join(apiRoot, rel);
    if (!fs.existsSync(abs)) {
      mismatches.push(`${rel}: declared ${size}, missing on disk`);
      continue;
    }
    const actual = fs.statSync(abs).size;
    if (actual !== size) mismatches.push(`${rel}: declared ${size}, on disk ${actual}`);
  }
  if (mismatches.length) {
    throw new Error(`manifest.files does not describe the bytes served:\n  ${mismatches.join('\n  ')}`);
  }
  return Object.keys(manifest.files).length;
}
