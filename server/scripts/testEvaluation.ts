import { evaluateDeckWithBrain } from "../services/deckEvaluationBrain";

async function runSingleTest() {
  console.log("🔍 Testando Cérebro com Deck Mockado (Azorius Control)...");

  // Mocking 60 cards for a typical Azorius Control
  const cards = [
    // Lands (26)
    ...Array(10).fill({ name: "Island", type: "Basic Land", text: "", cmc: 0 }),
    ...Array(10).fill({ name: "Plains", type: "Basic Land", text: "", cmc: 0 }),
    ...Array(6).fill({ name: "Hallowed Fountain", type: "Land", text: "", cmc: 0 }),
    
    // Removal & Interaction (12)
    ...Array(4).fill({ name: "Sunfall", type: "Sorcery", text: "Exile all creatures.", cmc: 5 }),
    ...Array(4).fill({ name: "Get Lost", type: "Instant", text: "Destroy target creature, enchantment, or planeswalker.", cmc: 2 }),
    ...Array(4).fill({ name: "No More Lies", type: "Instant", text: "Counter target spell.", cmc: 2 }),
    
    // Draw (8)
    ...Array(4).fill({ name: "Memory Deluge", type: "Instant", text: "Look at the top X cards and put two into your hand.", cmc: 4 }),
    ...Array(4).fill({ name: "Quick Study", type: "Instant", text: "Draw two cards.", cmc: 3 }),
    
    // Threats (4)
    ...Array(2).fill({ name: "The Wandering Emperor", type: "Legendary Planeswalker", text: "Flash. Exile target tapped creature.", cmc: 4 }),
    ...Array(2).fill({ name: "Tishana's Tidebinder", type: "Creature", text: "Flash. Counter target activated or triggered ability.", cmc: 3 }),
    
    // Other (10)
    ...Array(10).fill({ name: "Utility Spell", type: "Instant", text: "Scry 2.", cmc: 1 }),
  ];

  console.log(`📡 Deck mockado com ${cards.length} cartas.`);

  const result = await evaluateDeckWithBrain(cards, "control");

  console.log("\n📊 RESULTADO DA AVALIAÇÃO:");
  console.log(`- Tier: [${result.tier}]`);
  console.log(`- Score Normalizado: ${result.normalizedScore}/100`);
  console.log(`- Winrate Estimado: ${(result.winrate! * 100).toFixed(1)}%`);
  
  console.log("\n💪 Pontos Fortes:");
  result.analysis.strengths.forEach(s => console.log(`  ✓ ${s}`));

  console.log("\n⚠️ Pontos Fracos:");
  result.analysis.weaknesses.forEach(w => console.log(`  ⚠ ${w}`));

  console.log("\n💡 Recomendações:");
  result.recommendations.forEach(r => console.log(`  • ${r}`));

  process.exit(0);
}

runSingleTest().catch(console.error);
