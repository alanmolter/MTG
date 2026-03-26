import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Loader2, Image, Wand2, Download, Share2 } from "lucide-react";
import { useLocation } from "wouter";

export default function DeckVisualization() {
  const [, setLocation] = useLocation();
  const [selectedDeckId, setSelectedDeckId] = useState<number | null>(null);
  const [selectedStyle, setSelectedStyle] = useState<string>("fantasy");
  const [customPrompt, setCustomPrompt] = useState("");
  const [generatedImages, setGeneratedImages] = useState<any[]>([]);

  // Get user's decks
  const { data: decks, isLoading: decksLoading } = trpc.decks.getUserDecks.useQuery();

  // Generate single visualization
  const generateArtMutation = useMutation({
    mutationFn: async () => {
      if (!selectedDeckId) throw new Error("No deck selected");
      return await trpc.visualization.generateDeckArt.mutate({
        deckId: selectedDeckId,
        style: selectedStyle as any,
        includeCardNames: true,
        customPrompt: customPrompt || undefined,
      });
    },
    onSuccess: (data) => {
      setGeneratedImages(prev => [...prev, data]);
    },
  });

  // Generate multiple visualizations
  const generateArtSetMutation = useMutation({
    mutationFn: async () => {
      if (!selectedDeckId) throw new Error("No deck selected");
      return await trpc.visualization.generateDeckArtSet.mutate({
        deckId: selectedDeckId,
      });
    },
    onSuccess: (data) => {
      setGeneratedImages(data);
    },
  });

  const handleGenerateArt = () => {
    generateArtMutation.mutate();
  };

  const handleGenerateArtSet = () => {
    generateArtSetMutation.mutate();
  };

  const handleDownload = (imageUrl: string, filename: string) => {
    const link = document.createElement('a');
    link.href = imageUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const selectedDeck = decks?.find(d => d.id === selectedDeckId);

  return (
    <div className="container mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-white mb-2">Deck Visualization</h1>
        <p className="text-gray-400">Generate artistic visualizations of your decks using AI</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Controls */}
        <Card className="bg-slate-900/50 border-purple-500/30">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-2">
              <Wand2 className="w-5 h-5" />
              Generate Art
            </CardTitle>
            <CardDescription className="text-gray-400">
              Create beautiful artistic representations of your decks
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Deck Selection */}
            <div>
              <label className="text-sm font-medium text-white mb-2 block">
                Select Deck
              </label>
              {decksLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-5 h-5 text-purple-400 animate-spin" />
                </div>
              ) : (
                <Select value={selectedDeckId?.toString()} onValueChange={(value) => setSelectedDeckId(parseInt(value))}>
                  <SelectTrigger className="bg-slate-800 border-purple-500/30 text-white">
                    <SelectValue placeholder="Choose a deck..." />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-purple-500/30">
                    {decks?.map((deck) => (
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
                Art Style
              </label>
              <Select value={selectedStyle} onValueChange={setSelectedStyle}>
                <SelectTrigger className="bg-slate-800 border-purple-500/30 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-purple-500/30">
                  <SelectItem value="fantasy">Fantasy</SelectItem>
                  <SelectItem value="minimalist">Minimalist</SelectItem>
                  <SelectItem value="abstract">Abstract</SelectItem>
                  <SelectItem value="realistic">Realistic</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Custom Prompt */}
            <div>
              <label className="text-sm font-medium text-white mb-2 block">
                Custom Prompt (Optional)
              </label>
              <Textarea
                placeholder="Describe how you want the visualization to look..."
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
                Generate Art
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
                Generate All Styles
              </Button>
            </div>

            {/* Selected Deck Info */}
            {selectedDeck && (
              <div className="mt-4 p-3 bg-slate-800/50 rounded-lg">
                <h4 className="text-white font-medium mb-2">{selectedDeck.name}</h4>
                <div className="flex gap-2 flex-wrap">
                  <Badge variant="secondary">{selectedDeck.format}</Badge>
                  {selectedDeck.colors && (
                    <Badge variant="outline">{selectedDeck.colors}</Badge>
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
              Generated Art
            </CardTitle>
            <CardDescription className="text-gray-400">
              Your deck visualizations will appear here
            </CardDescription>
          </CardHeader>
          <CardContent>
            {generatedImages.length === 0 ? (
              <div className="text-center py-12">
                <Image className="w-12 h-12 text-gray-600 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-white mb-2">No visualizations yet</h3>
                <p className="text-gray-400">
                  Select a deck and generate some art to get started
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
                          Generated {new Date(image.createdAt).toLocaleString()}
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
                        alt={`Deck visualization in ${image.style} style`}
                        className="w-full h-48 object-cover rounded-lg"
                      />
                    </div>

                    <div className="mt-3">
                      <details className="text-sm">
                        <summary className="text-gray-400 cursor-pointer hover:text-white">
                          View Prompt
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

      {/* Info Section */}
      <Card className="mt-6 bg-slate-900/50 border-purple-500/30">
        <CardHeader>
          <CardTitle className="text-white">About Deck Visualization</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h4 className="text-white font-medium mb-2">Art Styles</h4>
            <div className="grid md:grid-cols-2 gap-4 text-sm">
              <div>
                <strong className="text-purple-300">Fantasy:</strong>
                <span className="text-gray-400 ml-2">Magical elements, mystical atmosphere, detailed illustrations</span>
              </div>
              <div>
                <strong className="text-purple-300">Minimalist:</strong>
                <span className="text-gray-400 ml-2">Clean design, geometric shapes, modern aesthetic</span>
              </div>
              <div>
                <strong className="text-purple-300">Abstract:</strong>
                <span className="text-gray-400 ml-2">Symbolic representations, color fields, artistic interpretation</span>
              </div>
              <div>
                <strong className="text-purple-300">Realistic:</strong>
                <span className="text-gray-400 ml-2">Detailed card illustrations, tangible magic elements</span>
              </div>
            </div>
          </div>

          <div>
            <h4 className="text-white font-medium mb-2">How It Works</h4>
            <p className="text-gray-400 text-sm">
              Our AI analyzes your deck's composition, colors, themes, and key cards to generate
              unique artistic representations. Each visualization captures the essence of your deck
              in a beautiful, shareable image.
            </p>
          </div>

          <div>
            <h4 className="text-white font-medium mb-2">Tips for Better Results</h4>
            <ul className="text-gray-400 text-sm space-y-1">
              <li>• Use custom prompts to specify particular themes or moods</li>
              <li>• Try different styles to see which best represents your deck</li>
              <li>• Include specific card names in prompts for more accurate representations</li>
              <li>• Fantasy style works well for most MTG decks</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}