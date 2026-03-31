import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, BarChart3, Target, Zap } from "lucide-react";
import { toast } from "sonner";

interface ClusterResult {
  clusterId: number;
  archetype: string;
  deckIds: number[];
  confidence: number;
  avgColors?: string;
  avgCardCount?: number;
}

interface ClusteringStats {
  silhouetteScore?: number;
  calinskiHarabaszIndex?: number;
  daviesBouldinIndex?: number;
}

interface ClusteringOutput {
  clusters: ClusterResult[];
  stats: ClusteringStats;
  archetypeStats: Array<{
    archetype: string;
    clusterCount: number;
    totalDecks: number;
    avgConfidence: number;
    colors: Set<string>;
  }>;
  totalClusters: number;
  totalDecksClustered: number;
}

export default function ClusteringPage() {
  const [kValue, setKValue] = useState(8);

  const clusterMutation = trpc.training.clusterDecks.useMutation({
    onSuccess: (data: ClusteringOutput) => {
      toast.success(`Clustering concluído! ${data.totalClusters} clusters com ${data.totalDecksClustered} decks.`);
    },
    onError: (error: any) => {
      toast.error(`Clustering falhou: ${error.message}`);
    },
  });

  const handleCluster = () => {
    if (kValue < 2 || kValue > 20) {
      toast.error("K deve estar entre 2 e 20");
      return;
    }
    clusterMutation.mutate({ k: kValue });
  };

  const result = clusterMutation.data as ClusteringOutput | undefined;

  return (
    <div className="container mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-white mb-2">Deck Clustering</h1>
        <p className="text-gray-400">Categorize automaticamente decks competitivos em arquétipos usando K-Means clustering</p>
      </div>

      {/* Clustering Controls */}
      <Card className="bg-slate-900/50 border-purple-500/30 mb-8">
        <CardHeader>
          <CardTitle className="text-white flex items-center gap-2">
            <Target className="w-5 h-5" />
            K-Means Clustering
          </CardTitle>
          <CardDescription className="text-gray-400">
            Agrupe decks competitivos em arquétipos baseados em embeddings de cartas e características
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4 items-end">
            <div className="space-y-2">
              <Label htmlFor="k-value" className="text-gray-300">Número de Clusters (K)</Label>
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
                  Clusterizando...
                </>
              ) : (
                <>
                  <Zap className="w-4 h-4 mr-2" />
                  Executar Clustering
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
          {result.stats && (result.stats.silhouetteScore !== undefined) && (
            <Card className="bg-slate-900/50 border-purple-500/30">
              <CardHeader>
                <CardTitle className="text-white flex items-center gap-2">
                  <BarChart3 className="w-5 h-5" />
                  Métricas de Qualidade do Clustering
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="text-center">
                    <div className="text-2xl font-bold text-green-400">
                      {result.stats.silhouetteScore?.toFixed(3)}
                    </div>
                    <div className="text-sm text-gray-400">Silhouette Score</div>
                    <div className="text-xs text-gray-500">Maior é melhor (0-1)</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-blue-400">
                      {result.stats.calinskiHarabaszIndex?.toFixed(1)}
                    </div>
                    <div className="text-sm text-gray-400">Calinski-Harabasz</div>
                    <div className="text-xs text-gray-500">Maior é melhor</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold text-orange-400">
                      {result.stats.daviesBouldinIndex?.toFixed(3)}
                    </div>
                    <div className="text-sm text-gray-400">Davies-Bouldin</div>
                    <div className="text-xs text-gray-500">Menor é melhor</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Summary */}
          <Card className="bg-slate-900/50 border-purple-500/30">
            <CardHeader>
              <CardTitle className="text-white">Resumo do Clustering</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-2xl font-bold text-purple-400">{result.totalClusters}</div>
                  <div className="text-sm text-gray-400">Clusters Gerados</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-green-400">{result.totalDecksClustered}</div>
                  <div className="text-sm text-gray-400">Decks Clusterizados</div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Clusters */}
          <div className="grid gap-4">
            <h2 className="text-2xl font-bold text-white">Arquétipos Gerados</h2>
            {result.clusters.map((cluster: ClusterResult) => (
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
                      <div className="text-sm text-gray-400">Confiança</div>
                      <div className="text-lg font-bold text-purple-400">
                        {(cluster.confidence * 100).toFixed(1)}%
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-4 text-sm">
                    <div>
                      <span className="text-gray-500">Cores:</span>
                      <Badge variant="secondary" className="ml-2">
                        {cluster.avgColors || "Incolor"}
                      </Badge>
                    </div>
                    <div>
                      <span className="text-gray-500">Média de Cartas:</span>
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
