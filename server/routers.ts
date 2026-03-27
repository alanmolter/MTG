import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  cards: router({
    search: publicProcedure
      .input(
        z.object({
          name: z.string().optional(),
          type: z.string().optional(),
          colors: z.string().optional(),
          cmc: z.number().optional(),
          rarity: z.string().optional(),
        })
      )
      .query(async ({ input }) => {
        const { searchCards } = await import("./services/scryfall");
        return await searchCards(input);
      }),

    getById: publicProcedure.input(z.number()).query(async ({ input }) => {
      const { getCardById } = await import("./services/scryfall");
      return await getCardById(input);
    }),

    similar: publicProcedure.input(z.number()).query(async ({ input }) => {
      const { findSimilarCards } = await import("./services/embeddings");
      return await findSimilarCards(input, 10);
    }),

    synergy: publicProcedure
      .input(z.object({ card1Id: z.number(), card2Id: z.number() }))
      .query(async ({ input }) => {
        const { getCardSynergy } = await import("./services/synergy");
        return await getCardSynergy(input.card1Id, input.card2Id);
      }),
  }),

  decks: router({
    create: protectedProcedure
      .input(
        z.object({
          name: z.string(),
          format: z.enum(["standard", "modern", "commander", "legacy"]),
          archetype: z.string().optional(),
          description: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { createDeck } = await import("./db-decks");
        return await createDeck(ctx.user.id, input.name, input.format, input.archetype, input.description);
      }),

    list: protectedProcedure.query(async ({ ctx }) => {
      const { getUserDecks } = await import("./db-decks");
      return await getUserDecks(ctx.user.id);
    }),

    getById: publicProcedure.input(z.number()).query(async ({ input }) => {
      const { getDeckById } = await import("./db-decks");
      return await getDeckById(input);
    }),

    addCard: protectedProcedure
      .input(
        z.object({
          deckId: z.number(),
          cardId: z.number(),
          quantity: z.number().default(1),
        })
      )
      .mutation(async ({ input }) => {
        const { addCardToDeck } = await import("./db-decks");
        return await addCardToDeck(input.deckId, input.cardId, input.quantity);
      }),

    removeCard: protectedProcedure
      .input(
        z.object({
          deckId: z.number(),
          cardId: z.number(),
        })
      )
      .mutation(async ({ input }) => {
        const { removeCardFromDeck } = await import("./db-decks");
        return await removeCardFromDeck(input.deckId, input.cardId);
      }),

    getCards: publicProcedure.input(z.number()).query(async ({ input }) => {
      const { getDeckCards } = await import("./db-decks");
      return await getDeckCards(input);
    }),

    delete: protectedProcedure.input(z.number()).mutation(async ({ input }) => {
      const { deleteDeck } = await import("./db-decks");
      return await deleteDeck(input);
    }),
  }),

  generator: router({
    generateByArchetype: publicProcedure
      .input(
        z.object({
          archetype: z.enum(["aggro", "burn", "control", "combo", "midrange", "ramp", "tempo"]),
          format: z.enum(["standard", "historic", "modern", "legacy", "commander", "pioneer"]),
          colors: z.array(z.enum(["W", "U", "B", "R", "G"])).optional(),
          tribes: z.array(z.string()).optional(),
          cardTypes: z.array(z.string()).optional(),
          useScoring: z.boolean().optional(),
          onlyArena: z.boolean().optional(),
          maxPrice: z.number().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { generateDeckByArchetype, exportToText, exportToArena } = await import("./services/archetypeGenerator");
        const { searchCards } = await import("./services/scryfall");
        const { evaluateDeckWithEngine } = await import("./services/deckGenerator");
        const { validateDeck } = await import("./services/deckGenerator");

        // Carregar pool de cartas do banco
        const cardPool = await searchCards({
          colors: input.colors?.join("") || undefined,
          isArena: input.onlyArena,
          maxPrice: input.maxPrice,
        });

        if (cardPool.length === 0) {
          return {
            error: "Nenhuma carta encontrada no banco. Sincronize cartas do Scryfall primeiro.",
            deck: [],
            metrics: null,
            validation: null,
            template: null,
            poolSize: 0,
            warnings: ["Banco de dados vazio."],
            exportText: "",
            exportArena: "",
          };
        }

        const result = generateDeckByArchetype(cardPool, {
          archetype: input.archetype,
          format: input.format,
          colors: input.colors,
          tribes: input.tribes,
          cardTypes: input.cardTypes,
          useScoring: input.useScoring ?? true,
          onlyArena: input.onlyArena,
        });

        // Avaliar com Game Feature Engine
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const metrics = evaluateDeckWithEngine(result.cards as any, input.archetype);

        // Validar deck
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const validation = validateDeck(result.cards as any, input.format === "historic" || input.format === "pioneer" ? "standard" : input.format);

        return {
          deck: result.cards,
          template: result.template,
          poolSize: result.poolSize,
          warnings: result.warnings,
          metrics,
          validation,
          exportText: exportToText(result.cards, { archetype: input.archetype, format: input.format }),
          exportArena: exportToArena(result.cards),
        };
      }),

    generate: publicProcedure
      .input(
        z.object({
          format: z.enum(["standard", "modern", "commander", "legacy"]),
          archetype: z.string().optional(),
          seedCards: z.array(z.number()).optional(),
          useRL: z.boolean().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { generateInitialDeck, validateDeck, evaluateDeckWithEngine, trainDeckWithRL } = await import(
          "./services/deckGenerator"
        );
        const deck = await generateInitialDeck(input, input.seedCards);
        const validation = validateDeck(deck, input.format);

        // Avaliar deck com Game Feature Engine
        const metrics = evaluateDeckWithEngine(deck, input.archetype || "default");

        // Otimizar com RL melhorado se solicitado
        if (input.useRL) {
          const { deck: rlDeck, metrics: rlMetrics, improvements } = await trainDeckWithRL(
            deck,
            { format: input.format, archetype: input.archetype },
            undefined,
            200
          );
          const rlValidation = validateDeck(rlDeck, input.format);
          return { deck: rlDeck, validation: rlValidation, metrics: rlMetrics, improvements };
        }

        return { deck, validation, metrics, improvements: 0 };
      }),

    evaluate: publicProcedure
      .input(
        z.object({
          cards: z.array(z.object({
            name: z.string(),
            type: z.string().optional(),
            text: z.string().optional(),
            cmc: z.number().optional(),
            quantity: z.number(),
          })),
          archetype: z.string().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { evaluateDeck } = await import("./services/gameFeatureEngine");
        // Expandir cartas com quantidades
        const expanded: { name: string; type?: string; text?: string; cmc?: number }[] = [];
        for (const card of input.cards) {
          for (let i = 0; i < card.quantity; i++) {
            expanded.push({ name: card.name, type: card.type, text: card.text, cmc: card.cmc });
          }
        }
        return evaluateDeck(expanded, input.archetype || "default");
      }),
  }),

  sync: router({
    syncScryfall: publicProcedure
      .input(
        z.object({
          format: z.enum(["standard", "modern", "commander", "legacy", "all"]).optional(),
          colors: z.array(z.string()).optional(),
          limit: z.number().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { syncCardsFromScryfall } = await import("./services/scryfallSync");
        return await syncCardsFromScryfall(input);
      }),

    getStats: publicProcedure.query(async () => {
      const { getCardStats } = await import("./services/scryfallSync");
      return await getCardStats();
    }),
  }),

  moxfield: router({
    importDecks: publicProcedure
      .input(
        z.object({
          format: z.enum(["standard", "modern", "commander", "legacy"]).optional(),
          limit: z.number().min(1).max(100).optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { importMoxfieldDecks } = await import("./services/moxfieldScraper");
        return await importMoxfieldDecks(input.format || "standard", input.limit || 50);
      }),

    getStats: publicProcedure.query(async () => {
      const { getCompetitiveDeckStats } = await import("./services/moxfieldScraper");
      return await getCompetitiveDeckStats();
    }),
  }),

  mtgtop8: router({
    importDecks: publicProcedure
      .input(
        z.object({
          format: z.enum(["standard", "pioneer", "modern", "legacy", "vintage", "commander"]).optional(),
          limit: z.number().min(1).max(100).optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { importMTGTop8Decks } = await import("./services/mtgtop8Scraper");
        return await importMTGTop8Decks(input.format || "standard", input.limit || 50);
      }),
  }),

  mtggoldfish: router({
    importDecks: publicProcedure
      .input(
        z.object({
          format: z.enum(["standard", "pioneer", "modern", "legacy", "vintage", "commander"]).optional(),
          limit: z.number().min(1).max(100).optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { importMTGGoldfishDecks } = await import("./services/mtggoldfishScraper");
        return await importMTGGoldfishDecks(input.format || "standard", input.limit || 50);
      }),
  }),

  training: router({
    trainEmbeddings: publicProcedure.mutation(async () => {
      const { trainEmbeddingsFromDecks } = await import("./services/embeddingTrainer");
      return await trainEmbeddingsFromDecks();
    }),

    clusterDecks: publicProcedure
      .input(z.object({ k: z.number().min(2).max(20).optional() }))
      .mutation(async ({ input }) => {
        const { clusterCompetitiveDecks, getClusterStatsByArchetype } = await import("./services/clustering");

        // Executar clustering com a nova implementação
        const { clusters, stats } = await clusterCompetitiveDecks(input.k || 8);

        // Obter estatísticas por arquétipo
        const archetypeStats = getClusterStatsByArchetype(clusters);

        return {
          clusters,
          stats,
          archetypeStats,
          totalClusters: clusters.length,
          totalDecksClustered: clusters.reduce((sum, c) => sum + c.deckIds.length, 0),
        };
      }),

    getHistory: publicProcedure.query(async () => {
      const { getTrainingJobHistory } = await import("./services/embeddingTrainer");
      return await getTrainingJobHistory(10);
    }),
  }),

  visualization: router({
    generateDeckArt: publicProcedure
      .input(
        z.object({
          deckId: z.number(),
          style: z.enum(["fantasy", "minimalist", "abstract", "realistic"]).optional(),
          includeCardNames: z.boolean().optional(),
          customPrompt: z.string().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { generateDeckVisualization } = await import("./services/deckVisualization");
        return await generateDeckVisualization(input);
      }),

    generateDeckArtSet: publicProcedure
      .input(z.object({ deckId: z.number() }))
      .mutation(async ({ input }) => {
        const { generateDeckVisualizationSet } = await import("./services/deckVisualization");
        return await generateDeckVisualizationSet(input.deckId);
      }),
  }),

  sharing: router({
    createShare: publicProcedure
      .input(
        z.object({
          deckId: z.number(),
          title: z.string().optional(),
          description: z.string().optional(),
          includeImage: z.boolean().optional(),
          expiresInDays: z.number().min(1).max(365).optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { createDeckShare } = await import("./services/deckSharing");
        return await createDeckShare(input);
      }),

    getSharedDeck: publicProcedure
      .input(z.object({ shareId: z.string() }))
      .query(async ({ input }) => {
        const { getSharedDeck } = await import("./services/deckSharing");
        return await getSharedDeck(input.shareId);
      }),

    getShareUrls: publicProcedure
      .input(z.object({ shareId: z.string() }))
      .query(async ({ input }) => {
        const { getSharedDeck, generateShareUrls } = await import("./services/deckSharing");
        const shareData = await getSharedDeck(input.shareId);
        if (!shareData) {
          throw new Error("Share not found");
        }
        return generateShareUrls(shareData);
      }),
  }),

  meta: router({
    analyze: publicProcedure
      .input(z.object({ format: z.string() }))
      .mutation(async ({ input }) => {
        const { performMetaAnalysis } = await import("./services/metaAnalysis");
        return await performMetaAnalysis(input.format);
      }),

    getStats: publicProcedure
      .input(z.object({ format: z.string() }))
      .query(async ({ input }) => {
        const { getMetaStats } = await import("./services/metaAnalysis");
        return await getMetaStats(input.format);
      }),
  }),
});

export type AppRouter = typeof appRouter;
