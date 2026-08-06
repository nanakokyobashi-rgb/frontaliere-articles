# Review Instructions

Contratto del reviewer. Filtra i finding per **scopo del progetto**, non per stile, naming o sicurezza.

Portato da `valerielinc-ops/frontaliere-si-o-no`. La struttura è deliberatamente la stessa — severity, formato, completeness contract, escalation — così una modifica al contratto del sito resta leggibile e riportabile qui. Ciò che cambia è il **filtro di scopo**, perché i due repo hanno funnel diversi. Vedi `scripts/ci/loop-sync-manifest.json`.

## Scopo progetto = filtro "important"

Questo repo **pubblica una superficie dati su HTTP** (`dist/api/`) che `frontaliereticino.ch` consuma in produzione: `manifest.json`, `articles.json`, `swiss-articles.json`, `meta-<locale>.json`, `slugs.json`, le sitemap blog, dieci feed RSS, `news-ticker-live.json`. Locali: `it`, `en`, `de`, `fr`.

Il fatto che decide tutto: **il sito non ribuilda quando questo repo pubblica.** Un errore qui è live subito, e non c'è una build del sito a fare da rete. Non esiste l'equivalente di "ce ne accorgiamo al prossimo deploy".

Un finding è **important** se impatta:

1. **Correttezza della superficie pubblicata** — forma dei JSON, `counts` nel manifest, slug, canonical, `previousSlugs`, sitemap, feed RSS, news-ticker. Una superficie *troncata* o di *forma diversa* è il caso peggiore, perché non fallisce: il sito la accetta e mostra meno di quello che c'è.
2. **Il contratto con il sito** — `SiteShellContract` (`engine/siteShell.ts`) e la sua metà `host/`. È il punto in cui questo repo si è già rotto: spedire l'engine senza la metà `host/` dà `TypeError: <membro> is not a function` a render time, **dietro una CI verde**, perché `node --test` non importa TypeScript e legge l'engine come testo.
3. **Il ciclo di pubblicazione** — `publish-api.yml`, `scripts/build-api.mjs`, upload R2/CDN, purge della cache, `repository_dispatch` verso il sito. Se il ciclo non parte, la superficie resta vecchia **in silenzio**: nessun errore, solo dati fermi.
4. **Correttezza del corpus generato** — articoli malformati, slug duplicati, locale mancante, frontmatter rotto. Il corpus è l'input di tutto il resto.

Nessuno dei quattro → droppa il finding. Non è importante per questo progetto.

### Il modo tipico in cui questo repo si rompe

Vale la pena tenerlo a mente mentre reviewi, perché non somiglia a un crash:

- Il registro spedito come modulo ES esportava una forma diversa dall'attesa → il pick risolveva `undefined` → **ogni pagina articolo è rimasta sullo skeleton di caricamento, senza un errore in console**.
- Un fix all'engine non è mai sceso per tre settimane perché il canale di mirror era stato disabilitato: visibile solo come un audit passato da 23 a 3608.
- Un feed RSS è rimasto fermo tre mesi perché `publish-api.yml` guardava solo `content/`, e il fix stava in `engine/`.

Il filo comune: **niente è esploso**. Se un finding descrive un modo in cui qualcosa smette di aggiornarsi o cambia forma senza fallire, è important anche se non c'è nessuna eccezione.

## Severity

| Marker | Quando |
|---|---|
| 🔴 Important | Rompe la superficie pubblicata, il contratto col sito o il ciclo di pubblicazione. Forma JSON cambiata, set troncato, slug/canonical sbagliati, publish che non riparte, engine spedito senza la sua metà. **Scope dovuto lasciato in `## Non implementato` come deferral senza essere fatto né avere un next-step concreto.** |
| 🟡 Nit | Migliora ma non blocca. Semplificazione, leggibilità, anti-duplicazione, **code-smell che crea debito** (valori hardcoded che invecchiano). **Cap 3 per review**; oltre → `+N similar nits` nel summary. |
| 🟣 Pre-existing | Bug già presente prima della PR. Solo se rilevante al diff. |
| ❓ q | Domanda genuina quando sei incerto. Mai speculazione. |

### Disposizione dei 🟡 al review-time

Ogni 🟡 deve dichiarare la propria disposizione, così il follow-up non deve indovinarla:

- **Nit non-funnel** (stile, leggibilità, naming, debito senza impatto sulla superficie) → suffissa **`— deferred, non funnel-critical`**. Non diventa follow-up.
- **Nit funnel-critical e azionabile** → resta candidato a follow-up. Se il fix è banale e isolato, dillo come 🔴-soft "fixa in-PR prima di `## LGTM`": un fix in-PR costa zero run, un follow-up ne costa tre.

Non bloccare l'auto-merge sui nit non-funnel. Il blocco resta solo su 🔴 e sul process gate.

## IGNORA (anche se veri)

- **Test coverage — MAI un finding**, né 🟡 né voce di `## Adversarial check`, nemmeno su path critici. "Manca un test", "aggiungi coverage", "pinna con un test" → non sollevare in nessuna forma. **Eccezione (in scope):** un BUG in un test ESISTENTE — assertion sbagliata, regex leaky che resta verde sulla regressione, fixture con date assolute — è correttezza, non coverage.
- **Verifica-live-only — mai un finding azionabile.** Un item la cui unica azione è ispezionare il sito già pubblicato ("verifica che la pagina si aggiorni", "curl l'endpoint in prod") non ha codice da cambiare → auto-routerebbe il fixer su una PR vuota. **Eccezione:** se mescola la verifica con un'edit concreta, solleva la parte editabile.
- Security (XSS, injection, path traversal) — fuori scopo per decisione del proprietario.
- Stile, formattazione, naming.
- Strictness TypeScript, salvo che mascheri un bug logico.
- Refactor speculativi non legati al diff.
- Cavilli architetturali se la soluzione attuale funziona.

## Tier review

Il tier è calcolato dal workflow (`pr-review-loop.yml`) e passato nel prompt; questa tabella è il razionale.

**Il tier si decide SOLO sul CODE.** `content/` (14.888 file di corpus), `data/`, `dist/` (superficie generata) e `public/` non sono codice: non escalano il tier e non vanno revieweati riga per riga.

| Tier | File trigger (CODE) | Profondità |
|---|---|---|
| **high** | `generator/**`, `engine/**`, `host/**`, `.github/workflows/**`, e tutto `scripts/**` ECCETTO `scripts/{ci,dev}/` e gli audit/report read-only | È il codice che emette o rende la superficie pubblicata. Un bug qui è live senza deploy. Probe su regex, assertion, exit code, idempotenza. Sezione `## Adversarial check` con 3 cose NON verificate. |
| **high-mega** | Stesso trigger di `high`, con ≥25 file di codice nel diff | Stesso rigore, solo più budget di turni (90 vs 60). La taglia della PR non abbassa lo standard. |
| **normal** | Tutto il resto, inclusi `scripts/{ci,dev}/` e gli audit read-only | Single-pass standard, nessun adversarial obbligatorio. |
| **minimal** | PR di soli content/data (zero codice reviewabile) | Percorso corto ≤6 turni: solo il completeness contract del body. Niente REVIEW.md, niente cross-file, niente adversarial. Posta `## LGTM`. |
| **incremental** / **incremental-high** | Re-review con delta non-funnel / funnel-critical | Reviewa SOLO il delta da `INCREMENTAL_BASE`, non l'intero contributo. Read/grep dei file pieni consentito per il contesto. Riduce i token, **non** la severity: un 🔴 nel delta resta 🔴. |

### CODE vs DATA nel diff

- **Non** revieware riga per riga `content/**`, `dist/**`, `data/**`, `public/**`. Non sono finding.
- Valuta solo se il **codice che li genera** è corretto.
- Serve un campione di output? Apri il file mirato con `Read`, non scorrere il blob nel diff.
- `rg`/`grep` cross-file scopati al codice: `rg <pattern> generator engine host scripts services` — cercare dentro `content/` matcha migliaia di file e brucia turni senza segnale.

Eccezione: un file sotto `data/` che è **config o fixture** (non output rigenerato) e che il diff modifica a mano → reviewalo come codice.

## Completeness contract

Il body della PR DEVE avere:

```markdown
## Implementato
- Cosa fa la PR.

## Non implementato (ancora)
- Piano di completamento: scope ancora dovuto + stato/next-step (in questa PR / PR concatenata #N / blocked: <causa>). «Nessuno» = task completo.
```

### Comportamento del reviewer

1. **Voce `Implementato`** → pensiero critico: il diff la implementa davvero? Edge case? Logica su boundary, null, ordinamento, async? C'è un modo più semplice? Un buco visibile? Code-smell con debito → 🟡.
2. **Voce `Non implementato`** → è un **piano di completamento**, non uno scope chiuso. Ogni voce è lavoro ancora dovuto: verifica che dichiari uno stato concreto (`in questa PR` / `PR concatenata #N` / `blocked: <causa esterna reale>`), non una scappatoia (`out of scope`, `posposto`). Scope dovuto senza piano né esecuzione → **🔴 Important**. Una PR PUÒ mergiare con la sezione non vuota se ogni voce porta un next-step credibile, ma in quel caso **il task non è chiuso**.
3. **Il diff fa cose non dichiarate** → 🟡 scope drift. **Inverso** — il body dichiara X ma il diff non lo mostra → 🟡: "`## Implementato` afferma X ma il diff non lo riflette".
4. **Sezioni mancanti** → 🔴 process: "manca `## Implementato` / `## Non implementato` nel body".
   - **Tier normal**: termina qui.
   - **Tier high / high-mega: NON terminare.** Posta il 🔴 process E prosegui con la review sostanziale nello stesso pass — il 🔴 blocca l'auto-merge, non un merge manuale, quindi la sostanza deferita evapora.
   - **`Closes #a #b` su una riga** → 🔴 process: GitHub chiude solo la prima issue dopo la keyword. Una keyword per issue, una per riga.
5. **Ripetizione di pattern cross-file** → quando il diff fixa un pattern (regex, idioma di parsing, forma di un'assertion) in un file, cerca l'equivalente nel resto del repo con `rg`, **scopato al codice**. Stesso anti-pattern altrove non toccato → 🔴 se in `generator/`, `engine/`, `host/` o negli emitter della superficie; 🟡 altrove.
6. **Conformità al piano di test** → voce verificabile pre-merge non spuntata e non confermabile dal diff → 🟡. Voce che richiede verifica live → **non** sollevare (vedi IGNORA).
7. **Claim di performance non validato** → PR che dichiara uno speedup senza misura baseline pre-merge, su tier high → 🔴: "claim non validato; allega misura pre/post oppure dichiara il revert-risk".

### Adversarial check (tier high)

Prima del summary finale, sezione `## Adversarial check` con 3 cose **non** verificate.

**Sono rischi di COMPORTAMENTO, mai "manca un test".** Non scrivere "questo ramo non ha test": è un missing-coverage travestito. Scrivi il rischio sottostante — *il comportamento X su input degenere potrebbe sbagliare* — come ❓ q, o 🔴 se tocca la superficie.

**Un ❓ dell'adversarial check che tocca la superficie pubblicata non resta sepolto lì.** Se, fosse vero, impatterebbe `dist/api/`, gli slug, le sitemap o i feed → promuovilo a 🔴 in `## Findings`.

## Verification

I claim sul comportamento richiedono `file:linea`. Niente speculazione. Incerto → `❓ q:`.

**Escalation ❓ → 🔴.** Un `❓` resta tale solo se l'impatto, fosse vero, è non-funnel o cosmetico. Se il soggetto tocca la superficie pubblicata, il contratto col sito o il ciclo di pubblicazione → **non** lasciarlo passivo accanto a un `## LGTM`. Promuovilo a 🔴 (blocca l'auto-merge) **oppure** apri una follow-up issue e linkala. Il filtro "pre-existing / fuori scopo" abbassa la severità del blocco, non cancella un bug che è già in produzione.

## Re-review convergence

Dopo la prima review:
- Sopprimi i 🟡. Posta solo i 🔴.
- Fix già applicato → conferma `Fix di L<linea>: ok.`
- Non rilanciare nit già detti.

## Output format

Una riga per finding:

```
<file>:L<linea>: <prefix> <problema>. <fix>.
```

Prefix: `🔴 Important` / `🟡 Nit` / `🟣 Pre-existing` / `❓ q:`.

**Il marker `🔴 Important` è una stringa esatta, MAI in grassetto.** Scrivi `🔴 Important`, non `🔴 **Important**`. È letto da gate deterministici (`auto-merge-eval.mjs` per bloccare il merge). Il grassetto ha già rotto il match una volta, lasciando un 🔴 mai indirizzato. I gate oggi tollerano il grassetto, ma la tolleranza è una cintura, non il formato.

**Elimina:** "ho notato", "sembra che", "forse", "potresti volere", il restating, "ottimo lavoro ma". Niente hedging.

**Tieni:** la linea esatta, i simboli in backtick, un fix concreto, il *perché* solo se non ovvio.

### Esempi

- `scripts/build-api.mjs:L142: 🔴 Important: quando un locale non ha articoli il file meta-<locale>.json viene scritto comunque con counts a 0, e il sito lo accetta come verita' — la pagina risulta vuota invece che assente. Salta il write o propaga l'errore.`
- `engine/siteShell.ts:L88: 🔴 Important: nuovo membro del contratto aggiunto senza la meta' host/ — a render time diventa TypeError dietro una CI verde (node --test legge l engine come testo, non lo importa). Spedisci host/ nello stesso giro.`
- `generator/lib/slugify.mjs:L37: 🔴 Important: due titoli che differiscono solo per accento collassano sullo stesso slug, il secondo articolo sovrascrive il primo in slugs.json.`
- `scripts/cf-purge-cache.mjs:L64: 🟡 Nit: retry senza backoff, tre tentativi in 300ms su un 429 sono un tentativo solo — deferred, non funnel-critical.`
- `engine/rssFeeds.mjs:L120: ❓ q: se pubDate manca, il feed emette la stringa vuota o omette il tag? Il primo caso invalida il feed per i reader.`

## Summary body

```markdown
## Scope
<una frase: scopo della PR> (tier: high|normal)

## Findings (Important: N, Nit: M)
<lista>

## Adversarial check
<solo tier high: 3 cose NON verificate>
```

Zero 🔴 → chiudi con `## LGTM` e una frase di recap.

**Critico:** la stringa esatta `## LGTM` fa scattare l'auto-merge in `auto-merge-on-lgtm.yml`. Non scriverla mai se hai aperto un 🔴 nei findings o nell'adversarial check, **né se hai un ❓ sulla superficie pubblicata non escalato**: o lo promuovi a 🔴, o apri una follow-up issue e lo dichiari.
