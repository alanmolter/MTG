import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Loader2, Download, BarChart3 } from "lucide-react";
import { toast } from "sonner";

export default function SyncData() {
  const [format, setFormat] = useState<"standard" | "modern" | "commander" | "legacy" | "all">("standard");
  const [colors, setColors] = useState<string[]>([]);
  const [limit, setLimit] = useState(1000);

  const statsQuery = trpc.sync.getStats.useQuery();

  const syncMutation = trpc.sync.syncScryfall.useMutation({
    onSuccess: (data) => {
      toast.success(`Sincronização concluída! ${data.imported} cartas importadas.`);
      statsQuery.refetch();
    },
    onError: () => {
      toast.error("Erro ao sincronizar cartas");
    },
  });

  const handleSync = () => {
    syncMutation.mutate({
      format,
      colors: colors.length > 0 ? colors : undefined,
      limit,
    });
  };

  const toggleColor = (color: string) => {
    setColors((prev) =>
      prev.includes(color) ? prev.filter((c) => c !== color) : [...prev, color]
    );
  };

  const colorOptions = [
    { value: "W", label: "White", bg: "bg-yellow-100" },
    { value: "U", label: "Blue", bg: "bg-blue-100" },
    { value: "B", label: "Black", bg: "bg-gray-800" },
    { value: "R", label: "Red", bg: "bg-red-100" },
    { value: "G", label: "Green", bg: "bg-green-100" },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950 to-slate-900">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">Sincronizar Dados</h1>
          <p className="text-gray-400">Importe cartas reais do Scryfall para alimentar o gerador de decks</p>
        </div>

        <div className="grid lg:grid-cols-3 gap-8">
          {/* Sync Panel */}
          <div className="lg:col-span-1">
            <Card className="bg-slate-900/50 border-purple-500/30 sticky top-8">
              <CardHeader>
                <CardTitle className="text-white">Sincronizar Cartas</CardTitle>
                <CardDescription className="text-gray-400">Importar do Scryfall</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="format" className="text-gray-300">Formato</Label>
                  <Select value={format} onValueChange={(value: any) => setFormat(value)}>
                    <SelectTrigger className="bg-slate-800 border-purple-500/30 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-slate-800 border-purple-500/30">
                      <SelectItem value="standard" className="text-white">Standard</SelectItem>
                      <SelectItem value="modern" className="text-white">Modern</SelectItem>
                      <SelectItem value="commander" className="text-white">Commander</SelectItem>
                      <SelectItem value="legacy" className="text-white">Legacy</SelectItem>
                      <SelectItem value="all" className="text-white">Todos</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-3">
                  <Label className="text-gray-300">Cores (opcional)</Label>
                  <div className="grid grid-cols-5 gap-2">
                    {colorOptions.map((color) => (
                      <button
                        key={color.value}
                        onClick={() => toggleColor(color.value)}
                        className={`p-2 rounded border-2 transition-all ${
                          colors.includes(color.value)
                            ? "border-purple-500 bg-purple-500/20"
                            : "border-purple-500/30 hover:border-purple-500/60"
                        }`}
                        title={color.label}
                      >
                        <span className="text-xs font-bold text-white">{color.value}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="limit" className="text-gray-300">Limite de cartas</Label>
                  <input
                    id="limit"
                    type="number"
                    value={limit}
                    onChange={(e) => setLimit(parseInt(e.target.value))}
                    className="w-full px-3 py-2 bg-slate-800 border border-purple-500/30 text-white rounded"
                  />
                  <p className="text-xs text-gray-500">Máximo de cartas a importar</p>
                </div>

                <Button
                  onClick={handleSync}
                  disabled={syncMutation.isPending}
                  className="w-full bg-purple-600 hover:bg-purple-700"
                >
                  {syncMutation.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Sincronizando...
                    </>
                  ) : (
                    <>
                      <Download className="w-4 h-4 mr-2" />
                      Sincronizar Agora
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* Stats Panel */}
          <div className="lg:col-span-2 space-y-6">
            {/* Status Card */}
            {syncMutation.data && (
              <Card className="bg-green-900/20 border-green-500/30">
                <CardHeader>
                  <CardTitle className="text-green-300">✓ Sincronização Concluída</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <p className="text-gray-400 text-sm">Importadas</p>
                      <p className="text-2xl font-bold text-green-300">{syncMutation.data.imported}</p>
                    </div>
                    <div>
                      <p className="text-gray-400 text-sm">Puladas</p>
                      <p className="text-2xl font-bold text-yellow-300">{syncMutation.data.skipped}</p>
                    </div>
                    <div>
                      <p className="text-gray-400 text-sm">Erros</p>
                      <p className="text-2xl font-bold text-red-300">{syncMutation.data.errors}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Stats Card */}
            {statsQuery.data && (
              <Card className="bg-slate-900/50 border-purple-500/30">
                <CardHeader>
                  <CardTitle className="text-white flex items-center gap-2">
                    <BarChart3 className="w-5 h-5 text-purple-400" />
                    Estatísticas de Cartas
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div>
                    <p className="text-gray-400 mb-2">Total de Cartas</p>
                    <p className="text-4xl font-bold text-purple-300">{statsQuery.data.total}</p>
                  </div>

                  <div>
                    <p className="text-gray-300 font-semibold mb-3">Por Raridade</p>
                    <div className="space-y-2">
                      {Object.entries(statsQuery.data.byRarity).map(([rarity, count]) => (
                        <div key={rarity} className="flex items-center justify-between">
                          <span className="text-gray-400 capitalize">{rarity}</span>
                          <div className="flex items-center gap-2">
                            <div className="w-32 bg-slate-800 rounded h-2">
                              <div
                                className="bg-purple-500 h-2 rounded"
                                style={{
                                  width: `${(count as number / statsQuery.data.total) * 100}%`,
                                }}
                              />
                            </div>
                            <span className="text-purple-300 font-semibold w-12 text-right">
                              {count}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="text-gray-300 font-semibold mb-3">Por Cor</p>
                    <div className="grid grid-cols-5 gap-3">
                      {colorOptions.map((color) => (
                        <div key={color.value} className="text-center">
                          <div className="text-2xl font-bold text-white mb-1">
                            {statsQuery.data.byColor[color.value] || 0}
                          </div>
                          <p className="text-xs text-gray-400">{color.label}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {statsQuery.isLoading && (
              <Card className="bg-slate-900/50 border-purple-500/30 h-96 flex items-center justify-center">
                <CardContent className="text-center">
                  <Loader2 className="w-8 h-8 text-purple-400 animate-spin mx-auto mb-4" />
                  <p className="text-gray-400">Carregando estatísticas...</p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
