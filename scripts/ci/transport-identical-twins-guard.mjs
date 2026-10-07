#!/usr/bin/env node
/**
 * Guard del trasporto: una PR invariata resta in volo; una PR il cui snapshot
 * del sito e' superato viene commentata/chiusa, cosi' il giro puo' aprirne una
 * nuova senza accumulare due trasporti sugli stessi gemelli.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { sha256, siteFile } from './loop-drift-check.mjs';
import { parseConvergedBullets, parseTransportBullets } from './transport-realign-body.mjs';
import { transportPrDisposition } from './transport-identical-twins.mjs';
import { isIdenticalTwinTransportPr } from './lib/transport-pr.mjs';

const repo = process.env.REPO || process.env.GITHUB_REPOSITORY || '';
const siteRepo = process.env.SITE_REPO || 'valerielinc-ops/frontaliere-si-o-no';
const manifestPath = process.env.MANIFEST_PATH || 'scripts/ci/loop-sync-manifest.json';

function gh(args, { json = true } = {}) {
  const output = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return json ? JSON.parse(output) : output;
}
function pullRequestFiles(number) {
  const raw = gh(['api', 'repos/' + repo + '/pulls/' + number + '/files', '--paginate', '--jq', '.[].filename'], { json: false });
  return String(raw || '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function openTransportPrs(manifest) {
  const pages = gh(['api', '--paginate', '--slurp', `repos/${repo}/pulls?state=open&per_page=100`]);
  const candidates = (Array.isArray(pages) ? pages.flat() : [])
    .filter((pr) => pr?.head?.repo?.full_name === repo)
    .filter((pr) => /^transport\/identical-twins-\d+$/u.test(String(pr?.head?.ref || '')));
  return candidates
    .map((pr) => {
      const files = pullRequestFiles(pr.number);
      const disposition = isIdenticalTwinTransportPr({
        pr,
        repository: repo,
        files,
        filesComplete: true,
        manifest,
        allowManifestOnly: true,
      });
      return disposition.transport ? { ...pr, transportDisposition: disposition } : null;
    })
    .filter(Boolean);
}

function sitePathFor(manifest, corpusPath) {
  const entry = (manifest.files || []).find((candidate) => candidate?.path === corpusPath);
  if (!entry || entry.mode !== 'identical') throw new Error(`PR trasporto cita un path non identical: ${corpusPath}`);
  return entry.sitePath || entry.path;
}

/**
 * Registra una sola attestazione per path. Duplicati identici sono innocui;
 * hash diversi sono ambigui e devono fermare il guard prima che un
 * `Object.fromEntries` ne nasconda uno.
 */
export function registeredTransportHashes(bullets) {
  const registered = new Map();
  for (const bullet of bullets || []) {
    const previous = registered.get(bullet.path);
    if (previous !== undefined && previous !== bullet.siteHash) {
      throw new Error(`attestazioni in conflitto per ${bullet.path}: ${previous} e ${bullet.siteHash}`);
    }
    registered.set(bullet.path, bullet.siteHash);
  }
  return Object.fromEntries(registered);
}

async function inspectPr(pr, manifest) {
  const body = pr.body || '';
  // Le righe `both-moved-converged` non appartengono al realign post-merge:
  // riattestano solo la baseline. Prima di questo parser dedicato il guard le
  // ignorava, quindi una PR solo-manifest restava `wait` anche se il sito
  // avanzava dopo l'apertura.
  const bullets = [...parseTransportBullets(body), ...parseConvergedBullets(body)];
  const registered = registeredTransportHashes(bullets);
  const current = {};
  for (const corpusPath of Object.keys(registered)) {
    const bytes = await siteFile(sitePathFor(manifest, corpusPath));
    if (bytes === null) return { pr, state: 'unknown', changed: [], reason: `il sito non espone più ${corpusPath}` };
    current[corpusPath] = sha256(bytes);
  }
  return { pr, ...transportPrDisposition({ openPr: true, registeredHashes: registered, currentHashes: current }) };
}

async function main() {
  if (!repo) throw new Error('REPO obbligatorio');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const prs = openTransportPrs(manifest);
  const inspected = [];
  for (const pr of prs) inspected.push(await inspectPr(pr, manifest));
  if (inspected.some((item) => item.state === 'unknown')) {
    throw new Error(inspected.filter((item) => item.state === 'unknown').map((item) => item.reason).join('; '));
  }
  const superseded = inspected.filter((item) => item.state === 'superseded');
  for (const item of superseded) {
    const changed = item.changed.map((rel) => `\`${rel}\``).join(', ');
    const comment = `♻️ **PR di trasporto superata**: lo snapshot sha256 del sito registrato in questa PR è cambiato per ${changed}. La chiudo senza force-push; il prossimo giro aprirà un trasporto nuovo sullo stato corrente.`;
    gh(['pr', 'close', String(item.pr.number), '--repo', repo, '--comment', comment], { json: false });
  }
  const waiting = inspected.filter((item) => item.state === 'wait');
  process.stdout.write(`${JSON.stringify({
    open: prs.length,
    superseded: superseded.map((item) => ({ number: item.pr.number, changed: item.changed })),
    waiting: waiting.map((item) => item.pr.number),
    openTransports: waiting.length,
  })}\n`);
}

if (process.argv[1] && process.argv[1].endsWith('transport-identical-twins-guard.mjs')) {
  main().catch((error) => {
    console.error(`transport-identical-twins-guard: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
