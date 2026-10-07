/**
 * `seo-http-downgrade.test.mjs` — i link HTTP rilevati dall'audit SEO non
 * devono rientrare nei body pubblicati.
 *
 * Il report #6 ha trovato gli stessi cinque target in più localizzazioni:
 * erano riferimenti generati nel corpus e non codice del renderer. Il gate
 * legge entrambe le radici dei body e impedisce che una nuova traduzione o un
 * nuovo sync ripristini l'URL insicuro dopo la correzione.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BODY_ROOTS = ['blog-body', 'blog-body-ch'];
const MIN_BODY_FILES = 20_000;

// Target elencati da links/https-downgrade nel report SEO #6. Le occorrenze
// delle versioni tradotte sono controllate insieme: il difetto non deve
// riapparire solo perché il crawler ha visitato una locale diversa.
export const REPORTED_HTTP_TARGETS = Object.freeze([
  'http://www.admin.ch/it/istruzione',
  'http://www.calcolatoristipendio.ch',
  'http://www.comune.lugano.ch',
  'http://www.lavenapontetresa.ch',
  'http://www.minieradessessa.ch',
]);

function collectBodyFiles(root = ROOT) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(absolute);
    }
  };
  for (const bodyRoot of BODY_ROOTS) {
    const absolute = path.join(root, 'content', bodyRoot);
    if (fs.existsSync(absolute)) walk(absolute);
  }
  return files;
}

describe('SEO — nessun downgrade HTTP nei target rilevati', () => {
  it('legge entrambe le radici complete dei body', () => {
    const roots = BODY_ROOTS.map((name) => path.join(ROOT, 'content', name));
    assert.ok(
      roots.every((dir) => fs.existsSync(dir)),
      'content/blog-body{,-ch} assente: il gate passerebbe a vuoto',
    );
    const files = collectBodyFiles();
    assert.ok(
      files.length >= MIN_BODY_FILES,
      `solo ${files.length} body letti: il checkout del corpus è incompleto`,
    );
  });

  it('non contiene i target HTTP segnalati dall audit #6', () => {
    const files = collectBodyFiles();
    assert.ok(
      files.length >= MIN_BODY_FILES,
      `solo ${files.length} body letti: il checkout del corpus è incompleto`,
    );
    const offenders = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const target of REPORTED_HTTP_TARGETS) {
        if (source.includes(target)) offenders.push(`${path.relative(ROOT, file)}: ${target}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `link HTTP rilevato dal report #6 ancora presente:\n${offenders.join('\n')}`,
    );
  });
});
