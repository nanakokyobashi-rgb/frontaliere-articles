/**
 * Extract the binding document sections needed by the corpus redflag fixer.
 *
 * The workflow runs this before Codex and fails closed: a renamed, duplicated,
 * empty, or truncated heading must stop the fixer instead of producing a
 * prompt that silently lost the repository contract.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const REQUIRED_SECTIONS = Object.freeze([
  { file: 'REVIEW.md', heading: '## Scopo progetto = filtro "important"' },
  { file: 'REVIEW.md', heading: '## Severity' },
  { file: 'AGENTS.md', heading: '## Non-negoziabili' },
  { file: 'AGENTS.md', heading: '## Credenziali' },
]);

// This exact marker is written by pr-redflag-fixer.yml to $GITHUB_OUTPUT. A
// literal line equal to it would terminate the heredoc early and corrupt the
// step output passed to the action prompt.
export const REDFLAG_DOC_SECTIONS_EOF = 'REDFLAG_DOC_SECTIONS_EOF';

// The value is interpolated into the action prompt from the ctx step output.
// Keep a bounded, UTF-8 byte-sized budget so document growth fails closed
// before the runner or action silently truncates the contract.
export const REDFLAG_DOC_SECTIONS_MAX_BYTES = 16_384;

function normalizeMarkdownHeading(line) {
  return line.replace(/^[ \t]{0,3}/, '').replace(/[ \t]+$/, '');
}

function headingLevel(line) {
  const match = normalizeMarkdownHeading(line).match(/^(#{1,6})[ \t]+/);
  return match ? match[1].length : null;
}

function fenceMarker(line) {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  return { character: match[1][0], length: match[1].length, suffix: match[2] };
}

function closesFence(line, opening) {
  const marker = fenceMarker(line);
  return marker
    && marker.character === opening.character
    && marker.length >= opening.length
    && /^[ \t]*$/.test(marker.suffix);
}

/**
 * Extract a Markdown section by its exact heading, stopping at the next
 * heading of the same or a higher level. Headings inside fenced code are
 * ignored.
 *
 * @param {string} markdown
 * @param {string} heading exact heading, including its # prefix
 * @returns {string} section body without the heading
 */
export function extractSectionByHeading(markdown, heading) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const target = String(heading).trim();
  let fence = null;
  const matches = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (fence) {
      if (closesFence(lines[index], fence)) fence = null;
      continue;
    }
    const marker = fenceMarker(lines[index]);
    if (marker) {
      fence = marker;
      continue;
    }
    if (normalizeMarkdownHeading(lines[index]) === target) matches.push(index);
  }

  if (fence) {
    throw new Error(`Unclosed fenced code block while locating required heading: ${target}`);
  }
  if (matches.length === 0) {
    throw new Error(`Required heading not found: ${target}`);
  }
  if (matches.length > 1) {
    throw new Error(`Required heading is ambiguous (${matches.length} matches): ${target}`);
  }

  const start = matches[0];
  const targetLevel = headingLevel(lines[start]);
  fence = null;
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (fence) {
      body.push(lines[index]);
      if (closesFence(lines[index], fence)) fence = null;
      continue;
    }
    const marker = fenceMarker(lines[index]);
    if (marker) {
      fence = marker;
      body.push(lines[index]);
      continue;
    }
    const level = headingLevel(lines[index]);
    if (level !== null && level <= targetLevel) break;
    body.push(lines[index]);
  }

  if (fence) {
    throw new Error(`Unclosed fenced code block in required section: ${target}`);
  }
  const content = body.join('\n').trim();
  if (!content) {
    throw new Error(`Required heading has no content: ${target}`);
  }
  return content;
}

function buildDocumentSections(requiredSections, title, { read } = {}) {
  const reader = read ?? ((file) => readFileSync(resolve(process.env.REDFLAG_DOC_ROOT ?? '.', file), 'utf8'));
  const chunks = requiredSections.map(({ file, heading }) => {
    const content = extractSectionByHeading(reader(file), heading);
    const sectionTitle = heading.replace(/^#{1,6}[ \t]+/, '');
    return [`## ${file} — ${sectionTitle}`, content].join('\n\n');
  });
  return [title, ...chunks].join('\n\n') + '\n';
}

/**
 * Validate the exact value that pr-redflag-fixer.yml writes to $GITHUB_ENV.
 *
 * @param {string} document
 * @returns {string}
 */
export function validateRedflagDocumentSections(document) {
  const value = String(document);
  const hasDelimiterLine = value.split(/\r?\n/).some(
    (line) => line === REDFLAG_DOC_SECTIONS_EOF,
  );
  if (hasDelimiterLine) {
    throw new Error(
      `Redflag document contains a line equal to the heredoc delimiter ${REDFLAG_DOC_SECTIONS_EOF}`,
    );
  }

  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > REDFLAG_DOC_SECTIONS_MAX_BYTES) {
    throw new Error(
      `Redflag document too large for GITHUB_OUTPUT: ${bytes} bytes > ${REDFLAG_DOC_SECTIONS_MAX_BYTES}-byte limit`,
    );
  }
  return value;
}

export function buildRedflagDocumentSections({ read } = {}) {
  return validateRedflagDocumentSections(
    buildDocumentSections(REQUIRED_SECTIONS, '# Redflag-fix: sezioni documentali vincolanti', { read }),
  );
}

const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  try {
    process.stdout.write(buildRedflagDocumentSections());
  } catch (error) {
    console.error(`redflag-doc-sections: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
