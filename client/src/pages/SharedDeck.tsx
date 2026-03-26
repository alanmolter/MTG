import { useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Copy, ExternalLink, Share2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function SharedDeck() {
  const { toast } = useToast();
  const params = useParams();
  const shareId = params.shareId;

  // Get shared deck data
  const { data: sharedDeck, isLoading, error } = useQuery({
    queryKey: ["shared-deck", shareId],
    queryFn: async () => {
      if (!shareId) throw new Error("No share ID provided");
      return await trpc.sharing.getSharedDeck.query({ shareId });
    },
    enabled: !!shareId,
  });

  const handleCopyDecklist = () => {
    if (sharedDeck?.decklist) {
      navigator.clipboard.writeText(sharedDeck.decklist);
      toast({
        title: "Copied!",
        description: "Decklist copied to clipboard.",
      });
    }
  };

  const handleShare = () => {
    if (navigator.share) {
      navigator.share({
        title: sharedDeck?.title,
        text: sharedDeck?.description,
        url: window.location.href,
      });
    } else {
      navigator.clipboard.writeText(window.location.href);
      toast({
        title: "Link copied!",
        description: "Share link copied to clipboard.",
      });
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950 to-slate-900 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-purple-400 animate-spin mx-auto mb-4" />
          <p className="text-gray-400">Loading shared deck...</p>
        </div>
      </div>
    );
  }

  if (error || !sharedDeck) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950 to-slate-900 flex items-center justify-center">
        <Card className="bg-slate-900/50 border-red-500/30 max-w-md">
          <CardHeader>
            <CardTitle className="text-white">Deck Not Found</CardTitle>
            <CardDescription className="text-gray-400">
              This shared deck link may have expired or is invalid.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() => window.location.href = "/"}
              className="w-full bg-purple-600 hover:bg-purple-700"
            >
              Go Home
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
                <h1 className="text-4xl font-bold text-white mb-2">{sharedDeck.title}</h1>
                <p className="text-gray-400">{sharedDeck.description}</p>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={handleCopyDecklist}
                  variant="outline"
                  size="sm"
                  className="border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
                >
                  <Copy className="w-4 h-4 mr-2" />
                  Copy Decklist
                </Button>
                <Button
                  onClick={handleShare}
                  variant="outline"
                  size="sm"
                  className="border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
                >
                  <Share2 className="w-4 h-4 mr-2" />
                  Share
                </Button>
              </div>
            </div>

            {/* Deck Metadata */}
            <div className="flex gap-2 flex-wrap">
              <Badge variant="secondary">{sharedDeck.format}</Badge>
              {sharedDeck.colors.map(color => (
                <Badge key={color} variant="outline">{color}</Badge>
              ))}
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Deck Image */}
            {sharedDeck.imageUrl && (
              <Card className="bg-slate-900/50 border-purple-500/30">
                <CardHeader>
                  <CardTitle className="text-white">Deck Art</CardTitle>
                </CardHeader>
                <CardContent>
                  <img
                    src={sharedDeck.imageUrl}
                    alt="Deck visualization"
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
                  Click "Copy Decklist" to copy the full deck to your clipboard
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="bg-slate-800/50 p-4 rounded-lg max-h-96 overflow-y-auto">
                  <pre className="text-sm text-gray-300 whitespace-pre-wrap font-mono">
                    {sharedDeck.decklist}
                  </pre>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Footer */}
          <div className="mt-8 text-center">
            <p className="text-gray-500 text-sm mb-4">
              Shared on {new Date(sharedDeck.createdAt).toLocaleDateString()}
              {sharedDeck.expiresAt && (
                <span className="ml-2">
                  • Expires on {new Date(sharedDeck.expiresAt).toLocaleDateString()}
                </span>
              )}
            </p>
            <Button
              onClick={() => window.location.href = "/"}
              variant="outline"
              className="border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
            >
              <ExternalLink className="w-4 h-4 mr-2" />
              Explore More Decks
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}