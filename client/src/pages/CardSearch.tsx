import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Search } from "lucide-react";
import { useLocation } from "wouter";

export default function CardSearch() {
  const [, setLocation] = useLocation();
  const [filters, setFilters] = useState({
    name: "",
    type: "",
    colors: "",
    cmc: undefined as number | undefined,
    rarity: "",
  });

  const searchQuery = trpc.cards.search.useQuery(filters, {
    enabled: filters.name.length > 0 || filters.type.length > 0 || filters.colors.length > 0,
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    searchQuery.refetch();
  };

  const colorOptions = [
    { value: "", label: "All Colors" },
    { value: "W", label: "White" },
    { value: "U", label: "Blue" },
    { value: "B", label: "Black" },
    { value: "R", label: "Red" },
    { value: "G", label: "Green" },
  ];

  const rarityOptions = [
    { value: "", label: "All Rarities" },
    { value: "common", label: "Common" },
    { value: "uncommon", label: "Uncommon" },
    { value: "rare", label: "Rare" },
    { value: "mythic", label: "Mythic" },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950 to-slate-900">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">Card Search</h1>
          <p className="text-gray-400">Find cards by name, type, colors, and more</p>
        </div>

        {/* Search Filters */}
        <Card className="bg-slate-900/50 border-purple-500/30 mb-8">
          <CardHeader>
            <CardTitle className="text-white">Search Filters</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSearch} className="space-y-6">
              <div className="grid md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <Label htmlFor="name" className="text-gray-300">Card Name</Label>
                  <Input
                    id="name"
                    placeholder="e.g., Lightning Bolt"
                    value={filters.name}
                    onChange={(e) => setFilters({ ...filters, name: e.target.value })}
                    className="bg-slate-800 border-purple-500/30 text-white placeholder-gray-500"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="type" className="text-gray-300">Card Type</Label>
                  <Input
                    id="type"
                    placeholder="e.g., Creature, Instant"
                    value={filters.type}
                    onChange={(e) => setFilters({ ...filters, type: e.target.value })}
                    className="bg-slate-800 border-purple-500/30 text-white placeholder-gray-500"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="colors" className="text-gray-300">Colors</Label>
                  <Select value={filters.colors} onValueChange={(value) => setFilters({ ...filters, colors: value })}>
                    <SelectTrigger className="bg-slate-800 border-purple-500/30 text-white">
                      <SelectValue placeholder="Select colors" />
                    </SelectTrigger>
                    <SelectContent className="bg-slate-800 border-purple-500/30">
                      {colorOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value} className="text-white">
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="rarity" className="text-gray-300">Rarity</Label>
                  <Select value={filters.rarity} onValueChange={(value) => setFilters({ ...filters, rarity: value })}>
                    <SelectTrigger className="bg-slate-800 border-purple-500/30 text-white">
                      <SelectValue placeholder="Select rarity" />
                    </SelectTrigger>
                    <SelectContent className="bg-slate-800 border-purple-500/30">
                      {rarityOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value} className="text-white">
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Button type="submit" className="bg-purple-600 hover:bg-purple-700 w-full">
                <Search className="w-4 h-4 mr-2" />
                Search Cards
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Results */}
        <div>
          {searchQuery.isLoading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
            </div>
          )}

          {searchQuery.isError && (
            <Card className="bg-red-900/20 border-red-500/30">
              <CardContent className="pt-6">
                <p className="text-red-300">Error searching cards. Please try again.</p>
              </CardContent>
            </Card>
          )}

          {searchQuery.data && searchQuery.data.length === 0 && (
            <Card className="bg-slate-900/50 border-purple-500/30">
              <CardContent className="pt-6">
                <p className="text-gray-400">No cards found. Try adjusting your filters.</p>
              </CardContent>
            </Card>
          )}

          {searchQuery.data && searchQuery.data.length > 0 && (
            <div>
              <p className="text-gray-400 mb-6">Found {searchQuery.data.length} cards</p>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {searchQuery.data.map((card) => (
                  <Card key={card.id} className="bg-slate-900/50 border-purple-500/30 hover:border-purple-500/60 transition-colors overflow-hidden">
                    <div className="h-48 bg-gradient-to-br from-purple-600/20 to-pink-600/20 flex items-center justify-center">
                      {card.imageUrl ? (
                        <img src={card.imageUrl} alt={card.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="text-center">
                          <p className="text-gray-400 text-sm">No image available</p>
                        </div>
                      )}
                    </div>
                    <CardHeader>
                      <CardTitle className="text-white text-lg">{card.name}</CardTitle>
                      <CardDescription className="text-gray-400">{card.type}</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <div>
                          <span className="text-gray-500">CMC:</span>
                          <span className="text-white ml-2">{card.cmc}</span>
                        </div>
                        <div>
                          <span className="text-gray-500">Rarity:</span>
                          <span className="text-white ml-2 capitalize">{card.rarity}</span>
                        </div>
                      </div>
                      {card.text && (
                        <div className="text-xs text-gray-400 bg-slate-800/50 p-2 rounded">
                          {card.text.substring(0, 100)}...
                        </div>
                      )}
                      <Button variant="outline" size="sm" className="w-full border-purple-500/30 text-purple-300 hover:bg-purple-500/10">
                        View Details
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
