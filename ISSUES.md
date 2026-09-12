# ISSUES.md

Contratto operativo del fixer autonomo (`issue-fix.yml`) e del ciclo delle
issue. Portato da `valerielinc-ops/frontaliere-si-o-no` e adattato.

## Come una issue arriva al fixer

```
workflow fallisce
   └─ workflow-failure-issues.yml (cron */30, centrale)
        └─ "Workflow Failure: <nome>"        ← titolo canonico, dedupato
             └─ issue-triage.yml             ← classifica, zero Claude
                  ├─ route=fix    → agent:fix          (solo `publish`)
                  └─ route=queue  → agent:fix-queued   (tutto il resto)
                       └─ followup-drainer.yml         ← promuove UNA alla volta
                            └─ issue-fix.yml           ← il fixer
                                 └─ PR → review → auto-merge
```

Quando il workflow torna verde, `close-recovered-failure-issues.yml` chiude la
issue da solo. **Non serve chiuderla a mano dopo un fix.**

## Categorie

Decise da `scripts/lib/classify-issue.mjs` (testato in
`generator/tests/classify-issue.test.mjs`):

| Categoria | Route | Perché |
|---|---|---|
| `publish` | **fix immediato** | Se `publish-api` non ripubblica, il sito continua a servire la superficie **vecchia** senza che nulla fallisca. È già successo: un feed RSS fermo tre mesi. Volume basso, quindi saltare la coda non la intasa. |
| `engine` | coda, priorità alta | Il contratto `engine/` ↔ `host/` si rompe a render time **dietro una CI verde**. Alta priorità perché invisibile, non perché urgente. |
| `generation` | coda, priorità bassa | Il grosso del volume, e transiente per natura (provider LLM, rete). Tenerlo in coda bassa è ciò che impedisce al rumore di generazione di affamare tutto il resto. |
| `ci` | coda, priorità alta | |
| `follow-up`, `loop-drift`, `other` | coda | |

**Nessuna categoria è human-only.** Le safety-valve del fixer (sotto) sono
generiche, non guardrail di categoria.

## Perché la coda esiste

`issue-fix` ha una concurrency globale con `cancel-in-progress: false`.
Promuovere N issue insieme significa N run in coda di cui **una sola gira**, e
le altre restano pending finché non vengono cancellate. Sul sito questo ha
prodotto il 60% di run follow-up cancellate e una ventina di issue bloccate.

Il drainer promuove **una alla volta, solo a slot libero**: la run promossa è
l'unica pending, quindi non può essere cancellata.

A slot libero la testa della coda viene ruotata per **equità** (#973): a parità
di `fu-prio`, chi ha tenuto lo slot più di recente passa dietro a chi lo ha
tenuto prima, e chi non lo ha mai tenuto passa davanti. Serve perché il
re-queue gratuito di una consegna è un bound di *terminazione*, non di equità:
un'aggregata che consegna a ogni ciclo rientrava con il suo `createdAt` — il più
vecchio — e si ri-prendeva lo slot indefinitamente, senza che nessun singolo
tick fosse sbagliato.

## Fix flow

1. **Branch isolato, resume-aware.** Se esiste già `fix/issue-<n>` su origin, un
   run precedente è morto **dopo** il checkpoint: continua da lì invece di
   rifare il lavoro. Se il diff è stale, `git reset --hard origin/main`.
   Il container CI è già un checkout isolato monouso: **non** creare worktree
   interni, bruciano turni rifacendo la meccanica del checkout.
2. **Diagnosi della root cause, non del sintomo.** Se dopo ~15 turni non emerge
   una root cause chiara, NON continuare a scavare: restringi lo scope o
   termina con `no-root-cause`. Un vicolo cieco esplorato fino in fondo brucia
   il budget e non consegna niente.
3. **Fix chirurgico alla classe del bug** (AGENTS.md #5).
4. **Checkpoint WIP: commit e push IMMEDIATI**, prima ancora di testare. Se il
   run muore dopo questo punto il branch sopravvive col diff reale. Senza
   checkpoint, un run morto per max-turns perde il 100% del lavoro insieme al
   container — sul sito è successo con 71 turni di lavoro reale e nessun branch
   su GitHub.
5. **Mai abbassare un gate** per far passare qualcosa.
6. **Gate test pre-PR:** `node --test 'generator/tests/*.test.mjs'`. Niente
   vitest (non esiste qui), niente `npm test` cieco, e il glob è obbligatorio.
   Una PR coi test rossi **non riceve review** e resta ferma: è un ciclo
   sprecato.
7-8. Commit e push.
9. **PR con il body obbligatorio** (contratto in `REVIEW.md`):
   ```
   ## Implementato
   - <cosa fa il fix>
   Closes #<n>

   ## Non implementato (ancora)
   - <scope non fatto + stato: in questa PR / PR concatenata #N / blocked: <causa>>
   ```
   Una keyword `Closes` **per issue, una per riga**: GitHub chiude solo la prima
   dopo la keyword, quindi `Closes #a #b` lascia `#b` aperta.

   **Eccezione — issue aggregata.** Il circuit-breaker qui sotto fa chiudere
   **un item su N**: `Closes #<n>` chiuderebbe al merge il tracker insieme agli
   item appena deferiti in `## Non implementato`, e non resterebbe niente da
   ri-accodare. `scripts/ci/reconcile-followups.mjs` si rifiuta gia' di
   auto-chiudere un aggregato (`closeEligible = ... && !isAggregate`) — la
   keyword nel body bypassa quella protezione. **Usa `Refs #<n>`** e lascia la
   issue aperta per il giro successivo.

   **Eccezione — fix provabile solo da una run su `main`.** Se la PR tocca
   `.github/workflows/**` o la config dell'action Claude (`claude_args`,
   `settings`, sandbox, `permissionMode`) per un bug osservabile solo a
   runtime (sandbox/bwrap, permessi, rate-limit, dispatch) — cioè nessun test
   o lettura del diff può dimostrare che il fix funziona, solo una run reale
   — **non usare `Closes #<n>`**: usa `Refs #<n>` e, dopo l'apertura della PR,
   `gh issue edit <n> --add-label awaiting-production-proof`. La issue resta
   aperta finché la misura di una run verde su `main` non arriva
   (vedi #151: la PR #147 è stata mergiata e la issue #127 chiusa 8 minuti
   prima che la misura in produzione smentisse la diagnosi). Il marker
   `FIX_OUTCOME: pr-created` resta comunque quello giusto — è la PR ad essere
   aperta, non il verdetto del fixer a mancare.

   La misura non la allega più una mano umana: dal 2026-09-06 (#973) il pass
   **PRODUCTION-PROOF** del drainer sospende la promozione finché la label c'è,
   e la toglie da solo quando una run **success** su `main` di un workflow
   toccato dalla PR risulta creata **dopo** il merge e girata su un commit che
   **discende** da quello di merge (l'orologio da solo non dice cosa c'era
   dentro la run). Sospensione senza
   rimuovitore = stato assorbente, quindi ogni altro esito toglie comunque la
   label: prova non definibile (la PR non tocca `.github/workflows/**`) o
   timeout a `FOLLOWUP_PROOF_MAX_HOLD_DAYS` (7) con un warning — una prova che
   non arriva in una settimana non arriva da sola.
10. La PR entra da sola nel ciclo di review e auto-merge. **Non mergiare a mano.**

## Issue aggregate: il circuit-breaker

Una issue con molti item distinti non entra in un solo run: tentarli tutti
sfora il budget turni e consegna **zero** PR — è il modo più costoso di
fallire, perché si paga tutto e non si ottiene niente.

**Regola ferrea:** fixa **esattamente un item**, poi fermati. Anche con turni
residui. Gli altri vanno elencati in `## Non implementato`, che li ri-accoda.
Ogni ciclo chiude almeno un item, quindi converge.

E nel body della PR **`Refs #<n>`, mai `Closes #<n>`**: la PR chiude un item, non
il tracker. Con `Closes`, GitHub chiude l'aggregato al merge e gli item deferiti
spariscono con lui — la convergenza si ferma al primo ciclo.

## Terminare senza PR è un esito legittimo

Non ogni issue produce una PR, e forzarne una è peggio che non farla:

- **Root cause non determinabile** → commenta cosa hai trovato e termina.
- **Capability mancante** — il fix richiederebbe di toccare
  `.github/workflows/**` senza lo scope, o impostazioni del repo, o segreti non
  presenti in CI. **Valutalo al turno 1, non alla fine:** fare tutto il lavoro
  per poi scoprire il blocco al push spreca l'intero run.
- **Overlap** — una PR aperta modifica già uno dei file target: fermarsi evita
  un conflitto o un doppione.
- **Già risolta** o **PR già in volo**.

## Telemetria degli esiti (obbligatoria)

L'**ultimo** commento che il fixer posta sulla issue deve contenere un marker
su riga propria — in testa o in coda, indifferentemente:

```
<!-- FIX_OUTCOME: <code> -->
```

`<code>` ∈ `pr-created` · `blocked-workflows-scope` · `blocked-secrets` ·
`blocked-admin-settings` · `no-root-cause` · `overlap-skip` ·
`pr-already-open` · `already-fixed`.

La posizione non conta: `FIX_OUTCOME_RE` in `followup-drainer.mjs` non è
ancorata, e il drainer stesso scrive il marker in fondo ai propri commenti. Una
regola più stretta di quanto il codice richieda verrebbe violata innocuamente
per sempre, e insegnerebbe a leggere questo contratto come approssimativo.

**Perché è obbligatorio.** Senza marker granulare, il drainer non distingue un
verdetto legittimo da una run morta, e ri-accoda contro un muro. Sul sito
questo ha prodotto una catena assorbente misurata: un 429 (che ha
`subtype: success` con `is_error: true`) veniva letto come "run morta, nessun
verdetto" → re-queue → altri 429 → tre tentativi → parcheggiata → chiusa in
automatico **senza che nessun agent l'avesse mai letta**.

## Il lock `agent:in-progress`

È **mutua esclusione, non stato**. Il claim gate appone sempre
`agent:in-progress` insieme a uno dei due proprietari:

- `agent:remote`: claim del fixer CI, rilasciabile solo dal fixer remoto;
- `agent:local`: claim di una sessione locale, protetto dal detector stale
  automatico perché una sessione locale non espone un heartbeat affidabile.

Il gate è fail-closed sulle letture GitHub: se non riesce a leggere le label non
acquisisce il lavoro e non rilascia il claim di qualcun altro. Ogni run remota
rilascia il proprio claim solo se l'acquisizione è stata confermata. Una
sessione locale deve usare il claim gate con `CLAIM_OWNER=local`; non deve
aggiungere o rimuovere `agent:in-progress` a mano. Un claim locale orfano va
verificato e rilasciato esplicitamente da una sessione locale, non dal cron.

Le PR create dal loop ricevono anche `agent:autofix`. È la prova di provenienza
che consente ai fixer redflag/redcheck, al rescuer e al recycle di operare sulle
PR owner-authored senza trattare ogni PR dell'owner come automatica. `fix/*`
resta compatibile con le PR storiche.

## La quota è condivisa col sito

Ogni run del fixer compete con il ciclo di `frontaliereticino.ch` sulla stessa
quota Claude. Questo repo ha **precedenza inferiore per costruzione**: il gate
di quota legge anche il beacon del sito e cede, mentre il sito non legge mai il
nostro (`QUOTA_BEACON_PEER_REPO`).

Il beacon Claude resta osservabile, ma `issue-fix` e il drainer usano Codex come
provider primario e Claude come fallback. Per questo il drainer non congela la
coda quando è attivo `FOLLOWUP_CODEX_FALLBACK_MODE=1`: promuove il prossimo
lavoro e lascia al fixer la decisione di usare il fallback. Il blocco
deterministico resta disponibile quando il fallback è disabilitato.

Quando il gate blocca, la issue viene ri-accodata **senza consumare un
tentativo**: una run che non ha nemmeno letto la issue non è un fallimento del
fixer, ed era importante distinguerlo — è la differenza fra una coda che
riparte da sola e una che si auto-parcheggia.
