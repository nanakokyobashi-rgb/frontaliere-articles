# Follow-up Triage Instructions

Contratto operativo di `post-merge-followup.yml`. Dopo il merge, estrae il
lavoro residuo dal body della PR e dai commenti del reviewer e lo raccoglie in
**una sola issue aggregata** con label `follow-up`, così lo scope deferito non
evapora.

Portato da `valerielinc-ops/frontaliere-si-o-no`. Struttura identica; cambia il
filtro di scopo, che qui è quello di `REVIEW.md` di questo repo.

## Il gate anti-nipote (zero Claude, PRIMA del triage)

Questo workflow gira su **ogni** PR mergiata — comprese quelle che *fixano* un
follow-up. Senza guardia il ciclo si auto-alimenta per costruzione:

> follow-up #A → PR di fix → merge → il reviewer lascia un 🟡 → **nuovo
> follow-up #B (nipote)** → PR di fix → …

Ogni giro costa tre run Claude (triage → fixer → review) sulla quota
**condivisa col sito**. Sul sito questo treadmill è arrivato a bruciare
centinaia di run a settimana.

Lo step deterministico salta interamente il triage quando la PR mergiata
dichiara di chiudere (`Closes`/`Fixes`/`Resolves`) almeno una issue con label
`follow-up`. Lo scope residuo di un fix-di-follow-up, se reale, appartiene alla
issue **padre**, che resta aperta finché non è risolta davvero.

**Proceed-safe nella direzione opposta al gate already-resolved:** body
illeggibile, riferimenti non parsati o errore di `gh` → il triage **gira** —
meglio un follow-up di troppo che perderne uno di una PR organica.

## Scopo

Ogni 🟡 nit, ogni ❓ q del reviewer e ogni voce di `## Non implementato` deve
finire in **una** di tre destinazioni: un item nella issue aggregata, un drop
**motivato**, oppure — se è pura verifica del sito pubblicato senza file da
editare — una voce in una checklist promemoria nel commento di chiusura.

Nessun silenzio. Un item che sparisce senza motivo è il modo in cui lo scope
deferito evapora.

## Input

- La PR mergiata: `gh pr view $PR_NUMBER --json number,title,body,mergedAt,url`
- Le review del bot: `gh api repos/$REPO/pulls/$PR_NUMBER/reviews`, filtrando
  `user.type == "Bot"` e login che inizia per `claude`
- Le issue già collegate: `gh issue list --label follow-up --state all --search "PR #$PR_NUMBER"`

## Regole di parsing

### Dal body della PR

Estrai `## Non implementato (ancora)`. **Non è scope chiuso: è il piano di
completamento di un task ancora aperto.**

- `Nessuno` o sezione vuota → nessun candidato, il task è completo.
- `blocked: <causa esterna reale>` → candidato, tracciato fino allo sblocco.
- **Ogni altra voce di scope dovuto → candidato.** Il task non è chiuso finché
  non è fatta. `out of scope` e `posposto` **non** sono scappatoie valide.

Restano fuori solo le quattro categorie hard-exclude qui sotto, che non sono
scope-feature.

### Dalle review del bot

- `🔴 Important` → **skip.** Un 🔴 blocca il merge: se la PR è mergiata, o è
  stato fixato in-PR o droppato consapevolmente. Niente follow-up retroattivi.
- `🟡 Nit` → candidato.
- `❓ q` → candidato, riformulato come "Verifica: …".
- `🟣 Pre-existing` → candidato solo se il file è ancora nel diff.
- Voci di `## Adversarial check` → un candidato ciascuna.

## Filtro di scopo

Applica il filtro di `REVIEW.md`. Un item passa se impatta **la correttezza
della superficie pubblicata**, **il contratto col sito** (`engine/` ↔ `host/`),
**il ciclo di pubblicazione** o **la correttezza del corpus generato**.
Altrimenti droppa, con la ragione registrata nel commento di chiusura.

### Hard-exclude: churn non azionabile

Prima del filtro di scopo, droppa (ragione: `non-actionable-churn`) gli item che
sono manutenzione documentale o igiene pura, **chiunque li abbia sollevati**:

- Rot di riferimenti: "aggiorna i line anchor", "i riferimenti `file:NNN` sono
  sfasati", "il link alla PR #N è stale".
- "Documenta l'intento": commenti che spiegano codice già funzionante, senza
  cambio di comportamento.
- Stile, leggibilità, naming, formattazione non legati a un bug.
- Item che **il reviewer stesso** ha marcato `— deferred, non funnel-critical`.

Apri un follow-up **solo** se l'item è rilevante per lo scopo **e** azionabile,
cioè esiste un cambiamento di comportamento concreto da fare. Nel dubbio, pesa
sul drop: una doc-nit persa non costa niente, una issue di churn costa una run
del fixer sulla quota condivisa col sito. **È la leva anti-spreco più alta di
questo workflow.**

### Hard-exclude: nit sulla copertura test

Droppato **sempre** (ragione: `missing-test-nit`), prima del filtro di scopo,
da qualunque fonte arrivi e **anche se l'item è rilevante**. Il reviewer non
dovrebbe più emetterne (`REVIEW.md` → IGNORA), ma questa resta la cintura per i
residui e per gli item del body.

Droppa: "manca un test per X", "aggiungere coverage", "pinnare il comportamento
con un test".

**Non** droppare: un BUG in un test **esistente** — assertion sbagliata, regex
leaky che resta verde sulla regressione, fixture con date assolute. È
correttezza, non copertura.

### Hard-exclude: item di sola verifica live

Un item la cui unica azione è ispezionare ciò che è già pubblicato ("controlla
che il feed si aggiorni", "curl l'endpoint") non ha codice da cambiare: aprire
una issue lo instraderebbe al fixer su una PR vuota. Va in una **checklist
promemoria** nel commento di chiusura, senza issue e senza fixer.

**Eccezione:** un item che mescola la verifica con un'edit concreta → solleva la
parte editabile, normalmente.

### Hard-exclude: rischio senza condizione di accettazione

Droppato **sempre** (ragione: `no-acceptance-condition`), prima del filtro di
scopo e da qualunque fonte arrivi — in particolare dai bullet di
`## Adversarial check`, che ne sono la fonte dominante.

Un item entra in coda solo se porta con sé qualcosa che, girando, può provare
che è stato affrontato: la sua `Suggested action` deve citare fra backtick
almeno un token con punteggiatura di codice. Un rischio che resta in prosa
(«nessun gate impedisce un drift futuro») non si può mai provare affrontato —
nessuna evidenza lo chiuderà — quindi entra e non esce più. Il metro è lo
stesso della chiusura, `citedTokens()` in
`scripts/ci/followup-resolution-match.mjs`: ammettere sotto una barra più bassa
di quella che libera è ciò che produce una coda che non si esaurisce.

**Il metro si applica alla `Suggested action` che stai per scrivere, non al
bullet grezzo.** Su un testo privo di quella regione l'oracolo ricade
sull'intero testo, quindi un backtick che finirà in `Original text` — regione
che la chiusura esclude per costruzione — basterebbe ad ammettere un item già
non chiudibile. Prima formula l'azione, poi giudica quella.

**Non è una scusa per perdere lavoro azionabile:** se l'item ha un punto
d'intervento ma la frase non lo cita, **derivalo** invece di scartare — ma in una
forma che l'oracolo riconosce, cioe' con punteggiatura di codice
(token-esempio: `funzione()`, `oggetto.campo`, `campo >= 1`). Le forme che NON
qualificano sono tre (token-controesempio: `percorso/file.mjs`, `nomeCampo`,
`run()`): il path nudo, l'identificatore nudo e il token troppo corto — anche
con la forma giusta. Usa il nome per esteso: `nomeFunzione()`, non `run()`. Lo scarto è per i rischi che un punto d'intervento
non ce l'hanno. Ciò che viene scartato va nel commento di summary della PR,
come per la verifica live.

## Output

Una **sola** issue aggregata per PR, titolo `follow-up(#<PR>): <sintesi>`, con
label `follow-up`. Non una issue per item: il triage della coda lavora una issue
alla volta, e frammentare moltiplica le run senza aggiungere informazione.

Nel commento di chiusura sulla PR: cosa è diventato un item, cosa è stato
droppato **e perché**, e la checklist delle verifiche live.

## Formato del corpo della issue

Questa struttura **non è cosmetica: è l'unico appiglio che ha la chiusura.**
`scripts/ci/reconcile-followups.mjs` — voce `identical` nel
`loop-sync-manifest.json`, quindi la sua evoluzione sul sito scende qui — spezza
il corpo sugli heading `### <n>.` e per ogni item chiede una *condizione di
accettazione falsificabile*: la regione `Suggested action` deve esistere **e**
citare fra backtick almeno un token che porti punteggiatura di codice
(token-esempio: `nomeFunzione()`, `oggetto.campo`, `contatore >= 1`). Un item che non la
porta non è lavoro verificabile ma un rischio in prosa: non si può provare né
fatto né da fare, e resta in coda per costruzione.

Misurato il 2026-09-06 sulle 227 follow-up di questo repo (ogni stato): 201 corpi
senza `### <n>.`, 26 con la struttura ma zero item validi, **0 corpi contenenti
la stringa `Suggested action`**. Il divario non era teorico: era totale, e a
partire dal primo mirror avrebbe reso non auto-chiudibile ogni singola aggregata
del corpus. Il formato qui sotto ha gli stessi nomi di campo del sito
**alla lettera** — è il vincolo che li tiene leggibili dallo stesso oracolo.

````markdown
Title: follow-up(#<PR>): <N> item deferiti — <titolo breve della PR>
Body:

## Origine

- PR: #<PR_NUMBER> — <PR_TITLE> (mergiata <mergedAt>)
- URL: <PR url>

## Item

### 1. <l'item in una riga>
- Source: <PR body Non implementato | reviewer 🟡 nit | reviewer ❓ q | adversarial check>
- Stato dichiarato nella PR: <lo stato letterale verbatim, es. `blocked: <causa>` | nessuno>
- Original text:
  > <verbatim>
- Funnel impact: <ciclo di pubblicazione | contratto col sito | superficie pubblicata | none>
- Rationale: <perché passa il filtro di scopo>
- Suggested action: <il passo concreto, che DEVE citare fra backtick almeno un token di codice (token-esempio: `discoverFreeModels()`, `staleIds.length`, `coerceRecordScore()`). Se il passo non è ovvio, cita comunque il simbolo su cui indagare — nella forma `simbolo()` o `oggetto.campo`, non il nome del file nudo, che vale zero token.>

### 2. <l'item in una riga>
- Source: ...
- Stato dichiarato nella PR: ...
- Original text:
  > ...
- Funnel impact: ...
- Rationale: ...
- Suggested action: <... con almeno un token fra backtick (token-esempio: `coerceRecordScore()`)>
````

`Stato dichiarato nella PR` è **obbligatorio su ogni item, anche quando vale
`nessuno`**: è il campo che distingue a macchina un residuo che aspetta una
decisione umana da uno che potrebbe chiudersi subito, senza rileggere a mano la
PR d'origine.

Anche con **un solo** item la issue mantiene la forma aggregata (una sola
sezione `### 1.`): un corpo senza struttura a item il reconciler lo legge
`aggregate-unparsed`, cioè «non so leggerlo», e non lo chiude mai.

Il campo `Suggested action` è il nome esatto atteso: `Prossimo passo:`,
`Next step:` o la stessa cosa detta in prosa **non** vengono viste.
