<!--
  Il body di questa PR ha un gate deterministico: lo step «PR-body completeness»
  di `tests.yml`, dentro il check-run che governa il merge.
  Non e' burocrazia — le due sezioni sono i due input di `auto-merge-eval`, e
  `Closes` e' l'unica cosa che chiude la issue al merge.

  Tre trappole misurate, tutte e tre gia' costate un ciclo di review:

  1. La sezione si chiude al PRIMO heading di qualunque livello. Un `###`
     subito sotto `## Implementato` la lascia VUOTA e il gate fallisce in 15
     secondi. Bullet sostanziosi PRIMA di qualunque sottosezione.

  2. Su questo repo l'header e' `## Non implementato (ancora)`, CON «(ancora)».
     Sul sito (`frontaliere-si-o-no`) e' senza. Copiare un body dall'uno
     all'altro fa fallire `contract`.

  3. La keyword di chiusura va scritta in INGLESE. GitHub riconosce solo
     close/closes/closed, fix/fixes/fixed, resolve/resolves/resolved — e NON i
     gerundi (Closing/Fixing). Un «Chiude» al posto di «Closes» e' prosa: il
     link non viene creato e la issue resta aperta con la fix gia' su main.
     E' successo davvero, sulla PR #139: la issue che citava e' rimasta nel
     backlog finche' non l'ha chiusa una persona a mano.

  4. Una keyword per issue, e una per riga. Due riferimenti dopo una sola
     keyword ne chiudono soltanto il primo: gli altri restano aperti in
     silenzio.

  I riferimenti qui sopra sono di proposito senza numero: questo commento resta
  nel body della PR, e un esempio con un numero vero verrebbe letto dal gate
  come una chiusura rivendicata.
-->

## Implementato

- 

## Non implementato (ancora)

<!--
  Ogni bullet non vuoto in `## Non implementato (ancora)` deve dichiarare uno
  stato riconosciuto:

      **Stato:** `in questa PR` | `PR concatenata #N` | `per scelta` |
      `by construction` | `falso positivo` (`false positive` e' sinonimo) |
      `blocked: <causa esterna reale>` | `blocked: decisione del proprietario`
      (`blocked: owner decision` e `blocked: scelta del proprietario` sono sinonimi)

  `PR concatenata` senza `#N` non e' tracciabile. `blocked:` tecnico mantiene
  il lavoro aperto; gli stati decisionali (`per scelta`, `by construction`,
  `falso positivo` / `false positive` e owner decision) richiedono nello stesso
  bullet `**Motivo:** <causa concreta>. **Prossimo passo:** <azione concreta>.`
  La negazione di `falso positivo` non chiude il bullet: «non e' un falso
  positivo» resta lavoro dovuto.

  Non valgono come stato: «out of scope», «posposto», «vale un giro dedicato»,
  «separatamente», «prima o poi». Sono le scappatoie che REVIEW.md §98 esclude,
  e il gate le rifiuta.

  Se il task e' completo, cancella i bullet e scrivi una riga sola: Nessuno
-->

- 

Closes #
