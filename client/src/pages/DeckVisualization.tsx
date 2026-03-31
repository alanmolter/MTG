import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Loader2, Image, Wand2, Download, Share2 } from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";

interface DeckRow {
  id: number;
  name: string;
  format: string;
  archetype: string | null;
  description: string | null;
  isPublic: number | null;
  createdAt: Date;
  updatedAt: Date;
  userId: number;
}

interface DeckArtisticVisualization {
  deckId: number;
  imageUrl: string;
  prompt: string;
  style: "fantasy" | "minimalist" | "abstract" | "realistic";
  createdAt: Date;
}

export default function DeckVisualization() {
  const [, setLocation] = useLocation();
  const [selectedDeckId, setSelectedDeckId] = useState<number | null>(null);
  const [selectedStyle, setSelectedStyle] = useState<"fantasy" | "minimalist" | "abstract" | "realistic">("fantasy");
  const [customPrompt, setCustomPrompt] = useState("");
  const [generatedImages, setGeneratedImages] = useState<DeckArtisticVisualization[]>([]);

  // Get user's decks usando a rota correta (decks.list)
  const { data: decks, isLoading: decksLoading } = trpc.decks.list.useQuery();
  const typedDecks = decks as unknown as DeckRow[] | undefined;

  // Generate single visualization
  const generateArtMutation = trpc.visualization.generateDeckArt.useMutation({
    onSuccess: (data: any) => {
      setGeneratedImages(prev => [...prev, data as DeckArtisticVisualization]);
      toast.success("Arte gerada com sucesso!");
    },
    onError: (error: any) => {
      toast.error(`Erro ao gerar arte: ${error.message}`);
    },
  });

  // Generate multiple visualizations
  const generateArtSetMutation = trpc.visualization.generateDeckArtSet.useMutation({
    onSuccess: (data: any) => {
      setGeneratedImages(data as DeckArtisticVisualization[]);
      toast.success("Conjunto de artes gerado com sucesso!");
    },
    onError: (error: any) => {
      toast.error(`Erro ao gerar conjunto de artes: ${error.message}`);
    },
  });

  const handleGenerateArt = () => {
    if (!selectedDeckId) {
      toast.error("Selecione um deck primeiro");
      return;
    }
    generateArtMutation.mutate({
      deckId: selectedDeckId,
      style: selectedStyle,
      includeCardNames: true,
      customPrompt: customPrompt || undefined,
    });
  };

  const handleGenerateArtSet = () => {
    if (!selectedDeckId) {
      toast.error("Selecione um deck primeiro");
      return;
    }
    generateArtSetMutation.mutate({ deckId: selectedDeckId });
  };

  const handleDownload = (imageUrl: string, filename: string) => {
    const link = document.createElement('a');
    link.href = imageUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const selectedDeck = typedDecks?.find((d: DeckRow) => d.id === selectedDeckId);

  return (
    <div className="container mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-white mb-2">Visualização de Deck</h1>
        <p className="text-gray-400">Gere visualizações artísticas dos seus decks usando IA</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Controls */}
        <Card className="bg-slate-900/50 border-purple-500/30">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-2">
              <Wand2 className="w-5 h-5" />
              Gerar Arte
            </CardTitle>
            <CardDescription className="text-gray-400">
              Crie representações artísticas dos seus decks
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Deck Selection */}
            <div>
              <label className="text-sm font-medium text-white mb-2 block">
                Selecionar Deck
              </label>
              {decksLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-5 h-5 text-purple-400 animate-spin" />
                </div>
              ) : (
                <Select
                  value={selectedDeckId?.toString()}
                  onValueChange={(value) => setSelectedDeckId(parseInt(value))}
                >
                  <SelectTrigger className="bg-slate-800 border-purple-500/30 text-white">
                    <SelectValue placeholder="Escolha um deck..." />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-purple-500/30">
                    {typedDecks?.map((deck: DeckRow) => (
                      <SelectItem key={deck.id} value={deck.id.toString()}>
                        {deck.name} ({deck.format})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Style Selection */}
            <div>
              <label className="text-sm font-medium text-white mb-2 block">
                Estilo de Arte
              </label>
              <Select value={selectedStyle} onValueChange={(v) => setSelectedStyle(v as any)}>
                <SelectTrigger className="bg-slate-800 border-purple-500/30 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-purple-500/30">
                  <SelectItem value="fantasy">Fantasy</SelectItem>
                  <SelectItem value="minimalist">Minimalista</SelectItem>
                  <SelectItem value="abstract">Abstrato</SelectItem>
                  <SelectItem value="realistic">Realista</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Custom Prompt */}
            <div>
              <label className="text-sm font-medium text-white mb-2 block">
                Prompt Personalizado (Opcional)
              </label>
              <Textarea
                placeholder="Descreva como você quer que a visualização pareça..."
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                className="bg-slate-800 border-purple-500/30 text-white placeholder-gray-500"
                rows={3}
              />
            </div>

            {/* Generate Buttons */}
            <div className="flex gap-2">
              <Button
                onClick={handleGenerateArt}
                disabled={!selectedDeckId || generateArtMutation.isPending}
                className="flex-1 bg-purple-600 hover:bg-purple-700"
              >
                {generateArtMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Image className="w-4 h-4 mr-2" />
                )}
                Gerar Arte
              </Button>

              <Button
                onClick={handleGenerateArtSet}
                disabled={!selectedDeckId || generateArtSetMutation.isPending}
                variant="outline"
                className="border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
              >
                {generateArtSetMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Wand2 className="w-4 h-4 mr-2" />
                )}
                Todos os Estilos
              </Button>
            </div>

            {/* Selected Deck Info */}
            {selectedDeck && (
              <div className="mt-4 p-3 bg-slate-800/50 rounded-lg">
                <h4 className="text-white font-medium mb-2">{selectedDeck.name}</h4>
                <div className="flex gap-2 flex-wrap">
                  <Badge variant="secondary">{selectedDeck.format}</Badge>
                  {selectedDeck.archetype && (
                    <Badge variant="outline">{selectedDeck.archetype}</Badge>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Generated Images */}
        <Card className="bg-slate-900/50 border-purple-500/30">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-2">
              <Image className="w-5 h-5" />
              Arte Gerada
            </CardTitle>
            <CardDescription className="text-gray-400">
              Suas visualizações de deck aparecerão aqui
            </CardDescription>
          </CardHeader>
          <CardContent>
            {generatedImages.length === 0 ? (
              <div className="text-center py-12">
                <Image className="w-12 h-12 text-gray-600 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-white mb-2">Nenhuma visualização ainda</h3>
                <p className="text-gray-400">
                  Selecione um deck e gere arte para começar
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {generatedImages.map((image, index) => (
                  <div key={index} className="border border-purple-500/20 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <h4 className="text-white font-medium">{image.style} Style</h4>
                        <p className="text-sm text-gray-400">
                          Gerado em {new Date(image.createdAt).toLocaleString('pt-BR')}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleDownload(image.imageUrl, `deck-${selectedDeck?.name}-${image.style}.png`)}
                          className="border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
                        >
                          <Download className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setLocation("/sharing")}
                          className="border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
                        >
                          <Share2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>

                    <div className="relative">
                      <img
                        src={image.imageUrl}
                        alt={`Visualização do deck em estilo ${image.style}`}
                        className="w-full h-48 object-cover rounded-lg"
                      />
                    </div>

                    <div className="mt-3">
                      <details className="text-sm">
                        <summary className="text-gray-400 cursor-pointer hover:text-white">
                          Ver Prompt
                        </summary>
                        <p className="text-gray-500 mt-2 text-xs">{image.prompt}</p>
                      </details>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
