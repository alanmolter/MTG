"""
Configuração centralizada para o sistema ML do Magic.
Define todas as constantes de dimensionalidade e parâmetros de modelo.

IMPORTANTE: Todas as mudanças aqui devem ser propagadas para:
- encoder.py (STATE_FEATURE_DIM)
- train_value.py (input_dim)
- deckEvaluationBrain.ts (BRAIN_INPUT_DIM)
"""

# ============================================================================
# DIMENSIONALIDADE DE FEATURES
# ============================================================================

# Estado do deck codificado pelo encoder
# Formato: [commander_embedding (128) + deck_encoding (128)]
CARD_EMBEDDING_DIM = 128
COMMANDER_DECK_ENCODING_DIM = 256

# Brain v2: Features estratégicas extraídas do estado
# Inclui: mana curve, card types, colors, synergies, etc.
STATE_FEATURE_DIM = 50

# ============================================================================
# VALIDAÇÃO DE DIMENSIONALIDADE
# ============================================================================

def validate_encoder_output(encoded_vector):
    """
    Valida que o encoder retorna exatamente COMMANDER_DECK_ENCODING_DIM dimensões.
    
    Args:
        encoded_vector: numpy array ou tensor do encoder
        
    Raises:
        ValueError: Se dimensão não corresponder
    """
    import numpy as np
    
    if isinstance(encoded_vector, np.ndarray):
        actual_dim = encoded_vector.shape[-1]
    else:
        # Tensor PyTorch
        actual_dim = encoded_vector.shape[-1]
    
    if actual_dim != COMMANDER_DECK_ENCODING_DIM:
        raise ValueError(
            f"Encoder output dimension mismatch! "
            f"Expected {COMMANDER_DECK_ENCODING_DIM}, got {actual_dim}"
        )


def validate_brain_state_vector(state_vector):
    """
    Valida que o vetor de estado para Brain tem exatamente STATE_FEATURE_DIM dimensões.
    
    Args:
        state_vector: numpy array ou tensor com features
        
    Raises:
        ValueError: Se dimensão não corresponder
    """
    import numpy as np
    
    if isinstance(state_vector, np.ndarray):
        actual_dim = state_vector.shape[-1]
    else:
        # Tensor PyTorch
        actual_dim = state_vector.shape[-1]
    
    if actual_dim != STATE_FEATURE_DIM:
        raise ValueError(
            f"Brain state vector dimension mismatch! "
            f"Expected {STATE_FEATURE_DIM}, got {actual_dim}"
        )


# ============================================================================
# PARÂMETROS DE TREINAMENTO
# ============================================================================

# Learning rate para Card Learning
CARD_LEARNING_RATE = 0.01

# Pesos de aprendizado por fonte (Problema 4)
LEARNING_WEIGHTS = {
    "forge_reality": 0.5,      # Dados reais, maior impacto
    "unified_learning": 0.008, # Simulação, impacto médio
    "rl_feedback": 0.1,        # Retroalimentação RL
    "user_generation": 0.1,    # Feedback implícito do usuário
}

# Limites de peso para card_learning
MIN_CARD_WEIGHT = 0.1
MAX_CARD_WEIGHT = 50.0

# ============================================================================
# PARÂMETROS DE EMBEDDINGS
# ============================================================================

# Word2Vec para sinergias de cartas
EMBEDDING_DIM = 100
EMBEDDING_WINDOW = 5
EMBEDDING_MIN_COUNT = 2
EMBEDDING_WORKERS = 4

# ============================================================================
# PARÂMETROS DE VALIDAÇÃO
# ============================================================================

# Confiança mínima de dados para treino de embeddings
MIN_DATA_CONFIDENCE = 0.7

# Percentual máximo de dados sintéticos permitido
MAX_SYNTHETIC_PERCENTAGE = 0.2

# ============================================================================
# LOGGING E DEBUG
# ============================================================================

LOG_LEVEL = "INFO"
DEBUG_MODE = False

# Ativar validação rigorosa de dimensionalidade
STRICT_DIMENSION_VALIDATION = True
