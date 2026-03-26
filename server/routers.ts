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
    generate: publicProcedure
      .input(
        z.object({
          format: z.enum(["standard", "modern", "commander", "legacy"]),
          archetype: z.string().optional(),
          seedCards: z.array(z.number()).optional(),
        })
      )
      .mutation(async ({ input }) => {
        const { generateInitialDeck, optimizeDeck, validateDeck } = await import(
          "./services/deckGenerator"
        );
        const deck = await generateInitialDeck(input, input.seedCards);
        const optimized = await optimizeDeck(deck, input, 3);
        const validation = validateDeck(optimized, input.format);
        return { deck: optimized, validation };
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

  training: router({
    trainEmbeddings: publicProcedure.mutation(async () => {
      const { trainEmbeddingsFromDecks } = await import("./services/embeddingTrainer");
      return await trainEmbeddingsFromDecks();
    }),

    getHistory: publicProcedure.query(async () => {
      const { getTrainingJobHistory } = await import("./services/embeddingTrainer");
      return await getTrainingJobHistory(10);
    }),
  }),
});

export type AppRouter = typeof appRouter;
