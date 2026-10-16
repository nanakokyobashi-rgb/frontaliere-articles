#!/usr/bin/env node
/**
 * Migrate `data/topic-candidates-evergreen-rejected.json` to ledger schema v2.
 *
 * The old file had no section, pool or pool-epoch provenance. This command is
 * deliberately dry-run by default. It preserves every old ban/strike as a
 * `legacy` record with the explicit `preflight-required` rule; the generator
 * revalidates it against the current pool before writing fresh provenance.
 * A malformed input or any would-be dropped entry aborts without writing.
 *
 * Usage:
 *   node generator/scripts/migrate-evergreen-rejected-ledger.mjs
 *   node generator/scripts/migrate-evergreen-rejected-ledger.mjs --apply
 */
import fs, { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EVERGREEN_REJECTED_PATH,
  migrateEvergreenRejectedTracker,
  persistEvergreenRejectedTrackerAtomically,
} from './lib/article-topic-selector.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = path.resolve(PROJECT_ROOT, EVERGREEN_REJECTED_PATH);

export function migrateLedgerDocument(raw, opts = {}) {
  return migrateEvergreenRejectedTracker(raw, opts);
}

function readLedger(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { error: `lettura/parsing fallito: ${error.message}` };
  }
}

function main(argv) {
  const apply = argv.includes('--apply');
  const unexpected = argv.filter((arg) => arg !== '--apply');
  if (unexpected.length > 0) {
    console.error(`argomenti non riconosciuti: ${unexpected.join(', ')}`);
    return 2;
  }

  const raw = readLedger(LEDGER);
  if (raw?.error) {
    console.error(`❌ ${raw.error}`);
    return 1;
  }
  const result = migrateLedgerDocument(raw);
  if (!result.ok) {
    console.error(`❌ migrazione rifiutata (fail-closed): ${result.error}`);
    if (result.dropped?.length) console.error(`   record non conservabili: ${result.dropped.length}`);
    return 1;
  }

  const report = result.report;
  console.log(`ledger: ${path.relative(PROJECT_ROOT, LEDGER)}`);
  console.log(`schema: ${raw.schemaVersion ?? 'legacy'} → ${result.tracker.schemaVersion}`);
  console.log(`ban con provenienza verificata : ${report.bans}`);
  console.log(`strike con provenienza verificata: ${report.strikes}`);
  console.log(`legacy in attesa di preflight : ${report.legacy}`);
  console.log(`record persi                   : ${report.dropped.length}`);

  if (!apply) {
    console.log('\nDRY-RUN: nessuna scrittura. Rilancia con --apply per applicare lo schema v2.');
    return 0;
  }
  if (!result.migrated) {
    console.log('\nNessuna migrazione necessaria: il ledger v2 è già valido.');
    return 0;
  }
  try {
    persistEvergreenRejectedTrackerAtomically((current) => current, { path: LEDGER });
  } catch {
    console.error('\n❌ scrittura del ledger fallita');
    return 1;
  }
  console.log(`\n✅ scritto ${path.relative(PROJECT_ROOT, LEDGER)}`);
  return 0;
}

const invokedDirectly = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || '');
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exit(main(process.argv.slice(2)));

