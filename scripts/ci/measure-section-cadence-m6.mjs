#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildM6RuntimeLogCoverage,
  collectM6Supplement,
  makeDateWindow,
} from './measure-section-cadence.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_REPO_ROOT = fs.realpathSync(REPO_ROOT);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!['--to', '--generation-report', '--output'].includes(flag)) {
      throw new Error(`Opzione sconosciuta: ${flag}`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} richiede un valore`);
    args[flag.slice(2)] = value;
    i += 1;
  }
  if (!args.to || !args['generation-report'] || !args.output) {
    throw new Error('Uso: node scripts/ci/measure-section-cadence-m6.mjs --to YYYY-MM-DD --generation-report file.json --output file.json');
  }
  makeDateWindow(args.to, args.to);
  return args;
}

function resolveRepoFile(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim() || path.isAbsolute(relativePath)) {
    throw new Error('i file di input/output devono essere percorsi relativi nel repository');
  }
  const absolutePath = path.resolve(REPO_ROOT, relativePath);
  if (!absolutePath.startsWith(`${REPO_ROOT}${path.sep}`)) {
    throw new Error('i file di input/output devono restare nel repository');
  }
  let cursor = REPO_ROOT;
  for (const segment of path.relative(REPO_ROOT, absolutePath).split(path.sep)) {
    if (!segment || segment === '.') continue;
    cursor = path.join(cursor, segment);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) {
        throw new Error('i file di input/output non possono attraversare symlink');
      }
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  let existingAncestor = absolutePath;
  while (!fs.existsSync(existingAncestor)) existingAncestor = path.dirname(existingAncestor);
  const realAncestor = fs.realpathSync(existingAncestor);
  if (realAncestor !== REAL_REPO_ROOT && !realAncestor.startsWith(`${REAL_REPO_ROOT}${path.sep}`)) {
    throw new Error('i file di input/output devono risolversi dentro il repository');
  }
  return absolutePath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const reportPath = resolveRepoFile(args['generation-report']);
  const outputPath = resolveRepoFile(args.output);
  if (!fs.statSync(reportPath).isFile()) throw new Error('generation report deve essere un file regolare');
  const generation = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const evidence = generation.generationEvidence || generation;
  const snapshot = generation.m6InputSnapshot;
  if (generation.timeZone !== 'Europe/Zurich'
    || generation.window?.toDateInclusive !== args.to
    || !snapshot
    || generation.source?.manifestCommit !== snapshot.manifestCommit
    || generation.source?.m6InputSnapshotChecksum !== snapshot.checksum
    || !evidence.llmRequestMarkers?.dedupEvidenceBySection) {
    throw new Error('generation report non corrisponde alla finestra Zurich, al manifest/snapshot o manca di dedup runtime evidence');
  }
  const runtimeLogCoverageBySection = buildM6RuntimeLogCoverage(generation);
  const { source, metric } = await collectM6Supplement(args.to, {
    candidateSnapshot: snapshot,
    runtimeDedupEvidenceBySection: evidence.llmRequestMarkers.dedupEvidenceBySection,
    runtimeLogCoverageBySection,
  });
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    window: generation.window,
    inputReport: path.relative(REPO_ROOT, reportPath),
    source,
    runtimeLogCoverageBySection,
    metric,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  resolveRepoFile(args.output);
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({
    output: path.relative(REPO_ROOT, outputPath),
    available: metric.available,
    productionGateMeasured: metric.productionGateMeasured,
    nearDuplicatePairCount: metric.nearDuplicatePairCount,
    policyThresholdProxyPairCount: metric.policyThresholdProxyPairCount,
    runtimeUnmeasuredSections: metric.productionGateUnmeasuredSections,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`measure-section-cadence-m6: ${error.message}`);
    process.exitCode = 1;
  });
}
