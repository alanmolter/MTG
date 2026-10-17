# Pool v3: relatório

- manifest_hash: `12190fe709d268ee4af6e281b91bf7d80439209575b0413674e0d29e0bb345cf`
- origem: database; decks elegíveis: 1103; seed 20261016; melhor tentativa 768 de 4000 (score 0.7061)
- pares quase-duplicados (Jaccard exato >= 0.8 entre candidatos LSH 32x4): 1601; clusters: 614
- grupos: 66 (treino 33, holdout 9, benchmark 24); arquétipos: 109 (treino 59, holdout 23, benchmark 27)
- mínimos: holdout 207 decks / 23 arquétipos (>= 150/15); benchmark 54 decks / 27 arquétipos, máx 5 por arquétipo (>= 40/8, <= 5)
- violações: nenhuma

## Jaccard máximo entre splits (exato, conjuntos de oracle_id do main)

- train x holdout: 0.7143 (decks 5869 x 2677)
- train x benchmark: 0.7647 (decks 2663 x 5856)
- holdout x benchmark: 0.7500 (decks 5564 x 5985)
- train_near x holdout_near: 0.7917 (decks 1364 x 1250)
- deck_hash em mais de um split: 0; group_id em mais de um split: 0; cluster em train_near e holdout_near: 0

- caveats: control no holdout: 13 decks (pioneer 9, vintage 4; na geração anterior eram 4), sem mover grupos. Nenhum control de Modern no holdout: os grupos gigantes de Modern (arquétipo + quase-duplicatas) ficam inteiros no treino. Amostra pequena; trate o win rate de control no holdout com cautela.
- holdout_near: 170 decks com exclude_from_train=true (saem do treino; treino efetivo 672)

## Por split

| key | train | holdout | benchmark | holdout_near | total |
|---|---|---|---|---|---|
| total | 842 | 207 | 54 | 170 | 1103 |

holdout_near é tirado do treino (coluna train inclui esses decks).

## Por formato

| key | train | holdout | benchmark | holdout_near | total |
|---|---|---|---|---|---|
| legacy | 60 | 18 | 9 | 12 | 87 |
| modern | 596 | 115 | 15 | 120 | 726 |
| pauper | 63 | 18 | 9 | 13 | 90 |
| pioneer | 38 | 19 | 7 | 8 | 64 |
| standard | 55 | 17 | 8 | 11 | 80 |
| vintage | 30 | 20 | 6 | 6 | 56 |

## Por macro-arquétipo

| key | train | holdout | benchmark | holdout_near | total |
|---|---|---|---|---|---|
| aggro | 107 | 51 | 27 | 21 | 185 |
| combo-ramp | 100 | 22 | 2 | 28 | 124 |
| control | 178 | 13 | 10 | 28 | 201 |
| midrange | 453 | 121 | 15 | 93 | 589 |
| unknown | 4 | 0 | 0 | 0 | 4 |

## Por cor (número de cores das mágicas não-terreno)

| key | train | holdout | benchmark | holdout_near | total |
|---|---|---|---|---|---|
| 1 | 100 | 19 | 4 | 24 | 123 |
| 2 | 308 | 83 | 24 | 56 | 415 |
| 3+ | 433 | 105 | 26 | 90 | 564 |
| c | 1 | 0 | 0 | 0 | 1 |

## Por classe de tamanho

| key | train | holdout | benchmark | holdout_near | total |
|---|---|---|---|---|---|
| offsize_61_63 | 14 | 8 | 3 | 1 | 25 |
| standard60 | 812 | 198 | 51 | 168 | 1061 |
| yorion_80_81 | 16 | 1 | 0 | 1 | 17 |

## Por formato x macro

| key | train | holdout | benchmark | holdout_near | total |
|---|---|---|---|---|---|
| legacy / aggro | 17 | 7 | 2 | 1 | 26 |
| legacy / combo-ramp | 0 | 10 | 0 | 0 | 10 |
| legacy / control | 5 | 0 | 0 | 2 | 5 |
| legacy / midrange | 34 | 1 | 7 | 9 | 42 |
| legacy / unknown | 4 | 0 | 0 | 0 | 4 |
| modern / aggro | 9 | 8 | 11 | 0 | 28 |
| modern / combo-ramp | 98 | 0 | 1 | 27 | 99 |
| modern / control | 168 | 0 | 0 | 26 | 168 |
| modern / midrange | 321 | 107 | 3 | 67 | 431 |
| pauper / aggro | 21 | 18 | 4 | 6 | 43 |
| pauper / control | 0 | 0 | 5 | 0 | 5 |
| pauper / midrange | 42 | 0 | 0 | 7 | 42 |
| pioneer / aggro | 20 | 8 | 3 | 4 | 31 |
| pioneer / combo-ramp | 0 | 2 | 0 | 0 | 2 |
| pioneer / control | 0 | 9 | 0 | 0 | 9 |
| pioneer / midrange | 18 | 0 | 4 | 4 | 22 |
| standard / aggro | 38 | 6 | 3 | 10 | 47 |
| standard / control | 0 | 0 | 5 | 0 | 5 |
| standard / midrange | 17 | 11 | 0 | 1 | 28 |
| vintage / aggro | 2 | 4 | 4 | 0 | 10 |
| vintage / combo-ramp | 2 | 10 | 1 | 1 | 13 |
| vintage / control | 5 | 4 | 0 | 0 | 9 |
| vintage / midrange | 21 | 2 | 1 | 5 | 24 |
