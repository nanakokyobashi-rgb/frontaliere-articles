#!/usr/bin/env node
/**
 * Piccolo helper corpus-only per il push del trasporto dei gemelli.
 *
 * Il preflight dello scope `workflows` e' solo un'indicazione: il push GitHub
 * resta l'autorita' finale. Se GitHub rifiuta esplicitamente un workflow per
 * permessi mancanti, il chiamante puo' togliere dal commit tutti i workflow e
 * lasciare gli altri gemelli nella stessa PR.
 */
import fs from 'node:fs';

const WORKFLOW_PREFIX = '.github/workflows/';
const WORKFLOW_REFUSAL_RE = /refusing to allow a GitHub App to create or update workflow\s+[`'\"]?(\.github\/workflows\/[^\s`'\"]+)[`'\"]?\s+without [`'\"]?workflows[`'\"]?\s+permission/gi;

export function isWorkflowPath(rel) {
  return typeof rel === 'string' && rel.startsWith(WORKFLOW_PREFIX) && rel.length > WORKFLOW_PREFIX.length;
}

function sortedUnique(paths) {
  return [...new Set(paths)].sort();
}

/** Classifica solo il rifiuto GitHub osservato; ogni altro errore resta rosso. */
export function classifyWorkflowPushFailure(output) {
  const rejectedPaths = [];
  for (const match of String(output ?? '').matchAll(WORKFLOW_REFUSAL_RE)) rejectedPaths.push(match[1]);
  const paths = sortedUnique(rejectedPaths);
  return paths.length
    ? { kind: 'workflow-permission', fallback: true, rejectedPaths: paths }
    : { kind: 'other', fallback: false, rejectedPaths: [] };
}

/**
 * Seleziona tutti i workflow presenti nel commit, non solo quello citato dal
 * primo rifiuto: con un token privo di quello scope il push li rifiuterebbe
 * uno alla volta. Un path rifiutato fuori dal commit invalida il fallback.
 */
export function selectWorkflowFallbackPaths(classification, committedPaths) {
  if (!classification?.fallback) return [];

  const commitPaths = sortedUnique(committedPaths);
  const workflowPaths = commitPaths.filter(isWorkflowPath);
  const rejectedPaths = sortedUnique(classification.rejectedPaths || []);
  if (!rejectedPaths.length) throw new Error('rifiuto workflow senza path esplicito');
  if (!workflowPaths.length) throw new Error('rifiuto workflow ma il commit non contiene workflow');

  const missing = rejectedPaths.filter((rel) => !workflowPaths.includes(rel));
  if (missing.length) {
    throw new Error(`path workflow rifiutati assenti dal commit: ${missing.join(', ')}`);
  }
  return workflowPaths;
}

function clone(value) {
  return structuredClone(value);
}

function restoreProperty(target, source, key) {
  if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = clone(source[key]);
  else delete target[key];
}

/** Ripristina solo baseline/couplingSnapshot dei path workflow indicati. */
export function restoreWorkflowSnapshots(currentManifest, previousManifest, paths) {
  const workflowPaths = sortedUnique(paths);
  const invalid = workflowPaths.filter((rel) => !isWorkflowPath(rel));
  if (invalid.length) throw new Error(`fallback non autorizzato per path non workflow: ${invalid.join(', ')}`);

  const current = clone(currentManifest);
  const currentFiles = Array.isArray(current.files) ? current.files : [];
  const previousFiles = Array.isArray(previousManifest?.files) ? previousManifest.files : [];
  for (const rel of workflowPaths) {
    const now = currentFiles.find((entry) => entry.path === rel);
    const old = previousFiles.find((entry) => entry.path === rel);
    if (!now || !old) throw new Error(`manifest senza voce corrente/precedente per ${rel}`);
    restoreProperty(now, old, 'baseline');
    restoreProperty(now, old, 'couplingSnapshot');
  }
  return current;
}

/** Toglie dal report solo i workflow rimossi dal commit e li rende espliciti. */
export function removeWorkflowPathsFromReport(report, paths) {
  const workflowPaths = sortedUnique(paths);
  const invalid = workflowPaths.filter((rel) => !isWorkflowPath(rel));
  if (invalid.length) throw new Error(`report fallback non autorizzato per path non workflow: ${invalid.join(', ')}`);
  const excluded = new Set(report.workflowExcluded || []);
  for (const rel of workflowPaths) excluded.add(rel);
  const excludedSet = new Set(workflowPaths);
  return {
    ...clone(report),
    transported: (report.transported || []).filter((item) => !excludedSet.has(item.path)),
    workflowExcluded: sortedUnique([...excluded]),
  };
}

function requiredArg(name) {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`manca --${name}=...`);
  return value;
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').map((line) => line.replace(/\r$/, '')).filter(Boolean);
}

function writeJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function prepareFallback() {
  const classification = classifyWorkflowPushFailure(fs.readFileSync(requiredArg('push-log'), 'utf8'));
  if (!classification.fallback) {
    console.log(JSON.stringify(classification, null, 2));
    return 2;
  }

  const commitPaths = readLines(requiredArg('commit-paths'));
  const workflowPaths = selectWorkflowFallbackPaths(classification, commitPaths);
  const manifestFile = requiredArg('manifest');
  const previousManifestFile = requiredArg('previous-manifest');
  const reportFile = requiredArg('report');
  const currentManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const previousManifest = JSON.parse(fs.readFileSync(previousManifestFile, 'utf8'));
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const restoredManifest = restoreWorkflowSnapshots(currentManifest, previousManifest, workflowPaths);
  const updatedReport = removeWorkflowPathsFromReport(report, workflowPaths);

  writeJson(manifestFile, restoredManifest);
  writeJson(reportFile, updatedReport);
  console.log(JSON.stringify({ ...classification, excludedPaths: workflowPaths }, null, 2));
  return 0;
}

if (process.argv[1]?.endsWith('transport-identical-twins-push-fallback.mjs')) {
  try {
    process.exit(prepareFallback());
  } catch (error) {
    console.error(`transport-identical-twins-push-fallback fallito: ${error?.stack || error}`);
    process.exit(1);
  }
}
