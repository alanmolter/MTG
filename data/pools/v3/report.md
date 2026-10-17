# Pool v3: relatório

- manifest_hash: `1bdc0d1cd10e42fcbc3c8207c5ef87539e05a3b438a35f1ce5d964282c84681a`
- origem: database; decks elegíveis: 1061; seed 20261016; melhor tentativa 822 de 4000 (score 0.7487)
- pares quase-duplicados (Jaccard exato >= 0.8 entre candidatos LSH 32x4): 1520; clusters: 590
- grupos: 66 (treino 34, holdout 9, benchmark 23); arquétipos: 107 (treino 61, holdout 20, benchmark 26)
- mínimos: holdout 189 decks / 20 arquétipos (>= 150/15); benchmark 52 decks / 26 arquétipos, máx 5 por arquétipo (>= 40/8, <= 5)
- violações: nenhuma

## Jaccard máximo entre splits (exato, conjuntos de oracle_id do main)

- train x holdout: 0.7500 (decks 5985 x 5564)
- train x benchmark: 0.7917 (decks 5963 x 3367)
- holdout x benchmark: 0.6129 (decks 960 x 5974)
- train_near x holdout_near: 0.7917 (decks 1250 x 1364)
- deck_hash em mais de um split: 0; group_id em mais de um split: 0; cluster em train_near e holdout_near: 0

## Por split

| key | train | holdout | benchmark | holdout_near | total |
|---|---|---|---|---|---|
| total | 820 | 189 | 52 | 164 | 1061 |

holdout_near é tirado do treino (coluna train inclui esses decks).

## Por formato

| key | train | holdout | benchmark | holdout_near | total |
|---|---|---|---|---|---|
| legacy | 48 | 14 | 8 | 10 | 70 |
| modern | 581 | 110 | 15 | 116 | 706 |
| pauper | 62 | 16 | 9 | 12 | 87 |
| pioneer | 44 | 13 | 7 | 9 | 64 |
| standard | 54 | 17 | 8 | 11 | 79 |
| vintage | 31 | 19 | 5 | 6 | 55 |

## Por macro-arquétipo

| key | train | holdout | benchmark | holdout_near | total |
|---|---|---|---|---|---|
| aggro | 105 | 46 | 26 | 19 | 177 |
| combo-ramp | 101 | 19 | 1 | 15 | 121 |
| control | 182 | 4 | 10 | 43 | 196 |
| midrange | 432 | 120 | 15 | 87 | 567 |

## Por cor (número de cores das mágicas não-terreno)

| key | train | holdout | benchmark | holdout_near | total |
|---|---|---|---|---|---|
| 1 | 90 | 25 | 4 | 7 | 119 |
| 2 | 305 | 68 | 23 | 66 | 396 |
| 3+ | 424 | 96 | 25 | 91 | 545 |
| c | 1 | 0 | 0 | 0 | 1 |

## Por formato x macro

| key | train | holdout | benchmark | holdout_near | total |
|---|---|---|---|---|---|
| legacy / aggro | 14 | 5 | 3 | 0 | 22 |
| legacy / combo-ramp | 0 | 9 | 0 | 0 | 9 |
| legacy / control | 5 | 0 | 0 | 4 | 5 |
| legacy / midrange | 29 | 0 | 5 | 6 | 34 |
| modern / aggro | 9 | 7 | 11 | 0 | 27 |
| modern / combo-ramp | 96 | 0 | 1 | 14 | 97 |
| modern / control | 164 | 0 | 0 | 36 | 164 |
| modern / midrange | 312 | 103 | 3 | 66 | 418 |
| pauper / aggro | 20 | 16 | 5 | 4 | 41 |
| pauper / control | 0 | 0 | 4 | 0 | 4 |
| pauper / midrange | 42 | 0 | 0 | 8 | 42 |
| pioneer / aggro | 20 | 8 | 3 | 4 | 31 |
| pioneer / combo-ramp | 2 | 0 | 0 | 0 | 2 |
| pioneer / control | 9 | 0 | 0 | 3 | 9 |
| pioneer / midrange | 13 | 5 | 4 | 2 | 22 |
| standard / aggro | 39 | 6 | 1 | 10 | 46 |
| standard / control | 0 | 0 | 5 | 0 | 5 |
| standard / midrange | 15 | 11 | 2 | 1 | 28 |
| vintage / aggro | 3 | 4 | 3 | 1 | 10 |
| vintage / combo-ramp | 3 | 10 | 0 | 1 | 13 |
| vintage / control | 4 | 4 | 1 | 0 | 9 |
| vintage / midrange | 21 | 1 | 1 | 4 | 23 |
