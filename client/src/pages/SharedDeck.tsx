import { useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Copy, ExternalLink, Share2 } from "lucide-react";
import { toast } from "sonner";

interface DeckShareData {
  shareId: string;
  deckId: number;
  title?: string;
  description?: string;
  format?: string;
  colors?: string[];
  decklist?: string;
  imageUrl?: string;
  createdAt?: string;
  expiresAt?: string;
}

export default function SharedDeck() {
  const params = useParams();
  const shareId = (params as any).shareId as string | undefined;

  // Get shared deck data usando hook nativo do tRPC
  const { data: sharedDeck, isLoading, error } = trpc.sharing.getSharedDeck.useQuery(
    { shareId: shareId ?? "" },
    { enabled: !!shareId }
  );

  const typedDeck = sharedDeck as unknown as DeckShareData | null | undefined;

  const handleCopyDecklist = () => {
    if (typedDeck?.decklist) {
      navigator.clipboard.writeText(typedDeck.decklist);
      toast.success("Decklist copiada para a área de transferência!");
    }
  };

  const handleShare = () => {
    if (navigator.share) {
      navigator.share({
        title: typedDeck?.title,
        text: typedDeck?.description,
        url: window.location.href,
      });
    } else {
      navigator.clipboard.writeText(window.location.href);
      toast.success("Link copiado para a área de transferência!");
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950 to-slate-900 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-purple-400 animate-spin mx-auto mb-4" />
          <p className="text-gray-400">Carregando deck compartilhado...</p>
        </div>
      </div>
    );
  }

  if (error || !typedDeck) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950 to-slate-900 flex items-center justify-center">
        <Card className="bg-slate-900/50 border-red-500/30 max-w-md">
          <CardHeader>
            <CardTitle className="text-white">Deck Não Encontrado</CardTitle>
            <CardDescription className="text-gray-400">
              Este link de deck compartilhado pode ter expirado ou é inválido.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() => window.location.href = "/"}
              className="w-full bg-purple-600 hover:bg-purple-700"
            >
              Ir para o Início
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950 to-slate-900">
      <div className="container mx-auto p-6">
        <div className="max-w-4xl mx-auto">
          {/* Header */}
          <div className="mb-8">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h1 className="text-4xl font-bold text-white mb-2">{typedDeck.title}</h1>
                <p className="text-gray-400">{typedDeck.description}</p>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={handleCopyDecklist}
                  variant="outline"
                  size="sm"
                  className="border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
                >
                  <Copy className="w-4 h-4 mr-2" />
                  Copiar Decklist
                </Button>
                <Button
                  onClick={handleShare}
                  variant="outline"
                  size="sm"
                  className="border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
                >
                  <Share2 className="w-4 h-4 mr-2" />
                  Compartilhar
                </Button>
              </div>
            </div>

            {/* Deck Metadata */}
            <div className="flex gap-2 flex-wrap">
              {typedDeck.format && <Badge variant="secondary">{typedDeck.format}</Badge>}
              {typedDeck.colors?.map((color: string) => (
                <Badge key={color} variant="outline">{color}</Badge>
              ))}
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Deck Image */}
            {typedDeck.imageUrl && (
              <Card className="bg-slate-900/50 border-purple-500/30">
                <CardHeader>
                  <CardTitle className="text-white">Arte do Deck</CardTitle>
                </CardHeader>
                <CardContent>
                  <img
                    src={typedDeck.imageUrl}
                    alt="Visualização do deck"
                    className="w-full rounded-lg border border-purple-500/20"
                  />
                </CardContent>
              </Card>
            )}

            {/* Decklist */}
            <Card className="bg-slate-900/50 border-purple-500/30">
              <CardHeader>
                <CardTitle className="text-white">Decklist</CardTitle>
                <CardDescription className="text-gray-400">
                  Clique em "Copiar Decklist" para copiar o deck completo
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="bg-slate-800/50 p-4 rounded-lg max-h-96 overflow-y-auto">
                  <pre className="text-sm text-gray-300 whitespace-pre-wrap font-mono">
                    {typedDeck.decklist}
                  </pre>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Footer */}
          <div className="mt-8 text-center">
            <p className="text-gray-500 text-sm mb-4">
              {typedDeck.createdAt && (
                <>Compartilhado em {new Date(typedDeck.createdAt).toLocaleDateString('pt-BR')}</>
              )}
              {typedDeck.expiresAt && (
                <span className="ml-2">
                  • Expira em {new Date(typedDeck.expiresAt).toLocaleDateString('pt-BR')}
                </span>
              )}
            </p>
            <Button
              onClick={() => window.location.href = "/"}
              variant="outline"
              className="border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
            >
              <ExternalLink className="w-4 h-4 mr-2" />
              Explorar Mais Decks
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
