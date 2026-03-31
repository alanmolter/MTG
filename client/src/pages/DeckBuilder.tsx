import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Trash2, Plus, Edit } from "lucide-react";
import { toast } from "sonner";
import CardCard from "@/components/CardCard";

// Tipos alinhados com o schema do banco (id: number, isPublic: number | null)
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

// Tipo de carta alinhado com o schema do banco (sem manaCost)
interface CardRow {
  id: number;
  name: string;
  type: string | null;
  colors: string | null;
  cmc: number | null;
  rarity: string | null;
  text: string | null;
  imageUrl: string | null;
  scryfallId: string;
  oracleId: string | null;
  power: string | null;
  toughness: string | null;
  priceUsd: number | null;
  isArena: number | null;
  createdAt: Date;
  updatedAt: Date;
}

interface DeckCardRow {
  id: number;
  deckId: number;
  cardId: number;
  quantity: number;
  card: CardRow;
}

// Adaptador para CardCard (que espera manaCost)
function toCardCardData(card: CardRow) {
  return {
    id: String(card.id),
    name: card.name,
    manaCost: null as string | null,
    cmc: card.cmc ?? 0,
    type: card.type ?? "",
    rarity: card.rarity ?? "",
    text: card.text,
    imageUrl: card.imageUrl,
  };
}

export default function DeckBuilder() {
  const [selectedDeck, setSelectedDeck] = useState<DeckRow | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<CardRow[]>([]);
  const [newDeck, setNewDeck] = useState({
    name: "",
    format: "standard" as "standard" | "modern" | "commander" | "legacy",
    archetype: "",
    description: "",
  });

  const queryClient = useQueryClient();

  // Queries
  const { data: decks, isLoading: decksLoading } = trpc.decks.list.useQuery();
  const { data: deckCards, isLoading: cardsLoading } = trpc.decks.getCards.useQuery(
    selectedDeck?.id ?? 0,
    { enabled: !!selectedDeck }
  );

  // Busca de cartas (é uma query, não mutation)
  const [searchEnabled, setSearchEnabled] = useState(false);
  const { data: cardSearchData, isFetching: isSearching } = trpc.cards.search.useQuery(
    { name: searchQuery },
    {
      enabled: searchEnabled && !!searchQuery.trim(),
      onSuccess: (data: CardRow[]) => {
        setSearchResults(data);
        setSearchEnabled(false);
      },
    } as any
  );

  // Mutations
  const createDeckMutation = trpc.decks.create.useMutation({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["decks.list"] });
      setIsCreating(false);
      setNewDeck({ name: "", format: "standard", archetype: "", description: "" });
      toast.success("Deck criado com sucesso!");
    },
    onError: (error: any) => toast.error(`Erro ao criar deck: ${error.message}`),
  });

  const deleteDeckMutation = trpc.decks.delete.useMutation({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["decks.list"] });
      setSelectedDeck(null);
      toast.success("Deck excluído com sucesso!");
    },
    onError: (error: any) => toast.error(`Erro ao excluir deck: ${error.message}`),
  });

  const addCardMutation = trpc.decks.addCard.useMutation({
    onSuccess: () => {
      if (selectedDeck) {
        queryClient.invalidateQueries({ queryKey: [["decks", "getCards"], { input: selectedDeck.id }] });
      }
      toast.success("Carta adicionada ao deck!");
    },
    onError: (error: any) => toast.error(`Erro ao adicionar carta: ${error.message}`),
  });

  const removeCardMutation = trpc.decks.removeCard.useMutation({
    onSuccess: () => {
      if (selectedDeck) {
        queryClient.invalidateQueries({ queryKey: [["decks", "getCards"], { input: selectedDeck.id }] });
      }
      toast.success("Carta removida do deck!");
    },
    onError: (error: any) => toast.error(`Erro ao remover carta: ${error.message}`),
  });

  const handleCreateDeck = () => {
    if (!newDeck.name.trim()) {
      toast.error("Nome do deck é obrigatório");
      return;
    }
    createDeckMutation.mutate({
      name: newDeck.name,
      format: newDeck.format,
      archetype: newDeck.archetype || undefined,
      description: newDeck.description || undefined,
    });
  };

  const handleDeleteDeck = () => {
    if (!selectedDeck) return;
    deleteDeckMutation.mutate(selectedDeck.id);
  };

  const handleAddCard = (cardId: number) => {
    if (!selectedDeck) return;
    addCardMutation.mutate({ deckId: selectedDeck.id, cardId, quantity: 1 });
  };

  const handleRemoveCard = (cardId: number) => {
    if (!selectedDeck) return;
    removeCardMutation.mutate({ deckId: selectedDeck.id, cardId });
  };

  const handleSearch = () => {
    if (searchQuery.trim()) {
      setSearchEnabled(true);
    }
  };

  const startEditing = (deck: DeckRow) => {
    setSelectedDeck(deck);
    setNewDeck({
      name: deck.name,
      format: deck.format as "standard" | "modern" | "commander" | "legacy",
      archetype: deck.archetype || "",
      description: deck.description || "",
    });
    setIsEditing(true);
  };

  const typedDeckCards = (deckCards as unknown as DeckCardRow[] | undefined);
  const totalCards = typedDeckCards?.reduce((sum, dc) => sum + dc.quantity, 0) || 0;

  return (
    <div className="container mx-auto p-6">
      <div className="flex gap-6">
        {/* Deck List Sidebar */}
        <div className="w-80">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-2xl font-bold">Meus Decks</h2>
            <Dialog open={isCreating} onOpenChange={setIsCreating}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="w-4 h-4 mr-2" />
                  Novo Deck
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Criar Novo Deck</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="name">Nome</Label>
                    <Input
                      id="name"
                      value={newDeck.name}
                      onChange={(e) => setNewDeck({ ...newDeck, name: e.target.value })}
                      placeholder="Nome do deck"
                    />
                  </div>
                  <div>
                    <Label htmlFor="format">Formato</Label>
                    <Select
                      value={newDeck.format}
                      onValueChange={(value) =>
                        setNewDeck({ ...newDeck, format: value as "standard" | "modern" | "commander" | "legacy" })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="standard">Standard</SelectItem>
                        <SelectItem value="modern">Modern</SelectItem>
                        <SelectItem value="legacy">Legacy</SelectItem>
                        <SelectItem value="commander">Commander</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="archetype">Arquétipo</Label>
                    <Input
                      id="archetype"
                      value={newDeck.archetype}
                      onChange={(e) => setNewDeck({ ...newDeck, archetype: e.target.value })}
                      placeholder="ex: Control, Aggro"
                    />
                  </div>
                  <div>
                    <Label htmlFor="description">Descrição</Label>
                    <Textarea
                      id="description"
                      value={newDeck.description}
                      onChange={(e) => setNewDeck({ ...newDeck, description: e.target.value })}
                      placeholder="Descrição do deck"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setIsCreating(false)}>
                      Cancelar
                    </Button>
                    <Button onClick={handleCreateDeck} disabled={createDeckMutation.isPending}>
                      Criar
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>

          {decksLoading ? (
            <div>Carregando decks...</div>
          ) : (
            <div className="space-y-2">
              {(decks as unknown as DeckRow[] | undefined)?.map((deck) => (
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
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(e) => { e.stopPropagation(); startEditing(deck); }}
                        >
                          <Edit className="w-4 h-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(e) => { e.stopPropagation(); setSelectedDeck(deck); handleDeleteDeck(); }}
                        >
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
                  <p className="text-muted-foreground">{selectedDeck.format} • {totalCards} cartas</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline">Exportar</Button>
                  <Button>Validar</Button>
                </div>
              </div>

              {/* Card Search */}
              <Card className="mb-6">
                <CardHeader>
                  <CardTitle>Adicionar Cartas</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Buscar cartas..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    />
                    <Button onClick={handleSearch} disabled={isSearching}>
                      Buscar
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
                            Adicionar
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
                  <CardTitle>Cartas do Deck ({totalCards})</CardTitle>
                </CardHeader>
                <CardContent>
                  {cardsLoading ? (
                    <div>Carregando cartas...</div>
                  ) : typedDeckCards && typedDeckCards.length > 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {typedDeckCards.map((deckCard) => (
                        <CardCard
                          key={deckCard.id}
                          card={toCardCardData(deckCard.card)}
                          quantity={deckCard.quantity}
                          onRemove={() => handleRemoveCard(deckCard.cardId)}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="text-muted-foreground">Nenhuma carta neste deck ainda.</p>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : (
            <div className="flex items-center justify-center h-96">
              <p className="text-muted-foreground">Selecione um deck para começar a editar</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
