import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Sparkles, Wand2, Search, BarChart3, Brain, Layers } from "lucide-react";
import { useLocation } from "wouter";
import { getLoginUrl } from "@/const";

export default function Home() {
  const { user, isAuthenticated } = useAuth();
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950 to-slate-900">
      {/* Header */}
      <header className="border-b border-purple-500/20 bg-black/40 backdrop-blur-sm">
        <div className="container mx-auto px-4 py-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
              <Sparkles className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-white">MTG Deck Engine</h1>
          </div>
          {isAuthenticated ? (
            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-300">Welcome, {user?.name}</span>
              <Button variant="outline" size="sm" onClick={() => setLocation("/decks")}>
                My Decks
              </Button>
            </div>
          ) : (
            <Button asChild>
              <a href={getLoginUrl()}>Sign In</a>
            </Button>
          )}
        </div>
      </header>

      {/* Hero Section */}
      <section className="container mx-auto px-4 py-20">
        <div className="max-w-3xl mx-auto text-center mb-16">
          <h2 className="text-5xl font-bold text-white mb-6 leading-tight">
            Generate Competitive MTG Decks with AI
          </h2>
          <p className="text-xl text-gray-300 mb-8">
            Discover synergies, analyze the meta, and build winning decks powered by machine learning and data-driven insights.
          </p>
          <div className="flex gap-4 justify-center flex-wrap">
            <Button size="lg" onClick={() => setLocation("/search")} className="bg-purple-600 hover:bg-purple-700">
              <Search className="w-5 h-5 mr-2" />
              Search Cards
            </Button>
            <Button size="lg" onClick={() => setLocation("/generator")} variant="outline" className="border-purple-500 text-purple-300 hover:bg-purple-500/10">
              <Wand2 className="w-5 h-5 mr-2" />
              Generate Deck
            </Button>
            <Button size="lg" onClick={() => setLocation("/sync")} variant="outline" className="border-blue-500 text-blue-300 hover:bg-blue-500/10">
              <BarChart3 className="w-5 h-5 mr-2" />
              Sync Data
            </Button>
            <Button size="lg" onClick={() => setLocation("/pipeline")} className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700">
              <Brain className="w-5 h-5 mr-2" />
              Full Pipeline
            </Button>
            <Button size="lg" onClick={() => setLocation("/archetype")} className="bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-700 hover:to-orange-700">
              <Layers className="w-5 h-5 mr-2" />
              Archetype Builder
            </Button>
          </div>
        </div>

        {/* Features Grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mt-20">
          <Card className="bg-slate-900/50 border-purple-500/30 hover:border-purple-500/60 transition-colors">
            <CardHeader>
              <Search className="w-8 h-8 text-purple-400 mb-2" />
              <CardTitle className="text-white">Card Search</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-400">Find cards by name, type, colors, and mana cost with advanced filters</p>
            </CardContent>
          </Card>

          <Card className="bg-slate-900/50 border-purple-500/30 hover:border-purple-500/60 transition-colors">
            <CardHeader>
              <Wand2 className="w-8 h-8 text-pink-400 mb-2" />
              <CardTitle className="text-white">Deck Generator</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-400">Automatically generate decks optimized for synergy and meta performance</p>
            </CardContent>
          </Card>

          <Card className="bg-slate-900/50 border-purple-500/30 hover:border-purple-500/60 transition-colors">
            <CardHeader>
              <BarChart3 className="w-8 h-8 text-blue-400 mb-2" />
              <CardTitle className="text-white">Meta Analytics</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-400">View deck archetypes, card frequencies, and win rates across formats</p>
            </CardContent>
          </Card>

          <Card className="bg-slate-900/50 border-amber-500/30 hover:border-amber-500/60 transition-colors cursor-pointer" onClick={() => setLocation("/archetype")}>
            <CardHeader>
              <Layers className="w-8 h-8 text-amber-400 mb-2" />
              <CardTitle className="text-white">Archetype Builder</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-400">Gere decks por arquétipo com filtros de cor, tribo, tipo e scoring por prioridades</p>
            </CardContent>
          </Card>

          <Card className="bg-slate-900/50 border-purple-500/30 hover:border-purple-500/60 transition-colors cursor-pointer" onClick={() => setLocation("/pipeline")}>
            <CardHeader>
              <Brain className="w-8 h-8 text-green-400 mb-2" />
              <CardTitle className="text-white">AI Pipeline</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-400">Import Moxfield decks, train Word2Vec embeddings, and generate optimized decks</p>
            </CardContent>
          </Card>
        </div>

        {/* CTA Section */}
        {!isAuthenticated && (
          <div className="mt-20 bg-gradient-to-r from-purple-600/20 to-pink-600/20 border border-purple-500/30 rounded-lg p-12 text-center">
            <h3 className="text-2xl font-bold text-white mb-4">Ready to build your next deck?</h3>
            <p className="text-gray-300 mb-6 max-w-2xl mx-auto">
              Sign in to create, save, and share your decks. Start exploring the power of data-driven deck building today.
            </p>
            <Button size="lg" asChild className="bg-purple-600 hover:bg-purple-700">
              <a href={getLoginUrl()}>Get Started</a>
            </Button>
          </div>
        )}
      </section>

      {/* Footer */}
      <footer className="border-t border-purple-500/20 bg-black/40 backdrop-blur-sm mt-20">
        <div className="container mx-auto px-4 py-8 text-center text-gray-400">
          <p>MTG Deck Engine © 2026 • Powered by Scryfall API</p>
        </div>
      </footer>
    </div>
  );
}
