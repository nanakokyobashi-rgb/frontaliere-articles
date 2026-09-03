# AGENTS.md

Contratto vincolante per ogni agente che lavora su questo repo. Portato da
`valerielinc-ops/frontaliere-si-o-no` e adattato: la struttura è la stessa
perché una modifica al contratto del sito resti riportabile, ma i
non-negoziabili sono quelli di **questo** repo, che ha un mestiere diverso.

## Cos'è questo repo, in una frase

`frontaliere-articles` genera il corpus degli articoli e **pubblica una
superficie dati su HTTP** che `frontaliereticino.ch` consuma in produzione.

Il fatto da cui discende tutto il resto: **il sito non ribuilda quando questo
repo pubblica.** Un articolo atterra e va live senza che il sito faccia un
deploy. Ottimo per la velocità, spietato per gli errori — non c'è una build del
sito a fare da rete, e non esiste "ce ne accorgiamo al prossimo deploy".

## La superficie pubblica

Sotto `dist/api/`, generata da `scripts/build-api.mjs` e pubblicata da
`publish-api.yml`:

`manifest.json`, `articles.json`, `swiss-articles.json`, `meta-<locale>.json`,
`meta-ch-<locale>.json`, `slugs.json`, le sitemap blog, dieci feed RSS,
`news-ticker-live.json`. Locali: `it`, `en`, `de`, `fr`.

**`manifest.json` si legge per primo:** `commit` identifica lo stato esatto del
corpus, e `counts` permette di rifiutare un set troncato *prima* di usarlo. Un
set troncato è il caso peggiore proprio perché non fallisce.

## Non-negoziabili

1. **Mai abbassare un quality gate, un test o una validazione** per far passare
   qualcosa. Se un gate blocca, il gate ha ragione finché non si dimostra il
   contrario.
2. **Mai importare `content/**` dentro il sito.** Il confine fra i due repo è
   JSON su HTTP, non import. L'accoppiamento precedente spediva il registro
   come modulo ES: pubblicato fuori build come bundle esbuild, esportava una
   forma diversa dall'attesa, il pick risolveva `undefined`, e **ogni pagina
   articolo è rimasta sullo skeleton di caricamento senza un errore in
   console**. Un documento JSON non ha una forma di modulo su cui litigare.
3. **L'engine si modifica in `packages/articles` del SITO, non qui.** Questo
   repo ne riceve una copia mirrorata: una modifica fatta qui viene sovrascritta
   al mirror successivo. Se stai per editare `engine/`, fermati e verifica di
   non essere dal lato sbagliato del mirror.
4. **`SiteShellContract` e la sua metà `host/` viaggiano insieme.** Il gate di
   confinamento dimostra via AST che nulla sotto `engine/` importa fuori — ed è
   quello a renderlo copiabile. Ma copre gli **import**, e il contratto non ha
   forma di import: spedire l'engine senza `host/` dà `TypeError: <membro> is
   not a function` a render time, **dietro una CI verde**, perché `node --test`
   non importa TypeScript e legge l'engine come testo.
5. **Fixa la CLASSE del bug, non il singolo file.** Niente refactor drive-by,
   ma per un fix di pattern (regex, guard, soglia, selettore) cerca i gemelli e
   sweepali nella stessa PR, oppure giustifica ogni gemello non toccato. Un fix
   mono-file su un antipattern condiviso non è "rispetto dello scope": è un fix
   incompleto, e costa due cicli di review.
6. **Un valore condiviso ha UNA sorgente.** Niente regex o costanti duplicate
   fra uno script e lo YAML che lo invoca: se non possono importarsi, il legame
   va coperto da un test (è esattamente ciò che fa
   `generator/tests/ci-check-name.test.mjs`).
7. **Niente path assoluti della home né email personali** nei commit.

## Build e test

```bash
npx -y tsx@4 scripts/build-api.mjs   # genera dist/api/
node --test 'generator/tests/*.test.mjs'
```

Due cose che sembrano dettagli e non lo sono:

- **`tsx` e non `node`** per il build: i sorgenti usano specificatori relativi
  senza estensione, che Node ESM puro non risolve.
- **Il glob è obbligatorio** nei test: `node --test <cartella>` su Node 22
  collassa la directory in UN test fallito invece di scoprire i file. Senza
  glob la suite "fallisce" senza aver eseguito nulla.

Questo repo **non ha vitest**, non ha `node_modules` per default e builda con
`npx -y tsx@4`. Gli script del ciclo agentico (`scripts/ci/**`) usano solo
builtin Node, per scelta: è ciò che permette di eseguirli senza `npm ci`.

## Credenziali

Nessun secret nei file. Tutto in **Firebase Remote Config**, progetto
`frontaliere-ticino`, e il ponte verso `process.env` è
`generator/scripts/load-rc-env.mjs` — l'**unico**. Un parametro che non compare
nella sua mappa `RC_TO_ENV` resta `undefined` per chi lo legge da
`process.env`, per quanto sia impostato in Remote Config. Se aggiungi un
secret, mappalo lì o è inerte.

Due comportamenti che confondono se non li conosci:

- Una variabile **già presente** nell'ambiente non viene sovrascritta dal
  valore di Remote Config. È voluto (permette l'override nei workflow).
- Il loader **esce 0 anche quando non carica niente** — non deve mai rompere un
  workflow. Quindi un fallimento di auth è indistinguibile da un successo, se
  non lo si controlla esplicitamente.

Per push, merge e dispatch si usa **`GITHUB_PAT_NANAKO`**, non `GITHUB_PAT`
(che è un token integration senza Actions write). E **mai il `GITHUB_TOKEN` per
i merge**: per anti-ricorsione non fa scattare `publish-api.yml`, quindi la
superficie servita al sito resta vecchia in silenzio.

## Il ciclo autonomo

Le PR ricevono una review automatica e vengono mergiate quando sono verdi. Dal
2026-09-03 sono la STESSA cosa: contratto del body, test e Claude review col suo
verdetto sono le tre famiglie di step di `tests.yml`, che produce il check-run
`tests (node --test)`; il ruleset su `main` richiede quel check e l'auto-merge
NATIVO di GitHub aspetta lui. Un `🔴 Important` rende rosso quel check, quindi il
merge non puo' scavalcare la review. `enable-native-automerge.yml` si limita ad
arruolare la PR nel meccanismo, con l'identita' del PAT owner perche' il merge
faccia scattare `publish-api.yml`. I workflow che falliscono aprono una
issue (`workflow-failure-issues`), che viene classificata e instradata
(`issue-triage`) e infine lavorata dal fixer (`issue-fix`), una alla volta.

**La quota Claude è condivisa con il ciclo del sito.** Questo repo ha
precedenza inferiore per costruzione: i suoi workflow Claude leggono anche il
beacon di rate-limit del sito e cedono, mentre il sito non legge mai il nostro.
Non è una gentilezza, è un invariante — vedi `scripts/ci/check-quota-backoff.mjs`.

Il ciclo è tenuto allineato a quello del sito da
`scripts/ci/loop-drift-check.mjs`, che confronta i due lati **contro la
baseline dell'ultimo allineamento**, non fra loro: la domanda utile non è "sono
diversi" (lo sono per costruzione) ma **chi si è mosso**. Ogni adattamento è
dichiarato con la sua ragione in `scripts/ci/loop-sync-manifest.json`.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **frontaliere-articles** (53534 symbols, 62053 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/frontaliere-articles/context` | Codebase overview, check index freshness |
| `gitnexus://repo/frontaliere-articles/clusters` | All functional areas |
| `gitnexus://repo/frontaliere-articles/processes` | All execution flows |
| `gitnexus://repo/frontaliere-articles/process/{name}` | Step-by-step execution trace |

## Cross-Repo Groups

This repository is listed under GitNexus **group(s): frontaliereticino** (see `~/.gitnexus/groups/`). For cross-repo analysis, use MCP tools `impact`, `query`, and `context` with `repo` set to `@<groupName>` or `@<groupName>/<memberPath>` (paths match keys in that group’s `group.yaml`). Use `group_list` / `group_sync` for membership and sync. From the project root: `node .gitnexus/run.cjs group list`, `node .gitnexus/run.cjs group sync <name>`, `node .gitnexus/run.cjs group impact <name> --target <symbol> --repo <group-path>` (the `.gitnexus/run.cjs` path is repo-root-relative).

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
