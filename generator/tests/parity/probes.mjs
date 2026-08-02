/**
 * Deterministic probes for the main↔nanako generator parity check
 * (issue #4974 item 3, §5.4 of the migration doc: "comparing its emitted
 * body/meta/SEO files byte-for-byte against what main's current generator would
 * have produced for the same synthetic input").
 *
 * WHAT THIS COVERS, AND WHAT IT CANNOT
 *
 * A full `create-article.mjs` run is not reproducible by construction: it calls
 * LLMs, fetches live RSS, and stamps `new Date()` into everything it writes.
 * Two runs of MAIN against itself would not be byte-identical, so diffing a
 * whole run against nanako's would prove nothing.
 *
 * What IS byte-comparable is the deterministic layer underneath: the pure text
 * transforms that turn a model's output into the strings that land in the
 * corpus. Those are the functions the transport could plausibly have broken —
 * a lost dependency, a changed default argument, a module that silently
 * resolved to a different file. Every probe below is a pure function of its
 * inputs, so main and nanako must agree exactly, and any disagreement is a real
 * transport defect rather than clock noise.
 *
 * Each probe names a module by its path RELATIVE TO THE GENERATOR SCRIPTS ROOT,
 * which is `scripts/` in main and `generator/scripts/` here. That is what lets
 * one file drive both trees.
 *
 * Inputs are chosen to be nasty on purpose: accented Italian, HTML entities,
 * competitor names, near-duplicate slugs, sparse history with null cells.
 */

/** @type {{module: string, calls: Array<{fn: string, args: unknown[]}>}[]} */
export const PROBES = [
  {
    module: 'lib/fnv1a.mjs',
    calls: [
      { fn: 'fnv1a32', args: [''] },
      { fn: 'fnv1a32', args: ['frontaliere-ticino'] },
      { fn: 'fnv1a32', args: ['città-öäü-À'] },
      { fn: 'fnv1a32Mod', args: ['nuovo-accordo-fiscale-2026', 97] },
      { fn: 'fnv1a32Mod', args: ['', 7] },
    ],
  },
  {
    module: 'lib/slug-truncate.mjs',
    calls: [
      { fn: 'truncateSlugAtWordBoundary', args: ['nuovo-accordo-fiscale-frontalieri-2026', 20] },
      { fn: 'truncateSlugAtWordBoundary', args: ['breve', 60] },
      { fn: 'truncateSlugAtWordBoundary', args: ['a-b-c-d-e-f-g-h-i-j-k', 5] },
      { fn: 'truncateSlugAtWordBoundary', args: ['senzaseparatori', 6] },
    ],
  },
  {
    module: 'lib/decode-html-entities.mjs',
    calls: [
      { fn: 'decodeHtmlEntities', args: ['Imposta &amp; tassa &lt;fonte&gt;'] },
      { fn: 'decodeHtmlEntities', args: ['&quot;citt&agrave;&quot; &#8217;'] },
      { fn: 'decodeHtmlEntities', args: ['nessuna entita'] },
      { fn: 'decodeHtmlEntities', args: ['&amp;amp;'] },
    ],
  },
  {
    module: 'lib/detect-language.mjs',
    calls: [
      { fn: 'detectLanguage', args: ['Il frontaliere paga l’imposta alla fonte in Svizzera.'] },
      { fn: 'detectLanguage', args: ['The cross-border worker pays withholding tax in Switzerland.'] },
      { fn: 'detectLanguage', args: ['Der Grenzgänger zahlt die Quellensteuer in der Schweiz.'] },
      { fn: 'detectLanguage', args: ['Le frontalier paie l’impôt à la source en Suisse.'] },
      { fn: 'isSameLanguage', args: ['Ciao a tutti quanti oggi', 'Buongiorno a tutti quanti', 'it'] },
    ],
  },
  {
    module: 'lib/it-text-similarity.mjs',
    calls: [
      { fn: 'stemIt', args: ['pensioni'] },
      { fn: 'stemIt', args: ['lavoratore'] },
      { fn: 'normalizeItWord', args: ['Città'] },
      { fn: 'tokenizeIt', args: ['Le nuove regole sulla tassa della salute per i frontalieri'] },
      {
        fn: 'jaccardSim',
        args: ['tassa salute frontalieri ticino', 'nuova tassa salute per frontalieri'],
      },
      { fn: 'containmentSim', args: ['avs pensione', 'la pensione avs cambia nel 2026'] },
    ],
  },
  {
    module: 'lib/haversine.mjs',
    calls: [
      { fn: 'haversineKm', args: [45.8399, 8.9525, 46.0037, 8.9511] },
      { fn: 'haversineKm', args: [0, 0, 0, 0] },
    ],
  },
  {
    module: 'lib/border-wait-ranking.mjs',
    calls: [
      { fn: 'windowFileNames', args: ['2026-07-15'] },
      { fn: 'windowFileNames', args: ['2026-01-03', 5] },
      { fn: 'computeWeekWindow', args: ['2026-07-15'] },
      // Leap-day and year boundary: the ISO arithmetic is the part most likely
      // to differ if a transported copy drifted.
      { fn: 'computeWeekWindow', args: ['2028-03-01'] },
      // The REWIRE path (#4974 item 3): with the ranking article generated in
      // nanako from main's published aggregate rather than from the 1.7 GB
      // history, these two ARE the article's numbers. Both sides must agree
      // exactly or the published ranking silently diverges from the telemetry
      // it claims to summarise.
      {
        fn: 'rankingFromStats',
        args: [
          {
            'chiasso-strada': { weightedAvgMinutes: 5.0555, totalSamples: 36 },
            gaggiolo: { weightedAvgMinutes: 0.6842, totalSamples: 38 },
            // Under the 20-sample floor: must be dropped, not ranked last.
            'ponte-tresa': { weightedAvgMinutes: 0.1, totalSamples: 3 },
          },
        ],
      },
      { fn: 'rankingFromStats', args: [{}] },
      {
        fn: 'trendFromStats',
        args: [
          {
            'chiasso-strada': { weightedAvgMinutes: 6, totalSamples: 36 },
            gaggiolo: { weightedAvgMinutes: 1, totalSamples: 38 },
            // Present now, absent in the previous window — no trend possible.
            brogeda: { weightedAvgMinutes: 3, totalSamples: 40 },
          },
          {
            'chiasso-strada': { weightedAvgMinutes: 4, totalSamples: 30 },
            // Delta 0.4 → below the 0.5 threshold, must read 'flat'.
            gaggiolo: { weightedAvgMinutes: 0.6, totalSamples: 25 },
          },
        ],
      },
    ],
  },
];

/**
 * Probes whose module reads the filesystem, so they run against a synthetic
 * tree the runner materialises rather than against literal arguments.
 */
export const HISTORY_FIXTURE = {
  '2026-07-08.json': {
    date: '2026-07-08',
    perCrossing: {
      'chiasso-strada': [
        null,
        { min: 1, avg: 4.5, max: 9, samples: 12 },
        null,
        { min: 0, avg: 2, max: 3, samples: 4 },
      ],
      gaggiolo: [{ min: 0, avg: 1.25, max: 2, samples: 8 }],
      // A crossing whose cells are all unusable — must not reach the ranking.
      'ponte-tresa': [null, { min: 0, max: 1 }, { avg: 'x', samples: 3 }],
    },
  },
  '2026-07-09.json': {
    date: '2026-07-09',
    perCrossing: {
      'chiasso-strada': [{ min: 2, avg: 6, max: 14, samples: 20 }],
      gaggiolo: [{ min: 0, avg: 0.5, max: 1, samples: 30 }],
    },
  },
  // Deliberately malformed: the aggregator must skip it, not throw.
  '2026-07-10.json': { date: '2026-07-10', perCrossing: null },
};

/** Calls made against the materialised history fixture, with a frozen "today". */
export const HISTORY_PROBES = [
  { fn: 'aggregateCrossingStats', args: ['2026-07-11', 3] },
  { fn: 'aggregateCrossingStats', args: ['2026-07-11', 7] },
];
