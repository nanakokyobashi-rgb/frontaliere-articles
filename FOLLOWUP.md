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

Restano fuori solo le tre categorie hard-exclude qui sotto, che non sono
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

## Output

Una **sola** issue aggregata per PR, titolo `follow-up(#<PR>): <sintesi>`, con
label `follow-up`. Non una issue per item: il triage della coda lavora una issue
alla volta, e frammentare moltiplica le run senza aggiungere informazione.

Nel commento di chiusura sulla PR: cosa è diventato un item, cosa è stato
droppato **e perché**, e la checklist delle verifiche live.
