import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Share2, Copy, ExternalLink, Twitter, Facebook, MessageSquare } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function DeckSharing() {
  const { toast } = useToast();
  const [selectedDeckId, setSelectedDeckId] = useState<number | null>(null);
  const [shareTitle, setShareTitle] = useState("");
  const [shareDescription, setShareDescription] = useState("");
  const [includeImage, setIncludeImage] = useState(true);
  const [expiresInDays, setExpiresInDays] = useState<number | undefined>();
  const [createdShare, setCreatedShare] = useState<any>(null);

  // Get user's decks
  const { data: decks, isLoading: decksLoading } = trpc.decks.getUserDecks.useQuery();

  // Create share mutation
  const createShareMutation = useMutation({
    mutationFn: async () => {
      if (!selectedDeckId) throw new Error("No deck selected");
      return await trpc.sharing.createShare.mutate({
        deckId: selectedDeckId,
        title: shareTitle || undefined,
        description: shareDescription || undefined,
        includeImage,
        expiresInDays,
      });
    },
    onSuccess: (data) => {
      setCreatedShare(data);
      toast({
        title: "Share created!",
        description: "Your deck share link is ready to use.",
      });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Get share URLs mutation
  const getShareUrlsMutation = useMutation({
    mutationFn: async () => {
      if (!createdShare) throw new Error("No share created");
      return await trpc.sharing.getShareUrls.query({
        shareId: createdShare.shareId,
      });
    },
  });

  const handleCreateShare = () => {
    createShareMutation.mutate();
  };

  const handleCopyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({
      title: "Copied!",
      description: "Link copied to clipboard.",
    });
  };

  const handleGetShareUrls = () => {
    getShareUrlsMutation.mutate();
  };

  const selectedDeck = decks?.find(d => d.id === selectedDeckId);

  // Auto-fill title and description when deck is selected
  const handleDeckSelect = (deckId: number) => {
    setSelectedDeckId(deckId);
    const deck = decks?.find(d => d.id === deckId);
    if (deck) {
      setShareTitle(`${deck.name} - ${deck.format}`);
      setShareDescription(`Check out this ${deck.format} deck: ${deck.name}`);
    }
  };

  return (
    <div className="container mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-white mb-2">Share Decks</h1>
        <p className="text-gray-400">Create shareable links for your decks</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Create Share */}
        <Card className="bg-slate-900/50 border-purple-500/30">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-2">
              <Share2 className="w-5 h-5" />
              Create Share Link
            </CardTitle>
            <CardDescription className="text-gray-400">
              Generate a shareable link for your deck
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Deck Selection */}
            <div>
              <Label className="text-white">Select Deck</Label>
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
                  <option value="">Choose a deck...</option>
                  {decks?.map((deck) => (
                    <option key={deck.id} value={deck.id}>
                      {deck.name} ({deck.format})
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* Title */}
            <div>
              <Label className="text-white">Title</Label>
              <Input
                value={shareTitle}
                onChange={(e) => setShareTitle(e.target.value)}
                placeholder="Deck title for sharing"
                className="bg-slate-800 border-purple-500/30 text-white placeholder-gray-500"
              />
            </div>

            {/* Description */}
            <div>
              <Label className="text-white">Description</Label>
              <Textarea
                value={shareDescription}
                onChange={(e) => setShareDescription(e.target.value)}
                placeholder="Brief description of your deck"
                className="bg-slate-800 border-purple-500/30 text-white placeholder-gray-500"
                rows={3}
              />
            </div>

            {/* Options */}
            <div className="space-y-3">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="includeImage"
                  checked={includeImage}
                  onCheckedChange={setIncludeImage}
                />
                <Label htmlFor="includeImage" className="text-white">
                  Include generated artwork
                </Label>
              </div>

              <div>
                <Label className="text-white">Expires in (days)</Label>
                <Input
                  type="number"
                  value={expiresInDays || ""}
                  onChange={(e) => setExpiresInDays(e.target.value ? parseInt(e.target.value) : undefined)}
                  placeholder="Leave empty for no expiration"
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
              Create Share Link
            </Button>

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

        {/* Share Links */}
        <Card className="bg-slate-900/50 border-purple-500/30">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-2">
              <ExternalLink className="w-5 h-5" />
              Share Links
            </CardTitle>
            <CardDescription className="text-gray-400">
              Your generated share links and social media options
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!createdShare ? (
              <div className="text-center py-12">
                <Share2 className="w-12 h-12 text-gray-600 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-white mb-2">No share created yet</h3>
                <p className="text-gray-400">
                  Create a share link on the left to get started
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Direct Link */}
                <div>
                  <Label className="text-white mb-2 block">Direct Link</Label>
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
                    onClick={() => handleCopyToClipboard(createdShare.decklist)}
                    className="mt-2 border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
                  >
                    <Copy className="w-4 h-4 mr-2" />
                    Copy Decklist
                  </Button>
                </div>

                {/* Social Media Buttons */}
                <div>
                  <Label className="text-white mb-2 block">Share on Social Media</Label>
                  <div className="flex gap-2 flex-wrap">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleGetShareUrls}
                      disabled={getShareUrlsMutation.isPending}
                      className="border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
                    >
                      {getShareUrlsMutation.isPending ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <ExternalLink className="w-4 h-4 mr-2" />
                      )}
                      Get Social Links
                    </Button>
                  </div>

                  {getShareUrlsMutation.data && (
                    <div className="mt-3 space-y-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => window.open(getShareUrlsMutation.data.twitter, '_blank')}
                        className="w-full justify-start border-blue-500/30 text-blue-300 hover:bg-blue-500/10"
                      >
                        <Twitter className="w-4 h-4 mr-2" />
                        Share on Twitter
                      </Button>

                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => window.open(getShareUrlsMutation.data.facebook, '_blank')}
                        className="w-full justify-start border-blue-600/30 text-blue-400 hover:bg-blue-600/10"
                      >
                        <Facebook className="w-4 h-4 mr-2" />
                        Share on Facebook
                      </Button>

                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => window.open(getShareUrlsMutation.data.reddit, '_blank')}
                        className="w-full justify-start border-orange-500/30 text-orange-300 hover:bg-orange-500/10"
                      >
                        <MessageSquare className="w-4 h-4 mr-2" />
                        Share on Reddit
                      </Button>
                    </div>
                  )}
                </div>

                {/* Preview Image */}
                {createdShare.imageUrl && (
                  <div>
                    <Label className="text-white mb-2 block">Preview Image</Label>
                    <img
                      src={createdShare.imageUrl}
                      alt="Deck preview"
                      className="w-full h-32 object-cover rounded-lg border border-purple-500/20"
                    />
                  </div>
                )}

                {/* Meta Tags */}
                <div>
                  <Label className="text-white mb-2 block">HTML Meta Tags</Label>
                  <div className="bg-slate-800/50 p-3 rounded-lg">
                    <pre className="text-xs text-gray-300 whitespace-pre-wrap">
                      {`<meta property="og:title" content="${createdShare.title}" />
<meta property="og:description" content="${createdShare.description}" />
<meta property="og:image" content="${createdShare.imageUrl || ''}" />
<meta property="og:url" content="${window.location.origin}/shared/${createdShare.shareId}" />`}
                    </pre>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleCopyToClipboard(`<meta property="og:title" content="${createdShare.title}" />
<meta property="og:description" content="${createdShare.description}" />
<meta property="og:image" content="${createdShare.imageUrl || ''}" />
<meta property="og:url" content="${window.location.origin}/shared/${createdShare.shareId}" />`)}
                    className="mt-2 border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
                  >
                    <Copy className="w-4 h-4 mr-2" />
                    Copy Meta Tags
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Info Section */}
      <Card className="mt-6 bg-slate-900/50 border-purple-500/30">
        <CardHeader>
          <CardTitle className="text-white">About Deck Sharing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h4 className="text-white font-medium mb-2">Share Features</h4>
            <ul className="text-gray-400 text-sm space-y-1">
              <li>• Generate permanent or expiring share links</li>
              <li>• Include AI-generated artwork with your shares</li>
              <li>• Automatic decklist formatting for easy copying</li>
              <li>• Social media integration (Twitter, Facebook, Reddit)</li>
              <li>• SEO-friendly meta tags for better link previews</li>
            </ul>
          </div>

          <div>
            <h4 className="text-white font-medium mb-2">Privacy & Security</h4>
            <p className="text-gray-400 text-sm">
              Share links are publicly accessible but don't reveal your personal information.
              You can set expiration dates to automatically remove old shares.
            </p>
          </div>

          <div>
            <h4 className="text-white font-medium mb-2">Best Practices</h4>
            <ul className="text-gray-400 text-sm space-y-1">
              <li>• Use descriptive titles and descriptions for better engagement</li>
              <li>• Include artwork to make your shares more visually appealing</li>
              <li>• Set reasonable expiration dates for time-sensitive content</li>
              <li>• Test your share links before posting them publicly</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}