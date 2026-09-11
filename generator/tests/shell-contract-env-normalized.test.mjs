/**
 * Il fingerprint del contratto non deve dipendere dall'ambiente. Run with `node --test`.
 *
 * IL DIFETTO (follow-up di #764, issue #788). `host/shell-contract-fingerprint.json`
 * registra lo SHA-256 dei 22 scalari di `SiteShellContract`, e uno di quei
 * scalari — `cdnPreconnectHint` — `host/constants.ts` lo deriva da
 * `process.env.ASSET_CDN` in una IIFE valutata al primo import. Il digest
 * risultava quindi funzione della sorgente E dell'ambiente del runner:
 * esportare `ASSET_CDN` faceva sparare «host chrome drifted from the main
 * repo», cioè una diagnosi FALSA su un gate cross-repo. La variabile non è
 * esotica in questo repo: `scripts/publish-article-fast.mjs` la imposta di
 * proposito prima di caricare lo stesso bootstrap.
 *
 * PERCHÉ UN TEST QUI E NON SOLO LA FIX. La fix è una riga al top dei due file di
 * `host/tests/`, e una riga al top di un file di test è esattamente ciò che una
 * riorganizzazione degli import sposta in buona fede sotto il primo `import` del
 * bootstrap — dove è un no-op silenzioso (la valutazione del modulo è cachata
 * per processo). Questo test difende l'ORDINE e la COMPLETEZZA della lista, e
 * gira offline su testo sorgente.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeOpaqueRead, scanEnvReads, stripCommentLines } from './lib/env-reads.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOST_TESTS = path.join(ROOT, 'host/tests');

/** I file di `host/tests/` che valutano il bootstrap e pinnano una baseline. */
const PINNING_TESTS = ['shell-contract-fingerprint.test.mjs', 'shell-contract-functions.test.mjs'];

/**
 * Le variabili lette da `host/` che NON raggiungono la superficie pinnata, con
 * la verifica scritta. Sta qui e non nel modulo sorvegliato per la stessa
 * ragione di `REQUIRED_ROOTS` in loop-sync-manifest-scope.test.mjs: una lista
 * di eccezioni che vive nel dato che sorveglia si allunga senza review.
 */
const NOT_REACHING_CONTRACT = {
  WRITE_COLLISION_MODE:
    'host/sharedWriteRegistry.ts: letta per chiamata in currentMode(), e la probe pinna ' +
    'solo la forma di WriteCollector (typeof add/flush, skippedByHash iniziale).',
  BUILD_LOCALE: 'host/shared/localeEmitFilter.ts: non raggiunta da nessun membro del contratto.',
  FIREBASE_API_KEY:
    'host/firebaseAuthPersistence.ts: getFirebaseApiKey() è usata solo dai consumer runtime; ' +
    'host/constants.ts importa esclusivamente FIREBASE_AUTH_SESSION_MARKER_KEY, quindi la ' +
    'lettura non viene valutata dalla superficie pinnata.',
  VITE_FIREBASE_API_KEY:
    'host/firebaseAuthPersistence.ts: getFirebaseApiKey() è usata solo dai consumer runtime; ' +
    'host/constants.ts importa esclusivamente FIREBASE_AUTH_SESSION_MARKER_KEY, quindi la ' +
    'lettura non viene valutata dalla superficie pinnata.',
};

test('ogni test che pinna il contratto normalizza l\'ambiente PRIMA di importare il bootstrap', () => {
  for (const name of PINNING_TESTS) {
    const src = fs.readFileSync(path.join(HOST_TESTS, name), 'utf-8');
    const callAt = src.indexOf('normalizeContractEnv()');
    assert.ok(
      callAt > 0,
      `${name} non chiama normalizeContractEnv(): il digest/la golden tornano a dipendere da ` +
        'process.env.ASSET_CDN e il gate cross-repo accusa l\'altro repo di un drift inesistente (#788).',
    );
    // Il primo import del bootstrap, in QUALUNQUE forma (statica o dinamica),
    // deve venire dopo: dopo di lui il delete non ha più effetto. Cerca
    // l'ESPRESSIONE di import, non il nome: entrambi i file nominano il
    // bootstrap in prosa nell'intestazione, molto prima di importarlo.
    const importAt = src.search(/(?:import\s*\(|from)\s*['"][^'"]*siteShellBootstrap/);
    assert.ok(importAt > 0, `${name} non importa il bootstrap: il test non pinna più niente?`);
    assert.ok(
      callAt < importAt,
      `${name}: normalizeContractEnv() è chiamata DOPO il primo riferimento al bootstrap. ` +
        'La valutazione del modulo è cachata per processo, quindi lì il delete è un no-op ' +
        'silenzioso — il gate sembra normalizzato e non lo è.',
    );
  }
});

test('CONTRACT_ENV_KEYS copre ogni process.env letta da host/', async () => {
  const { CONTRACT_ENV_KEYS } = await import('../../host/tests/shell-contract-env.mjs');
  const declared = new Set([...CONTRACT_ENV_KEYS, ...Object.keys(NOT_REACHING_CONTRACT)]);

  const read = new Set();
  const opache = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'tests') continue; // i test possono leggere l'ambiente che vogliono
        walk(fp);
      } else if (/\.(ts|mjs)$/.test(e.name)) {
        // Il gemello di #1046: cercare le sole letture `process.env.NOME` (piu'
        // l'indicizzazione con letterale) lascia fuori la destrutturazione e
        // l'alias dell'intero oggetto, e TACE sulla chiave dinamica. Qui la
        // conseguenza e' la stessa di la': una variabile non classificata che
        // il digest del contratto legge comunque.
        const { names, opaque } = scanEnvReads(stripCommentLines(fs.readFileSync(fp, 'utf-8')));
        for (const n of names) if (/^[A-Z0-9_]+$/.test(n)) read.add(n);
        for (const o of opaque) opache.push(`${path.relative(ROOT, fp)}:${describeOpaqueRead(o)}`);
      }
    }
  };
  walk(path.join(ROOT, 'host'));

  assert.deepEqual(
    opache,
    [],
    `${opache.length} lettura/e di process.env sotto host/ non sono risolvibili leggendo il sorgente, ` +
      'quindi CONTRACT_ENV_KEYS non puo\' essere dimostrata completa:\n  ' +
      `${opache.join('\n  ')}\n` +
      'Rendi la chiave letterale, oppure annota la riga con `// env-scan: <motivo>` (#1046).',
  );

  const undeclared = [...read].filter((k) => !declared.has(k)).sort();
  assert.deepEqual(
    undeclared,
    [],
    `${undeclared.length} variabile/i d'ambiente lette da host/ non sono classificate:\n  ` +
      `${undeclared.join('\n  ')}\n` +
      'Ognuna va decisa: se raggiunge un valore del contratto va aggiunta a CONTRACT_ENV_KEYS ' +
      '(host/tests/shell-contract-env.mjs), altrimenti a NOT_REACHING_CONTRACT in questo file, ' +
      'con la verifica scritta. Una variabile non classificata è un digest che dipende ' +
      'dall\'ambiente senza che nessuno lo sappia (#788).',
  );
});
