import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Loader2, Wand2, Download } from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";

export default function DeckGenerator() {
  const [, setLocation] = useLocation();
  const [format, setFormat] = useState<"standard" | "modern" | "commander" | "legacy">("standard");
  const [archetype, setArchetype] = useState("");
  const [generatedDeck, setGeneratedDeck] = useState<any>(null);

  const generateMutation = trpc.generator.generate.useMutation({
    onSuccess: (data) => {
      setGeneratedDeck(data);
      toast.success("Deck generated successfully!");
    },
    onError: () => {
      toast.error("Failed to generate deck");
    },
  });

  const handleGenerate = () => {
    generateMutation.mutate({
      format,
      archetype: archetype || undefined,
    });
  };

  const exportDeckAsText = () => {
    if (!generatedDeck?.deck) return;

    const deckList = generatedDeck.deck
      .map((card: any) => `${card.quantity}x ${card.name}`)
      .join("\n");

    const text = `MTG Deck - ${format.toUpperCase()}\n${archetype ? `Archetype: ${archetype}\n` : ""}\n${deckList}`;

    const element = document.createElement("a");
    element.setAttribute("href", `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`);
    element.setAttribute("download", `deck-${Date.now()}.txt`);
    element.style.display = "none";
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);

    toast.success("Deck exported as text");
  };

  const archetypes = [
    "Aggro",
    "Control",
    "Midrange",
    "Combo",
    "Ramp",
    "Tempo",
    "Burn",
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950 to-slate-900">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">Deck Generator</h1>
          <p className="text-gray-400">Generate optimized decks based on format and archetype</p>
        </div>

        <div className="grid lg:grid-cols-3 gap-8">
          {/* Generator Panel */}
          <div className="lg:col-span-1">
            <Card className="bg-slate-900/50 border-purple-500/30 sticky top-8">
              <CardHeader>
                <CardTitle className="text-white">Generate Deck</CardTitle>
                <CardDescription className="text-gray-400">Select format and archetype</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="format" className="text-gray-300">Format</Label>
                  <Select value={format} onValueChange={(value: any) => setFormat(value)}>
                    <SelectTrigger className="bg-slate-800 border-purple-500/30 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-slate-800 border-purple-500/30">
                      <SelectItem value="standard" className="text-white">Standard</SelectItem>
                      <SelectItem value="modern" className="text-white">Modern</SelectItem>
                      <SelectItem value="commander" className="text-white">Commander</SelectItem>
                      <SelectItem value="legacy" className="text-white">Legacy</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="archetype" className="text-gray-300">Archetype</Label>
                  <Select value={archetype} onValueChange={setArchetype}>
                    <SelectTrigger className="bg-slate-800 border-purple-500/30 text-white">
                      <SelectValue placeholder="Select archetype" />
                    </SelectTrigger>
                    <SelectContent className="bg-slate-800 border-purple-500/30">
                      <SelectItem value="" className="text-white">Random</SelectItem>
                      {archetypes.map((arch) => (
                        <SelectItem key={arch} value={arch} className="text-white">
                          {arch}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Button
                  onClick={handleGenerate}
                  disabled={generateMutation.isPending}
                  className="w-full bg-purple-600 hover:bg-purple-700"
                >
                  {generateMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <Wand2 className="w-4 h-4 mr-2" />
                      Generate Deck
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* Results Panel */}
          <div className="lg:col-span-2">
            {!generatedDeck && (
              <Card className="bg-slate-900/50 border-purple-500/30 h-96 flex items-center justify-center">
                <CardContent className="text-center">
                  <p className="text-gray-400">Generate a deck to see results</p>
                </CardContent>
              </Card>
            )}

            {generatedDeck && (
              <div className="space-y-6">
                {/* Validation */}
                {generatedDeck.validation && (
                  <Card className={`border-l-4 ${
                    generatedDeck.validation.isValid
                      ? "bg-green-900/20 border-l-green-500 border-green-500/30"
                      : "bg-red-900/20 border-l-red-500 border-red-500/30"
                  }`}>
                    <CardHeader>
                      <CardTitle className={generatedDeck.validation.isValid ? "text-green-300" : "text-red-300"}>
                        {generatedDeck.validation.isValid ? "✓ Valid Deck" : "✗ Invalid Deck"}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {generatedDeck.validation.errors.length > 0 && (
                        <div>
                          <p className="text-red-300 font-semibold mb-2">Errors:</p>
                          <ul className="space-y-1">
                            {generatedDeck.validation.errors.map((error: string, idx: number) => (
                              <li key={idx} className="text-red-200 text-sm">• {error}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {generatedDeck.validation.warnings.length > 0 && (
                        <div>
                          <p className="text-yellow-300 font-semibold mb-2">Warnings:</p>
                          <ul className="space-y-1">
                            {generatedDeck.validation.warnings.map((warning: string, idx: number) => (
                              <li key={idx} className="text-yellow-200 text-sm">• {warning}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}

                {/* Deck List */}
                <Card className="bg-slate-900/50 border-purple-500/30">
                  <CardHeader className="flex flex-row items-center justify-between">
                    <div>
                      <CardTitle className="text-white">Generated Deck</CardTitle>
                      <CardDescription className="text-gray-400">
                        {generatedDeck.deck?.reduce((sum: number, card: any) => sum + card.quantity, 0)} cards total
                      </CardDescription>
                    </div>
                    <Button
                      onClick={exportDeckAsText}
                      variant="outline"
                      size="sm"
                      className="border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
                    >
                      <Download className="w-4 h-4 mr-2" />
                      Export
                    </Button>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 max-h-96 overflow-y-auto">
                      {generatedDeck.deck?.map((card: any, idx: number) => (
                        <div key={idx} className="flex items-center justify-between p-3 bg-slate-800/50 rounded border border-purple-500/10 hover:border-purple-500/30 transition-colors">
                          <div className="flex-1">
                            <p className="text-white font-medium">{card.name}</p>
                            <p className="text-gray-400 text-sm">{card.type}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-purple-300 font-semibold">{card.quantity}x</p>
                            {card.cmc && <p className="text-gray-400 text-sm">CMC {card.cmc}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
