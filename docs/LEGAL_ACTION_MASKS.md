# Máscaras legais do treino Forge/Ray

O agente escolhe ações em um catálogo dinâmico de 512 slots produzido no ponto
de decisão real do Forge. `0` é passar/encerrar a escolha quando permitido;
`1..509` são alternativas legais da página corrente; `510/511` navegam entre
páginas. Cada slot vem com tipo, carta-fonte, alvo e, quando aplicável, texto
da habilidade. A observação informa controlador, zona e estado de ataque da
carta. O mesmo catálogo é usado para aplicar a ação, evitando divergência
entre máscara e execução.

Tipos cobertos no perfil atual: jogar terreno/conjurar mágicas simples, declarar
atacantes, declarar bloqueadores, selecionar alvos e ativar habilidades simples
não-mana. Custos de mana são pagos pelo Forge. O ambiente rejeita máscaras ou
metadados ausentes, tamanhos errados e referências a cartas fora da observação.
Uma ação mascarada é recusada sem avançar a partida. A via autoregressiva sem
máscara condicional foi desabilitada para treino.

Isto **não** equivale a cobrir todas as regras/cartas de Magic. O contrato
atual bloqueia escolhas modais/opcionais, custos X ou adicionais complexos,
gatilhos com escolha, restrições globais de combate e atribuição não trivial
de dano/ordem de múltiplos combatentes. Quando uma dessas situações surge em
combate, o episódio termina com `policy_contract_violation`; ela não é
silenciosamente decidida pela IA do Forge. `full_magic_training_ready=false`
permanece no protocolo. Resultados deste perfil não devem ser apresentados
como domínio completo de Magic nem usados para promover um modelo com essa
alegação.

Antes do treino de duas GPUs, `scripts/train-dual-gpu.ps1` exige:

1. `training_preflight --min-gpus 2`: duas GPUs CUDA, controlador externo,
   máscara consistente, mão visível e ações efetivamente aplicadas.
2. `training:mechanics`: partidas determinísticas ao vivo para terreno/conjuração,
   ataque, bloqueio, alvo, habilidade ativada e rejeição de slot inválido.

Para executar isoladamente: `npm run training:preflight` e
`npm run training:mechanics`. Para iniciar uma rodada de duas horas:
`npm run train:ray:dual-gpu -- -BudgetHours 2`.

Esses gates validam integração e legalidade do subconjunto. Aprendizado
estratégico ainda requer avaliação em matchups não vistos, baselines fixos e
regras/decks mais amplos; recompensa de treino sozinha não prova evolução.
