"""
gerar_documentacao_projeto.py
─────────────────────────────
Gera o arquivo DOCUMENTACAO_PROJETO.docx — um guia didático do projeto
mtg-deck-mvp escrito para uma pessoa SEM conhecimento de ML/IA/TI.

Uso:
    .venv\\Scripts\\python.exe scripts\\gerar_documentacao_projeto.py

Saída:
    DOCUMENTACAO_PROJETO.docx (na raiz do projeto)
"""
from __future__ import annotations

from pathlib import Path

from docx import Document
from docx.enum.table import WD_ALIGN_VERTICAL
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Cm, Pt, RGBColor


# ---------------------------------------------------------------------------
# Helpers de formatação
# ---------------------------------------------------------------------------

AZUL = RGBColor(0x1F, 0x4E, 0x79)
CINZA_ESCURO = RGBColor(0x40, 0x40, 0x40)
VERDE = RGBColor(0x2E, 0x7D, 0x32)
LARANJA = RGBColor(0xE6, 0x5A, 0x00)
PRETO = RGBColor(0x00, 0x00, 0x00)


def set_font(run, *, size=11, bold=False, italic=False, color=PRETO, name="Calibri"):
    run.font.name = name
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.italic = italic
    run.font.color.rgb = color


def add_heading(doc, text, level=1, color=AZUL):
    h = doc.add_heading(level=level)
    run = h.add_run(text)
    set_font(
        run,
        size={0: 26, 1: 20, 2: 16, 3: 13}.get(level, 12),
        bold=True,
        color=color,
    )
    h.paragraph_format.space_before = Pt(14)
    h.paragraph_format.space_after = Pt(6)
    return h


def add_para(doc, text, *, size=11, bold=False, italic=False, color=PRETO, align=None):
    p = doc.add_paragraph()
    run = p.add_run(text)
    set_font(run, size=size, bold=bold, italic=italic, color=color)
    if align is not None:
        p.alignment = align
    p.paragraph_format.space_after = Pt(6)
    p.paragraph_format.line_spacing = 1.25
    return p


def add_rich_para(doc, segments, *, size=11, align=None):
    """segments = list[(text, bold, italic, color)]"""
    p = doc.add_paragraph()
    for text, bold, italic, color in segments:
        run = p.add_run(text)
        set_font(run, size=size, bold=bold, italic=italic, color=color or PRETO)
    if align is not None:
        p.alignment = align
    p.paragraph_format.space_after = Pt(6)
    p.paragraph_format.line_spacing = 1.25
    return p


def add_bullet(doc, text, *, size=11, bold_first_n=0):
    p = doc.add_paragraph(style="List Bullet")
    if bold_first_n > 0 and ":" in text:
        head, tail = text.split(":", 1)
        run = p.add_run(head + ":")
        set_font(run, size=size, bold=True)
        run2 = p.add_run(tail)
        set_font(run2, size=size)
    else:
        run = p.add_run(text)
        set_font(run, size=size)
    p.paragraph_format.space_after = Pt(3)
    p.paragraph_format.line_spacing = 1.2
    return p


def add_numbered(doc, text, *, size=11):
    p = doc.add_paragraph(style="List Number")
    run = p.add_run(text)
    set_font(run, size=size)
    p.paragraph_format.space_after = Pt(3)
    return p


def add_callout(doc, titulo, corpo, *, cor_titulo=LARANJA):
    """Caixa estilizada: título colorido em negrito + parágrafo."""
    p = doc.add_paragraph()
    run = p.add_run(f"▶ {titulo}")
    set_font(run, size=11, bold=True, color=cor_titulo)
    p.paragraph_format.space_after = Pt(2)

    q = doc.add_paragraph()
    run = q.add_run(corpo)
    set_font(run, size=11, italic=True, color=CINZA_ESCURO)
    q.paragraph_format.space_after = Pt(8)
    q.paragraph_format.left_indent = Cm(0.6)


def add_codeblock(doc, code):
    p = doc.add_paragraph()
    run = p.add_run(code)
    set_font(run, size=10, name="Consolas", color=CINZA_ESCURO)
    p.paragraph_format.left_indent = Cm(0.4)
    p.paragraph_format.space_after = Pt(8)
    p.paragraph_format.line_spacing = 1.1


def add_table(doc, headers, rows, *, col_widths=None):
    tbl = doc.add_table(rows=1 + len(rows), cols=len(headers))
    tbl.style = "Light Grid Accent 1"
    # cabeçalho
    hdr_cells = tbl.rows[0].cells
    for i, h in enumerate(headers):
        hdr_cells[i].vertical_alignment = WD_ALIGN_VERTICAL.CENTER
        p = hdr_cells[i].paragraphs[0]
        run = p.add_run(h)
        set_font(run, size=11, bold=True, color=AZUL)
    # corpo
    for r_idx, row in enumerate(rows, start=1):
        cells = tbl.rows[r_idx].cells
        for c_idx, val in enumerate(row):
            cells[c_idx].vertical_alignment = WD_ALIGN_VERTICAL.CENTER
            p = cells[c_idx].paragraphs[0]
            run = p.add_run(val)
            set_font(run, size=10)
    if col_widths:
        for row in tbl.rows:
            for i, w in enumerate(col_widths):
                row.cells[i].width = Cm(w)
    doc.add_paragraph()  # espaço após tabela
    return tbl


def page_break(doc):
    doc.add_page_break()


# ---------------------------------------------------------------------------
# Conteúdo
# ---------------------------------------------------------------------------

def build_document(output_path: Path) -> None:
    doc = Document()

    # Margens
    for section in doc.sections:
        section.top_margin = Cm(2.0)
        section.bottom_margin = Cm(2.0)
        section.left_margin = Cm(2.2)
        section.right_margin = Cm(2.2)

    # ─────────── CAPA ───────────
    add_para(doc, "", size=1)  # espacinho
    add_para(
        doc,
        "MTG Deck MVP",
        size=36, bold=True, color=AZUL, align=WD_ALIGN_PARAGRAPH.CENTER,
    )
    add_para(
        doc,
        "Uma Inteligência Artificial que aprende a jogar Magic: The Gathering",
        size=18, italic=True, color=CINZA_ESCURO, align=WD_ALIGN_PARAGRAPH.CENTER,
    )
    add_para(doc, "", size=10)
    add_para(
        doc,
        "Documentação Didática Completa — Para Leitores Sem Formação em TI",
        size=14, bold=True, color=LARANJA, align=WD_ALIGN_PARAGRAPH.CENTER,
    )
    for _ in range(6):
        add_para(doc, "", size=10)
    add_para(
        doc,
        "Versão da documentação: 23 de abril de 2026",
        size=11, italic=True, align=WD_ALIGN_PARAGRAPH.CENTER, color=CINZA_ESCURO,
    )
    add_para(
        doc,
        "Status do projeto: Fase 4 concluída, treinamento validado em produção",
        size=11, italic=True, align=WD_ALIGN_PARAGRAPH.CENTER, color=VERDE,
    )

    page_break(doc)

    # ─────────── SUMÁRIO (texto simples) ───────────
    add_heading(doc, "Como ler este documento", level=1)
    add_para(
        doc,
        "Este documento foi escrito para alguém que NUNCA ouviu falar em "
        "inteligência artificial, programação ou engenharia de software. "
        "Toda vez que aparece um termo técnico, ele vem seguido de uma "
        "explicação curta e, sempre que possível, de uma analogia com algo "
        "do dia a dia.",
    )
    add_para(
        doc,
        "Você pode ler do começo ao fim (é uma história) ou pular direto "
        "para a parte que mais interessa — cada seção é autocontida.",
    )

    add_heading(doc, "Mapa do documento", level=2)
    add_bullet(doc, "Parte 1 — O que é o projeto e por que ele existe (visão geral + objetivos).")
    add_bullet(doc, "Parte 2 — A analogia dos três cérebros (como o sistema pensa).")
    add_bullet(doc, "Parte 3 — Os 8 pilares (o alicerce técnico explicado em linguagem humana).")
    add_bullet(doc, "Parte 4 — Como o projeto está organizado fisicamente (pastas e arquivos).")
    add_bullet(doc, "Parte 5 — Cada componente em detalhe (o que faz, por quê e analogia).")
    add_bullet(doc, "Parte 6 — O ciclo de treinamento passo a passo (o dia na vida da IA).")
    add_bullet(doc, "Parte 7 — Como o modelo efetivamente aprende (o momento do aprendizado).")
    add_bullet(doc, "Parte 8 — As bibliotecas escolhidas e por quê.")
    add_bullet(doc, "Parte 9 — Os comandos do dia a dia (o que cada um faz, linha por linha).")
    add_bullet(doc, "Parte 10 — O banco de dados: a memória de longo prazo.")
    add_bullet(doc, "Parte 11 — Testes e garantias de qualidade.")
    add_bullet(doc, "Parte 12 — Resultados esperados, observados e objetivos cumpridos.")
    add_bullet(doc, "Parte 13 — Próximos passos.")
    add_bullet(doc, "Anexo — Glossário de termos técnicos.")

    page_break(doc)

    # ═══════════════════════════════════════════════════════════════════════
    # PARTE 1 — O QUE É O PROJETO
    # ═══════════════════════════════════════════════════════════════════════
    add_heading(doc, "Parte 1 — O que é o projeto e por que ele existe", level=1)

    add_heading(doc, "Magic: The Gathering em 30 segundos", level=2)
    add_para(
        doc,
        "Magic: The Gathering (MTG, daqui em diante) é um jogo de cartas "
        "colecionáveis criado em 1993. Cada jogador monta um \"deck\" — um "
        "baralho personalizado com cerca de 60 a 100 cartas escolhidas entre "
        "mais de 25.000 cartas existentes. Em uma partida, os dois jogadores "
        "tentam reduzir a vida um do outro de 20 até 0 usando feitiços, "
        "criaturas e combinações (\"sinergias\") entre cartas.",
    )
    add_para(
        doc,
        "Escolher quais 60 cartas colocar no deck é um problema absurdamente "
        "difícil. Matematicamente, o número de decks possíveis é maior que "
        "o número de átomos no universo visível. Jogadores profissionais "
        "estudam durante anos para ficar bons nisso — e mesmo assim metade "
        "dos torneios é vencida por decks \"descobertos\" em lampejos "
        "criativos.",
    )

    add_heading(doc, "A pergunta que este projeto tenta responder", level=2)
    add_callout(
        doc,
        "A pergunta central",
        "É possível ensinar um computador a montar decks tão bons "
        "quanto — ou melhores que — jogadores humanos profissionais, "
        "aprendendo sozinho, apenas jogando partidas contra si mesmo?",
    )
    add_para(
        doc,
        "Se a resposta é sim, ganhamos três coisas:",
    )
    add_bullet(doc, "Um assistente que sugere decks competitivos em segundos para qualquer torneio.")
    add_bullet(doc, "Um oráculo de \"força de carta\" — quais cartas são, de fato, poderosas em cada contexto.")
    add_bullet(doc, "Uma base científica: tudo que funciona aqui pode ser reaproveitado em outros jogos, em diagnóstico médico, em estratégias de negócio.")

    add_heading(doc, "Objetivos e metas do projeto", level=2)
    add_para(
        doc,
        "Os objetivos do projeto foram definidos em ordem de dificuldade crescente:",
    )
    add_numbered(doc, "Coletar e organizar um catálogo de todas as cartas de MTG existentes (aproximadamente 60 mil cartas, com textos, custos, tipos).")
    add_numbered(doc, "Construir uma interface web onde humanos possam pesquisar cartas e montar decks manualmente.")
    add_numbered(doc, "Criar um avaliador heurístico (\"cérebro simbólico\") que dá uma nota a cada deck sem precisar simular partidas.")
    add_numbered(doc, "Construir um cérebro evolutivo que testa decks uns contra os outros e ajusta pesos de cartas — como seleção natural.")
    add_numbered(doc, "Plugar um motor de regras do MTG (Forge, que é open source) para simular partidas REAIS, carta por carta, movimento por movimento.")
    add_numbered(doc, "Treinar uma rede neural de aprendizado por reforço que joga contra si mesma no Forge e aprende a tomar decisões.")
    add_numbered(doc, "Fazer esse cérebro neural realimentar os pesos de cartas no banco de dados — assim, o sistema inteiro fica mais forte.")
    add_numbered(doc, "Garantir que o sistema não \"esqueça\" o que aprendeu e não gaste dinheiro demais em APIs pagas.")
    add_para(
        doc,
        "Em abril de 2026, os objetivos 1 a 7 estão implementados e funcionando. "
        "O objetivo 8 (defesa financeira e anti-esquecimento) está parcialmente "
        "implementado — a parte anti-esquecimento (League) já roda; a parte "
        "financeira (RAG cache + circuit breaker) está validada em testes.",
        bold=False,
    )

    page_break(doc)

    # ═══════════════════════════════════════════════════════════════════════
    # PARTE 2 — A ANALOGIA DOS TRÊS CÉREBROS
    # ═══════════════════════════════════════════════════════════════════════
    add_heading(doc, "Parte 2 — A analogia dos três cérebros", level=1)
    add_para(
        doc,
        "Para entender o sistema, imagine uma pessoa aprendendo um jogo novo. "
        "Ela usa três tipos de pensamento diferentes, que trabalham juntos:",
    )

    add_heading(doc, "Cérebro 1 — O Simbólico (o regrador)", level=2)
    add_para(
        doc,
        "É o cérebro que segue regras explícitas, do tipo \"um deck de Magic "
        "precisa ter entre 23 e 26 terrenos\" ou \"evite custos acima de 5 "
        "mana em excesso\". Ele é rápido, barato e nunca surpreende — mas "
        "também nunca aprende nada novo. Funciona como um professor de "
        "xadrez que fala \"nunca exponha a dama cedo\": serve como filtro "
        "inicial, mas não ganha campeonato.",
    )
    add_rich_para(doc, [
        ("Onde vive: ", True, False, None),
        ("arquivo ", False, False, None),
        ("server/services/deckEvaluationBrain.ts", False, True, CINZA_ESCURO),
        (" e outros serviços em TypeScript no backend web.", False, False, None),
    ])

    add_heading(doc, "Cérebro 2 — O Evolutivo (a seleção natural)", level=2)
    add_para(
        doc,
        "É o cérebro que testa coisas. Gera 100 decks aleatórios, faz cada "
        "um lutar contra os outros, pega os 25 melhores, combina suas cartas "
        "para gerar uma nova geração, e repete. É exatamente como seleção "
        "natural: a cada geração, os \"genes\" (cartas) que aparecem em "
        "vencedores ficam mais comuns. Com mil gerações, o sistema descobre "
        "sinergias que humanos nunca tinham visto.",
    )
    add_para(
        doc,
        "A analogia: imagine um laboratório de criação de cachorros. Você não "
        "sabe como desenhar um bom cão-guia, mas sabe reconhecer um quando vê. "
        "Então cruza os melhores, gera filhotes, avalia os filhotes, cruza os "
        "melhores filhotes… depois de 30 gerações você tem labradores. "
        "Mesmo princípio aqui, mas com decks.",
    )
    add_rich_para(doc, [
        ("Onde vive: ", True, False, None),
        ("arquivos como ", False, False, None),
        ("server/services/modelLearning.ts", False, True, CINZA_ESCURO),
        (", ", False, False, None),
        ("server/services/continuousTraining.ts", False, True, CINZA_ESCURO),
        (" e ", False, False, None),
        ("server/scripts/fullBrainTraining.ts", False, True, CINZA_ESCURO),
        (".", False, False, None),
    ])

    add_heading(doc, "Cérebro 3 — O Neural (o aprendiz profundo)", level=2)
    add_para(
        doc,
        "É o cérebro mais interessante e mais poderoso. Ele não segue regras "
        "prontas — aprende a partir de milhares de partidas jogando contra "
        "si mesmo. Para cada jogada possível, ele calcula: \"se eu fizer ISSO, "
        "qual a chance de ganhar?\". No começo, ele joga como um bebê "
        "aleatório. Depois de algumas horas de treino, joga como um iniciante. "
        "Depois de dias, começa a surpreender humanos.",
    )
    add_para(
        doc,
        "A analogia: é como ensinar uma criança a andar de bicicleta. Você "
        "não explica física dos giroscópios. Ela cai muitas vezes, sente o "
        "desequilíbrio, e após dezenas de tentativas seu cérebro calibra "
        "sozinho os músculos e reflexos certos. Ninguém precisou ensinar "
        "cálculo — os tombos bastaram.",
    )
    add_rich_para(doc, [
        ("Onde vive: ", True, False, None),
        ("arquivos em ", False, False, None),
        ("ml_engine/", False, True, CINZA_ESCURO),
        (" — especialmente ", False, False, None),
        ("ml_engine/ray_cluster/orchestrator.py", False, True, CINZA_ESCURO),
        (" e ", False, False, None),
        ("ml_engine/models/game_state_gnn.py", False, True, CINZA_ESCURO),
        (".", False, False, None),
    ])

    add_heading(doc, "Como os três conversam", level=2)
    add_para(
        doc,
        "Os três cérebros NÃO são sistemas separados que competem. Eles "
        "compartilham um banco de dados em comum (Postgres). Todos escrevem "
        "na mesma tabela — ",
    )
    add_rich_para(doc, [
        ("", False, False, None),
        ("card_learning", True, True, CINZA_ESCURO),
        (" — que guarda um número para cada carta: seu \"peso\", uma ", False, False, None),
        ("medida de quão boa essa carta é", True, False, None),
        (". Sempre que um cérebro aprende algo novo, ele propõe um ajuste de ", False, False, None),
        ("peso, e os ajustes vão para uma fila que processa uma atualização por vez "
         "(para evitar bagunça quando três cérebros querem escrever ao mesmo tempo). "
         "Este é o ", False, False, None),
        ("CardLearningQueue", False, True, CINZA_ESCURO),
        (": o coração do aprendizado unificado.", False, False, None),
    ])
    add_callout(
        doc,
        "Resumo em uma frase",
        "Três cérebros (regras rígidas, seleção natural e rede neural) "
        "trabalham juntos, cada um escrevendo melhorias em uma planilha "
        "compartilhada (o banco de dados), que depois é usada para gerar "
        "decks cada vez melhores.",
    )

    page_break(doc)

    # ═══════════════════════════════════════════════════════════════════════
    # PARTE 3 — OS 8 PILARES
    # ═══════════════════════════════════════════════════════════════════════
    add_heading(doc, "Parte 3 — Os 8 pilares técnicos", level=1)
    add_para(
        doc,
        "Quando o projeto foi planejado, o arquiteto identificou 8 problemas "
        "distintos que precisavam ser resolvidos. Cada problema recebeu uma "
        "tecnologia específica — o \"pilar\" que o sustenta. Aqui vai cada "
        "um em linguagem humana.",
    )

    pilares = [
        (
            "Pilar 1 — Aprendizado por Reforço em Escala",
            "Ray RLlib + IMPALA",
            "Como treinar uma rede neural rapidamente quando cada partida de "
            "Magic demora segundos para rodar? Resposta: divida o trabalho em "
            "muitos \"coletadores\" de experiência (que jogam partidas em "
            "paralelo) e um \"professor\" central (que aprende com elas). "
            "Ray é a biblioteca que orquestra esse paralelismo. IMPALA é a "
            "técnica específica para treinar quando os coletadores ficam "
            "atrasados em relação ao professor.",
            "Como uma fábrica: muitos operários coletam dados, um gerente "
            "consolida tudo em aprendizado, e o gerente distribui novas "
            "instruções de volta para os operários.",
        ),
        (
            "Pilar 2 — Representação de Estado com Grafos",
            "Graph Neural Network (GNN)",
            "Uma partida de Magic é uma rede de relacionamentos: jogador A "
            "controla criatura X, que ataca jogador B, cuja criatura Y bloqueia "
            "e tem sinergia com carta Z na mão. Representar isso como uma "
            "lista plana perde toda a estrutura. Uma GNN (rede neural de "
            "grafos) entende naturalmente essa teia.",
            "Como uma árvore genealógica: quem é pai de quem, quem se casou "
            "com quem, importa muito mais do que uma lista alfabética dos "
            "parentes.",
        ),
        (
            "Pilar 3 — Significado Semântico das Cartas",
            "Sentence-Transformers (embeddings)",
            "Duas cartas com textos diferentes (\"destrua uma criatura\" e "
            "\"exile uma criatura\") fazem coisas parecidas. Como o "
            "computador percebe essa semelhança? Transformando cada texto "
            "em uma lista de 384 números (\"embedding\"), de modo que "
            "textos parecidos virem listas parecidas.",
            "Como coordenadas em um mapa semântico: Paris e Londres ficam "
            "perto (ambas são capitais europeias); Paris e Sushi ficam "
            "longe. Aqui o mapa é de cartas de Magic em vez de cidades.",
        ),
        (
            "Pilar 4 — Busca Rápida em Memória Vetorial",
            "pgvector (Postgres) + cache semântico",
            "Todo mundo armazena bancos de dados. Poucos conseguem procurar "
            "\"a carta mais parecida com essa outra\" em milissegundos em "
            "60 mil registros. pgvector adiciona essa capacidade no "
            "Postgres (o banco de dados tradicional), usando uma técnica "
            "chamada HNSW — um índice otimizado para buscar vizinhos próximos "
            "em alta dimensão.",
            "Como um catálogo de biblioteca organizado não por ordem "
            "alfabética, mas por \"livros parecidos ficam na mesma "
            "prateleira\" — você chega na prateleira certa e varre 10 "
            "livros em vez de 60 mil.",
        ),
        (
            "Pilar 5 — Simulação Fiel de Partidas",
            "Forge (motor Java do MTG) + Gymnasium",
            "Simular Magic com regras inventadas dá resultado ruim: a IA "
            "aprende a abusar de bugs da simulação em vez de aprender Magic. "
            "Forge é um motor open source que implementa 100 % das regras "
            "oficiais. O projeto o conecta a um ambiente \"Gymnasium\" — o "
            "padrão da indústria para treinar IAs em jogos.",
            "Como um simulador de voo certificado: se a IA aprende a "
            "pilotar ali, realmente sabe pilotar — não aprendeu a "
            "explorar falhas do simulador.",
        ),
        (
            "Pilar 6 — Sinal de Recompensa Denso",
            "Reward Shaping (Ng, Harada & Russell, 1999)",
            "Se a IA só sabe se ganhou ou perdeu no final da partida (20 "
            "turnos depois), ela fica perdida. É como ensinar cálculo "
            "gritando \"errado!\" no final da prova. Reward Shaping entrega "
            "sinais menores a cada turno (\"você aumentou sua vantagem de "
            "cartas em 1\", \"sua eficiência de mana melhorou 10 %\") — e "
            "um teorema matemático garante que esses sinais extras não "
            "enviesam a decisão final.",
            "Como GPS que avisa \"vire à direita em 200 m\" em vez de só "
            "reportar \"chegou\" ou \"errou o caminho\" no destino.",
        ),
        (
            "Pilar 7 — Anti-Esquecimento (League)",
            "Population-Based Training + Pool de Oponentes Congelados",
            "Se a IA só treina contra si mesma, ela pode ficar ótima contra "
            "UMA estratégia e esquecer como derrotar outras. O sistema "
            "guarda cópias congeladas da IA em diferentes fases e obriga a "
            "versão atual a também enfrentar essas cópias antigas. Assim, "
            "ela nunca \"esquece\" de combater metagames antigos.",
            "Como um lutador que mantém sparrings de estilos diferentes — "
            "um boxeador, um lutador de jiu-jítsu, um karateca — para não "
            "virar especialista num só oponente.",
        ),
        (
            "Pilar 8 — Defesa Financeira e de Concorrência",
            "RAG Cache + Circuit Breaker + Fila Serial",
            "APIs de IA (como Claude, da Anthropic) cobram por uso. Se o "
            "sistema consultar a API milhões de vezes sem controle, a "
            "conta estoura. Além disso, quando três cérebros tentam "
            "escrever no banco ao mesmo tempo, pode virar bagunça (race "
            "condition). Este pilar junta: (a) um cache que lembra "
            "consultas parecidas, (b) um disjuntor que desliga a API se "
            "ela ficar instável, (c) uma fila que serializa escritas no "
            "banco.",
            "Como ter: (a) uma memória de curto prazo para não repetir "
            "pergunta, (b) um disjuntor elétrico que desarma antes de "
            "pegar fogo, (c) um caixa único no banco em vez de vários "
            "caixas brigando pela mesma conta.",
        ),
    ]

    for nome, tecs, descricao, analogia in pilares:
        add_heading(doc, nome, level=2)
        add_rich_para(doc, [
            ("Tecnologia principal: ", True, False, None),
            (tecs, False, True, CINZA_ESCURO),
        ])
        add_para(doc, descricao)
        add_rich_para(doc, [
            ("Analogia do dia a dia: ", True, True, VERDE),
            (analogia, False, True, CINZA_ESCURO),
        ])

    page_break(doc)

    # ═══════════════════════════════════════════════════════════════════════
    # PARTE 4 — ORGANIZAÇÃO FÍSICA
    # ═══════════════════════════════════════════════════════════════════════
    add_heading(doc, "Parte 4 — Como o projeto está organizado fisicamente", level=1)
    add_para(
        doc,
        "Se você abrir a pasta do projeto no Windows (",
    )
    add_rich_para(doc, [
        ("", False, False, None),
        ("C:\\Users\\alanr\\OneDrive\\Desktop\\mtg-deck-mvp\\", False, True, CINZA_ESCURO),
        ("), vai ver várias subpastas. Cada uma tem um papel claro. Aqui a "
         "lista decorada.", False, False, None),
    ])

    pastas = [
        ("client/", "O site — a parte que o usuário vê.",
         "Todo o código React (HTML/CSS/JavaScript) da interface de busca, "
         "construção de decks e visualização de gráficos de sinergia."),
        ("server/", "O backend em Node.js/TypeScript.",
         "Expõe APIs para o site, conversa com o banco de dados, roda os "
         "cérebros 1 (simbólico) e 2 (evolutivo)."),
        ("ml_engine/", "O cérebro pesado em Python.",
         "É aqui que mora o cérebro 3 (neural): orquestrador de "
         "treinamento, ambiente Gymnasium, modelo GNN, embeddings."),
        ("forge/", "O motor do Magic em Java.",
         "Contém o .jar do Forge (motor de regras oficial) e uma ponte "
         "chamada rlbridge que faz a comunicação Python↔Java."),
        ("drizzle/", "As migrações do banco de dados.",
         "Cada vez que o esquema do banco muda (adiciona coluna, cria "
         "tabela), é registrado como um arquivo de migração aqui."),
        ("shared/", "Tipos compartilhados entre front e back.",
         "Garantir que o formato de um deck é igual no site e no servidor."),
        ("scripts/", "Utilitários avulsos.",
         "Scripts que não fazem parte do fluxo principal — ferramentas "
         "de análise, geração de documentação (como este arquivo!), helpers."),
        ("tests/", "Testes automatizados.",
         "Testes de ponta a ponta que validam os cenários mais "
         "importantes do sistema."),
        ("ray_results/", "Resultados dos treinamentos (gerado automaticamente).",
         "Quando você roda .\\train.ps1, cada experimento cria uma subpasta "
         "aqui com checkpoints, métricas, logs e, em caso de erro, um "
         "arquivo error.txt."),
        ("data/", "Dados brutos que alimentam o sistema.",
         "Listas de decks de torneio baixadas, dumps da Scryfall, arquivos "
         "JSON com cartas."),
        ("dist/", "Código compilado pronto para produção.",
         "Gerado pelo comando `npm run build`. Você não mexe aqui à mão."),
        ("tmp/", "Arquivos temporários.",
         "Descartáveis. Pode ser apagado a qualquer momento."),
        ("logs/", "Logs dos serviços.",
         "Cada serviço rodando grava seu log aqui — útil para entender o "
         "que aconteceu quando algo deu errado."),
    ]

    add_table(
        doc,
        ["Pasta", "Papel", "O que tem dentro"],
        pastas,
        col_widths=[3.2, 5.2, 8.0],
    )

    add_heading(doc, "Arquivos soltos na raiz — os principais", level=2)
    add_bullet(doc, "train.ps1 — script PowerShell que liga o treinamento neural.")
    add_bullet(doc, "run-stack.ps1 — liga os três serviços (site + backend + ML) em paralelo.")
    add_bullet(doc, "setup.ps1 — instalação inicial (cria ambiente Python, instala dependências).")
    add_bullet(doc, "docker-compose.yml — configura o banco de dados Postgres em um contêiner.")
    add_bullet(doc, "package.json — lista das dependências JavaScript e comandos do npm.")
    add_bullet(doc, "ARCHITECTURE.md — documento técnico que explica a arquitetura (este Word é a versão didática dele).")
    add_bullet(doc, "TRAINING_TROUBLESHOOTING.md — manual de problemas comuns durante treinamento.")
    add_bullet(doc, "SEED.md — um resumo \"semente\" que ajuda novos desenvolvedores a entrar no projeto rapidamente.")

    page_break(doc)

    # ═══════════════════════════════════════════════════════════════════════
    # PARTE 5 — COMPONENTES EM DETALHE
    # ═══════════════════════════════════════════════════════════════════════
    add_heading(doc, "Parte 5 — Cada componente em detalhe", level=1)
    add_para(
        doc,
        "Aqui vamos abrir cada componente, explicar o que ele faz, por que "
        "ele existe, e dar uma analogia para ficar fácil.",
    )

    # 5.1
    add_heading(doc, "5.1 — O Orquestrador de Treinamento", level=2)
    add_rich_para(doc, [
        ("Arquivo: ", True, False, None),
        ("ml_engine/ray_cluster/orchestrator.py", False, True, CINZA_ESCURO),
    ])
    add_para(
        doc,
        "É o regente da orquestra. Ele monta a configuração do treinamento, "
        "decide quantos \"trabalhadores\" vão coletar experiência em paralelo, "
        "quanta memória de GPU cada um recebe, e lança o treinamento.",
    )
    add_para(
        doc,
        "Funções mais importantes (pense em \"ferramentas\" que o regente tem):",
    )
    add_bullet(doc, "build_impala_config(): monta o cardápio do treino — tamanho de lote, velocidade de aprendizado, quais recursos usar.", bold_first_n=1)
    add_bullet(doc, "_validate_batch_alignment(): confere se o cardápio é matematicamente consistente (evita um bug brutal que derrubava 100 % dos treinos antigos).", bold_first_n=1)
    add_bullet(doc, "_align_batch_size(): quando o usuário pede um tamanho \"quase certo\", ajusta para o próximo valor válido e avisa.", bold_first_n=1)
    add_bullet(doc, "_gpu_per_trial(): descobre quantas GPUs existem e divide o bolo entre os treinos em paralelo.", bold_first_n=1)
    add_bullet(doc, "LeagueManager: administra os oponentes congelados para o anti-esquecimento (Pilar 7).", bold_first_n=1)

    add_callout(
        doc,
        "Analogia",
        "É como o diretor de um curso de treinamento de pilotos: escolhe "
        "quantos simuladores, qual o cronograma, qual o nível de dificuldade "
        "inicial, e garante que nenhum aluno pule matéria obrigatória.",
    )

    # 5.2
    add_heading(doc, "5.2 — O Ambiente de Simulação", level=2)
    add_rich_para(doc, [
        ("Arquivo: ", True, False, None),
        ("ml_engine/ray_cluster/env.py", False, True, CINZA_ESCURO),
    ])
    add_para(
        doc,
        "É o \"tabuleiro virtual\" onde a IA joga. Tecnicamente, envolve o "
        "Forge (motor Java) em uma API padrão chamada Gymnasium, que toda "
        "biblioteca de RL (Reinforcement Learning, aprendizado por reforço) "
        "entende.",
    )
    add_para(
        doc,
        "A comunicação entre Python e Java acontece por \"linhas de JSON\" — "
        "Python escreve uma instrução, Forge responde o estado do jogo.",
    )
    add_bullet(doc, "MtgForgeEnv.reset(): começa nova partida, sorteia cartas iniciais.", bold_first_n=1)
    add_bullet(doc, "MtgForgeEnv.step(action): executa uma jogada e retorna o novo estado + quanta recompensa aquela jogada deu.", bold_first_n=1)

    add_callout(
        doc,
        "Analogia",
        "É o palco do teatro. O Forge é o diretor que cumpre o roteiro "
        "de MTG rigorosamente; o ambiente Python é o contra-regra que fala "
        "\"agora entra a IA\" e passa as falas de volta.",
    )

    # 5.3
    add_heading(doc, "5.3 — A Rede Neural de Grafos (GNN)", level=2)
    add_rich_para(doc, [
        ("Arquivo: ", True, False, None),
        ("ml_engine/models/game_state_gnn.py", False, True, CINZA_ESCURO),
    ])
    add_para(
        doc,
        "É o cérebro pensante. Recebe o estado do jogo representado como um "
        "grafo (nós de jogadores, nós de cartas, arestas de \"controla\", "
        "\"está na zona tal\", \"tem sinergia\") e devolve duas coisas:",
    )
    add_numbered(doc, "Logits — uma nota para cada jogada possível (quanto maior, mais a IA acha que essa jogada é boa).")
    add_numbered(doc, "Value — uma previsão de \"quanto eu vou ganhar no total se a partida continuar a partir daqui?\".")
    add_para(
        doc,
        "A arquitetura usa 3 camadas \"HeteroConv\" (convolução heterogênea — "
        "mistura nós de tipos diferentes) e dentro de cada uma, o \"GATConv\" "
        "(atenção gráfica, que deixa a rede decidir quais vizinhos prestar "
        "atenção primeiro).",
    )

    add_callout(
        doc,
        "Analogia",
        "Imagine um general olhando um mapa de batalha. Ele vê unidades "
        "amigas, inimigas, ligações de suprimento. Uma GNN é exatamente esse "
        "\"olho do general\" — entende que dois batalhões a 100 metros um "
        "do outro estão relacionados, enquanto uma lista alfabética os "
        "separaria.",
    )

    # 5.4
    add_heading(doc, "5.4 — O Modelador de Recompensa", level=2)
    add_rich_para(doc, [
        ("Arquivo: ", True, False, None),
        ("ml_engine/forge_worker/reward_shaper.py", False, True, CINZA_ESCURO),
    ])
    add_para(
        doc,
        "Este arquivo responde à pergunta: \"quanto eu deveria recompensar a "
        "IA agora, no meio da partida, para que ela aprenda?\". Uma "
        "recompensa só no fim da partida (+1 se ganhou, −1 se perdeu) é "
        "muito pouco sinal. O Reward Shaper dá recompensas pequenas a cada "
        "turno baseado em:",
    )
    add_bullet(doc, "Vantagem de vida (quanta vida eu tenho vs oponente).")
    add_bullet(doc, "Eficiência de mana (usei minha mana disponível? desperdicei?).")
    add_bullet(doc, "Vantagem de cartas (quantas cartas na mão vs oponente).")
    add_bullet(doc, "Controle do tabuleiro (quanta \"força\" em criaturas em jogo).")
    add_bullet(doc, "Progresso em direção à vitória (quantos turnos até eu poder ganhar).")
    add_bullet(doc, "Bônus por arquétipo (um deck \"control\" é premiado quando passa o turno com mana aberta — jogada característica).")

    add_callout(
        doc,
        "Analogia",
        "GPS que fala \"virou na rua certa\" em vez de só dizer \"chegou\" "
        "ou \"errou o destino\". Os sinais intermediários são bem pequenos "
        "(±0.1) para não sobrepujar a recompensa final, que é ±1.",
    )

    # 5.5
    add_heading(doc, "5.5 — O Guarda Contra Loops", level=2)
    add_rich_para(doc, [
        ("Arquivo: ", True, False, None),
        ("ml_engine/forge_worker/loop_guard.py", False, True, CINZA_ESCURO),
    ])
    add_para(
        doc,
        "Magic tem combos infinitos. Se a IA descobre um, ela poderia "
        "ficar repetindo pra sempre e travar o treino. O Loop Guard "
        "calcula uma \"impressão digital\" (hash SHA1) do estado do jogo "
        "a cada jogada. Se o mesmo estado repetir 3 vezes em 50 jogadas, "
        "ele declara loop, dá recompensa MUITO negativa (−2.0) e registra "
        "aquela sequência numa tabela de ",
    )
    add_rich_para(doc, [
        ("", False, False, None),
        ("toxic_actions", False, True, CINZA_ESCURO),
        (". Treinos futuros vão evitar essa rota.", False, False, None),
    ])

    add_callout(
        doc,
        "Analogia",
        "Como um apito do juiz de basquete que sinaliza violação de 3 "
        "segundos. Tira o time do loop, dá falta, e o juiz fala \"da "
        "próxima vez, não faça isso\".",
    )

    # 5.6
    add_heading(doc, "5.6 — O Cérebro de Avaliação Heurística", level=2)
    add_rich_para(doc, [
        ("Arquivo: ", True, False, None),
        ("server/services/deckEvaluationBrain.ts", False, True, CINZA_ESCURO),
    ])
    add_para(
        doc,
        "Avalia um deck sem precisar simular partida. Olha curva de mana, "
        "proporção de terrenos, diversidade de mecânicas e dá uma nota "
        "normalizada de 0 a 100, com um tier (S, A, B, C, D, F) igual "
        "ranking de aluno.",
    )
    add_callout(
        doc,
        "Analogia",
        "É o professor que bate o olho na prova e já sabe mais ou menos a "
        "nota antes de ler com cuidado. Não substitui uma correção detalhada, "
        "mas filtra os casos óbvios em milissegundos.",
    )

    # 5.7
    add_heading(doc, "5.7 — A Fila de Aprendizado de Cartas", level=2)
    add_rich_para(doc, [
        ("Arquivo: ", True, False, None),
        ("server/services/cardLearningQueue.ts", False, True, CINZA_ESCURO),
    ])
    add_para(
        doc,
        "O ponto de encontro dos três cérebros. Quando qualquer cérebro "
        "descobre \"a carta X é melhor do que achávamos\", ele NÃO escreve "
        "direto no banco de dados. Escreve numa fila. Um único trabalhador "
        "consome a fila em ordem, aplicando uma atualização por vez. Isso "
        "evita race conditions (quando dois processos gravam no mesmo "
        "registro ao mesmo tempo e um sobrescreve o outro).",
    )
    add_para(
        doc,
        "Além disso, os pesos são limitados entre 0.1 e 50.0 (não podem "
        "crescer infinitamente nem zerar). Aplica uma fórmula de decaimento "
        "para que cartas que já estão muito altas subam cada vez menos — "
        "assim, o sistema não fica obcecado por UMA carta.",
    )
    add_callout(
        doc,
        "Analogia",
        "Como o caixa único do banco: todo mundo que quer sacar, saca na "
        "mesma fila, na ordem em que chegou. Acabou a briga de qual caixa "
        "atende primeiro.",
    )

    # 5.8
    add_heading(doc, "5.8 — O Servidor de Embeddings", level=2)
    add_rich_para(doc, [
        ("Arquivos: ", True, False, None),
        ("ml_engine/rag/embedder.py", False, True, CINZA_ESCURO),
        (", ", False, False, None),
        ("ml_engine/rag/server.py", False, True, CINZA_ESCURO),
        (", ", False, False, None),
        ("ml_engine/rag/pgvector_writer.py", False, True, CINZA_ESCURO),
    ])
    add_para(
        doc,
        "Embedding é a \"tradução\" de um texto para uma lista de 384 "
        "números. O ",
    )
    add_rich_para(doc, [
        ("", False, False, None),
        ("embedder.py", False, True, CINZA_ESCURO),
        (" carrega o modelo MiniLM (da família Sentence-Transformers), que "
         "faz essa tradução. O ", False, False, None),
        ("server.py", False, True, CINZA_ESCURO),
        (" expõe isso como uma API HTTP — assim o backend Node consegue "
         "pedir embeddings sem chamar Python o tempo todo. O ", False, False, None),
        ("pgvector_writer.py", False, True, CINZA_ESCURO),
        (" é um script único que roda uma vez e preenche a tabela ", False, False, None),
        ("card_oracle_embeddings", False, True, CINZA_ESCURO),
        (" com os vetores de todas as 60 mil cartas.", False, False, None),
    ])

    add_callout(
        doc,
        "Analogia",
        "Como um tradutor profissional que mora em uma sala só dele. Quem "
        "precisa de tradução manda um bilhete por baixo da porta — o "
        "tradutor devolve a versão traduzida por baixo da porta. A sala é "
        "o servidor FastAPI, o bilhete é o HTTP.",
    )

    # 5.9
    add_heading(doc, "5.9 — Scrapers de Metagame", level=2)
    add_rich_para(doc, [
        ("Arquivos: ", True, False, None),
        ("server/services/mtggoldfishScraper.ts", False, True, CINZA_ESCURO),
        (", ", False, False, None),
        ("mtgtop8Scraper.ts", False, True, CINZA_ESCURO),
    ])
    add_para(
        doc,
        "Baixam listas de decks vencedores de torneios reais (Standard, "
        "Modern, Legacy, Pioneer, Pauper, Vintage) dos sites MTGGoldfish e "
        "MTGTop8. São cerca de 10 decks por formato. Esses dados entram na "
        "tabela ",
    )
    add_rich_para(doc, [
        ("", False, False, None),
        ("competitive_decks", False, True, CINZA_ESCURO),
        (" e servem de \"norte\" para a IA — se o sistema estiver "
         "divergindo muito do metagame real, saberemos.", False, False, None),
    ])

    # 5.10
    add_heading(doc, "5.10 — Verificador de Progresso", level=2)
    add_rich_para(doc, [
        ("Arquivo: ", True, False, None),
        ("ml_engine/scripts/check_learning_progress.py", False, True, CINZA_ESCURO),
    ])
    add_para(
        doc,
        "Script de diagnóstico. Vasculha a pasta ",
    )
    add_rich_para(doc, [
        ("", False, False, None),
        ("ray_results/", False, True, CINZA_ESCURO),
        (", lê os logs de cada experimento e imprime em texto simples: quais "
         "treinos estão VIVOS, quais MORRERAM, quantas iterações cada um "
         "completou, qual a recompensa média atual. Se detectar que "
         "train_batch_size e rollout_fragment_length estão desalinhados "
         "(o bug histórico do Pilar 1), grita \"MISALIGNED\".", False, False, None),
    ])
    add_callout(
        doc,
        "Analogia",
        "É a enfermeira que passa de leito em leito e diz \"paciente 1 "
        "estável, paciente 2 em recuperação, paciente 3 faleceu às 14h — "
        "causa: parada cardíaca\". Economiza horas lendo logs crus.",
    )

    page_break(doc)

    # ═══════════════════════════════════════════════════════════════════════
    # PARTE 6 — CICLO DE TREINAMENTO
    # ═══════════════════════════════════════════════════════════════════════
    add_heading(doc, "Parte 6 — O ciclo de treinamento passo a passo", level=1)
    add_para(
        doc,
        "Vamos acompanhar o \"dia na vida da IA\". Você digita ",
    )
    add_rich_para(doc, [
        ("", False, False, None),
        (".\\train.ps1", False, True, CINZA_ESCURO),
        (" no PowerShell. O que acontece?", False, False, None),
    ])

    etapas = [
        ("1. O script PowerShell acorda (train.ps1)",
         "Carrega o arquivo .env (que tem chaves de API, senhas, caminhos), "
         "descobre onde está o Python instalado (na pasta .venv), faz um "
         "pré-voo matemático: \"seu tamanho de lote é múltiplo do fragmento "
         "de rollout?\". Se não for, ajusta automaticamente e avisa em "
         "amarelo."),
        ("2. Chama o orquestrador Python",
         "Lança python -m ml_engine.ray_cluster.orchestrator com os "
         "parâmetros (quantos trabalhadores, quantos \"trials\" simultâneos, "
         "quantas horas). O script passa adiante a execução."),
        ("3. O orquestrador detecta recursos",
         "Pergunta ao sistema: \"tem GPU disponível?\". Se sim, reserva "
         "25 % da GPU para cada um dos 4 trials (totalizando 100 %). Os "
         "coletadores de experiência ficam na CPU, poupando GPU para o "
         "aprendizado."),
        ("4. Monta a configuração do IMPALA",
         "Chama build_impala_config() que devolve um dicionário gigante com "
         "tudo: qual ambiente usar, quantas cartas no máximo (max_cards), "
         "tamanho de lote, velocidade de aprendizado, frequência de "
         "checkpoint, e mais 50 opções."),
        ("5. Valida a configuração",
         "Chama _validate_batch_alignment() que confere se train_batch_size "
         "é múltiplo de rollout_fragment_length. Se não for, LEVANTA UM ERRO "
         "ANTES de qualquer coisa subir. Este é o guard que impede o bug "
         "histórico (Seção 1 do TRAINING_TROUBLESHOOTING.md)."),
        ("6. Inicia o Ray",
         "ray.init() sobe o cluster Ray local. Ray é a biblioteca que "
         "coordena processos paralelos em Python — funciona como um "
         "gerente que delega tarefas a vários trabalhadores."),
        ("7. Lança os trials em paralelo",
         "tune.run() com o scheduler PopulationBasedTraining cria 4 trials. "
         "Cada trial é uma IA independente, com seus próprios "
         "hiperparâmetros (lr, entropy_coeff, etc.). Cada trial tem N env "
         "runners — processos separados rodando MtgForgeEnv."),
        ("8. Cada env runner joga partidas",
         "Um env runner chama env.reset() → Forge sobe, sorteia cartas, "
         "começa a partida 1. Depois env.step(ação_da_IA) → Forge executa, "
         "retorna o novo estado. A rede neural (GameStateGNN) olha o estado "
         "e devolve a próxima ação. E assim por cerca de 20-30 turnos até "
         "alguém ganhar."),
        ("9. O Reward Shaper distribui recompensas",
         "A cada turno, calcula a recompensa densa baseada em vida, mana, "
         "vantagem de cartas. No fim da partida, ±1 de outcome. Tudo vira "
         "uma trajetória: (estado, ação, recompensa, próximo estado)."),
        ("10. O Loop Guard vigia",
         "Calcula SHA1 de cada estado. Se vir o mesmo estado 3 vezes em 50 "
         "passos, encerra a partida com recompensa −2.0 e marca como loop "
         "tóxico."),
        ("11. Trajetórias vão para a fila de rollout",
         "A cada 50 passos (rollout_fragment_length), o env runner empacota "
         "a trajetória e manda para o learner."),
        ("12. O Learner aprende com V-trace",
         "O learner central pega os lotes de trajetórias e ajusta os pesos "
         "da rede neural usando a fórmula V-trace (Pilar 1 / IMPALA). A "
         "parte importante do V-trace: mesmo quando os dados que chegam "
         "estão \"velhos\" (foram coletados com uma versão anterior da "
         "rede), ele corrige matematicamente para aprender corretamente."),
        ("13. Checkpoint",
         "A cada 10 iterações, salva os pesos atuais da rede em "
         "ray_results/pbt_mtg_<timestamp>/IMPALA_mtg_forge_env_<id>/. Se "
         "algum trial morrer, você pode resumir a partir desse ponto."),
        ("14. A cada 20 iterações, o PBT atua",
         "PopulationBasedTraining compara os 4 trials por recompensa média. "
         "Os piores copiam os pesos dos melhores e \"mutam\" um dos "
         "hiperparâmetros (multiplica lr por 1.2 ou 0.8, por exemplo). É "
         "seleção natural entre as próprias IAs."),
        ("15. O League Manager congela o melhor trial",
         "A cada N iterações, pega o melhor trial e coloca uma cópia "
         "congelada num pool. Env runners passam a jogar 50 % contra IAs "
         "vivas e 50 % contra oponentes do pool. É assim que o sistema "
         "NÃO esquece estratégias antigas (Pilar 7)."),
        ("16. Budget termina (por padrão 24h)",
         "Quando as horas acabam, o treino para graciosamente. Os pesos "
         "finais são salvos. Se tudo deu certo, você pode rodar "
         "check_learning_progress.py e ver os trials ALIVE com recompensa "
         "alta."),
        ("17. Distilação para o banco (futuro)",
         "O objetivo final é uma ponte (rlToCardLearningBridge.ts) que lê "
         "os pesos da rede e traduz de volta para pesos de cartas na tabela "
         "card_learning — fechando o ciclo com os outros dois cérebros."),
    ]

    for titulo, corpo in etapas:
        add_heading(doc, titulo, level=3)
        add_para(doc, corpo)

    add_callout(
        doc,
        "Um exemplo real",
        "No seu último treinamento (pbt_mtg_1776975725, 23/04/2026), os 2 "
        "trials rodaram 35 minutos, completaram 162 iterações cada, e "
        "salvaram 38 e 39 checkpoints. Recompensa média: −0.166 e −0.318 "
        "(ainda negativa porque 35 minutos é pouco treino — em 24h esse "
        "valor tende a subir para algo positivo, indicando que a IA "
        "finalmente passou a ganhar mais do que perder).",
    )

    page_break(doc)

    # ═══════════════════════════════════════════════════════════════════════
    # PARTE 7 — COMO O MODELO APRENDE
    # ═══════════════════════════════════════════════════════════════════════
    add_heading(doc, "Parte 7 — Como o modelo efetivamente aprende", level=1)
    add_para(
        doc,
        "Vamos ampliar o microscópio e olhar o momento mágico: quando a "
        "rede neural REALMENTE aprende algo. Esta é a parte mais importante "
        "e mais difícil de explicar. Vamos devagar.",
    )

    add_heading(doc, "O que é uma \"rede neural\" em uma frase?", level=2)
    add_para(
        doc,
        "É uma fórmula matemática com milhões de \"botões\" (parâmetros). "
        "Cada botão é um número. A fórmula recebe o estado do jogo como "
        "entrada e cospe \"qual é a melhor jogada?\" como saída. Treinar "
        "significa girar esses milhões de botões até que a saída da "
        "fórmula acerte mais vezes do que erra.",
    )

    add_heading(doc, "Como os botões são girados? (gradiente descendente)", level=2)
    add_para(
        doc,
        "Imagine que você está numa montanha com os olhos vendados, querendo "
        "chegar ao vale. Você sente com os pés a inclinação do terreno — "
        "qual direção desce mais. Dá um passo nessa direção. Repete. "
        "Eventualmente chega no vale.",
    )
    add_para(
        doc,
        "Na rede neural, o \"vale\" é onde o erro é mínimo. A \"inclinação\" "
        "é o gradiente — uma conta matemática que diz: \"se você girar o "
        "botão 1 mil e quatorze um pouco para a direita, o erro cai\". A "
        "biblioteca PyTorch calcula esse gradiente AUTOMATICAMENTE (é por "
        "isso que ela é tão usada — ela faz a parte difícil do cálculo por "
        "você).",
    )
    add_para(
        doc,
        "O \"tamanho do passo\" é chamado de learning rate (lr). Muito grande "
        "e você atravessa o vale e sobe a montanha do outro lado. Muito "
        "pequeno e você demora para chegar. PBT testa vários tamanhos de "
        "passo em paralelo para descobrir qual funciona.",
    )

    add_heading(doc, "O que é o \"gradiente\" em termos da nossa partida?", level=2)
    add_para(
        doc,
        "A rede olha o estado e prevê \"vou ganhar com probabilidade 70 %\". "
        "A partida termina com derrota (0 %). A diferença entre previsão "
        "(70 %) e realidade (0 %) é o erro. O gradiente aponta: \"os "
        "botões que levaram a \"70 %\" foram excessivamente otimistas — "
        "gire para baixo\". Com milhões dessas correções pequenas, a rede "
        "fica calibrada.",
    )

    add_heading(doc, "Por que IMPALA em vez de PPO/DQN?", level=2)
    add_para(
        doc,
        "PPO é a técnica mais famosa de RL, mas exige que todos os "
        "coletadores ESPEREM o learner terminar cada iteração antes de "
        "coletar mais. Se o ambiente é lento (e Magic é muito lento — "
        "cada partida leva 10-20 segundos), isso deixa os trabalhadores "
        "parados, desperdiçando CPU.",
    )
    add_para(
        doc,
        "IMPALA resolve isso: coletadores nunca esperam, simplesmente "
        "coletam e mandam. O learner aceita dados \"velhos\" e usa V-trace "
        "para corrigir a velhice. É o mesmo princípio de um buffer de "
        "vídeo: você assiste enquanto novos bits ainda estão chegando.",
    )

    add_heading(doc, "O que é V-trace em analogia?", level=2)
    add_para(
        doc,
        "Imagine que você é um treinador de futebol revisando DVDs antigos. "
        "Os jogadores em 2020 jogavam diferente dos de 2025. Se você for "
        "treinar seu time de 2025 usando comentários de um treinador de "
        "2020 sem ajustar, vai ensinar coisas erradas. V-trace ajusta: "
        "\"esse conselho de 2020 ainda vale? Então eu confio nele 80 %. "
        "Esse outro? Já não serve — peso zero\". É um mecanismo para "
        "aprender com dados de versões antigas da própria IA.",
    )

    add_heading(doc, "Iteração por iteração — o que muda?", level=2)
    add_para(
        doc,
        "A cada iteração (umas 30 segundos no seu PC):",
    )
    add_bullet(doc, "A rede joga mais 50 × N_workers partidas (ou fragmentos de partida).")
    add_bullet(doc, "Os pesos dos botões mudam um pouquinho — nada dramático, talvez 0.001 % de alteração média.")
    add_bullet(doc, "A recompensa média de longo prazo (média dos últimos 100 episódios) começa a subir — devagar no começo, mais rápido depois.")
    add_bullet(doc, "Depois de 20 iterações, o PBT age: se dois trials estão bem melhor que os outros dois, os piores copiam os melhores e mutam.")
    add_bullet(doc, "Eventualmente, os melhores trials alcançam uma \"barreira\" e param de melhorar naquele hiperparâmetro — aí o PBT muta mais forte.")

    add_callout(
        doc,
        "O que dizer para um amigo",
        "\"A IA joga milhares de partidas contra si mesma. Cada vez que ela "
        "prevê errado (achou que ia ganhar e perdeu, ou vice-versa), ela "
        "ajusta milhões de botões internos na direção que reduz o erro. "
        "Em 24 horas ela joga MILHÕES de partidas e ajusta os botões "
        "MILHÕES de vezes. No fim, joga melhor do que qualquer humano que "
        "só jogou 10 mil partidas na vida.\"",
    )

    page_break(doc)

    # ═══════════════════════════════════════════════════════════════════════
    # PARTE 8 — BIBLIOTECAS
    # ═══════════════════════════════════════════════════════════════════════
    add_heading(doc, "Parte 8 — Bibliotecas escolhidas e por quê", level=1)
    add_para(
        doc,
        "Uma biblioteca é um pacote de código pronto que resolve um problema "
        "comum. Em vez de escrever uma do zero (meses de trabalho), você "
        "pega uma biblioteca aberta e usa. Aqui as principais deste projeto.",
    )

    bibliotecas = [
        ("Ray + RLlib + Tune", "2.53",
         "Orquestra treinamento de IAs em paralelo, com IMPALA e PBT "
         "integrados. É a \"Kubernetes\" do aprendizado por reforço.",
         "Concorrentes como RLlib da Garage e CleanRL não têm PBT pronto, "
         "ou não escalam para centenas de trabalhadores. Ray é padrão na "
         "indústria."),
        ("PyTorch", "2.11",
         "Biblioteca de redes neurais. Faz o cálculo automático de "
         "gradientes e a execução em GPU.",
         "TensorFlow é concorrente, mas ecossistema de RL (Ray, "
         "torch-geometric, Sentence-Transformers) gira em torno do "
         "PyTorch. Facilita integração."),
        ("torch-geometric", "2.7",
         "Extensão do PyTorch para redes neurais de grafos (GNN). Oferece "
         "GATConv, HeteroConv — blocos fundamentais do nosso modelo.",
         "DGL é concorrente mas menos integrado com PyTorch \"puro\". "
         "torch-geometric tem a comunidade mais ativa em heterogêneos."),
        ("Sentence-Transformers (MiniLM)", "2.7+",
         "Converte textos em vetores de 384 números que capturam "
         "significado semântico.",
         "OpenAI Ada é concorrente mas é API paga (custa dinheiro por "
         "embedding). MiniLM é local, grátis, roda em CPU, qualidade "
         "excelente para nosso uso."),
        ("Gymnasium", "1.1",
         "API padrão para ambientes de RL. reset() / step() / "
         "observation_space / action_space.",
         "Fork comunitário do OpenAI Gym (que foi abandonado). Todos os "
         "frameworks modernos esperam essa API."),
        ("FastAPI + Uvicorn", "0.110+",
         "Framework Python para criar APIs HTTP assíncronas. Usado no "
         "servidor de embeddings.",
         "Flask é concorrente mas síncrono. FastAPI tem validação "
         "automática via Pydantic e é muito mais rápido."),
        ("Pydantic", "2.5+",
         "Validação de dados em Python. \"Esse JSON tem todos os campos "
         "certos? Os tipos estão corretos?\".",
         "Sem concorrente sério. Usado internamente pelo FastAPI e por "
         "Ray."),
        ("PostgreSQL + pgvector", "18 + 0.3",
         "Banco de dados relacional com extensão vetorial. Guarda cartas, "
         "decks, pesos, embeddings.",
         "SQLite é mais leve mas não escala. MongoDB é NoSQL e nosso "
         "problema é muito relacional. Postgres com pgvector é o sweet "
         "spot."),
        ("psycopg2-binary", "2.9+",
         "Driver Python para Postgres. É o que permite o ml_engine falar "
         "com o banco.",
         "Há asyncpg (async) mas nossos scripts Python são síncronos. "
         "psycopg2 é mais maduro e estável."),
        ("Drizzle ORM", "0.44",
         "ORM TypeScript para Postgres. Escrevemos queries com tipagem "
         "forte — se o nome de uma coluna mudar no banco, o TypeScript "
         "avisa antes de rodar.",
         "Prisma é concorrente mas mais pesado e abstrai demais o SQL. "
         "Drizzle é leve e fica \"perto do SQL\"."),
        ("Express", "4.21",
         "Servidor HTTP do Node. É quem recebe as requisições do "
         "navegador.",
         "Fastify é mais rápido, Koa é mais moderno — mas Express tem "
         "ecossistema enorme de middlewares."),
        ("tRPC", "11.6",
         "Sistema de RPC tipado. O frontend chama funções do backend "
         "como se fossem funções locais, com o TypeScript garantindo "
         "que os tipos batem.",
         "REST/OpenAPI exige manter documentação em paralelo; GraphQL é "
         "mais complexo. tRPC é o caminho mais direto com TypeScript dos "
         "dois lados."),
        ("Zod", "4.1",
         "Validação de dados em TypeScript. Define um \"formato\" e "
         "testa se um objeto respeita esse formato em runtime.",
         "Yup, Joi são concorrentes mas Zod integra nativamente com "
         "tRPC e Drizzle."),
        ("React", "19.2",
         "Framework de UI. Componentes reutilizáveis que se atualizam "
         "quando os dados mudam.",
         "Vue, Svelte, Angular são concorrentes. React tem a maior "
         "comunidade e o padrão em startups."),
        ("Tailwind CSS", "4.1",
         "Utilitários de CSS via classes curtas. Em vez de escrever CSS, "
         "você coloca classes como text-lg font-bold text-blue-600.",
         "Bootstrap é mais \"rígido\", Styled Components exige mais "
         "código. Tailwind é ágil e consistente."),
        ("Radix UI", "^1.x",
         "Componentes acessíveis (dialogs, menus, tooltips) respeitando "
         "WAI-ARIA. \"Primitives\" desenhados para serem estilizados com "
         "Tailwind por cima.",
         "Material UI é mais opinativo. Radix deixa você desenhar seu "
         "próprio visual mas garante acessibilidade."),
        ("Cytoscape.js", "3.33",
         "Desenha grafos interativos no navegador. Usado na "
         "visualização de sinergias entre cartas.",
         "D3.js é mais flexível mas exige muito mais código. "
         "Cytoscape é pronto para grafos."),
        ("Vite", "7.1",
         "Ferramenta que empacota o código React do frontend. Rápido "
         "em desenvolvimento, otimizado em produção.",
         "Webpack é o tradicional, mais lento. Vite usa esbuild "
         "internamente e é 10x mais rápido em dev."),
        ("Vitest", "2.1",
         "Framework de testes para TypeScript. Mesma API do Jest mas "
         "mais rápido com ESM.",
         "Jest é o clássico mas não suporta ESM nativamente. Vitest "
         "integra perfeito com Vite."),
        ("pytest", "7.4+",
         "Framework de testes Python. Escrevemos funções test_* e ele "
         "encontra e roda.",
         "unittest (built-in) é mais verboso. pytest é padrão de "
         "facto."),
        ("Docker + docker-compose", "—",
         "Contêinerização. Roda Postgres numa \"caixa\" isolada do "
         "sistema operacional, com pgvector já embutido.",
         "Instalar pgvector no Postgres do Windows nativo exige "
         "compilar C++ com MSVC. Impraticável. Docker resolve em 1 "
         "comando."),
    ]

    for nome, versao, oq, porque in bibliotecas:
        add_heading(doc, f"{nome}  (v{versao})", level=3)
        add_rich_para(doc, [
            ("O que faz: ", True, False, None),
            (oq, False, False, None),
        ])
        add_rich_para(doc, [
            ("Por que foi escolhida: ", True, False, None),
            (porque, False, True, CINZA_ESCURO),
        ])

    page_break(doc)

    # ═══════════════════════════════════════════════════════════════════════
    # PARTE 9 — COMANDOS
    # ═══════════════════════════════════════════════════════════════════════
    add_heading(doc, "Parte 9 — Comandos do dia a dia", level=1)
    add_para(
        doc,
        "Aqui um guia linha-a-linha dos comandos mais usados. Cada um "
        "começa pelo que você digita, depois o que acontece.",
    )

    add_heading(doc, "9.1 — Preparação inicial (uma vez)", level=2)
    add_codeblock(doc, ".\\setup.ps1")
    add_para(
        doc,
        "Faz a instalação completa: cria o ambiente Python .venv, instala "
        "todas as bibliotecas Python do requirements.txt, instala as "
        "dependências Node via npm, gera o .env a partir do "
        ".env.example, compila a ponte Java rlbridge. Só precisa rodar "
        "uma vez (ou depois de um pull grande).",
    )

    add_heading(doc, "9.2 — Subindo o banco de dados", level=2)
    add_codeblock(doc, "docker compose up -d postgres")
    add_para(
        doc,
        "Liga um contêiner Postgres na porta 5434 (escolhida porque o "
        "Windows desse projeto já tinha Postgres nativos em 5432 e 5433). "
        "O -d significa \"daemon\" — roda em segundo plano. A imagem é a "
        "pgvector/pgvector:pg18, que já traz a extensão vector instalada.",
    )
    add_codeblock(doc, "docker compose logs -f postgres")
    add_para(doc, "Mostra os logs do contêiner em tempo real. Ctrl+C para sair.")
    add_codeblock(doc, "docker compose down")
    add_para(doc, "Para o contêiner preservando os dados.")
    add_codeblock(doc, "docker compose down -v")
    add_para(
        doc,
        "Para o contêiner E APAGA OS DADOS. Só use em reset total de "
        "desenvolvimento!",
    )

    add_heading(doc, "9.3 — Subindo todos os serviços", level=2)
    add_codeblock(doc, ".\\run-stack.ps1")
    add_para(
        doc,
        "Liga em paralelo: (a) servidor de embeddings FastAPI na porta "
        "8765, (b) backend Node/Express na porta 3000, (c) opcionalmente "
        "o worker de Forge. Ctrl+C mata todos simultaneamente (o script "
        "faz taskkill /F /T).",
    )

    add_heading(doc, "9.4 — Treinando o cérebro evolutivo (rápido, 9 min)", level=2)
    add_codeblock(doc, "npm run teach")
    add_para(
        doc,
        "Executa server/scripts/fullBrainTraining.ts. Faz: gera 100 decks "
        "aleatórios por arquétipo, roda simulações no Forge, seleciona "
        "elite, atualiza pesos na tabela card_learning. Imprime métricas "
        "no final: quantas cartas elite, fracas, baseline.",
    )

    add_heading(doc, "9.5 — Treinando o cérebro neural (pesado, horas)", level=2)
    add_codeblock(doc, ".\\train.ps1")
    add_para(
        doc,
        "O comando estrela. Roda o orquestrador Ray com os padrões "
        "conservadores. Pode levar horas, pode levar dias — depende do "
        "-BudgetHours (padrão 24h). Para parar antes, Ctrl+C no console.",
    )
    add_codeblock(doc, ".\\train.ps1 -NumWorkers 2 -NumTrials 2 -BudgetHours 0.5 -BatchSize 500 -MaxCards 32")
    add_para(
        doc,
        "Versão \"smoke test\" — roda 30 minutos com parâmetros reduzidos. "
        "Bom para verificar que o ambiente está OK antes de começar um "
        "treino de 24 horas.",
    )

    add_heading(doc, "9.6 — Verificando se o treino está vivo", level=2)
    add_codeblock(doc, ".venv\\Scripts\\python -m ml_engine.scripts.check_learning_progress")
    add_para(
        doc,
        "Lê os ray_results dos 3 experimentos mais recentes e imprime "
        "status ALIVE/DEAD/IDLE, iterações completadas, recompensa, "
        "config resumido. Equivalente em usabilidade ao \"htop\" para "
        "treinos.",
    )
    add_codeblock(doc, ".venv\\Scripts\\python -m ml_engine.scripts.check_learning_progress --tail 1 --json")
    add_para(
        doc,
        "Só o experimento mais recente, em formato JSON para scripts.",
    )

    add_heading(doc, "9.7 — Rodando os testes", level=2)
    add_codeblock(doc, "npm test")
    add_para(doc, "Roda todos os testes TypeScript com Vitest.")
    add_codeblock(doc, ".venv\\Scripts\\python -m pytest ml_engine/ -v")
    add_para(
        doc,
        "Roda todos os testes Python com pytest. -v mostra cada teste "
        "individual.",
    )
    add_codeblock(doc, ".venv\\Scripts\\python -m pytest ml_engine/ray_cluster/tests/test_orchestrator_config.py -v")
    add_para(
        doc,
        "Roda SÓ os testes do orquestrador — os que travam a regressão do "
        "bug histórico de batch alignment.",
    )

    add_heading(doc, "9.8 — Diagnóstico do banco", level=2)
    add_codeblock(doc, "npm run db:health")
    add_para(
        doc,
        "Imprime um relatório: está conectando? Todas as tabelas "
        "existem? Quantas linhas em cada uma? Nenhuma coluna faltando?",
    )
    add_codeblock(doc, "npm run db:migrate")
    add_para(
        doc,
        "Aplica as migrações pendentes na pasta drizzle/. Ajusta o "
        "esquema do banco para a versão atual do código.",
    )
    add_codeblock(doc, "npm run db:heal")
    add_para(
        doc,
        "Tenta auto-reparar inconsistências — por exemplo, sinergias "
        "órfãs, cartas sem oracle_text, etc.",
    )

    add_heading(doc, "9.9 — Ajustes e exploração", level=2)
    add_codeblock(doc, "npm run check:learn")
    add_para(
        doc,
        "Lista o top 30 de cartas por peso (separando por arquétipo). Bom "
        "para \"sentir\" se o sistema está aprendendo algo razoável.",
    )
    add_codeblock(doc, "npm run calibrate:llm")
    add_para(
        doc,
        "Calibração semanal via Claude Haiku (custo ~$0.50). Manda as 80 "
        "cartas top de cada arquétipo para o LLM, recebe uma pontuação de "
        "0-100, traduz em delta de peso. Corrige possíveis vieses do "
        "self-play.",
    )

    page_break(doc)

    # ═══════════════════════════════════════════════════════════════════════
    # PARTE 10 — BANCO DE DADOS
    # ═══════════════════════════════════════════════════════════════════════
    add_heading(doc, "Parte 10 — O banco de dados: a memória de longo prazo", level=1)
    add_para(
        doc,
        "Todos os três cérebros escrevem e leem do mesmo banco Postgres. "
        "O banco é organizado em tabelas (como abas de uma planilha "
        "gigante do Excel). Cada tabela guarda um tipo específico de "
        "informação. Aqui as mais importantes.",
    )

    tabelas = [
        ("cards",
         "Catálogo completo: ~60 mil cartas com nome, texto, custo, tipo, "
         "raridade.",
         "Preenchida pelo seed-scryfall. Lida pela interface e pelos "
         "cérebros de avaliação."),
        ("decks",
         "Decks salvos pelo usuário no site.",
         "Preenchida pelo frontend. Lida pelo motor de sugestões."),
        ("card_learning",
         "O coração do aprendizado. Para cada carta, guarda um peso "
         "global + pesos por arquétipo (aggro, control, midrange, combo, "
         "ramp).",
         "Escrita pelo CardLearningQueue (serializado). Lida por DeckGen, "
         "DeckExplainer, CardSearch."),
        ("card_oracle_embeddings",
         "Para cada carta, um vetor de 384 números que captura "
         "significado do texto oracle.",
         "Preenchida uma vez pelo pgvector_writer.py. Lida por cache "
         "semântico e por busca de cartas parecidas."),
        ("competitive_decks",
         "Decks de torneios reais baixados dos scrapers.",
         "Escrita por mtggoldfishScraper e mtgtop8Scraper. Lida para "
         "análise de metagame e \"benchmark\" das IAs."),
        ("card_synergies",
         "Pares de cartas com um score de sinergia.",
         "Calculada por self-play e embeddings. Lida pelo DeckGen para "
         "escolher cartas complementares."),
        ("semantic_cache",
         "Cache de respostas de LLM indexado por embedding da pergunta.",
         "Escrita/lida pelo ragCache. Expira depois de 30 dias (TTL)."),
        ("api_budget_ledger",
         "Registro horário de gasto em API. Quanto foi gasto, em qual "
         "serviço.",
         "Escrita pelo circuitBreaker. Lida para decidir se abrir o "
         "circuito."),
        ("toxic_actions",
         "Sequências de ações que levaram a loops ou derrota "
         "catastrófica.",
         "Escrita pelo LoopGuard. Lida pelo ambiente RL para criar "
         "aversão."),
        ("league_state",
         "Snapshots de IAs congeladas para anti-esquecimento.",
         "Escrita pelo LeagueManager. Lida pelos env runners para "
         "pareamento com oponentes antigos."),
        ("card_contextual_weight",
         "Peso de cada carta em contexto específico (commander X, "
         "arquétipo Y).",
         "Futura distilação da rede neural. Ainda não preenchida em "
         "produção."),
    ]

    add_table(
        doc,
        ["Tabela", "O que guarda", "Quem escreve / lê"],
        tabelas,
        col_widths=[3.5, 5.0, 7.5],
    )

    add_heading(doc, "Migrações: como o esquema evolui", level=2)
    add_para(
        doc,
        "Quando precisamos adicionar uma coluna ou criar uma tabela, "
        "NUNCA fazemos direto no banco. Criamos um arquivo de migração "
        "numerado em drizzle/ (0000, 0001, 0002, …, 0006). Cada arquivo "
        "contém o SQL para aplicar a mudança E o SQL para reverter. "
        "O comando npm run db:migrate aplica as pendentes, na ordem.",
    )
    add_para(
        doc,
        "Assim, qualquer nova instalação do projeto roda migrate e "
        "converge para o esquema atual, sem surpresas.",
    )

    page_break(doc)

    # ═══════════════════════════════════════════════════════════════════════
    # PARTE 11 — TESTES
    # ═══════════════════════════════════════════════════════════════════════
    add_heading(doc, "Parte 11 — Testes e garantias de qualidade", level=1)
    add_para(
        doc,
        "Um projeto que depende de IA aprendendo sozinha precisa ter "
        "redes de segurança rigorosas — senão um bug pequeno derruba o "
        "treino de uma semana. Usamos testes automatizados em 3 níveis.",
    )

    add_heading(doc, "Nível 1 — Testes unitários", level=2)
    add_para(
        doc,
        "Cada função sozinha é testada com entradas conhecidas. Exemplo: "
        "\"dada essa lista de cartas, o evaluator deve retornar score 75\". "
        "Se alguém mexer na função e quebrar essa expectativa, o teste "
        "reprova.",
    )
    add_bullet(doc, "TypeScript: arquivos *.test.ts ao lado dos .ts.")
    add_bullet(doc, "Python: arquivos test_*.py dentro de pastas tests/.")

    add_heading(doc, "Nível 2 — Testes de integração", level=2)
    add_para(
        doc,
        "Testam vários componentes juntos. Exemplo: \"ligar o env, rodar "
        "3 passos, verificar que o Forge respondeu\". Mais lentos mas "
        "mais realistas.",
    )

    add_heading(doc, "Nível 3 — Testes de regressão", level=2)
    add_para(
        doc,
        "Especificamente focados em bugs que JÁ ocorreram em produção. "
        "Para cada incidente documentado no TRAINING_TROUBLESHOOTING.md, "
        "existe um teste que reproduz a situação e verifica que a "
        "correção está presente. Exemplos:",
    )
    add_bullet(doc, "test_validate_batch_alignment_rejects_nondivisible_256_50 — trava a configuração EXATA que matou 100 % dos treinos antigos.")
    add_bullet(doc, "test_build_config_default_max_cards_is_memory_safe — garante que max_cards não passe de 64 por padrão.")
    add_bullet(doc, "test_clp_reports_alive_and_dead_trials — valida que o diagnosticador detecta corretamente trials mortos.")

    add_heading(doc, "O número atual de testes", level=2)
    add_para(
        doc,
        "Em abril de 2026, o projeto tem aproximadamente 56 testes Python "
        "(pytest) e 362 arquivos de teste TypeScript (vitest). Cada "
        "push que mexe em ml_engine roda os testes Python antes; cada "
        "push no backend Node roda os testes TypeScript.",
    )

    page_break(doc)

    # ═══════════════════════════════════════════════════════════════════════
    # PARTE 12 — RESULTADOS
    # ═══════════════════════════════════════════════════════════════════════
    add_heading(doc, "Parte 12 — Resultados: esperados, observados e cumpridos", level=1)

    add_heading(doc, "12.1 — Objetivos e o que foi entregue", level=2)

    obj_rows = [
        ("Coletar catálogo de cartas", "60 mil cartas disponíveis",
         "~60 mil cartas carregadas da Scryfall", "✅ Cumprido"),
        ("Interface web de busca e deck-builder",
         "Usuário monta deck confortavelmente",
         "Páginas CardSearch, DeckBuilder, DeckGenerator, MetaDashboard, "
         "SynergyGraph funcionais", "✅ Cumprido"),
        ("Avaliador heurístico (Cérebro 1)",
         "Classificar deck em tiers S-F em < 10 ms",
         "deckEvaluationBrain.ts entrega em < 5 ms",
         "✅ Cumprido"),
        ("Cérebro evolutivo (Cérebro 2)",
         "Evoluir 100 decks × N gerações e melhorar métricas de win rate",
         "fullBrainTraining.ts roda em 9 min, gera métricas de elite / "
         "weak / baseline", "✅ Cumprido"),
        ("Ponte com motor MTG real (Forge)",
         "Simulação fiel de regras oficiais",
         "rlbridge.jar estável, protocolo JSON validado com 25 asserts",
         "✅ Cumprido"),
        ("Treinamento de rede neural (Cérebro 3)",
         "Treino executa 24h sem crashes, recompensa média converge "
         "positiva", "Último treino: 35 min, 162 iterações por trial, "
         "ambiente estável, recompensa ainda negativa mas estável "
         "(−0.166 / −0.318)", "🟡 Em progresso"),
        ("League / anti-esquecimento",
         "Pool de oponentes congelados ativo",
         "LeagueManager implementado e integrado ao orchestrator",
         "✅ Cumprido"),
        ("Defesa financeira (Pilar 8)",
         "RAG cache, circuit breaker, CardLearningQueue funcionando",
         "Todos implementados e testados, ainda não em carga produção",
         "🟡 Cumprido, aguardando carga real"),
        ("Distilação RL → card_learning",
         "rlToCardLearningBridge traduz pesos da rede em ajustes de "
         "peso de cartas", "Planejado para fase 5", "⏳ Próximos passos"),
    ]

    add_table(
        doc,
        ["Objetivo", "Meta esperada", "Resultado observado", "Status"],
        obj_rows,
        col_widths=[3.4, 3.6, 5.4, 2.2],
    )

    add_heading(doc, "12.2 — O que saímos resolvendo no caminho (Fase 4)", level=2)
    add_para(
        doc,
        "Durante abril de 2026 enfrentamos 4 bugs que matavam 100 % dos "
        "treinos. Cada um foi corrigido, testado e documentado:",
    )
    add_bullet(doc, "Bug #1 — Reshape inválido (shape [5,50] invalid for input size 256). Corrigido via _validate_batch_alignment.", bold_first_n=1)
    add_bullet(doc, "Bug #2 — Estouro de memória (40 MiB por dummy batch × 4 trials × 4 workers = 650 MiB). Corrigido via max_cards=64 padrão.", bold_first_n=1)
    add_bullet(doc, "Bug #3 — Erro CUBLAS em cascata. Corrigido com wrapper que aponta para o runbook.", bold_first_n=1)
    add_bullet(doc, "Bug #4 — Módulo check_learning_progress inexistente. Criado + testado.", bold_first_n=1)

    add_heading(doc, "12.3 — A validação em produção (23/04/2026)", level=2)
    add_para(
        doc,
        "Com todos os guards no lugar, rodamos um smoke test de 30 minutos:",
    )
    add_codeblock(doc, ".\\train.ps1 -NumWorkers 2 -NumTrials 2 -BudgetHours 0.5 -BatchSize 500 -MaxCards 32")
    add_para(doc, "Resultado:")
    add_bullet(doc, "35 minutos totais de treino.")
    add_bullet(doc, "2 trials completaram 162 iterações cada.")
    add_bullet(doc, "108.800 e 109.200 passos de ambiente totais.")
    add_bullet(doc, "38 e 39 checkpoints salvos.")
    add_bullet(doc, "Ciclos de PBT exploit/explore funcionaram — lr/grad_clip/vf_loss_coeff/entropy_coeff foram perturbados.")
    add_bullet(doc, "Exit code 0 (sucesso limpo).")
    add_bullet(doc, "check_learning_progress --tail 1 reportou os 2 trials ALIVE com configuração válida (tbs=500 rfl=50 workers=2 ok).")
    add_callout(
        doc,
        "Conclusão do marco",
        "Este foi o primeiro treino do projeto a rodar do começo ao fim "
        "sem intervenção humana. A infraestrutura de treinamento está "
        "agora pronta para rodar por 24-48 horas e começar a produzir "
        "recompensa média positiva.",
        cor_titulo=VERDE,
    )

    page_break(doc)

    # ═══════════════════════════════════════════════════════════════════════
    # PARTE 13 — PRÓXIMOS PASSOS
    # ═══════════════════════════════════════════════════════════════════════
    add_heading(doc, "Parte 13 — Próximos passos", level=1)
    add_numbered(doc, "Rodar um treino completo de 24 horas com os parâmetros validados e medir recompensa média final (esperado: convergir para valores > 0).")
    add_numbered(doc, "Implementar rlToCardLearningBridge.ts — traduzir pesos da rede neural em deltas de card_learning, fechando o ciclo com os outros dois cérebros.")
    add_numbered(doc, "Levar o Pilar 8 a carga real — ligar o RAG cache em produção com tráfego real e medir economia de LLM.")
    add_numbered(doc, "Expandir a cobertura de arquétipos — hoje temos 5 (aggro, control, midrange, combo, ramp); desejável adicionar tribal, prison, storm.")
    add_numbered(doc, "Preparar um modo competitivo — o usuário fornece o deck do oponente e a IA escolhe a melhor jogada em tempo real.")
    add_numbered(doc, "Publicar um estudo técnico sobre a abordagem (baseado no ARCHITECTURE.md) para validação científica externa.")

    page_break(doc)

    # ═══════════════════════════════════════════════════════════════════════
    # ANEXO — GLOSSÁRIO
    # ═══════════════════════════════════════════════════════════════════════
    add_heading(doc, "Anexo — Glossário", level=1)

    glossario = [
        ("Aprendizado por Reforço (RL)",
         "Tipo de IA que aprende por tentativa e erro. Em vez de "
         "mostrar exemplos corretos, deixamos a IA tentar, damos "
         "recompensas positivas quando acerta e negativas quando "
         "erra."),
        ("Arquétipo",
         "Família de deck com estratégia parecida — aggro "
         "(agressivo), control (controla o ritmo), midrange (meio "
         "termo), combo (monta combos infinitos), ramp (acelera "
         "mana)."),
        ("Backend",
         "Código que roda no servidor, invisível para o usuário. Em "
         "oposição ao frontend (o site que o usuário vê)."),
        ("Batch",
         "Lote. Quantidade de dados processados juntos. "
         "Train_batch_size = 500 significa \"ajustar os pesos da "
         "rede a cada 500 exemplos\"."),
        ("Checkpoint",
         "Foto tirada dos pesos da rede em um dado momento do "
         "treino. Serve para resumir a partir dali se algo falhar."),
        ("Contêiner (Docker)",
         "Caixa de software isolada com tudo que um programa "
         "precisa para rodar. Evita \"na minha máquina funciona\"."),
        ("CUDA",
         "Tecnologia da NVIDIA que permite rodar cálculos pesados "
         "na GPU em vez da CPU. Muito mais rápido para redes "
         "neurais."),
        ("Embedding",
         "Lista de números que representa um texto (ou imagem, ou "
         "som). Textos parecidos → listas parecidas."),
        ("Frontend",
         "Parte do sistema que o usuário vê — páginas, botões, "
         "gráficos. Roda no navegador."),
        ("GNN",
         "Graph Neural Network. Rede neural que processa grafos "
         "(pontos ligados por linhas), em vez de listas planas."),
        ("GPU",
         "Graphic Processing Unit. Placa de vídeo. Bilhões de "
         "cálculos pequenos em paralelo."),
        ("Gradient / Gradiente",
         "Direção matemática de maior queda do erro. Segui-lo = "
         "aprender."),
        ("Hiperparâmetro",
         "Configuração escolhida antes do treino começar (lr, "
         "batch_size, entropy_coeff). Diferente dos parâmetros "
         "(pesos) que a rede aprende sozinha."),
        ("Hash (SHA1)",
         "Impressão digital numérica de um dado. Dois dados "
         "idênticos → mesmo hash. Dois diferentes → hashes "
         "virtualmente impossíveis de coincidir."),
        ("IMPALA",
         "Algoritmo de RL distribuído que tolera atrasos entre "
         "coletadores e aprendiz. Específico para ambientes lentos."),
        ("Iteração",
         "Uma passada do loop de treino. Coletar dados + ajustar "
         "pesos + salvar checkpoint (se for o caso)."),
        ("Learning rate (lr)",
         "Tamanho do passo ao descer a montanha do erro. Muito "
         "grande: ultrapassa o vale. Muito pequeno: demora."),
        ("LLM",
         "Large Language Model. Modelos grandes de linguagem — "
         "GPT, Claude, Gemini. Aqui usamos Claude Haiku para "
         "calibração semanal."),
        ("ORM",
         "Object-Relational Mapper. Biblioteca que traduz tabelas "
         "do banco em objetos no código. Usamos Drizzle."),
        ("PBT",
         "Population-Based Training. Técnica que treina N IAs em "
         "paralelo, periodicamente faz as piores copiarem as "
         "melhores e mutar hiperparâmetros."),
        ("pgvector",
         "Extensão do Postgres que adiciona tipo \"vector\" e "
         "busca por similaridade (HNSW)."),
        ("Pipeline",
         "Sequência encadeada de passos. Aqui: scraping → "
         "clustering → embeddings → treino → distilação."),
        ("Reward Shaping",
         "Técnica de dar recompensas intermediárias para acelerar "
         "aprendizado em ambientes com recompensa final muito "
         "esparsa."),
        ("Rollout",
         "Sequência de passos coletados por um env runner antes "
         "de enviar para o learner. Controlado por "
         "rollout_fragment_length."),
        ("tRPC",
         "Sistema de RPC tipado. O frontend chama funções do "
         "backend com garantia de tipos."),
        ("V-trace",
         "Correção matemática usada pelo IMPALA para aprender "
         "corretamente com dados coletados por versões antigas da "
         "rede."),
        ("Venv / virtualenv",
         "Ambiente Python isolado. Cada projeto tem seu próprio, "
         "para não misturar versões de bibliotecas."),
        ("Worker / Trabalhador",
         "Processo que coleta experiência (joga partidas). Há "
         "vários em paralelo."),
    ]

    for termo, def_ in glossario:
        add_rich_para(doc, [
            (termo + " — ", True, False, AZUL),
            (def_, False, False, None),
        ])

    # Final
    add_para(doc, "", size=6)
    add_para(
        doc,
        "— FIM DA DOCUMENTAÇÃO —",
        bold=True, color=AZUL, align=WD_ALIGN_PARAGRAPH.CENTER,
    )
    add_para(
        doc,
        "Dúvidas, sugestões ou erros: manter atualizado em "
        "ARCHITECTURE.md e TRAINING_TROUBLESHOOTING.md.",
        italic=True, color=CINZA_ESCURO, align=WD_ALIGN_PARAGRAPH.CENTER,
    )

    doc.save(output_path)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    out = root / "DOCUMENTACAO_PROJETO.docx"
    build_document(out)
    print(f"[OK] Documento gerado: {out}")
    print(f"     Tamanho: {out.stat().st_size / 1024:.1f} KB")
