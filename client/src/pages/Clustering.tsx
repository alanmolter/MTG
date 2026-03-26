import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, BarChart3, Target, Zap } from "lucide-react";
import { toast } from "sonner";

export default function ClusteringPage() {
  const [kValue, setKValue] = useState(8);

  const clusterMutation = useMutation({
    mutationFn: (k: number) => trpc.training.clusterDecks.mutate({ k }),
    onSuccess: (data) => {
      toast.success(`Clustering completed! Generated ${data.totalClusters} clusters with ${data.totalDecksClustered} decks.`);
    },
    onError: (error) => {
      toast.error(`Clustering failed: ${error.message}`);
    },
  });

  const handleCluster = () => {
    if (kValue < 2 || kValue > 20) {
      toast.error("K must be between 2 and 20");
      return;
    }
    clusterMutation.mutate(kValue);
  };

  const result = clusterMutation.data;

  return (
    <div className="container mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-white mb-2">Deck Clustering</h1>
        <p className="text-gray-400">Automatically categorize competitive decks into archetypes using K-Means clustering</p>
      </div>

      {/* Clustering Controls */}
      <Card className="bg-slate-900/50 border-purple-500/30 mb-8">
        <CardHeader>
          <CardTitle className="text-white flex items-center gap-2">
            <Target className="w-5 h-5" />
            K-Means Clustering
          </CardTitle>
          <CardDescription className="text-gray-400">
            Group competitive decks into archetypes based on their card embeddings and characteristics
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4 items-end">
            <div className="space-y-2">
              <Label htmlFor="k-value" className="text-gray-300">Number of Clusters (K)</Label>
              <Input
                id="k-value"
                type="number"
                min="2"
                max="20"
                value={kValue}
                onChange={(e) => setKValue(parseInt(e.target.value) || 8)}
                className="bg-slate-800 border-purple-500/30 text-white w-32"
              />
            </div>
            <Button
              onClick={handleCluster}
              disabled={clusterMutation.isPending}
              className="bg-purple-600 hover:bg-purple-700"
            >
              {clusterMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Clustering...
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4 mr-2" />
                  Run Clustering
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      {result && (
        <div className="space-y-6">
          {/* Metrics */}
          {result.metrics && (
            <Card className="bg-slate-900/50 border-purple-500/30">
              <CardHeader>
                <CardTitle className="text-white flex items-center gap-2">
                  <BarChart3 className="w-5 h-5" />
                  Clustering Quality Metrics
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-green-400">
                      {result.metrics.silhouetteScore.toFixed(3)}
                    </div>
                    <div className="text-sm text-gray-400">Silhouette Score</div>
                    <div className="text-xs text-gray-500">Higher is better (0-1)</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-blue-400">
                      {result.metrics.calinskiHarabaszIndex.toFixed(1)}
                    </div>
                    <div className="text-sm text-gray-400">Calinski-Harabasz</div>
                    <div className="text-xs text-gray-500">Higher is better</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-orange-400">
                      {result.metrics.daviesBouldinIndex.toFixed(3)}
                    </div>
                    <div className="text-sm text-gray-400">Davies-Bouldin</div>
                    <div className="text-xs text-gray-500">Lower is better</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Summary */}
          <Card className="bg-slate-900/50 border-purple-500/30">
            <CardHeader>
              <CardTitle className="text-white">Clustering Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-2xl font-bold text-purple-400">{result.totalClusters}</div>
                  <div className="text-sm text-gray-400">Clusters Generated</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-green-400">{result.totalDecksClustered}</div>
                  <div className="text-sm text-gray-400">Decks Clustered</div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Clusters */}
          <div className="grid gap-4">
            <h2 className="text-2xl font-bold text-white">Generated Archetypes</h2>
            {result.clusters.map((cluster) => (
              <Card key={cluster.clusterId} className="bg-slate-900/50 border-purple-500/30">
                <CardHeader>
                  <div className="flex justify-between items-start">
                    <div>
                      <CardTitle className="text-white text-lg">{cluster.archetype}</CardTitle>
                      <CardDescription className="text-gray-400">
                        Cluster {cluster.clusterId + 1} • {cluster.deckIds.length} decks
                      </CardDescription>
                    </div>
                    <div className="text-right">
                      <div className="text-sm text-gray-400">Confidence</div>
                      <div className="text-lg font-bold text-purple-400">
                        {(cluster.confidence * 100).toFixed(1)}%
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-4 text-sm">
                    <div>
                      <span className="text-gray-500">Colors:</span>
                      <Badge variant="secondary" className="ml-2">
                        {cluster.avgColors || "Colorless"}
                      </Badge>
                    </div>
                    <div>
                      <span className="text-gray-500">Avg. Cards:</span>
                      <span className="text-white ml-2">{cluster.avgCardCount}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}