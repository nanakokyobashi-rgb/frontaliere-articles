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

   **Eccezione — fix provabile solo da una run su `main`.** Se la PR tocca
   `.github/workflows/**` o la config dell'action Claude (`claude_args`,
   `settings`, sandbox, `permissionMode`) per un bug osservabile solo a
   runtime (sandbox/bwrap, permessi, rate-limit, dispatch) — cioè nessun test
   o lettura del diff può dimostrare che il fix funziona, solo una run reale
   — **non usare `Closes #<n>`**: usa `Refs #<n>` e, dopo l'apertura della PR,
   `gh issue edit <n> --add-label awaiting-production-proof`. La issue resta
   aperta finché qualcuno non allega la misura di una run verde su `main`
   (vedi #151: la PR #147 è stata mergiata e la issue #127 chiusa 8 minuti
   prima che la misura in produzione smentisse la diagnosi). Il marker
   `FIX_OUTCOME: pr-created` resta comunque quello giusto — è la PR ad essere
   aperta, non il verdetto del fixer a mancare.
10. La PR entra da sola nel ciclo di review e auto-merge. **Non mergiare a mano.**

## Issue aggregate: il circuit-breaker

Una issue con molti item distinti non entra in un solo run: tentarli tutti
sfora il budget turni e consegna **zero** PR — è il modo più costoso di
fallire, perché si paga tutto e non si ottiene niente.

**Regola ferrea:** fixa **esattamente un item**, poi fermati. Anche con turni
residui. Gli altri vanno elencati in `## Non implementato`, che li ri-accoda.
Ogni ciclo chiude almeno un item, quindi converge.

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

È **mutua esclusione, non stato**. Viene apposto dal claim gate e rilasciato su
ogni percorso terminale. Se resta appeso su una issue aperta, quella issue è
esclusa dal fixer **per sempre** — non con un errore: semplicemente non viene
più presa. Se ne trovi uno orfano su una issue senza run attive, va rimosso.

## La quota è condivisa col sito

Ogni run del fixer compete con il ciclo di `frontaliereticino.ch` sulla stessa
quota Claude. Questo repo ha **precedenza inferiore per costruzione**: il gate
di quota legge anche il beacon del sito e cede, mentre il sito non legge mai il
nostro (`QUOTA_BEACON_PEER_REPO`).

Quando il gate blocca, la issue viene ri-accodata **senza consumare un
tentativo**: una run che non ha nemmeno letto la issue non è un fallimento del
fixer, ed era importante distinguerlo — è la differenza fra una coda che
riparte da sola e una che si auto-parcheggia.
