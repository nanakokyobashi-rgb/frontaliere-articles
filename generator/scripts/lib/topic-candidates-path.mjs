export function resolveExperimentalCandidatesPath(envPath, defaultPath) {
  if (typeof envPath === 'string' && envPath.trim()) return envPath;
  return defaultPath;
}
