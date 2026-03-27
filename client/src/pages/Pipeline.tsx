import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Loader2, Download, Brain, Wand2, CheckCircle, XCircle, Clock } from "lucide-react";
import { toast } from "sonner";

type PipelineStep = "idle" | "importing" | "training" | "generating" | "done";

export default function Pipeline() {
  const [format, setFormat] = useState<"standard" | "modern" | "commander" | "legacy">("standard");
  const [deckLimit, setDeckLimit] = useState(30);
  const [archetype, setArchetype] = useState("");
  const [step, setStep] = useState<PipelineStep>("idle");
  const [importResult, setImportResult] = useState<any>(null);
  const [trainResult, setTrainResult] = useState<any>(null);
  const [generatedDeck, setGeneratedDeck] = useState<any>(null);

  const moxfieldStats = trpc.moxfield.getStats.useQuery();
  const trainingHistory = trpc.training.getHistory.useQuery();

  const importMutation = trpc.moxfield.importDecks.useMutation({
    onSuccess: (data) => {
      setImportResult(data);
      toast.success(`${data.decksImported} decks importados!`);
    },
    onError: (err) => toast.error(`Erro na importação: ${err.message}`),
  });

  const trainMutation = trpc.training.trainEmbeddings.useMutation({
    onSuccess: (data) => {
      setTrainResult(data);
      trainingHistory.refetch();
      if (data.status === "completed") {
        toast.success(`Treinamento concluído! ${data.embeddingsTrained} embeddings, ${data.synergiesUpdated} sinergias`);
      } else {
        toast.error(`Treinamento falhou: ${data.error}`);
      }
    },
    onError: (err) => toast.error(`Erro no treinamento: ${err.message}`),
  });

  const generateMutation = trpc.generator.generate.useMutation({
    onSuccess: (data) => {
      setGeneratedDeck(data);
      toast.success("Deck gerado com sucesso!");
    },
    onError: (err) => toast.error(`Erro na geração: ${err.message}`),
  });

  const runFullPipeline = async () => {
    setStep("importing");
    setImportResult(null);
    setTrainResult(null);
    setGeneratedDeck(null);

    // 1. Importar decks
    const importData = await importMutation.mutateAsync({ format, limit: deckLimit });
    setImportResult(importData);

    if (importData.decksImported === 0 && importData.decksSkipped === 0) {
      toast.error("Nenhum deck importado. Verifique a conexão.");
      setStep("idle");
      return;
    }

    // 2. Treinar embeddings
    setStep("training");
    const trainData = await trainMutation.mutateAsync();
    setTrainResult(trainData);

    if (trainData.status === "failed") {
      setStep("idle");
      return;
    }

    // 3. Gerar deck
    setStep("generating");
    await generateMutation.mutateAsync({ format, archetype: archetype || undefined });

    setStep("done");
  };

  const exportDeck = () => {
    if (!generatedDeck?.deck) return;
    const text = generatedDeck.deck.map((c: any) => `${c.quantity}x ${c.name}`).join("\n");
    const el = document.createElement("a");
    el.setAttribute("href", `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`);
    el.setAttribute("download", `deck-${format}-${Date.now()}.txt`);
    el.click();
    toast.success("Deck exportado!");
  };

  const isRunning = step === "importing" || step === "training" || step === "generating";

  const stepStatus = (targetStep: PipelineStep) => {
    const order: PipelineStep[] = ["idle", "importing", "training", "generating", "done"];
    const current = order.indexOf(step);
    const target = order.indexOf(targetStep);
    if (current > target) return "done";
    if (current === target) return "running";
    return "pending";
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950 to-slate-900">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-white mb-2">Pipeline Completo</h1>
          <p className="text-gray-400">
            Importar decks do Moxfield → Treinar embeddings → Gerar deck otimizado
          </p>
        </div>

        <div className="grid lg:grid-cols-3 gap-8">
          {/* Config Panel */}
          <div className="lg:col-span-1 space-y-6">
            <Card className="bg-slate-900/50 border-purple-500/30">
              <CardHeader>
                <CardTitle className="text-white">Configuração</CardTitle>
                <CardDescription className="text-gray-400">Parâmetros do pipeline</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <Label className="text-gray-300">Formato</Label>
                  <Select value={format} onValueChange={(v: any) => setFormat(v)}>
                    <SelectTrigger className="bg-slate-800 border-purple-500/30 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-slate-800 border-purple-500/30">
                      <SelectItem value="standard" className="text-white">Standard</SelectItem>
                      <SelectItem value="modern" className="text-white">Modern</SelectItem>
                      <SelectItem value="commander" className="text-white">Commander</SelectItem>
                      <SelectItem value="legacy" className="text-white">Legacy</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label className="text-gray-300">Arquétipo</Label>
                  <Select value={archetype} onValueChange={setArchetype}>
                    <SelectTrigger className="bg-slate-800 border-purple-500/30 text-white">
                      <SelectValue placeholder="Qualquer" />
                    </SelectTrigger>
                    <SelectContent className="bg-slate-800 border-purple-500/30">
                      <SelectItem value="none" className="text-white">Qualquer</SelectItem>
                      {["Aggro", "Control", "Midrange", "Combo", "Burn", "Tempo", "Ramp"].map((a) => (
                        <SelectItem key={a} value={a} className="text-white">{a}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label className="text-gray-300">Decks a importar</Label>
                  <input
                    type="number"
                    min={5}
                    max={100}
                    value={deckLimit}
                    onChange={(e) => setDeckLimit(parseInt(e.target.value))}
                    className="w-full px-3 py-2 bg-slate-800 border border-purple-500/30 text-white rounded"
                  />
                </div>

                <Button
                  onClick={runFullPipeline}
                  disabled={isRunning}
                  className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 font-semibold"
                >
                  {isRunning ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Executando...</>
                  ) : (
                    <><Wand2 className="w-4 h-4 mr-2" />Executar Pipeline</>
                  )}
                </Button>

                <div className="text-xs text-gray-500 text-center">
                  Também pode executar cada etapa individualmente abaixo
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => importMutation.mutate({ format, limit: deckLimit })}
                    disabled={isRunning || importMutation.isPending}
                    className="border-blue-500/30 text-blue-300 hover:bg-blue-500/10 text-xs"
                  >
                    {importMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3 mr-1" />}
                    Só Importar
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => trainMutation.mutate()}
                    disabled={isRunning || trainMutation.isPending}
                    className="border-green-500/30 text-green-300 hover:bg-green-500/10 text-xs"
                  >
                    {trainMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Brain className="w-3 h-3 mr-1" />}
                    Só Treinar
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Moxfield Stats */}
            {moxfieldStats.data && (
              <Card className="bg-slate-900/50 border-purple-500/30">
                <CardHeader>
                  <CardTitle className="text-white text-sm">Decks Competitivos</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-3xl font-bold text-purple-300">{moxfieldStats.data.totalDecks}</p>
                  <div className="space-y-1">
                    {Object.entries(moxfieldStats.data.byFormat).map(([fmt, count]) => (
                      <div key={fmt} className="flex justify-between text-sm">
                        <span className="text-gray-400 capitalize">{fmt}</span>
                        <span className="text-white font-semibold">{count as number}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Results Panel */}
          <div className="lg:col-span-2 space-y-6">
            {/* Pipeline Steps */}
            <Card className="bg-slate-900/50 border-purple-500/30">
              <CardHeader>
                <CardTitle className="text-white">Status do Pipeline</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {[
                    { key: "importing" as PipelineStep, label: "1. Importar Decks do Moxfield", icon: Download },
                    { key: "training" as PipelineStep, label: "2. Treinar Embeddings Word2Vec", icon: Brain },
                    { key: "generating" as PipelineStep, label: "3. Gerar Deck Otimizado", icon: Wand2 },
                  ].map(({ key, label, icon: Icon }) => {
                    const status = stepStatus(key);
                    return (
                      <div key={key} className={`flex items-center gap-4 p-3 rounded-lg border ${
                        status === "done" ? "border-green-500/30 bg-green-900/10" :
                        status === "running" ? "border-purple-500/50 bg-purple-900/20" :
                        "border-slate-700/50 bg-slate-800/20"
                      }`}>
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                          status === "done" ? "bg-green-500/20" :
                          status === "running" ? "bg-purple-500/20" :
                          "bg-slate-700/50"
                        }`}>
                          {status === "done" ? (
                            <CheckCircle className="w-5 h-5 text-green-400" />
                          ) : status === "running" ? (
                            <Loader2 className="w-5 h-5 text-purple-400 animate-spin" />
                          ) : (
                            <Icon className="w-5 h-5 text-gray-500" />
                          )}
                        </div>
                        <span className={`font-medium ${
                          status === "done" ? "text-green-300" :
                          status === "running" ? "text-purple-300" :
                          "text-gray-500"
                        }`}>{label}</span>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            {/* Import Result */}
            {importResult && (
              <Card className="bg-slate-900/50 border-blue-500/30">
                <CardHeader>
                  <CardTitle className="text-blue-300 flex items-center gap-2">
                    <Download className="w-5 h-5" /> Resultado da Importação
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div>
                      <p className="text-2xl font-bold text-green-300">{importResult.decksImported}</p>
                      <p className="text-gray-400 text-sm">Importados</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-yellow-300">{importResult.decksSkipped}</p>
                      <p className="text-gray-400 text-sm">Já existiam</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-purple-300">{importResult.cardsImported}</p>
                      <p className="text-gray-400 text-sm">Cartas</p>
                    </div>
                  </div>
                  {importResult.errors?.length > 0 && (
                    <div className="mt-4 p-3 bg-red-900/20 rounded border border-red-500/30">
                      <p className="text-red-300 text-sm font-semibold mb-1">Erros ({importResult.errors.length}):</p>
                      {importResult.errors.slice(0, 3).map((e: string, i: number) => (
                        <p key={i} className="text-red-200 text-xs">• {e}</p>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Training Result */}
            {trainResult && (
              <Card className={`bg-slate-900/50 ${trainResult.status === "completed" ? "border-green-500/30" : "border-red-500/30"}`}>
                <CardHeader>
                  <CardTitle className={`flex items-center gap-2 ${trainResult.status === "completed" ? "text-green-300" : "text-red-300"}`}>
                    <Brain className="w-5 h-5" />
                    {trainResult.status === "completed" ? "Treinamento Concluído" : "Treinamento Falhou"}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {trainResult.status === "completed" ? (
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div>
                        <p className="text-2xl font-bold text-green-300">{trainResult.embeddingsTrained}</p>
                        <p className="text-gray-400 text-sm">Embeddings</p>
                      </div>
                      <div>
                        <p className="text-2xl font-bold text-blue-300">{trainResult.synergiesUpdated}</p>
                        <p className="text-gray-400 text-sm">Sinergias</p>
                      </div>
                      <div>
                        <p className="text-2xl font-bold text-purple-300">{(trainResult.durationMs / 1000).toFixed(1)}s</p>
                        <p className="text-gray-400 text-sm">Duração</p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-red-200 text-sm">{trainResult.error}</p>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Generated Deck */}
            {generatedDeck && (
              <Card className="bg-slate-900/50 border-purple-500/30">
                <CardHeader className="flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-white flex items-center gap-2">
                      <Wand2 className="w-5 h-5 text-purple-400" />
                      Deck Gerado
                    </CardTitle>
                    <CardDescription className="text-gray-400">
                      {generatedDeck.deck?.reduce((s: number, c: any) => s + c.quantity, 0)} cartas •{" "}
                      {generatedDeck.validation?.isValid ? (
                        <span className="text-green-400">Válido</span>
                      ) : (
                        <span className="text-red-400">Inválido</span>
                      )}
                    </CardDescription>
                  </div>
                  <Button
                    onClick={exportDeck}
                    size="sm"
                    variant="outline"
                    className="border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
                  >
                    <Download className="w-4 h-4 mr-2" />
                    Exportar
                  </Button>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1 max-h-80 overflow-y-auto">
                    {generatedDeck.deck?.map((card: any, idx: number) => (
                      <div key={idx} className="flex justify-between items-center py-1.5 px-3 bg-slate-800/40 rounded hover:bg-slate-800/70 transition-colors">
                        <span className="text-white text-sm">{card.name}</span>
                        <div className="flex items-center gap-3">
                          {card.type && <span className="text-gray-500 text-xs hidden sm:block">{card.type?.split("—")[0].trim()}</span>}
                          <span className="text-purple-300 font-bold text-sm w-6 text-right">{card.quantity}x</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Training History */}
            {trainingHistory.data && trainingHistory.data.length > 0 && (
              <Card className="bg-slate-900/50 border-purple-500/30">
                <CardHeader>
                  <CardTitle className="text-white text-sm flex items-center gap-2">
                    <Clock className="w-4 h-4 text-gray-400" />
                    Histórico de Treinamentos
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {trainingHistory.data.map((job) => (
                      <div key={job.id} className="flex items-center justify-between p-2 bg-slate-800/40 rounded text-sm">
                        <div className="flex items-center gap-2">
                          {job.status === "completed" ? (
                            <CheckCircle className="w-4 h-4 text-green-400" />
                          ) : job.status === "failed" ? (
                            <XCircle className="w-4 h-4 text-red-400" />
                          ) : (
                            <Loader2 className="w-4 h-4 text-yellow-400 animate-spin" />
                          )}
                          <span className="text-gray-300 capitalize">{job.status}</span>
                        </div>
                        <div className="text-right text-gray-400 text-xs">
                          <p>{job.embeddingsTrained} embeddings • {job.synergiesUpdated} sinergias</p>
                          <p>{new Date(job.startedAt).toLocaleString()}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
