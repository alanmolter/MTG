import { getDb } from "../db";
import { eq } from "drizzle-orm";
import { generateDeckVisualization } from "./deckVisualization";

export interface DeckShareData {
  deckId: number;
  shareId: string;
  title: string;
  description: string;
  imageUrl?: string;
  decklist: string;
  format: string;
  colors: string[];
  createdAt: Date;
  expiresAt?: Date;
}

export interface ShareOptions {
  deckId: number;
  title?: string;
  description?: string;
  includeImage?: boolean;
  expiresInDays?: number;
}

/**
 * Create a shareable link for a deck
 */
export async function createDeckShare(options: ShareOptions): Promise<DeckShareData> {
  const { deckId, title, description, includeImage = true, expiresInDays } = options;

  // Get deck information
  const db = getDb();
  const { decks, deckCards, cards } = await import("../../drizzle/schema");

  const deckResult = await db
    .select()
    .from(decks)
    .where(eq(decks.id, deckId))
    .limit(1);

  if (!deckResult.length) {
    throw new Error("Deck not found");
  }

  const deck = deckResult[0];

  // Get deck cards
  const deckCardsResult = await db
    .select({
      card: cards,
      quantity: deckCards.quantity,
    })
    .from(deckCards)
    .innerJoin(cards, eq(deckCards.cardId, cards.id))
    .where(eq(deckCards.deckId, deckId));

  // Generate share ID
  const shareId = generateShareId();

  // Generate decklist in text format
  const decklist = generateDecklistText(deck, deckCardsResult);

  // Extract colors
  const colors = extractDeckColors(deckCardsResult);

  // Generate image if requested
  let imageUrl: string | undefined;
  if (includeImage) {
    try {
      const visualization = await generateDeckVisualization({
        deckId,
        style: "fantasy",
        includeCardNames: false,
      });
      imageUrl = visualization.imageUrl;
    } catch (error) {
      console.warn("Failed to generate deck image for sharing:", error);
      // Continue without image
    }
  }

  const shareData: DeckShareData = {
    deckId,
    shareId,
    title: title || `${deck.name} - ${deck.format}`,
    description: description || generateDeckDescription(deck, deckCardsResult),
    imageUrl,
    decklist,
    format: deck.format,
    colors,
    createdAt: new Date(),
    expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : undefined,
  };

  // Store share data (in a real implementation, you'd save this to a database)
  // For now, we'll just return it - in production you'd want to persist shares

  return shareData;
}

/**
 * Get shared deck data by share ID
 */
export async function getSharedDeck(shareId: string): Promise<DeckShareData | null> {
  // In a real implementation, you'd fetch this from a database
  // For now, return null as we don't persist shares
  return null;
}

/**
 * Generate a unique share ID
 */
function generateShareId(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

/**
 * Generate decklist in MTG text format
 */
function generateDecklistText(deck: any, deckCards: any[]): string {
  let decklist = `${deck.name}\n`;
  if (deck.description) {
    decklist += `${deck.description}\n`;
  }
  decklist += `\n`;

  // Group cards by type
  const creatures = deckCards.filter(dc => dc.card.type?.toLowerCase().includes('creature'));
  const spells = deckCards.filter(dc =>
    dc.card.type?.toLowerCase().includes('instant') ||
    dc.card.type?.toLowerCase().includes('sorcery')
  );
  const artifacts = deckCards.filter(dc => dc.card.type?.toLowerCase().includes('artifact'));
  const enchantments = deckCards.filter(dc => dc.card.type?.toLowerCase().includes('enchantment'));
  const planeswalkers = deckCards.filter(dc => dc.card.type?.toLowerCase().includes('planeswalker'));
  const lands = deckCards.filter(dc => dc.card.type?.toLowerCase().includes('land'));

  // Add mainboard
  if (creatures.length > 0) {
    decklist += `Creatures (${creatures.reduce((sum, dc) => sum + dc.quantity, 0)})\n`;
    creatures.forEach(dc => {
      decklist += `${dc.quantity} ${dc.card.name}\n`;
    });
    decklist += `\n`;
  }

  if (spells.length > 0) {
    decklist += `Spells (${spells.reduce((sum, dc) => sum + dc.quantity, 0)})\n`;
    spells.forEach(dc => {
      decklist += `${dc.quantity} ${dc.card.name}\n`;
    });
    decklist += `\n`;
  }

  if (artifacts.length > 0) {
    decklist += `Artifacts (${artifacts.reduce((sum, dc) => sum + dc.quantity, 0)})\n`;
    artifacts.forEach(dc => {
      decklist += `${dc.quantity} ${dc.card.name}\n`;
    });
    decklist += `\n`;
  }

  if (enchantments.length > 0) {
    decklist += `Enchantments (${enchantments.reduce((sum, dc) => sum + dc.quantity, 0)})\n`;
    enchantments.forEach(dc => {
      decklist += `${dc.card.name}\n`;
    });
    decklist += `\n`;
  }

  if (planeswalkers.length > 0) {
    decklist += `Planeswalkers (${planeswalkers.reduce((sum, dc) => sum + dc.quantity, 0)})\n`;
    planeswalkers.forEach(dc => {
      decklist += `${dc.quantity} ${dc.card.name}\n`;
    });
    decklist += `\n`;
  }

  if (lands.length > 0) {
    decklist += `Lands (${lands.reduce((sum, dc) => sum + dc.quantity, 0)})\n`;
    lands.forEach(dc => {
      decklist += `${dc.quantity} ${dc.card.name}\n`;
    });
    decklist += `\n`;
  }

  return decklist.trim();
}

/**
 * Generate a description for the deck
 */
function generateDeckDescription(deck: any, deckCards: any[]): string {
  const colors = extractDeckColors(deckCards);
  const colorNames = colors.map(c => {
    switch (c.toLowerCase()) {
      case 'w': return 'White';
      case 'u': return 'Blue';
      case 'b': return 'Black';
      case 'r': return 'Red';
      case 'g': return 'Green';
      default: return c;
    }
  });

  const totalCards = deckCards.reduce((sum, dc) => sum + dc.quantity, 0);
  const creatureCount = deckCards
    .filter(dc => dc.card.type?.toLowerCase().includes('creature'))
    .reduce((sum, dc) => sum + dc.quantity, 0);

  let description = `${deck.format} deck`;
  if (colorNames.length > 0) {
    description += ` - ${colorNames.join('/')}`;
  }
  description += ` with ${totalCards} cards`;
  if (creatureCount > 0) {
    description += `, ${creatureCount} creatures`;
  }

  return description;
}

/**
 * Extract color identity from deck cards
 */
function extractDeckColors(deckCards: any[]): string[] {
  const colors = new Set<string>();

  for (const deckCard of deckCards) {
    const cardColors = deckCard.card.colors;
    if (cardColors) {
      for (const color of cardColors.split('')) {
        colors.add(color);
      }
    }
  }

  return Array.from(colors).sort();
}

/**
 * Generate social media share URLs
 */
export function generateShareUrls(shareData: DeckShareData): {
  twitter: string;
  facebook: string;
  reddit: string;
  discord: string;
} {
  const baseUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/shared/${shareData.shareId}`;
  const text = `Check out this ${shareData.format} deck: ${shareData.title}`;

  return {
    twitter: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(baseUrl)}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(baseUrl)}`,
    reddit: `https://reddit.com/submit?url=${encodeURIComponent(baseUrl)}&title=${encodeURIComponent(shareData.title)}`,
    discord: `https://discord.com/api/webhooks/...`, // Would need webhook URL
  };
}

/**
 * Generate HTML meta tags for social sharing
 */
export function generateMetaTags(shareData: DeckShareData): string {
  const baseUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/shared/${shareData.shareId}`;

  return `
    <meta property="og:title" content="${shareData.title}" />
    <meta property="og:description" content="${shareData.description}" />
    <meta property="og:image" content="${shareData.imageUrl || ''}" />
    <meta property="og:url" content="${baseUrl}" />
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${shareData.title}" />
    <meta name="twitter:description" content="${shareData.description}" />
    <meta name="twitter:image" content="${shareData.imageUrl || ''}" />
  `.trim();
}