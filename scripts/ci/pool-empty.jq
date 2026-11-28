# Il run report di un tentativo senza articolo prova che il pool era vuoto?
# Usato da generate-article.yml per `pool_empty`: con tutti i tentativi dichiarati
# e questa prova su ognuno, un anello a 90 s riaprirebbe lo stesso pool.
# Non vale se i backstop D/E del pre-spend gate hanno ripristinato candidati.
(.article.id // null) == null
and (.headlines.preSpendGateBackstopRestored // 0) == 0
and (.poolKnownEmpty == true or .evergreenPool.saturated == true or .headlines.preSpendGateTotalRejection == true)
