# Decisões de treino de RL

## Contrato da próxima rodada

O objetivo imediato não é resolver Magic inteiro. É aprender a escolher entre
passar e jogar uma mágica legal, a partir da mão própria e do estado público,
contra um oponente Forge fixo. Vitória/derrota continua sendo a métrica
primária; recompensas densas só aceleram crédito e são limitadas a `±0,5` por
episódio, abaixo do resultado terminal `±1`.

Antes de iniciar horas de GPU, `training:preflight` exige controle externo,
máscara não vazia, mão própria observável e ações confirmadamente aplicadas.

## Pesquisa e escolhas

- [Huang & Ontañón, 2020](https://arxiv.org/abs/2006.14171) demonstra por que
  mascarar ações inválidas é importante em policy gradients. Por isso o modo
  padrão é `Discrete(512)` com máscara vinda do Forge, e não o produto cartesiano
  não mascarado de 65.536 ações.
- [Ng, Harada & Russell, 1999](https://people.eecs.berkeley.edu/~russell/papers/icml99-shaping.pdf)
  estabelece shaping baseado em potencial; como nossos sinais são heurísticos,
  usamos caps explícitos e mantemos vitória/derrota dominante.
- [Silver et al., AlphaZero](https://arxiv.org/abs/1712.01815) combina self-play,
  policy/value e busca; [Browne et al., MCTS](https://ieeexplore.ieee.org/document/6145622/)
  descreve a busca. Não habilitamos MCTS ainda: Magic possui informação oculta,
  aleatoriedade, ações incompletas e o bridge ainda não clona estados. Uma árvore
  sobre esse contrato produziria avaliações enganosas.
- Um estudo de CCGs relata justamente informação oculta, aleatoriedade e grande
  espaço combinatório como dificuldades centrais, favorecendo política mascarada
  e self-play incremental ([Gopalakrishnan et al., 2023](https://www.sciencedirect.com/science/article/pii/S1875952123000496)).

## Sequência segura de evolução

1. Medir win rate contra `pass`, aleatório legal e Forge AI em seeds fixas.
2. Implementar ataque, bloqueio, alvo e habilidades com enumeração/máscara legal.
3. Só então adicionar uma busca PUCT curta, usando clones determinísticos do
   estado e a rede como prior/value.
4. Evoluir para liga de self-play e promover apenas após superar o campeão em
   várias seeds e matchups nunca vistos.

Embeddings/cosseno são sinais para geração e avaliação de deck; não entram na
recompensa de combate até existir validação causal de que predizem vitórias.
