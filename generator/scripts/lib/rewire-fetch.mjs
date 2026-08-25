/**
 * Fetch helper for the three REWIRE consumers (border-wait window,
 * averages, events). Cloudflare returns HTTP 403 to GitHub Actions'
 * default Node/undici User-Agent (measured 2026-08-25 on
 * generator-ci.yml: both CDN and same-origin). A named UA is the
 * first retry; callers then decide the policy via explicit env:
 *   REWIRE_SKIP_WAF_403=1   --check may exit 0 (PR CI only)
 *   REWIRE_FIXTURE_ON_403=1 write may copy the offline fixture (dry self-test)
 * rewire-contract-watch.yml sets neither: a 403 there stays a hard fail.
 */
export const REWIRE_FETCH_HEADERS = {
  'user-agent':
    'frontaliere-articles-rewire/1 (+https://github.com/nanakokyobashi-rgb/frontaliere-articles)',
  accept: 'application/json',
};

/** True when every source failed with HTTP 403 on GitHub Actions. Policy is separate. */
export function isCiWafBlock(errors, env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true') return false;
  if (!Array.isArray(errors) || errors.length === 0) return false;
  return errors.every((e) => /HTTP 403/.test(String(e)));
}

/** Retries 5xx/429/network. 4xx other than 429 fail immediately. */
export async function getRewireUrl(url, { retries = 4, headers = REWIRE_FETCH_HEADERS } = {}) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers });
      if (res.ok) {
        const body = await res.text();
        if (body.length > 0) return body;
        lastErr = new Error('empty body');
      } else {
        const err = new Error(`HTTP ${res.status}`);
        if (res.status < 500 && res.status !== 429) throw err;
        lastErr = err;
      }
    } catch (err) {
      if (/HTTP 4\d\d/.test(err.message) && !/HTTP 429/.test(err.message)) throw err;
      lastErr = err;
    }
    if (i < retries) await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
  }
  throw lastErr;
}

export async function fetchFirstOk(urls, opts = {}) {
  const errors = [];
  for (const url of urls) {
    try {
      const body = await getRewireUrl(url, opts);
      return { ok: true, url, body, errors };
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }
  return { ok: false, url: undefined, body: undefined, errors };
}
