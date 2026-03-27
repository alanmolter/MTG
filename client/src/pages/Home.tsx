import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sparkles, Search, Layers, Network } from "lucide-react";
import { useLocation, Link } from "wouter";
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
              <Button variant="outline" size="sm" onClick={() => setLocation("/archetype")}>
                Dashboard
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
          
          <div className="flex gap-6 justify-center flex-wrap">
            <Link href="/archetype">
              <Button size="lg" className="h-16 px-8 text-lg bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-700 hover:to-orange-700 shadow-lg shadow-orange-500/20">
                <Layers className="w-6 h-6 mr-3" />
                Archetype Builder
              </Button>
            </Link>
            <Link href="/search">
              <Button size="lg" className="h-16 px-8 text-lg bg-purple-600 hover:bg-purple-700 shadow-lg shadow-purple-500/20">
                <Search className="w-6 h-6 mr-3" />
                Search Cards
              </Button>
            </Link>
            <Link href="/synergy">
              <Button size="lg" variant="outline" className="h-16 px-8 text-lg border-cyan-500 text-cyan-300 hover:bg-cyan-500/10 shadow-lg shadow-cyan-500/10">
                <Network className="w-6 h-6 mr-3" />
                Synergy Graph
              </Button>
            </Link>
          </div>
        </div>

        {/* Features Grid */}
        <div className="grid md:grid-cols-3 gap-8 mt-20">
          <Link href="/archetype" className="block h-full group">
            <Card className="bg-slate-900/50 border-amber-500/30 group-hover:border-amber-500/60 transition-all transform group-hover:-translate-y-1 h-full">
              <CardHeader>
                <Layers className="w-10 h-10 text-amber-400 mb-2" />
                <CardTitle className="text-white text-xl">Archetype Builder</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-gray-400">Generate decks by archetype with color filters, tribe/type selection, and priority-based scoring.</p>
              </CardContent>
            </Card>
          </Link>

          <Link href="/search" className="block h-full group">
            <Card className="bg-slate-900/50 border-purple-500/30 group-hover:border-purple-500/60 transition-all transform group-hover:-translate-y-1 h-full">
              <CardHeader>
                <Search className="w-10 h-10 text-purple-400 mb-2" />
                <CardTitle className="text-white text-xl">Card Search</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-gray-400">Advanced search for cards by name, type, colors, and mana cost with meta data insights.</p>
              </CardContent>
            </Card>
          </Link>

          <Link href="/synergy" className="block h-full group">
            <Card className="bg-slate-900/50 border-cyan-500/30 group-hover:border-cyan-500/60 transition-all transform group-hover:-translate-y-1 h-full">
              <CardHeader>
                <Network className="w-10 h-10 text-cyan-400 mb-2" />
                <CardTitle className="text-white text-xl">Synergy Graph</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-gray-400">Explore complex card relationships and synergy networks discovered by our AI engines.</p>
              </CardContent>
            </Card>
          </Link>
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
