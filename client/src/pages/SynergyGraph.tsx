import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, Network, Search, Zap } from "lucide-react";
import CytoscapeComponent from "react-cytoscapejs";

interface SynergyNode {
  id: string;
  label: string;
  color: string;
  size: number;
}

interface SynergyEdge {
  id: string;
  source: string;
  target: string;
  weight: number;
  label: string;
}

export default function SynergyGraph() {
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [graphData, setGraphData] = useState<{ nodes: SynergyNode[]; edges: SynergyEdge[] }>({
    nodes: [],
    edges: [],
  });

  // Search for cards
  const cardSearch = trpc.cards.search.useQuery(
    { name: searchQuery },
    { enabled: searchQuery.length > 2 }
  );

  // Get synergy neighbors when a card is selected
  const synergyQuery = trpc.cards.similar.useQuery(
    selectedCardId || 0,
    { enabled: !!selectedCardId }
  );

  // Build graph data when we have synergy data
  useEffect(() => {
    if (selectedCardId && synergyQuery.data) {
      const nodes: SynergyNode[] = [];
      const edges: SynergyEdge[] = [];

      // Add central node
      nodes.push({
        id: `card-${selectedCardId}`,
        label: "Selected Card", // Would need card name
        color: "#3b82f6",
        size: 20,
      });

      // Add neighbor nodes and edges
      synergyQuery.data.slice(0, 8).forEach((similarCard, index) => {
        const nodeId = `card-${similarCard.id}`;
        nodes.push({
          id: nodeId,
          label: similarCard.name.substring(0, 15) + (similarCard.name.length > 15 ? "..." : ""),
          color: "#10b981",
          size: 12 + (8 - index) * 1, // Size based on similarity rank
        });

        edges.push({
          id: `edge-${selectedCardId}-${similarCard.id}`,
          source: `card-${selectedCardId}`,
          target: nodeId,
          weight: similarCard.similarity,
          label: similarCard.similarity.toFixed(2),
        });
      });

      setGraphData({ nodes, edges });
    }
  }, [selectedCardId, synergyQuery.data]);

  const handleCardSelect = (cardId: number) => {
    setSelectedCardId(cardId);
    setSearchQuery("");
  };

  const renderCytoscapeGraph = () => {
    if (graphData.nodes.length === 0) return null;

    const elements = [
      ...graphData.nodes.map(node => ({
        data: { 
          id: node.id, 
          label: node.label,
          color: node.color,
          size: node.size * 2
        }
      })),
      ...graphData.edges.map(edge => ({
        data: { 
          id: edge.id, 
          source: edge.source, 
          target: edge.target, 
          weight: edge.weight,
          label: edge.label
        }
      }))
    ];

    const stylesheet: any = [
      {
        selector: 'node',
        style: {
          'background-color': 'data(color)',
          'label': 'data(label)',
          'width': 'data(size)',
          'height': 'data(size)',
          'color': '#fff',
          'font-size': '10px',
          'text-valign': 'center',
          'text-halign': 'center',
          'border-width': 2,
          'border-color': '#fff'
        }
      },
      {
        selector: 'edge',
        style: {
          'width': 'mapData(weight, 0, 1, 1, 8)',
          'line-color': '#8b5cf6',
          'target-arrow-color': '#8b5cf6',
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
          'opacity': 'mapData(weight, 0, 1, 0.3, 0.8)',
          'label': 'data(label)',
          'font-size': '8px',
          'color': '#a78bfa',
          'text-rotation': 'autorotate',
          'text-margin-y': -10
        }
      },
      {
        selector: ':selected',
        style: {
          'border-width': 4,
          'border-color': '#f59e0b'
        }
      }
    ];

    return (
      <div className="bg-slate-900/50 border border-purple-500/30 rounded-lg p-4">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-white">Interactive Synergy Network</h3>
          <Badge variant="outline" className="text-purple-400 border-purple-400/30">
            Powered by Cytoscape.js
          </Badge>
        </div>

        <div className="h-[500px] bg-slate-800/30 rounded-lg border border-slate-700 overflow-hidden">
          <CytoscapeComponent
            elements={elements}
            style={{ width: '100%', height: '100%' }}
            stylesheet={stylesheet}
            layout={{
              name: 'cose',
              animate: true,
              refresh: 20,
              fit: true,
              padding: 50,
              nodeRepulsion: 4000,
              idealEdgeLength: 100,
            }}
            cy={(cy) => {
              cy.on('tap', 'node', (evt) => {
                const node = evt.target;
                console.log('Tapped node:', node.id());
              });
            }}
          />
        </div>

        {/* Legend */}
        <div className="mt-4 flex flex-wrap gap-4 text-sm bg-slate-800/50 p-3 rounded">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-blue-500"></div>
            <span className="text-gray-300">Selected Card</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-green-500"></div>
            <span className="text-gray-300">Synergistic Connection</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-6 h-0.5 bg-purple-500"></div>
            <span className="text-gray-300 ml-1">Similarity Weight</span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="container mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-white mb-2">Synergy Graph</h1>
        <p className="text-gray-400">Explore card relationships and synergy networks</p>
      </div>

      <div className="grid gap-6">
        {/* Card Search */}
        <Card className="bg-slate-900/50 border-purple-500/30">
          <CardHeader>
            <CardTitle className="text-white flex items-center gap-2">
              <Search className="w-5 h-5" />
              Find a Card
            </CardTitle>
            <CardDescription className="text-gray-400">
              Search for a card to explore its synergy network
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Input
                placeholder="Search cards..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-slate-800 border-purple-500/30 text-white placeholder-gray-500"
              />
            </div>

            {cardSearch.isLoading && (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="w-5 h-5 text-purple-400 animate-spin" />
              </div>
            )}

            {cardSearch.data && cardSearch.data.length > 0 && (
              <div className="mt-4 max-h-48 overflow-y-auto">
                {cardSearch.data.slice(0, 10).map((card) => (
                  <div
                    key={card.id}
                    className="flex justify-between items-center p-2 hover:bg-slate-800/50 rounded cursor-pointer"
                    onClick={() => handleCardSelect(card.id)}
                  >
                    <div>
                      <p className="text-white font-medium">{card.name}</p>
                      <p className="text-gray-400 text-sm">{card.type}</p>
                    </div>
                    <Button size="sm" variant="outline">
                      Select
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Synergy Graph */}
        {selectedCardId ? (
          <Card className="bg-slate-900/50 border-purple-500/30">
            <CardHeader>
              <CardTitle className="text-white flex items-center gap-2">
                <Network className="w-5 h-5" />
                Synergy Network
              </CardTitle>
              <CardDescription className="text-gray-400">
                Visual representation of card relationships based on co-occurrence in competitive decks
              </CardDescription>
            </CardHeader>
            <CardContent>
              {synergyQuery.isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 text-purple-400 animate-spin" />
                  <span className="ml-2 text-gray-400">Loading synergy data...</span>
                </div>
              ) : synergyQuery.data && synergyQuery.data.length > 0 ? (
                renderCytoscapeGraph()
              ) : (
                <div className="text-center py-12">
                  <Zap className="w-12 h-12 text-gray-600 mx-auto mb-4" />
                  <p className="text-gray-400">No synergy data available for this card</p>
                  <p className="text-sm text-gray-500 mt-2">
                    Try selecting a different card or ensure embeddings have been trained
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card className="bg-slate-900/50 border-purple-500/30">
            <CardContent className="pt-6">
              <div className="text-center py-12">
                <Network className="w-12 h-12 text-gray-600 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-white mb-2">Select a Card to Begin</h3>
                <p className="text-gray-400">
                  Choose a card above to explore its synergy relationships with other cards
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Info Panel */}
        <Card className="bg-slate-900/50 border-purple-500/30">
          <CardHeader>
            <CardTitle className="text-white">How Synergy Works</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <h4 className="text-white font-medium mb-2">Co-occurrence Analysis</h4>
              <p className="text-gray-400 text-sm">
                Synergy scores are calculated based on how often cards appear together in competitive decks.
                Higher scores indicate stronger relationships.
              </p>
            </div>
            <div>
              <h4 className="text-white font-medium mb-2">Network Visualization</h4>
              <p className="text-gray-400 text-sm">
                The central node represents your selected card. Connected nodes show similar cards,
                with connection strength indicating synergy strength.
              </p>
            </div>
            <div>
              <h4 className="text-white font-medium mb-2">Data Source</h4>
              <p className="text-gray-400 text-sm">
                Synergy data is derived from competitive deck lists imported from MTGGoldfish and MTGTop8.
                The more decks analyzed, the more accurate the synergy scores become.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}