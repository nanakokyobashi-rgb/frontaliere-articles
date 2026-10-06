import fs from 'node:fs';

/** I mode che `loop-drift-check.mjs` sa trattare. */
export const MANIFEST_ENTRY_MODES = Object.freeze([
  'identical',
  'adapted',
  'corpus-only',
  'corpus-only-pending',
  'not-ported',
]);

const MODE_SET = new Set(MANIFEST_ENTRY_MODES);

/** Una issue APERTA sul sito che traccia un lavoro mancante. */
export const TRACKING_ISSUE_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/;

/** Exit riservato a un manifest che non e' certificabile e non va pushato. */
export const EXIT_INVALID_MANIFEST = 1;

/**
 * Le regole di forma di una voce, condivise dal test di scope e dagli writer.
 * I nomi sono stabili cosi' una guardia puo' stampare la regola precisa che ha
 * rifiutato il candidato.
 */
export function manifestEntryRuleChecks(entry, { actualBlobSha } = {}) {
  const baseline = entry?.baseline || {};
  const mode = entry?.mode;
  const hasExpectedSiteBlob = entry?.expectedSiteBlob !== undefined;
  const expectedSiteBlobMatchesContent = !hasExpectedSiteBlob
    || actualBlobSha === undefined
    || actualBlobSha === entry.expectedSiteBlob;
  const requiresAdaptationIssue = mode === 'adapted' && baseline.site === baseline.corpus;

  return {
    knownMode: MODE_SET.has(mode),
    hasBaseline: Boolean(entry?.baseline),
    hasReason: mode === 'identical' || (entry?.reason || '').trim().length > 0,
    requiresAdaptationIssue,
    adaptationIssueValid: !requiresAdaptationIssue || TRACKING_ISSUE_RE.test(entry?.adaptationIssue || ''),
    sitePathCoherent: entry?.sitePath === undefined || entry.sitePath !== entry.path,
    corpusOnlySitePathCoherent: mode !== 'corpus-only' || entry?.sitePath === undefined,
    corpusOnlySiteBaselineCoherent: mode !== 'corpus-only' || baseline.site === null,
    pendingSiteBaselineCoherent: mode !== 'corpus-only-pending' || baseline.site === null,
    siteBaselineCoherent: mode === 'corpus-only' || mode === 'corpus-only-pending' || Boolean(baseline.site),
    corpusBaselineCoherent: mode === 'not-ported' || baseline.corpus === null || Boolean(baseline.corpus),
    identicalBaselineCoherent: mode !== 'identical' || baseline.site === baseline.corpus,
    expectedSiteBlobModeCoherent: !hasExpectedSiteBlob || mode === 'corpus-only-pending',
    expectedSiteBlobPathCoherent: !hasExpectedSiteBlob || typeof entry?.sitePath === 'string',
    expectedSiteBlobFormatCoherent: !hasExpectedSiteBlob || /^[a-f0-9]{40}$/.test(entry.expectedSiteBlob),
    expectedSiteBlobMatchesContent,
    pendingTrackingIssueCoherent: mode !== 'corpus-only-pending'
      || (typeof entry?.trackingIssue === 'string' && TRACKING_ISSUE_RE.test(entry.trackingIssue)),
    trackingIssueAbsentOutsidePending: mode === 'corpus-only-pending' || entry?.trackingIssue === undefined,
  };
}

/** Path ripetuti fra le voci del manifest. */
export function duplicateManifestEntryPaths(manifest) {
  const counts = new Map();
  for (const entry of manifest?.files || []) {
    const rel = entry?.path;
    if (typeof rel !== 'string') continue;
    counts.set(rel, (counts.get(rel) || 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([rel]) => rel));
}

function entryPath(entry, index) {
  return typeof entry?.path === 'string' ? entry.path : `<entry ${index}>`;
}

/**
 * Valida tutte le regole di forma delle voci che uno writer automatico puo'
 * violare. La lista e' anche il formato del messaggio della guardia finale.
 */
export function validateManifestEntries(manifest, { blobShaForPath } = {}) {
  const violations = [];
  if (!manifest || !Array.isArray(manifest.files)) {
    return [{ path: '<manifest>', rule: 'files', message: 'manca un array `files`' }];
  }
  const duplicates = duplicateManifestEntryPaths(manifest);
  for (const [index, entry] of manifest.files.entries()) {
    const rel = entryPath(entry, index);
    const checks = manifestEntryRuleChecks(entry, {
      actualBlobSha: entry?.expectedSiteBlob !== undefined && blobShaForPath
        ? (() => {
          try {
            return blobShaForPath(entry.path);
          } catch {
            return null;
          }
        })()
        : undefined,
    });

    if (typeof entry?.path !== 'string') violations.push({ path: rel, rule: 'path', message: `voce senza path: ${JSON.stringify(entry)}` });
    if (duplicates.has(rel)) violations.push({ path: rel, rule: 'duplicate-path', message: `path duplicato nel manifest: ${rel}` });
    if (!checks.knownMode) violations.push({ path: rel, rule: 'mode', message: `mode sconosciuto su ${rel}: ${entry?.mode}` });
    if (!checks.hasBaseline) violations.push({ path: rel, rule: 'baseline', message: `${rel}: manca \`baseline\`` });
    if (!checks.hasReason) {
      violations.push({
        path: rel,
        rule: 'reason',
        message: `${rel} e' \`${entry?.mode}\` senza \`reason\`. Un file diverso dal sito senza una ragione scritta e' indistinguibile da uno andato alla deriva: e' la ragione a rendere rileggibile la scelta fra sei mesi.`,
      });
    }
    if (!checks.adaptationIssueValid) {
      violations.push({ path: rel, rule: 'adaptationIssue', message: `${rel}: adaptationIssue mancante per baseline allineato` });
    }
    if (!checks.sitePathCoherent) {
      violations.push({ path: rel, rule: 'sitePath', message: `${rel}: \`sitePath\` identico a \`path\` — ridondante, loop-drift-check usa gia' \`entry.sitePath || rel\`.` });
    }
    if (!checks.corpusOnlySitePathCoherent) {
      violations.push({ path: rel, rule: 'mode-baseline', message: `${rel}: \`corpus-only\` non puo' avere un \`sitePath\`` });
    }
    if (!checks.corpusOnlySiteBaselineCoherent) {
      violations.push({ path: rel, rule: 'mode-baseline', message: `${rel}: \`corpus-only\` con \`baseline.site\` non nullo. loop-drift-check non lo legge mai per questo mode, quindi il valore e' solo un'affermazione falsa.` });
    }
    if (entry?.mode === 'corpus-only-pending' && !checks.pendingSiteBaselineCoherent) {
      violations.push({ path: rel, rule: 'mode-baseline', message: `${rel}: \`corpus-only-pending\` con \`baseline.site\` non nullo. Il gemello non e' ancora comparso sul sito (o e' comparso e la voce va promossa, non lasciata pending con un hash): in nessuno dei due casi un \`--init\` di routine deve scriverlo qui.` });
    }
    if (checks.knownMode && !checks.siteBaselineCoherent) {
      violations.push({ path: rel, rule: 'mode-baseline', message: `${rel}: \`${entry?.mode}\` senza \`baseline.site\`` });
    }
    if (checks.knownMode && !checks.corpusBaselineCoherent) violations.push({ path: rel, rule: 'mode-baseline', message: `${rel}: manca \`baseline.corpus\`` });
    if (!checks.expectedSiteBlobModeCoherent) violations.push({ path: rel, rule: 'expectedSiteBlob', message: `${rel}: expectedSiteBlob e' riservato a un gemello pending` });
    if (!checks.expectedSiteBlobPathCoherent) violations.push({ path: rel, rule: 'expectedSiteBlob', message: `${rel}: expectedSiteBlob senza sitePath esplicito` });
    if (!checks.expectedSiteBlobFormatCoherent) violations.push({ path: rel, rule: 'expectedSiteBlob', message: `${rel}: expectedSiteBlob non e' un Git blob SHA-1` });
    if (!checks.expectedSiteBlobMatchesContent) violations.push({ path: rel, rule: 'expectedSiteBlob', message: `${rel}: expectedSiteBlob non pinna il contenuto presente nel corpus; non promuovere una copia stantia.` });
    if (!checks.identicalBaselineCoherent) {
      violations.push({
        path: rel,
        rule: 'identical-baseline',
        message: `${rel}: \`identical\` con le due baseline diverse (site \`${entry?.baseline?.site}\`, corpus \`${entry?.baseline?.corpus}\`).`,
      });
    }
    if (!checks.pendingTrackingIssueCoherent) violations.push({ path: rel, rule: 'trackingIssue', message: `${rel}: \`corpus-only-pending\` senza un \`trackingIssue\` valido (atteso URL completo tipo https://github.com/<owner>/<repo>/issues/<n>). Senza, e' un candidato solo in prosa: esattamente il punto cieco che questo mode chiude.` });
    if (!checks.trackingIssueAbsentOutsidePending) violations.push({ path: rel, rule: 'trackingIssue', message: `${rel}: \`trackingIssue\` su mode \`${entry?.mode}\` — letto solo per \`corpus-only-pending\`, altrove e' un campo morto. O il mode e' sbagliato, o il campo va tolto.` });
  }
  return violations;
}

export function formatManifestViolations(violations) {
  return violations.map(({ path: rel, rule, message }) => `::error::Manifest non valido — ${rel}: ${rule}: ${message}`).join('\n');
}

function restoreManifest(manifestPath, originalBytes, fsApi) {
  fsApi.writeFileSync(manifestPath, Buffer.from(originalBytes));
}

/** Valida lo stato corrente e ripristina i byte originali in caso di errore. */
export function guardManifestState({ manifestPath, manifest, originalBytes, blobShaForPath, fsApi = fs, log = console.error }) {
  const before = originalBytes === undefined ? fsApi.readFileSync(manifestPath) : originalBytes;
  let violations;
  try {
    violations = validateManifestEntries(manifest, { blobShaForPath });
  } catch (error) {
    violations = [{ path: '<manifest>', rule: 'validation', message: String(error?.message || error) }];
  }
  if (!violations.length) return { ok: true, exitCode: 0, violations: [] };
  restoreManifest(manifestPath, before, fsApi);
  log(formatManifestViolations(violations));
  return { ok: false, exitCode: EXIT_INVALID_MANIFEST, violations };
}

/** Scrive solo un manifest interamente valido e verifica anche il file persistito. */
export function writeManifestWithGuard({ manifestPath, manifest, originalBytes, blobShaForPath, fsApi = fs, log = console.error }) {
  const before = originalBytes === undefined ? fsApi.readFileSync(manifestPath) : originalBytes;
  const state = guardManifestState({ manifestPath, manifest, originalBytes: before, blobShaForPath, fsApi, log });
  if (!state.ok) return state;

  try {
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    fsApi.writeFileSync(manifestPath, bytes);
    const persisted = JSON.parse(fsApi.readFileSync(manifestPath, 'utf8'));
    const persistedViolations = validateManifestEntries(persisted, { blobShaForPath });
    if (persistedViolations.length) {
      restoreManifest(manifestPath, before, fsApi);
      log(formatManifestViolations(persistedViolations));
      return { ok: false, exitCode: EXIT_INVALID_MANIFEST, violations: persistedViolations };
    }
    return { ok: true, exitCode: 0, violations: [], bytes };
  } catch (error) {
    restoreManifest(manifestPath, before, fsApi);
    const violations = [{ path: '<manifest>', rule: 'write', message: String(error?.message || error) }];
    log(formatManifestViolations(violations));
    return { ok: false, exitCode: EXIT_INVALID_MANIFEST, violations };
  }
}
