import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Loader2, Share2, Copy, ExternalLink } from "lucide-react";
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

interface DeckShareData {
  shareId: string;
  deckId: number;
  title?: string;
  description?: string;
  decklist?: string;
  imageUrl?: string;
  expiresAt?: string;
}

export default function DeckSharing() {
  const [selectedDeckId, setSelectedDeckId] = useState<number | null>(null);
  const [shareTitle, setShareTitle] = useState("");
  const [shareDescription, setShareDescription] = useState("");
  const [includeImage, setIncludeImage] = useState(true);
  const [expiresInDays, setExpiresInDays] = useState<number | undefined>();
  const [createdShare, setCreatedShare] = useState<DeckShareData | null>(null);

  // Get user's decks usando a rota correta (decks.list)
  const { data: decks, isLoading: decksLoading } = trpc.decks.list.useQuery();
  const typedDecks = decks as unknown as DeckRow[] | undefined;

  // Create share mutation
  const createShareMutation = trpc.sharing.createShare.useMutation({
    onSuccess: (data: any) => {
      setCreatedShare(data as DeckShareData);
      toast.success("Link de compartilhamento criado com sucesso!");
    },
    onError: (error: any) => {
      toast.error(`Erro ao criar compartilhamento: ${error.message}`);
    },
  });

  // Get share URLs query (lazy — só busca quando shareId está disponível)
  const { data: shareUrls, refetch: fetchShareUrls, isFetching: isFetchingUrls } =
    trpc.sharing.getShareUrls.useQuery(
      { shareId: createdShare?.shareId ?? "" },
      { enabled: false }
    );

  const handleCreateShare = () => {
    if (!selectedDeckId) {
      toast.error("Selecione um deck primeiro");
      return;
    }
    createShareMutation.mutate({
      deckId: selectedDeckId,
      title: shareTitle || undefined,
      description: shareDescription || undefined,
      includeImage,
      expiresInDays,
    });
  };

  const handleCopyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Link copiado para a área de transferência!");
  };

  const handleGetShareUrls = () => {
    if (createdShare?.shareId) {
      fetchShareUrls();
    }
  };

  const selectedDeck = typedDecks?.find((d: DeckRow) => d.id === selectedDeckId);

  const handleDeckSelect = (deckId: number) => {
    setSelectedDeckId(deckId);
    const deck = typedDecks?.find((d: DeckRow) => d.id === deckId);
    if (deck) {
      setShareTitle(`${deck.name} - ${deck.format}`);
      setShareDescription(`Confira este deck de ${deck.format}: ${deck.name}`);
    }
  };

  return (
    <div className="container mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-white mb-2">Compartilhar Decks</h1>
        <p className="text-gray-400">Crie links compartilháveis para seus decks</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Create Share */}
        <Card className="bg-slate-900/50 border-purple-500/30">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-2">
              <Share2 className="w-5 h-5" />
              Criar Link de Compartilhamento
            </CardTitle>
            <CardDescription className="text-gray-400">
              Gere um link compartilhável para seu deck
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Deck Selection */}
            <div>
              <Label className="text-white">Selecionar Deck</Label>
              {decksLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-5 h-5 text-purple-400 animate-spin" />
                </div>
              ) : (
                <select
                  value={selectedDeckId || ""}
                  onChange={(e) => handleDeckSelect(parseInt(e.target.value))}
                  className="w-full mt-1 px-3 py-2 bg-slate-800 border border-purple-500/30 rounded-md text-white focus:outline-none focus:ring-2 focus:ring-purple-500"
                >
                  <option value="">Escolha um deck...</option>
                  {typedDecks?.map((deck: DeckRow) => (
                    <option key={deck.id} value={deck.id}>
                      {deck.name} ({deck.format})
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* Title */}
            <div>
              <Label className="text-white">Título</Label>
              <Input
                value={shareTitle}
                onChange={(e) => setShareTitle(e.target.value)}
                placeholder="Título do deck para compartilhamento"
                className="bg-slate-800 border-purple-500/30 text-white placeholder-gray-500"
              />
            </div>

            {/* Description */}
            <div>
              <Label className="text-white">Descrição</Label>
              <Textarea
                value={shareDescription}
                onChange={(e) => setShareDescription(e.target.value)}
                placeholder="Breve descrição do seu deck"
                className="bg-slate-800 border-purple-500/30 text-white placeholder-gray-500"
                rows={3}
              />
            </div>

            {/* Options */}
            <div className="space-y-3">
              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="includeImage"
                  checked={includeImage}
                  onChange={(e) => setIncludeImage(e.target.checked)}
                  className="rounded border-purple-500/30"
                />
                <Label htmlFor="includeImage" className="text-white">
                  Incluir arte gerada
                </Label>
              </div>

              <div>
                <Label className="text-white">Expira em (dias)</Label>
                <Input
                  type="number"
                  value={expiresInDays || ""}
                  onChange={(e) => setExpiresInDays(e.target.value ? parseInt(e.target.value) : undefined)}
                  placeholder="Deixe vazio para não expirar"
                  className="bg-slate-800 border-purple-500/30 text-white placeholder-gray-500"
                  min="1"
                  max="365"
                />
              </div>
            </div>

            {/* Create Button */}
            <Button
              onClick={handleCreateShare}
              disabled={!selectedDeckId || createShareMutation.isPending}
              className="w-full bg-purple-600 hover:bg-purple-700"
            >
              {createShareMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Share2 className="w-4 h-4 mr-2" />
              )}
              Criar Link de Compartilhamento
            </Button>

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

        {/* Share Links */}
        <Card className="bg-slate-900/50 border-purple-500/30">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-2">
              <ExternalLink className="w-5 h-5" />
              Links de Compartilhamento
            </CardTitle>
            <CardDescription className="text-gray-400">
              Seus links gerados e opções de redes sociais
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!createdShare ? (
              <div className="text-center py-12">
                <Share2 className="w-12 h-12 text-gray-600 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-white mb-2">Nenhum compartilhamento criado</h3>
                <p className="text-gray-400">
                  Crie um link de compartilhamento à esquerda para começar
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Direct Link */}
                <div>
                  <Label className="text-white mb-2 block">Link Direto</Label>
                  <div className="flex gap-2">
                    <Input
                      value={`${window.location.origin}/shared/${createdShare.shareId}`}
                      readOnly
                      className="bg-slate-800 border-purple-500/30 text-white"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleCopyToClipboard(`${window.location.origin}/shared/${createdShare.shareId}`)}
                      className="border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
                    >
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                {/* Decklist */}
                {createdShare.decklist && (
                  <div>
                    <Label className="text-white mb-2 block">Decklist</Label>
                    <div className="bg-slate-800/50 p-3 rounded-lg max-h-32 overflow-y-auto">
                      <pre className="text-xs text-gray-300 whitespace-pre-wrap">
                        {createdShare.decklist}
                      </pre>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleCopyToClipboard(createdShare.decklist!)}
                      className="mt-2 border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
                    >
                      <Copy className="w-4 h-4 mr-2" />
                      Copiar Decklist
                    </Button>
                  </div>
                )}

                {/* Social Media Buttons */}
                <div>
                  <Label className="text-white mb-2 block">Compartilhar nas Redes Sociais</Label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleGetShareUrls}
                    disabled={isFetchingUrls}
                    className="border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
                  >
                    {isFetchingUrls ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <ExternalLink className="w-4 h-4 mr-2" />
                    )}
                    Obter Links Sociais
                  </Button>

                  {shareUrls && (
                    <div className="mt-3 space-y-2">
                      {(shareUrls as any).twitter && (
                        <a
                          href={(shareUrls as any).twitter}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 text-blue-400 hover:text-blue-300 text-sm"
                        >
                          <ExternalLink className="w-4 h-4" />
                          Compartilhar no Twitter/X
                        </a>
                      )}
                      {(shareUrls as any).reddit && (
                        <a
                          href={(shareUrls as any).reddit}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 text-orange-400 hover:text-orange-300 text-sm"
                        >
                          <ExternalLink className="w-4 h-4" />
                          Compartilhar no Reddit
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
