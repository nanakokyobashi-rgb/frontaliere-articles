#!/usr/bin/env -S npx -y tsx
/**
 * Every field the engine's SiteShellContract declares must actually arrive from
 * this repo's host/ bootstrap.
 *
 * `engine/` is mirrored down from valerielinc-ops/frontaliere-si-o-no, where it
 * is the source of truth; `host/` is ours and supplies the shell the engine
 * reads through `getSiteShell()`. Those two move in lockstep, and nothing was
 * checking that they still fit: when the site's #5147 added
 * `repairSerpSnippet` to the contract, mirroring the engine without the host
 * half produced
 *
 *     TypeError: repairSerpSnippet is not a function
 *
 * at article-render time — while `node --test generator/tests/*.test.mjs`
 * reported 40/40 and `test:parity` reported 8/8 byte-identical. Both suites
 * read the engine as TEXT (node --test cannot import TypeScript), so neither
 * can observe a shell that is missing a member, and the parity golden compares
 * probe modules that never touch the contract.
 *
 * A green CI in front of a renderer that throws is the exact failure shape this
 * migration keeps producing, so this check is deliberately RUNTIME: it boots the
 * real bootstrap and inspects the real object, rather than asserting that some
 * source file mentions a name.
 *
 * Runs under tsx because both sides are TypeScript. `--check` for symmetry with
 * the other reachability gates in generator-ci.yml.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Member names declared directly on `interface SiteShellContract`.
 *
 * Brace-depth aware rather than line-shaped: contract members include
 * multi-line function signatures and object types, and a naive per-line regex
 * would also collect the identifiers nested inside them — inflating the
 * expected set with names the bootstrap is not supposed to provide, which
 * fails closed but for the wrong reason and trains people to ignore it.
 */
function contractMembers(src) {
  const start = src.indexOf('export interface SiteShellContract');
  if (start === -1) throw new Error('SiteShellContract not found in engine/siteShell.ts');
  const open = src.indexOf('{', start);

  // Strip block and line comments so prose (which contains braces and colons)
  // cannot shift the depth counter or masquerade as a member.
  //
  // Parentheses are tracked as well as braces, and that is not incidental: a
  // member like
  //     buildTitleWithBrand: (headline: string, brand?: string) => string;
  // spans lines, and its PARAMETERS sit at brace depth 1. Counting braces alone
  // collected `headline`/`brand` as contract members — four phantom names, so
  // the check failed on a correctly-wired host. A gate that is red when
  // everything is fine gets muted, which is worse than not having it.
  let body = '';
  let depth = 0;
  let paren = 0;
  for (let i = open; i < src.length; i++) {
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (src.startsWith('//', i)) {
      const end = src.indexOf('\n', i);
      i = end === -1 ? src.length : end;
      body += '\n';
      continue;
    }
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    } else if (ch === '(') paren++;
    else if (ch === ')') paren--;

    // Keep only what sits directly on the interface: brace depth 1, outside
    // any parameter list.
    const top = depth === 1 && paren === 0 && ch !== ')' && ch !== '(';
    body += top ? ch : ch === '\n' ? '\n' : ' ';
  }

  const names = new Set();
  for (const m of body.matchAll(/(?:^|[;\n])\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/g)) {
    names.add(m[1]);
  }
  return [...names];
}

const siteShellSrc = fs.readFileSync(path.join(ROOT, 'engine', 'siteShell.ts'), 'utf-8');
const declared = contractMembers(siteShellSrc);

if (declared.length < 20) {
  console.error(
    `::error::parsed only ${declared.length} SiteShellContract member(s) — the parser is broken, ` +
      'not the contract. A check that expects nothing passes for free.',
  );
  process.exit(1);
}

// Same ordering publish-article-fast.mjs uses: ASSET_CDN before the bootstrap,
// because host/constants.ts derives CDN_PRECONNECT_HINT at module-evaluation
// time and a later assignment is a no-op.
process.env.ASSET_CDN ||= 'https://cdn.frontaliereticino.ch';

await import(path.join(ROOT, 'host', 'siteShellBootstrap.ts'));
const { getSiteShell } = await import(path.join(ROOT, 'engine', 'siteShell.ts'));
const shell = getSiteShell();

const missing = declared.filter((k) => !(k in shell) || shell[k] === undefined);

console.log(`[shell-contract] ${declared.length} declared member(s), ${missing.length} missing`);

if (missing.length) {
  console.error(
    '::error::host/siteShellBootstrap.ts does not satisfy engine/siteShell.ts. ' +
      'The engine is mirrored from the site and grew a contract member that this ' +
      "repo's host tree does not supply; article rendering will throw at the first " +
      'call site. Missing: ' +
      missing.join(', '),
  );
  process.exit(1);
}

console.log('[shell-contract] host/ satisfies the mirrored engine contract');
