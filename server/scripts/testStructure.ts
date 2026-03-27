import { generateDeckByArchetype, CardData } from "../services/archetypeGenerator";
import { searchCards } from "../services/scryfall";

async function testStructure() {
  const cardPool = await searchCards({ isArena: true });

  const testArr = ["aggro", "control", "combo"];
  
  for (const arch of testArr) {
    console.log(`\nTesting Archetype: ${arch.toUpperCase()}`);
    const result = generateDeckByArchetype(cardPool, { 
      archetype: arch as any, 
      format: "standard" 
    });
    
    const lands = result.cards.filter(c => c.role === "land").reduce((s, c) => s + c.quantity, 0);
    const creatures = result.cards.filter(c => c.role === "creature").reduce((s, c) => s + c.quantity, 0);
    const spells = result.cards.filter(c => c.role === "spell").reduce((s, c) => s + c.quantity, 0);

    console.log(`Lands: ${lands} | Creatures: ${creatures} | Spells: ${spells}`);
  }
  
  console.log("\nTesting format: COMMANDER (Aggro) with Artifacts filter");
  const resultArt = generateDeckByArchetype(cardPool, { 
    archetype: "aggro", 
    format: "commander",
    cardTypes: ["artifact"] 
  });
  const artifactCount = resultArt.cards.filter(c => (c.type || "").toLowerCase().includes("artifact")).reduce((s, c) => s + c.quantity, 0);
  const totalCardsArt = resultArt.cards.reduce((s, c) => s + c.quantity, 0);
  console.log(`Artifacts: ${artifactCount} / Total: ${totalCardsArt}`);
  console.log(`Pool Size during Art-Filter: ${resultArt.poolSize}`);

  process.exit(0);
}

testStructure().catch(console.error);
