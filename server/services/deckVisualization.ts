import { generateImage } from "../_core/imageGeneration";
import { getDb } from "../db";
import { eq } from "drizzle-orm";

export interface DeckArtisticVisualization {
  deckId: number;
  imageUrl: string;
  prompt: string;
  style: "fantasy" | "minimalist" | "abstract" | "realistic";
  createdAt: Date;
}

export interface DeckArtOptions {
  deckId: number;
  style?: "fantasy" | "minimalist" | "abstract" | "realistic";
  includeCardNames?: boolean;
  customPrompt?: string;
}

/**
 * Generate an artistic visualization of a deck
 */
export async function generateDeckVisualization(options: DeckArtOptions): Promise<DeckArtisticVisualization> {
  const { deckId, style = "fantasy", includeCardNames = true, customPrompt } = options;

  // Get deck information
  const db = await getDb();
  if (!db) throw new Error('[DeckVisualization] Banco de dados indisponível');
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

  // Generate prompt based on deck composition
  const prompt = customPrompt || generateDeckPrompt(deck, deckCardsResult, style, includeCardNames);

  // Generate image
  const imageResult = await generateImage({
    prompt,
    originalImages: [], // Could add card images as references
  });

  if (!imageResult.url) {
    throw new Error("Failed to generate deck visualization image");
  }

  return {
    deckId,
    imageUrl: imageResult.url,
    prompt,
    style,
    createdAt: new Date(),
  };
}

/**
 * Generate a descriptive prompt for deck visualization
 */
function generateDeckPrompt(
  deck: any,
  deckCards: any[],
  style: string,
  includeCardNames: boolean
): string {
  const colors = extractDeckColors(deckCards);
  const themes = extractDeckThemes(deckCards);
  const cardNames = includeCardNames ? extractKeyCardNames(deckCards) : [];

  let prompt = `Create a ${style} artistic visualization of a Magic: The Gathering deck`;

  // Add color theme
  if (colors.length > 0) {
    const colorNames = colors.map(c => {
      switch (c.toLowerCase()) {
        case 'w': return 'white';
        case 'u': return 'blue';
        case 'b': return 'black';
        case 'r': return 'red';
        case 'g': return 'green';
        default: return c;
      }
    });
    prompt += ` with ${colorNames.join(' and ')} color scheme`;
  }

  // Add thematic elements
  if (themes.length > 0) {
    prompt += ` featuring ${themes.slice(0, 3).join(', ')} themes`;
  }

  // Add key cards if requested
  if (cardNames.length > 0) {
    prompt += `. Include visual elements representing: ${cardNames.slice(0, 5).join(', ')}`;
  }

  // Add style-specific instructions
  switch (style) {
    case "fantasy":
      prompt += ". Fantasy art style with magical elements, mystical atmosphere, detailed illustrations";
      break;
    case "minimalist":
      prompt += ". Clean minimalist design, geometric shapes, abstract representations, modern aesthetic";
      break;
    case "abstract":
      prompt += ". Abstract art style, symbolic representations, color fields, non-literal interpretation";
      break;
    case "realistic":
      prompt += ". Realistic style, detailed card illustrations, photorealistic elements, tangible magic";
      break;
  }

  prompt += ". High quality, professional artwork, suitable for deck profile image";

  return prompt;
}

/**
 * Extract color identity from deck cards
 */
function extractDeckColors(deckCards: any[]): string[] {
  const colors = new Set<string>();

  for (const deckCard of deckCards) {
    const cardColors = deckCard.card.colors;
    if (cardColors) {
      // Handle color strings like "W", "WU", "WUB", etc.
      for (const color of cardColors.split('')) {
        colors.add(color);
      }
    }
  }

  return Array.from(colors).sort();
}

/**
 * Extract thematic elements from deck cards
 */
function extractDeckThemes(deckCards: any[]): string[] {
  const themes = new Set<string>();

  for (const deckCard of deckCards) {
    const cardType = deckCard.card.type?.toLowerCase() || '';

    // Extract themes from card types
    if (cardType.includes('creature')) themes.add('creatures');
    if (cardType.includes('instant') || cardType.includes('sorcery')) themes.add('spells');
    if (cardType.includes('artifact')) themes.add('artifacts');
    if (cardType.includes('enchantment')) themes.add('enchantments');
    if (cardType.includes('planeswalker')) themes.add('planeswalkers');
    if (cardType.includes('land')) themes.add('lands');

    // Extract themes from card names/text (simplified)
    const cardName = deckCard.card.name?.toLowerCase() || '';
    const cardText = deckCard.card.text?.toLowerCase() || '';

    if (cardName.includes('dragon') || cardText.includes('dragon')) themes.add('dragons');
    if (cardName.includes('angel') || cardText.includes('angel')) themes.add('angels');
    if (cardName.includes('demon') || cardText.includes('demon')) themes.add('demons');
    if (cardName.includes('zombie') || cardText.includes('zombie')) themes.add('undead');
    if (cardName.includes('elf') || cardText.includes('elf')) themes.add('elves');
    if (cardName.includes('goblin') || cardText.includes('goblin')) themes.add('goblins');
  }

  return Array.from(themes);
}

/**
 * Extract key card names for the prompt
 */
function extractKeyCardNames(deckCards: any[]): string[] {
  // Sort by quantity and CMC to get "key" cards
  const sortedCards = deckCards
    .filter(dc => dc.card.cmc !== null && dc.card.cmc >= 3) // Focus on higher-cost cards
    .sort((a, b) => (b.quantity * (b.card.cmc || 0)) - (a.quantity * (a.card.cmc || 0)))
    .slice(0, 8); // Top 8 cards

  return sortedCards.map(dc => dc.card.name);
}

/**
 * Generate multiple visualizations with different styles
 */
export async function generateDeckVisualizationSet(deckId: number): Promise<DeckArtisticVisualization[]> {
  const styles: Array<"fantasy" | "minimalist" | "abstract" | "realistic"> = [
    "fantasy", "minimalist", "abstract", "realistic"
  ];

  const visualizations: DeckArtisticVisualization[] = [];

  for (const style of styles) {
    try {
      const visualization = await generateDeckVisualization({
        deckId,
        style,
        includeCardNames: true,
      });
      visualizations.push(visualization);
    } catch (error) {
      console.error(`Failed to generate ${style} visualization for deck ${deckId}:`, error);
      // Continue with other styles
    }
  }

  return visualizations;
}