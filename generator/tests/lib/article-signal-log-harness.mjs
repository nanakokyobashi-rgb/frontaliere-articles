import { readFileSync } from 'node:fs';

const CREATE_ARTICLE = readFileSync(
  new URL('../../scripts/create-article.mjs', import.meta.url),
  'utf8',
);

function cutFunction(name) {
  const start = CREATE_ARTICLE.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in create-article.mjs`);
  const end = CREATE_ARTICLE.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`function ${name} is not closed in create-article.mjs`);
  return CREATE_ARTICLE.slice(start, end + 2);
}

// Several generator tests execute one extracted function with `new Function`.
// Give those isolated functions the real signal-aware logging helpers and the
// same empty run context they have in their fixtures.
const makeHelpers = new Function(
  'RUN_REPORT',
  [
    'const SIGNAL_TOPIC_TERMS = new Set();',
    cutFunction('isSignalDrivenTopicCandidate'),
    cutFunction('isSignalDrivenRunReport'),
    cutFunction('isSignalDrivenRunSelection'),
    cutFunction('redactSignalDrivenReportNote'),
    cutFunction('safeTopicSelectionLogLabel'),
    cutFunction('safeSignalTextForLog'),
    cutFunction('safeSignalDiagnosticTextForLog'),
    'return { safeTopicSelectionLogLabel, safeSignalTextForLog, safeSignalDiagnosticTextForLog };',
  ].join('\n'),
);

export const ARTICLE_SIGNAL_LOG_HELPERS = makeHelpers({});
