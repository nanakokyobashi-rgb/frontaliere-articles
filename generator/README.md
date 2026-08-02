# Article generator (transported from `valerielinc-ops/frontaliere-si-o-no`)

Issue #4974 item 3. The authority for the plan is
`docs/articles-generator-migration.md` **in that repo**, not this file — this
one records only what is true HERE, and where reality diverged from the plan.

**Nothing in here is wired to a schedule yet.** There is no cron, no secret, no
push. `main` publishes the live surface (JSON, sitemaps, 10 RSS feeds,
news-ticker) that the site consumes in production; the generator does not touch
it. Cutover is step 6 of the plan and has not started.

## Layout

```
generator/
  scripts/          the 67 transported files (6 producers + fix-faq-locales + lib/**)
  build-plugins/    \
  data/              > vendored dependencies the transport missed — see below
  services/         /
  tests/            gates that did not exist before (node:test, no framework)
```

`build-plugins/`, `data/` and `services/` mirror main's directory names on
purpose: the transported files import them with main-relative specifiers
(`../data/municipalities.ts`), so keeping the names identical means those import
lines stay byte-identical and the diff against main stays reviewable.

Note `generator/data/` is NOT the same as the repo-root `data/` the generator
writes its own state into (`article-source-quotas.json` and friends, which
resolve against the repo root). One is vendored input, the other is generator
state.

## What had to change, and why

The code arrived as a file copy and had never been executed here. Running it
surfaced four classes of problem.

**1. The transport closure was incomplete.** Six static top-level imports were
never copied — `borderWaitData.ts`, `borderCrossings.ts`, `municipalities.ts`,
`canton-url-slugs.json`, `borderWaitFormat.ts` (plus `borderCrossingSlug.ts`,
pulled in by `borderCrossings.ts`). All are specifiers that LEAVE `scripts/`
(`../build-plugins/`, `../data/`, `../services/`), which is exactly what the
manifest's closure did not follow. A seventh, `articleSectionCore.mjs`, needed no
copy at all: it is a symlink in main into `packages/articles/engine/shared/`,
which this repo already mirrors at `engine/shared/` — the import was repointed
instead. `generator/tests/import-closure.test.mjs` is the gate for this.

**2. Every entry point resolved the wrong repo root.** In main these live at
`scripts/x.mjs`, so `path.resolve(__dirname, '..')` was the repo root. Here they
are at `generator/scripts/x.mjs`, so it silently became `generator/`. Reads
would have failed and writes would have built a phantom corpus under
`generator/`. All seven now resolve `'..', '..'`, and the closure test asserts
none of them regresses.

**3. Path layout.** Main keeps the corpus at `services/locales/**` (OS symlinks
into `packages/articles/content/`); here it is a real `content/` tree. Rather
than rewrite ~30 literals in an 8800-line file, `scripts/lib/corpus-paths.mjs`
maps them, and every read/write in `create-article.mjs` funnels through the one
`resolve()` helper. That module also replaces main's `resolve-git-add-path.mjs`,
which was deliberately not transported: it exists solely to `realpath` past
main's symlinks, and this repo has none. The mapping is an explicit table, not a
prefix rule, so that the generator's own state files under `data/` are not
quietly relocated into the published corpus.

**4. Three REWIREs** (plan §5.3, plus the border-wait ranking window):

- **Google News whitelist** — vendored as code at
  `data/news-sitemap-whitelist.mjs`, not fetched. Main loaded it by
  regex-parsing a `.ts` file at startup and treated a failed parse as an empty
  list, which `isArticleEligibleForNewsSitemap()` reads as **allow-all**.
  Transported here that fallback fired every time, because the file it looked
  for does not exist in this repo: every article would have entered
  `sitemap-news.xml`, silently. A static import cannot fail that way. Tokens are
  byte-identical to main's and extracted mechanically; main stays the editorial
  owner.
- **Border-wait averages** — `scripts/refresh-border-wait-averages.mjs` fetches
  them over HTTP into a gitignored cache that `data/borderCrossings.ts` reads.
  The plan said "fetched over HTTP from the live site instead of read from a
  repo file", which was right about the file but described a URL that did not
  exist: `data/border-wait-averages.json` was not part of main's deployed
  surface. Main now publishes it to `public/data/`, so the fetch has something
  to fetch. Absence is not an error — the overlay is cosmetic and
  `borderCrossings.ts` falls back to its editorial defaults, so a network blip
  must never fail a generation run.
- **Border-wait ranking window** — `scripts/refresh-border-wait-window.mjs`
  fetches `border-wait-ranking-window.json`, the aggregate the weekly ranking
  article is built from. In main that article read `data/border-wait-history/**`
  directly: 90 daily files, 1.7 GB, Firestore telemetry that belongs to the site
  repo. It never had to move. Every one of `rankingFromStats` /
  `trendFromStats` / `computeFunFacts` bottoms out on the *aggregate*, ~140
  crossings x 2 numbers, so main publishes that (32 KB) and the identical pure
  functions run here. Two windows, not one, because the trend section compares
  the current 7 days against the preceding 7.

  Verified equivalent, not assumed: computing the ranking and the trend from
  main's 1.7 GB history and from the 32 KB published aggregate gives
  byte-identical results, and both functions are now parity probes.

  **Unlike the averages, this fetch is REQUIRED.** The averages are a cosmetic
  overlay with a documented fallback; this is the article's data. A ranking
  article generated without a ranking is wrong output on an evergreen URL that
  already ranks, not degraded output — so an unreachable publisher, a window
  whose `windowDays` is not 7, or one whose data is more than 14 days old all
  fail the run.

## Gates

```
npm test              # unit + import-closure  (node --test, no dependencies)
npm run test:parity   # behavioural parity vs main, byte-for-byte
npm run test:dry-run  # every entry point loads with writes disabled
```

`test:parity` is the §5.4 byte-comparison. A whole generation run is not
reproducible — it calls LLMs, fetches live RSS and stamps `new Date()` — so two
runs of MAIN against itself would not match either. What IS comparable is the
deterministic layer under it, and `tests/parity/run.mjs` runs the same probes
against both trees:

```
node generator/tests/parity/run.mjs --root ../frontaliere-si-o-no/scripts > /tmp/main.json
node generator/tests/parity/run.mjs > /tmp/nanako.json
diff /tmp/main.json /tmp/nanako.json
```

That diff is currently empty — 32 calls across 8 modules, byte-identical. CI
cannot run it (main is not checked out there), so `golden.json` is the recorded
result and `--check` compares against it.

## Known gaps

- **The publisher does not emit the two new artifacts yet.** Main can already
  receive a hero-image manifest (`images-manifest.json`) and Google News
  candidates (`sitemap-news-candidates.xml`) — see §7 of the migration doc for
  the exact contract — but nothing here writes them. Main tolerates their
  absence by design until `--require-new` is set.
- **No nanako-side secrets or workflows for generation.** Plan §6 question 3.
