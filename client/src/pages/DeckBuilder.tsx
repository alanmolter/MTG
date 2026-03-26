import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Trash2, Plus, Edit, Save, X } from "lucide-react";
import { toast } from "sonner";
import CardCard from "@/components/CardCard";

interface Deck {
  id: string;
  name: string;
  format: string;
  archetype: string | null;
  description: string | null;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
}

interface DeckCard {
  id: string;
  cardId: string;
  quantity: number;
  card: {
    id: string;
    name: string;
    manaCost: string | null;
    cmc: number;
    type: string;
    rarity: string;
    text: string | null;
    imageUrl: string | null;
  };
}

export default function DeckBuilder() {
  const [selectedDeck, setSelectedDeck] = useState<Deck | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [newDeck, setNewDeck] = useState({
    name: "",
    format: "standard",
    archetype: "",
    description: "",
    isPublic: false,
  });

  const queryClient = useQueryClient();

  // Queries
  const { data: decks, isLoading: decksLoading } = trpc.decks.list.useQuery();
  const { data: deckCards, isLoading: cardsLoading } = trpc.decks.getCards.useQuery(
    { deckId: selectedDeck?.id || "" },
    { enabled: !!selectedDeck }
  );

  // Mutations
  const createDeckMutation = trpc.decks.create.useMutation({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["decks.list"] });
      setIsCreating(false);
      setNewDeck({ name: "", format: "standard", archetype: "", description: "", isPublic: false });
      toast.success("Deck created successfully!");
    },
    onError: (error) => toast.error(`Failed to create deck: ${error.message}`),
  });

  const updateDeckMutation = trpc.decks.update.useMutation({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["decks.list"] });
      setIsEditing(false);
      toast.success("Deck updated successfully!");
    },
    onError: (error) => toast.error(`Failed to update deck: ${error.message}`),
  });

  const deleteDeckMutation = trpc.decks.delete.useMutation({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["decks.list"] });
      setSelectedDeck(null);
      toast.success("Deck deleted successfully!");
    },
    onError: (error) => toast.error(`Failed to delete deck: ${error.message}`),
  });

  const addCardMutation = trpc.decks.addCard.useMutation({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["decks.getCards", { deckId: selectedDeck?.id }] });
      toast.success("Card added to deck!");
    },
    onError: (error) => toast.error(`Failed to add card: ${error.message}`),
  });

  const removeCardMutation = trpc.decks.removeCard.useMutation({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["decks.getCards", { deckId: selectedDeck?.id }] });
      toast.success("Card removed from deck!");
    },
    onError: (error) => toast.error(`Failed to remove card: ${error.message}`),
  });

  // Search cards
  const searchCardsMutation = trpc.cards.search.useMutation({
    onSuccess: (results) => setSearchResults(results),
  });

  const handleCreateDeck = () => {
    if (!newDeck.name.trim()) {
      toast.error("Deck name is required");
      return;
    }
    createDeckMutation.mutate(newDeck);
  };

  const handleUpdateDeck = () => {
    if (!selectedDeck) return;
    updateDeckMutation.mutate({
      id: selectedDeck.id,
      ...newDeck,
    });
  };

  const handleDeleteDeck = () => {
    if (!selectedDeck) return;
    deleteDeckMutation.mutate({ id: selectedDeck.id });
  };

  const handleAddCard = (cardId: string) => {
    if (!selectedDeck) return;
    addCardMutation.mutate({ deckId: selectedDeck.id, cardId, quantity: 1 });
  };

  const handleRemoveCard = (cardId: string) => {
    if (!selectedDeck) return;
    removeCardMutation.mutate({ deckId: selectedDeck.id, cardId });
  };

  const handleSearch = () => {
    if (searchQuery.trim()) {
      searchCardsMutation.mutate({ query: searchQuery });
    }
  };

  const startEditing = (deck: Deck) => {
    setSelectedDeck(deck);
    setNewDeck({
      name: deck.name,
      format: deck.format,
      archetype: deck.archetype || "",
      description: deck.description || "",
      isPublic: deck.isPublic,
    });
    setIsEditing(true);
  };

  const totalCards = deckCards?.reduce((sum, dc) => sum + dc.quantity, 0) || 0;

  return (
    <div className="container mx-auto p-6">
      <div className="flex gap-6">
        {/* Deck List Sidebar */}
        <div className="w-80">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-2xl font-bold">My Decks</h2>
            <Dialog open={isCreating} onOpenChange={setIsCreating}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="w-4 h-4 mr-2" />
                  New Deck
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create New Deck</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="name">Name</Label>
                    <Input
                      id="name"
                      value={newDeck.name}
                      onChange={(e) => setNewDeck({ ...newDeck, name: e.target.value })}
                      placeholder="Deck name"
                    />
                  </div>
                  <div>
                    <Label htmlFor="format">Format</Label>
                    <Select value={newDeck.format} onValueChange={(value) => setNewDeck({ ...newDeck, format: value })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="standard">Standard</SelectItem>
                        <SelectItem value="pioneer">Pioneer</SelectItem>
                        <SelectItem value="modern">Modern</SelectItem>
                        <SelectItem value="legacy">Legacy</SelectItem>
                        <SelectItem value="vintage">Vintage</SelectItem>
                        <SelectItem value="commander">Commander</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="archetype">Archetype</Label>
                    <Input
                      id="archetype"
                      value={newDeck.archetype}
                      onChange={(e) => setNewDeck({ ...newDeck, archetype: e.target.value })}
                      placeholder="e.g., Control, Aggro"
                    />
                  </div>
                  <div>
                    <Label htmlFor="description">Description</Label>
                    <Textarea
                      id="description"
                      value={newDeck.description}
                      onChange={(e) => setNewDeck({ ...newDeck, description: e.target.value })}
                      placeholder="Deck description"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setIsCreating(false)}>
                      Cancel
                    </Button>
                    <Button onClick={handleCreateDeck} disabled={createDeckMutation.isPending}>
                      Create
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>

          {decksLoading ? (
            <div>Loading decks...</div>
          ) : (
            <div className="space-y-2">
              {decks?.map((deck) => (
                <Card
                  key={deck.id}
                  className={`cursor-pointer ${selectedDeck?.id === deck.id ? "ring-2 ring-primary" : ""}`}
                  onClick={() => setSelectedDeck(deck)}
                >
                  <CardContent className="p-4">
                    <div className="flex justify-between items-start">
                      <div>
                        <h3 className="font-semibold">{deck.name}</h3>
                        <p className="text-sm text-muted-foreground">{deck.format}</p>
                        {deck.archetype && <Badge variant="secondary">{deck.archetype}</Badge>}
                      </div>
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); startEditing(deck); }}>
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); handleDeleteDeck(); }}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Deck Editor */}
        <div className="flex-1">
          {selectedDeck ? (
            <div>
              <div className="flex justify-between items-center mb-6">
                <div>
                  <h1 className="text-3xl font-bold">{selectedDeck.name}</h1>
                  <p className="text-muted-foreground">{selectedDeck.format} • {totalCards} cards</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline">Export</Button>
                  <Button>Validate</Button>
                </div>
              </div>

              {/* Edit Deck Dialog */}
              <Dialog open={isEditing} onOpenChange={setIsEditing}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Edit Deck</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="edit-name">Name</Label>
                      <Input
                        id="edit-name"
                        value={newDeck.name}
                        onChange={(e) => setNewDeck({ ...newDeck, name: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label htmlFor="edit-format">Format</Label>
                      <Select value={newDeck.format} onValueChange={(value) => setNewDeck({ ...newDeck, format: value })}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="standard">Standard</SelectItem>
                          <SelectItem value="pioneer">Pioneer</SelectItem>
                          <SelectItem value="modern">Modern</SelectItem>
                          <SelectItem value="legacy">Legacy</SelectItem>
                          <SelectItem value="vintage">Vintage</SelectItem>
                          <SelectItem value="commander">Commander</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label htmlFor="edit-archetype">Archetype</Label>
                      <Input
                        id="edit-archetype"
                        value={newDeck.archetype}
                        onChange={(e) => setNewDeck({ ...newDeck, archetype: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label htmlFor="edit-description">Description</Label>
                      <Textarea
                        id="edit-description"
                        value={newDeck.description}
                        onChange={(e) => setNewDeck({ ...newDeck, description: e.target.value })}
                      />
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" onClick={() => setIsEditing(false)}>
                        Cancel
                      </Button>
                      <Button onClick={handleUpdateDeck} disabled={updateDeckMutation.isPending}>
                        Save
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>

              {/* Card Search */}
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle>Add Cards</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Search cards..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyPress={(e) => e.key === "Enter" && handleSearch()}
                    />
                    <Button onClick={handleSearch} disabled={searchCardsMutation.isPending}>
                      Search
                    </Button>
                  </div>
                  {searchResults.length > 0 && (
                    <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-h-96 overflow-y-auto">
                      {searchResults.map((card) => (
                        <div key={card.id} className="flex justify-between items-center p-2 border rounded">
                          <div className="flex-1">
                            <p className="font-medium">{card.name}</p>
                            <p className="text-sm text-muted-foreground">{card.type}</p>
                          </div>
                          <Button size="sm" onClick={() => handleAddCard(card.id)}>
                            Add
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Deck Cards */}
              <Card>
                <CardHeader>
                  <CardTitle>Deck Cards ({totalCards})</CardTitle>
                </CardHeader>
                <CardContent>
                  {cardsLoading ? (
                    <div>Loading cards...</div>
                  ) : deckCards && deckCards.length > 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {deckCards.map((deckCard) => (
                        <CardCard
                          key={deckCard.id}
                          card={deckCard.card}
                          quantity={deckCard.quantity}
                          onRemove={() => handleRemoveCard(deckCard.cardId)}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="text-muted-foreground">No cards in this deck yet.</p>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : (
            <div className="flex items-center justify-center h-96">
              <p className="text-muted-foreground">Select a deck to start editing</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}