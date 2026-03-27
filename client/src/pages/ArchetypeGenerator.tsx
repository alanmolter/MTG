import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  Wand2,
  Download,
  Copy,
  AlertTriangle,
  CheckCircle2,
  Swords,
  Zap,
  Shield,
  BarChart3,
} from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";

// ─── Tipos ────────────────────────────────────────────────────────────────────

type ArchetypeName =
  | "aggro"
  | "burn"
  | "control"
  | "combo"
  | "midrange"
  | "ramp"
  | "tempo";
type FormatName =
  | "standard"
  | "historic"
  | "modern"
  | "legacy"
  | "commander"
  | "pioneer";
type ManaColor = "W" | "U" | "B" | "R" | "G";
type Playstyle =
  | "go_wide"
  | "go_tall"
  | "burn_hybrid"
  | "draw_go"
  | "tap_out"
  | "hard_control";
type ColorMode = "strict" | "splash" | "flex";
type PowerLevel = "casual" | "ranked" | "meta";
type Consistency = "high" | "medium" | "greedy";

// ─── Dados de configuração ────────────────────────────────────────────────────

const ARCHETYPES: {
  value: ArchetypeName;
  label: string;
  icon: string;
  description: string;
}[] = [
  {
    value: "aggro",
    label: "Aggro",
    icon: "⚔️",
    description: "Pressão rápida com criaturas de baixo custo",
  },
  {
    value: "burn",
    label: "Burn",
    icon: "🔥",
    description: "Dano direto com instants e sorceries",
  },
  {
    value: "control",
    label: "Control",
    icon: "🛡️",
    description: "Remoção e counterspells para ganhar no late game",
  },
  {
    value: "combo",
    label: "Combo",
    icon: "⚡",
    description: "Monta combinações para vencer em um turno",
  },
  {
    value: "midrange",
    label: "Midrange",
    icon: "⚖️",
    description: "Ameaças eficientes com respostas flexíveis",
  },
  {
    value: "ramp",
    label: "Ramp",
    icon: "🌿",
    description: "Acelera mana para jogar ameaças gigantes",
  },
  {
    value: "tempo",
    label: "Tempo",
    icon: "🌊",
    description: "Ameaças baratas com interação eficiente",
  },
];

const FORMATS: { value: FormatName; label: string }[] = [
  { value: "standard", label: "Standard" },
  { value: "historic", label: "Historic" },
  { value: "pioneer", label: "Pioneer" },
  { value: "modern", label: "Modern" },
  { value: "legacy", label: "Legacy" },
  { value: "commander", label: "Commander" },
];

const PLAYSTYLES: {
  value: Playstyle;
  label: string;
  icon: string;
  description: string;
  archetypes: ArchetypeName[];
}[] = [
  {
    value: "go_wide",
    label: "Go Wide",
    icon: "🐜",
    description: "Many small creatures",
    archetypes: ["aggro", "combo"],
  },
  {
    value: "go_tall",
    label: "Go Tall",
    icon: "🦍",
    description: "Big pumped creatures",
    archetypes: ["aggro", "midrange"],
  },
  {
    value: "burn_hybrid",
    label: "Burn Hybrid",
    icon: "🔥",
    description: "Direct damage + creatures",
    archetypes: ["aggro", "burn"],
  },
  {
    value: "draw_go",
    label: "Draw-Go",
    icon: "📚",
    description: "Pass & react with instants",
    archetypes: ["control", "tempo"],
  },
  {
    value: "tap_out",
    label: "Tap-Out",
    icon: "👐",
    description: "Play big spells on turn",
    archetypes: ["control", "midrange"],
  },
  {
    value: "hard_control",
    label: "Hard Control",
    icon: "🛡️",
    description: "Total lock & inevitability",
    archetypes: ["control"],
  },
];

const COLOR_MODES: {
  value: ColorMode;
  label: string;
  icon: string;
  description: string;
}[] = [
  {
    value: "strict",
    label: "Strict",
    icon: "🎯",
    description: "Apenas cores selecionadas",
  },
  {
    value: "splash",
    label: "Splash",
    icon: "💧",
    description: "1 cor extra leve",
  },
  {
    value: "flex",
    label: "Flex",
    icon: "🔀",
    description: "Engine decide livremente",
  },
];

const POWER_LEVELS: {
  value: PowerLevel;
  label: string;
  icon: string;
  description: string;
}[] = [
  {
    value: "casual",
    label: "Casual",
    icon: "🎲",
    description: "Diversão, cartas mais acessíveis",
  },
  {
    value: "ranked",
    label: "Ranked",
    icon: "🏆",
    description: "Equilibrado, boa performance",
  },
  {
    value: "meta",
    label: "Meta",
    icon: "⚔️",
    description: "Otimizado para competitiva",
  },
];

const CONSISTENCIES: {
  value: Consistency;
  label: string;
  icon: string;
  description: string;
}[] = [
  {
    value: "high",
    label: "High",
    icon: "📗",
    description: "Mais consistente, menos variance",
  },
  { value: "medium", label: "Medium", icon: "📙", description: "Balanceado" },
  {
    value: "greedy",
    label: "Greedy",
    icon: "📕",
    description: "Mais poderoso, mais variance",
  },
];

const MANA_COLORS: {
  value: ManaColor;
  label: string;
  symbol: string;
  bg: string;
  border: string;
  text: string;
}[] = [
  {
    value: "W",
    label: "White",
    symbol: "☀️",
    bg: "bg-yellow-50",
    border: "border-yellow-300",
    text: "text-yellow-800",
  },
  {
    value: "U",
    label: "Blue",
    symbol: "💧",
    bg: "bg-blue-900/40",
    border: "border-blue-400",
    text: "text-blue-300",
  },
  {
    value: "B",
    label: "Black",
    symbol: "💀",
    bg: "bg-gray-800/60",
    border: "border-gray-400",
    text: "text-gray-300",
  },
  {
    value: "R",
    label: "Red",
    symbol: "🔥",
    bg: "bg-red-900/40",
    border: "border-red-400",
    text: "text-red-300",
  },
  {
    value: "G",
    label: "Green",
    symbol: "🌿",
    bg: "bg-green-900/40",
    border: "border-green-400",
    text: "text-green-300",
  },
];

const TRIBES = [
  "Elf",
  "Goblin",
  "Zombie",
  "Human",
  "Dragon",
  "Merfolk",
  "Vampire",
  "Angel",
  "Wizard",
  "Warrior",
  "Soldier",
  "Shaman",
  "Rogue",
  "Cleric",
  "Beast",
];
const CARD_TYPES = [
  "creature",
  "instant",
  "sorcery",
  "enchantment",
  "artifact",
  "planeswalker",
];

// ─── Sub-componentes ──────────────────────────────────────────────────────────

function TemplatePreview({ archetype }: { archetype: ArchetypeName }) {
  const templates: Record<
    ArchetypeName,
    {
      curve: Record<number, number>;
      lands: number;
      creatures: number;
      spells: number;
    }
  > = {
    aggro: {
      curve: { 1: 12, 2: 14, 3: 8, 4: 4 },
      lands: 22,
      creatures: 28,
      spells: 10,
    },
    burn: {
      curve: { 1: 16, 2: 12, 3: 6, 4: 2 },
      lands: 20,
      creatures: 8,
      spells: 32,
    },
    control: {
      curve: { 2: 6, 3: 10, 4: 10, 5: 6 },
      lands: 26,
      creatures: 6,
      spells: 28,
    },
    combo: {
      curve: { 1: 6, 2: 10, 3: 12, 4: 8 },
      lands: 24,
      creatures: 12,
      spells: 24,
    },
    midrange: {
      curve: { 2: 8, 3: 12, 4: 10, 5: 6 },
      lands: 24,
      creatures: 22,
      spells: 14,
    },
    ramp: {
      curve: { 1: 4, 2: 8, 3: 8, 4: 4, 5: 8, 6: 4 },
      lands: 22,
      creatures: 16,
      spells: 22,
    },
    tempo: {
      curve: { 1: 8, 2: 14, 3: 10, 4: 4 },
      lands: 20,
      creatures: 16,
      spells: 24,
    },
  };
  const t = templates[archetype];
  const maxCurve = Math.max(...Object.values(t.curve));
  const cmcs = [1, 2, 3, 4, 5, 6];

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">
        Template do Arquétipo
      </p>
      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <div className="p-2 bg-red-900/20 rounded border border-red-500/20">
          <p className="text-red-300 font-bold text-lg">{t.creatures}</p>
          <p className="text-gray-500">Criaturas</p>
        </div>
        <div className="p-2 bg-blue-900/20 rounded border border-blue-500/20">
          <p className="text-blue-300 font-bold text-lg">{t.spells}</p>
          <p className="text-gray-500">Spells</p>
        </div>
        <div className="p-2 bg-green-900/20 rounded border border-green-500/20">
          <p className="text-green-300 font-bold text-lg">{t.lands}</p>
          <p className="text-gray-500">Terrenos</p>
        </div>
      </div>
      <div className="space-y-1">
        <p className="text-xs text-gray-500">Curva de Mana Ideal</p>
        <div className="flex items-end gap-1 h-12">
          {cmcs.map(cmc => {
            const count = t.curve[cmc] || 0;
            const h = count > 0 ? Math.max(6, (count / maxCurve) * 44) : 4;
            return (
              <div
                key={cmc}
                className="flex-1 flex flex-col items-center gap-0.5"
              >
                <div
                  className="w-full rounded-t bg-gradient-to-t from-purple-600 to-purple-400"
                  style={{ height: `${h}px`, opacity: count > 0 ? 1 : 0.15 }}
                />
                <span className="text-xs text-gray-600">{cmc}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ScoreBar({
  label,
  value,
  color,
  isNormalized = true,
}: {
  label: string;
  value: number;
  color: string;
  isNormalized?: boolean;
}) {
  const pct = isNormalized 
    ? Math.max(0, Math.min(100, value))
    : Math.max(0, Math.min(100, ((value + 30) / 80) * 100));
  
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-gray-400">
        <span>{label}</span>
        <span className={value >= (isNormalized ? 50 : 0) ? "text-green-400" : "text-red-400"}>
          {value.toFixed(1)}{isNormalized ? "%" : ""}
        </span>
      </div>
      <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${color} transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ─── Componente Principal ─────────────────────────────────────────────────────

export default function ArchetypeGenerator() {
  const [, setLocation] = useLocation();

  // Configurações
  const [archetype, setArchetype] = useState<ArchetypeName>("aggro");
  const [format, setFormat] = useState<FormatName>("standard");
  const [playstyle, setPlaystyle] = useState<Playstyle | "">("");
  const [colorMode, setColorMode] = useState<ColorMode>("strict");
  const [powerLevel, setPowerLevel] = useState<PowerLevel>("ranked");
  const [consistency, setConsistency] = useState<Consistency>("medium");
  const [selectedColors, setSelectedColors] = useState<ManaColor[]>(["R"]);
  const [selectedTribes, setSelectedTribes] = useState<string[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const [onlyArena, setOnlyArena] = useState<boolean>(true);
  const [enableBudget, setEnableBudget] = useState<boolean>(false);
  const [maxPrice, setMaxPrice] = useState<number>(50);

  // Resultado
  const [result, setResult] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<"list" | "metrics" | "export">(
    "list"
  );

  // Auto-sugestão inteligente de tribos
  const [suggestedTribes, setSuggestedTribes] = useState<string[]>([]);

  useEffect(() => {
    const suggestions: string[] = [];

    // Aggro + Red → Goblin, Burn
    if (archetype === "aggro" && selectedColors.includes("R")) {
      suggestions.push("Goblin");
    }
    // Aggro + White → Soldier, Human
    if (archetype === "aggro" && selectedColors.includes("W")) {
      suggestions.push("Soldier", "Human");
    }
    // Aggro + Black → Zombie, Vampire
    if (archetype === "aggro" && selectedColors.includes("B")) {
      suggestions.push("Zombie", "Vampire");
    }
    // Aggro + Green → Elf, Beast
    if (archetype === "aggro" && selectedColors.includes("G")) {
      suggestions.push("Elf", "Beast");
    }
    // Aggro + Blue → Merfolk, Wizard
    if (archetype === "aggro" && selectedColors.includes("U")) {
      suggestions.push("Merfolk", "Wizard");
    }

    // Midrange + Green → Elf, Beast
    if (archetype === "midrange" && selectedColors.includes("G")) {
      suggestions.push("Elf", "Beast");
    }
    // Midrange + Black → Zombie, Demon
    if (archetype === "midrange" && selectedColors.includes("B")) {
      suggestions.push("Zombie", "Demon");
    }

    // Control + White → Angel, Cleric
    if (archetype === "control" && selectedColors.includes("W")) {
      suggestions.push("Angel", "Cleric");
    }
    // Control + Blue → Sphinx, Wizard
    if (archetype === "control" && selectedColors.includes("U")) {
      suggestions.push("Sphinx", "Wizard");
    }

    // Ramp + Green (always)
    if (archetype === "ramp" && selectedColors.includes("G")) {
      suggestions.push("Elf");
    }

    // Combo + Red → Goblin
    if (archetype === "combo" && selectedColors.includes("R")) {
      suggestions.push("Goblin");
    }
    // Combo + Blue → Wizard, Merfolk
    if (archetype === "combo" && selectedColors.includes("U")) {
      suggestions.push("Wizard", "Merfolk");
    }

    setSuggestedTribes(suggestions);
  }, [archetype, selectedColors]);

  // Aplicar sugestão automaticamente se nenhuma tribo selecionada
  useEffect(() => {
    if (suggestedTribes.length > 0 && selectedTribes.length === 0) {
      // Não aplicar automaticamente, apenas mostrar as sugestões
    }
  }, [suggestedTribes, selectedTribes]);

  const generateMutation = trpc.generator.generateByArchetype.useMutation({
    onSuccess: data => {
      setResult(data);
      setActiveTab("list");
      if (data.warnings?.length > 0) {
        toast.warning(`Deck gerado com ${data.warnings.length} aviso(s)`);
      } else {
        toast.success(
          `Deck ${archetype} gerado! ${data.deck?.length} tipos de cartas.`
        );
      }
    },
    onError: err => {
      toast.error(`Erro ao gerar deck: ${err.message}`);
    },
  });

  const toggleColor = (color: ManaColor) => {
    setSelectedColors(prev =>
      prev.includes(color) ? prev.filter(c => c !== color) : [...prev, color]
    );
  };

  const toggleTribe = (tribe: string) => {
    setSelectedTribes(prev =>
      prev.includes(tribe) ? prev.filter(t => t !== tribe) : [...prev, tribe]
    );
  };

  const toggleType = (type: string) => {
    setSelectedTypes(prev =>
      prev.includes(type) ? prev.filter(t => t !== type) : [...prev, type]
    );
  };

  // Validação de combinações archetype + tribo
  const getTriboWarning = (
    archetype: ArchetypeName,
    tribes: string[]
  ): string | null => {
    if (tribes.length === 0) return null;

    // Control raramente usa tribos específicas
    if (archetype === "control" && tribes.length > 1) {
      return "Control decks são mais flexíveis. Considere usar menos tribos.";
    }

    // Burn não combina bem com muitas tribos
    if (archetype === "burn" && tribes.length > 0) {
      return "Burn deck usa pouco criaturas. Tribo pode limitar opções.";
    }

    // Ramp funciona melhor com menos tribos (quer acesso a qualquer ramp)
    if (archetype === "ramp" && tribes.length > 1) {
      return "Ramp prefere flexibilidade. Considere reduzir tribos.";
    }

    // Combo funciona melhor com sinergia forte (pode usar tribo se Make loads of tokens)
    if (archetype === "combo" && tribes.length > 1) {
      return "Combo precisa de sinergia. Múltiplas tribos podem diluir a estratégia.";
    }

    return null;
  };

  const triboWarning = getTriboWarning(archetype, selectedTribes);

  const handleGenerate = () => {
    if (triboWarning) {
      toast.warning(triboWarning);
    }
    generateMutation.mutate({
      archetype,
      format,
      colors: selectedColors.length > 0 ? selectedColors : undefined,
      tribes: selectedTribes.length > 0 ? selectedTribes : undefined,
      cardTypes: selectedTypes.length > 0 ? selectedTypes : undefined,
      onlyArena,
      maxPrice: enableBudget ? maxPrice : undefined,
      playstyle: playstyle || undefined,
      colorMode,
      powerLevel,
      consistency,
    });
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copiado para a área de transferência!");
  };

  const downloadText = (text: string, filename: string) => {
    const el = document.createElement("a");
    el.setAttribute(
      "href",
      `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`
    );
    el.setAttribute("download", filename);
    el.click();
  };

  const archetypeInfo = ARCHETYPES.find(a => a.value === archetype)!;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-purple-950 to-slate-900">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold text-white mb-2">
              {archetypeInfo.icon} Gerador por Arquétipo
            </h1>
            <p className="text-gray-400">
              Decks inteligentes com templates, filtros e scoring por mecânica
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => setLocation("/")}
            className="border-purple-500/30 text-purple-300"
          >
            ← Home
          </Button>
        </div>

        <div className="grid lg:grid-cols-3 gap-8">
          {/* ── Painel de Configuração ── */}
          <div className="lg:col-span-1 space-y-4">
            {/* Arquétipo */}
            <Card className="bg-slate-900/50 border-purple-500/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-white text-sm font-semibold uppercase tracking-wide">
                  Arquétipo
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-2">
                {ARCHETYPES.map(a => (
                  <button
                    key={a.value}
                    onClick={() => setArchetype(a.value)}
                    className={`p-3 rounded-lg border text-left transition-all ${
                      archetype === a.value
                        ? "bg-purple-600/30 border-purple-400 text-white"
                        : "bg-slate-800/40 border-slate-700 text-gray-400 hover:border-purple-500/50 hover:text-gray-200"
                    }`}
                  >
                    <div className="text-lg mb-1">{a.icon}</div>
                    <div className="text-xs font-semibold">{a.label}</div>
                  </button>
                ))}
              </CardContent>
            </Card>

            {/* Formato */}
            <Card className="bg-slate-900/50 border-purple-500/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-white text-sm font-semibold uppercase tracking-wide">
                  Formato
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Select
                  value={format}
                  onValueChange={(v: FormatName) => setFormat(v)}
                >
                  <SelectTrigger className="bg-slate-800 border-purple-500/30 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-purple-500/30">
                    {FORMATS.map(f => (
                      <SelectItem
                        key={f.value}
                        value={f.value}
                        className="text-white"
                      >
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <div className="mt-4 flex items-center gap-2 px-1">
                  <input
                    type="checkbox"
                    id="arena-toggle"
                    checked={onlyArena}
                    onChange={e => setOnlyArena(e.target.checked)}
                    className="w-4 h-4 rounded appearance-none border border-slate-600 bg-slate-800/50 checked:bg-purple-600 checked:border-purple-500 cursor-pointer relative after:content-['✓'] after:absolute after:text-white after:text-xs after:w-full after:h-full after:flex after:items-center after:justify-center after:opacity-0 checked:after:opacity-100 transition-colors"
                  />
                  <Label
                    htmlFor="arena-toggle"
                    className="text-sm text-gray-300 font-medium cursor-pointer"
                  >
                    Apenas cartas no MTG Arena
                  </Label>
                </div>

                <div className="mt-4 pt-4 border-t border-purple-500/20">
                  <div className="flex items-center gap-2 px-1 mb-3">
                    <input
                      type="checkbox"
                      id="budget-toggle"
                      checked={enableBudget}
                      onChange={e => setEnableBudget(e.target.checked)}
                      className="w-4 h-4 rounded appearance-none border border-slate-600 bg-slate-800/50 checked:bg-purple-600 checked:border-purple-500 cursor-pointer relative after:content-['✓'] after:absolute after:text-white after:text-xs after:w-full after:h-full after:flex after:items-center after:justify-center after:opacity-0 checked:after:opacity-100 transition-colors"
                    />
                    <Label
                      htmlFor="budget-toggle"
                      className="text-sm text-gray-300 font-medium cursor-pointer"
                    >
                      Limite de Preço (Budget)
                    </Label>
                  </div>
                  {enableBudget && (
                    <div className="px-1 space-y-2">
                      <div className="flex justify-between text-xs text-gray-400">
                        <span>US$ 0</span>
                        <span className="text-purple-300 font-bold">
                          Máx: US$ {maxPrice.toFixed(2)} / carta
                        </span>
                        <span>US$ 100+</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        step="0.5"
                        value={maxPrice}
                        onChange={e => setMaxPrice(parseFloat(e.target.value))}
                        className="w-full accent-purple-500 h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer"
                      />
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Playstyle */}
            <Card className="bg-slate-900/50 border-purple-500/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-white text-sm font-semibold uppercase tracking-wide">
                  Estilo de Jogo (opcional)
                </CardTitle>
                <CardDescription className="text-gray-500 text-xs">
                  Sub-intenção estratégica do deck
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Select
                  value={playstyle}
                  onValueChange={(v: Playstyle | "") => setPlaystyle(v)}
                >
                  <SelectTrigger className="bg-slate-800 border-purple-500/30 text-white">
                    <SelectValue placeholder="Selecione um estilo..." />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-purple-500/30">
                    {PLAYSTYLES.map(p => (
                      <SelectItem
                        key={p.value}
                        value={p.value}
                        className="text-white"
                      >
                        {p.icon} {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {playstyle && (
                  <p className="text-xs text-gray-500 mt-2">
                    {PLAYSTYLES.find(p => p.value === playstyle)?.description}
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Cores */}
            <Card className="bg-slate-900/50 border-purple-500/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-white text-sm font-semibold uppercase tracking-wide">
                  Cores de Mana
                </CardTitle>
                <CardDescription className="text-gray-500 text-xs">
                  Selecione uma ou mais cores
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex gap-2">
                  {MANA_COLORS.map(c => (
                    <button
                      key={c.value}
                      onClick={() => toggleColor(c.value)}
                      title={c.label}
                      className={`flex-1 py-3 rounded-lg border-2 text-xl transition-all ${
                        selectedColors.includes(c.value)
                          ? `${c.bg} ${c.border} scale-105 shadow-lg`
                          : "bg-slate-800/40 border-slate-700 opacity-40 hover:opacity-70"
                      }`}
                    >
                      {c.symbol}
                    </button>
                  ))}
                </div>
                {selectedColors.length > 0 && (
                  <p className="text-xs text-gray-500 mt-2">
                    Selecionado:{" "}
                    {selectedColors
                      .map(c => MANA_COLORS.find(m => m.value === c)?.label)
                      .join(", ")}
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Modo de Cores */}
            <Card className="bg-slate-900/50 border-purple-500/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-white text-sm font-semibold uppercase tracking-wide">
                  Modo de Cores
                </CardTitle>
                <CardDescription className="text-gray-500 text-xs">
                  Como tratar cores secundárias
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-3 gap-2">
                {COLOR_MODES.map(m => (
                  <button
                    key={m.value}
                    onClick={() => setColorMode(m.value)}
                    className={`p-2 rounded-lg border text-center transition-all ${
                      colorMode === m.value
                        ? "bg-purple-600/30 border-purple-400 text-white"
                        : "bg-slate-800/40 border-slate-700 text-gray-400 hover:border-purple-500/50"
                    }`}
                  >
                    <div className="text-lg mb-1">{m.icon}</div>
                    <div className="text-xs font-semibold">{m.label}</div>
                  </button>
                ))}
              </CardContent>
            </Card>

            {/* Power Level */}
            <Card className="bg-slate-900/50 border-purple-500/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-white text-sm font-semibold uppercase tracking-wide">
                  Power Level
                </CardTitle>
                <CardDescription className="text-gray-500 text-xs">
                  Nível de potência do deck
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-3 gap-2">
                {POWER_LEVELS.map(p => (
                  <button
                    key={p.value}
                    onClick={() => setPowerLevel(p.value)}
                    className={`p-2 rounded-lg border text-center transition-all ${
                      powerLevel === p.value
                        ? "bg-purple-600/30 border-purple-400 text-white"
                        : "bg-slate-800/40 border-slate-700 text-gray-400 hover:border-purple-500/50"
                    }`}
                  >
                    <div className="text-lg mb-1">{p.icon}</div>
                    <div className="text-xs font-semibold">{p.label}</div>
                  </button>
                ))}
              </CardContent>
            </Card>

            {/* Consistency */}
            <Card className="bg-slate-900/50 border-purple-500/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-white text-sm font-semibold uppercase tracking-wide">
                  Consistency
                </CardTitle>
                <CardDescription className="text-gray-500 text-xs">
                  Balance entre consistência e poder
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-3 gap-2">
                {CONSISTENCIES.map(c => (
                  <button
                    key={c.value}
                    onClick={() => setConsistency(c.value)}
                    className={`p-2 rounded-lg border text-center transition-all ${
                      consistency === c.value
                        ? "bg-purple-600/30 border-purple-400 text-white"
                        : "bg-slate-800/40 border-slate-700 text-gray-400 hover:border-purple-500/50"
                    }`}
                  >
                    <div className="text-lg mb-1">{c.icon}</div>
                    <div className="text-xs font-semibold">{c.label}</div>
                  </button>
                ))}
              </CardContent>
            </Card>

            {/* Tribos */}
            <Card className="bg-slate-900/50 border-purple-500/30">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-white text-sm font-semibold uppercase tracking-wide">
                    Tribo (opcional)
                  </CardTitle>
                  {triboWarning && (
                    <Badge className="bg-yellow-900/50 text-yellow-300 border-yellow-500/30 text-xs">
                      ⚠️ Aviso
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-1.5">
                  {TRIBES.map(tribe => (
                    <button
                      key={tribe}
                      onClick={() => toggleTribe(tribe)}
                      className={`px-2 py-1 rounded text-xs border transition-all ${
                        selectedTribes.includes(tribe)
                          ? "bg-amber-900/40 border-amber-500/60 text-amber-300"
                          : suggestedTribes.includes(tribe)
                            ? "bg-amber-900/20 border-amber-500/30 text-amber-400 hover:bg-amber-900/30"
                            : "bg-slate-800/40 border-slate-700 text-gray-500 hover:border-amber-500/30 hover:text-gray-300"
                      }`}
                    >
                      {tribe}
                    </button>
                  ))}
                </div>
                {suggestedTribes.length > 0 && selectedTribes.length === 0 && (
                  <p className="text-xs text-amber-400 mt-2 flex items-center gap-1">
                    💡 Sugestão: {suggestedTribes.join(", ")}
                  </p>
                )}
                {triboWarning && (
                  <p className="text-xs text-yellow-400 mt-2 flex items-center gap-1">
                    ⚠️ {triboWarning}
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Tipos de carta */}
            <Card className="bg-slate-900/50 border-purple-500/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-white text-sm font-semibold uppercase tracking-wide">
                  Tipos de Carta (opcional)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-1.5">
                  {CARD_TYPES.map(type => (
                    <button
                      key={type}
                      onClick={() => toggleType(type)}
                      className={`px-2 py-1 rounded text-xs border capitalize transition-all ${
                        selectedTypes.includes(type)
                          ? "bg-cyan-900/40 border-cyan-500/60 text-cyan-300"
                          : "bg-slate-800/40 border-slate-700 text-gray-500 hover:border-cyan-500/30 hover:text-gray-300"
                      }`}
                    >
                      {type}
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Template Preview */}
            <Card className="bg-slate-900/50 border-purple-500/30">
              <CardContent className="pt-4">
                <TemplatePreview archetype={archetype} />
              </CardContent>
            </Card>

            {/* Botão Gerar */}
            <Button
              onClick={handleGenerate}
              disabled={generateMutation.isPending}
              className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 py-6 text-lg"
            >
              {generateMutation.isPending ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  Gerando deck {archetypeInfo.label}...
                </>
              ) : (
                <>
                  <Wand2 className="w-5 h-5 mr-2" />
                  Gerar Deck {archetypeInfo.icon}
                </>
              )}
            </Button>
          </div>

          {/* ── Painel de Resultado ── */}
          <div className="lg:col-span-2">
            {!result && !generateMutation.isPending && (
              <Card className="bg-slate-900/50 border-purple-500/30 h-96 flex items-center justify-center">
                <CardContent className="text-center">
                  <div className="text-6xl mb-4">{archetypeInfo.icon}</div>
                  <p className="text-gray-400 text-lg font-medium">
                    {archetypeInfo.label}
                  </p>
                  <p className="text-gray-600 text-sm mt-2">
                    {archetypeInfo.description}
                  </p>
                  <p className="text-gray-700 text-xs mt-4">
                    Configure os filtros e clique em Gerar Deck
                  </p>
                </CardContent>
              </Card>
            )}

            {generateMutation.isPending && (
              <Card className="bg-slate-900/50 border-purple-500/30 h-96 flex items-center justify-center">
                <CardContent className="text-center">
                  <Loader2 className="w-12 h-12 text-purple-400 animate-spin mx-auto mb-4" />
                  <p className="text-gray-400">
                    Selecionando cartas do pool...
                  </p>
                  <p className="text-gray-600 text-sm mt-2">
                    Aplicando template {archetypeInfo.label} + scoring
                  </p>
                </CardContent>
              </Card>
            )}

            {result && !generateMutation.isPending && (
              <div className="space-y-4">
                {/* Avisos */}
                {result.warnings?.length > 0 && (
                  <Card className="bg-yellow-900/20 border-yellow-500/30">
                    <CardContent className="py-3 px-4">
                      {result.warnings.map((w: string, i: number) => (
                        <p
                          key={i}
                          className="text-yellow-300 text-sm flex items-start gap-2"
                        >
                          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                          {w}
                        </p>
                      ))}
                    </CardContent>
                  </Card>
                )}

                {/* Validação */}
                {result.validation && (
                  <Card
                    className={`border-l-4 ${result.validation.isValid ? "bg-green-900/20 border-l-green-500 border-green-500/30" : "bg-red-900/20 border-l-red-500 border-red-500/30"}`}
                  >
                    <CardContent className="py-3 px-4 flex items-center gap-2">
                      {result.validation.isValid ? (
                        <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                      )}
                      <p
                        className={`text-sm font-medium ${result.validation.isValid ? "text-green-300" : "text-red-300"}`}
                      >
                        {result.validation.isValid
                          ? "Deck válido"
                          : "Deck inválido"}
                        {result.validation.errors?.map(
                          (e: string, i: number) => (
                            <span
                              key={i}
                              className="block text-xs font-normal mt-0.5"
                            >
                              • {e}
                            </span>
                          )
                        )}
                      </p>
                    </CardContent>
                  </Card>
                )}

                {/* Abas */}
                <Card className="bg-slate-900/50 border-purple-500/30">
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="text-white">
                          {archetypeInfo.icon} Deck {archetypeInfo.label} —{" "}
                          {format.charAt(0).toUpperCase() + format.slice(1)}
                        </CardTitle>
                        <CardDescription className="text-gray-400">
                          {result.deck?.reduce(
                            (s: number, c: any) => s + c.quantity,
                            0
                          )}{" "}
                          cartas
                          {result.poolSize > 0 &&
                            ` · Pool: ${result.poolSize} cartas`}
                        </CardDescription>
                      </div>
                      <div className="flex gap-1">
                        {(["list", "metrics", "export"] as const).map(tab => (
                          <button
                            key={tab}
                            onClick={() => setActiveTab(tab)}
                            className={`px-3 py-1.5 rounded text-xs font-medium transition-all capitalize ${
                              activeTab === tab
                                ? "bg-purple-600 text-white"
                                : "text-gray-400 hover:text-gray-200"
                            }`}
                          >
                            {tab === "list"
                              ? "Lista"
                              : tab === "metrics"
                                ? "Métricas"
                                : "Exportar"}
                          </button>
                        ))}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {/* Tab: Lista */}
                    {activeTab === "list" && (
                      <div className="max-h-[600px] overflow-y-auto space-y-4 pr-1">
                        {(["land", "creature", "spell"] as const).map(role => {
                          const cards =
                            result.deck?.filter((c: any) => c.role === role) ||
                            [];
                          if (cards.length === 0) return null;
                          const roleLabels = {
                            land: "🌍 Terrenos",
                            creature: "⚔️ Criaturas",
                            spell: "✨ Spells",
                          };
                          const roleColors = {
                            land: "text-green-400",
                            creature: "text-red-400",
                            spell: "text-blue-400",
                          };
                          return (
                            <div key={role}>
                              <p
                                className={`text-xs font-semibold uppercase tracking-wide mb-2 ${roleColors[role]}`}
                              >
                                {roleLabels[role]} (
                                {cards.reduce(
                                  (s: number, c: any) => s + c.quantity,
                                  0
                                )}
                                )
                              </p>
                              <div className="space-y-1">
                                {cards.map((card: any, idx: number) => (
                                  <div
                                    key={idx}
                                    className="flex items-center justify-between px-3 py-2 bg-slate-800/40 rounded border border-purple-500/10 hover:border-purple-500/30 transition-colors"
                                  >
                                    <div className="flex-1 min-w-0">
                                      <p className="text-white text-sm font-medium truncate">
                                        {card.name}
                                      </p>
                                      <p className="text-gray-500 text-xs truncate">
                                        {card.type}
                                      </p>
                                    </div>
                                    <div className="flex items-center gap-3 ml-3 shrink-0">
                                      {card.cmc != null && (
                                        <span className="text-gray-500 text-xs">
                                          CMC {card.cmc}
                                        </span>
                                      )}
                                      {card.colors &&
                                        card.colors.length > 0 && (
                                          <span className="text-gray-500 text-xs">
                                            {card.colors}
                                          </span>
                                        )}
                                      <span className="text-purple-300 font-bold text-sm w-6 text-right">
                                        {card.quantity}×
                                      </span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Tab: Métricas */}
                    {activeTab === "metrics" && result.metrics && (
                      <div className="space-y-6">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div className="p-4 bg-slate-800/50 rounded-lg border border-purple-500/20 text-center flex flex-col justify-center">
                            <p className="text-xs text-gray-400 mb-1">
                              Deck Score (Normalizado)
                            </p>
                            <p
                              className={`text-6xl font-black ${result.metrics.normalizedScore >= 70 ? "text-green-400" : result.metrics.normalizedScore >= 50 ? "text-yellow-400" : "text-red-400"}`}
                            >
                              {result.metrics.normalizedScore?.toFixed(0)}
                              <span className="text-2xl font-normal text-gray-600">
                                /100
                              </span>
                            </p>
                          </div>
                          <div className="p-4 bg-slate-800/50 rounded-lg border border-purple-500/20 text-center">
                            <p className="text-xs text-gray-400 mb-1">
                              Qualidade (Tier)
                            </p>
                            <div className="relative inline-block mt-2">
                              <div
                                className={`text-7xl font-black italic tracking-tighter ${
                                  result.metrics.tier === "S"
                                    ? "text-yellow-400 drop-shadow-[0_0_15px_rgba(250,204,21,0.5)]"
                                    : result.metrics.tier === "A"
                                      ? "text-purple-400"
                                      : result.metrics.tier === "B"
                                        ? "text-blue-400"
                                        : result.metrics.tier === "C"
                                          ? "text-green-400"
                                          : "text-gray-500"
                                }`}
                              >
                                {result.metrics.tier}
                              </div>
                              <Badge className="absolute -top-1 -right-4 bg-purple-600 border-none scale-75 animate-pulse">
                                NEW BRAIN
                              </Badge>
                            </div>
                          </div>
                        </div>

                        {/* Análise Estrutural do Brain */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <p className="text-xs text-gray-400 font-medium uppercase tracking-wide flex items-center gap-2">
                              <CheckCircle2 className="w-3 h-3 text-green-400" />{" "}
                              Pontos Fortes
                            </p>
                            <div className="space-y-1">
                              {result.metrics.analysis?.strengths?.map(
                                (s: string, i: number) => (
                                  <div
                                    key={i}
                                    className="px-3 py-1.5 bg-green-900/10 border border-green-500/20 rounded text-xs text-green-300"
                                  >
                                    ✓ {s}
                                  </div>
                                )
                              ) || (
                                <p className="text-xs text-gray-600 italic">
                                  Nenhum ponto forte identificado.
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="space-y-2">
                            <p className="text-xs text-gray-400 font-medium uppercase tracking-wide flex items-center gap-2">
                              <AlertTriangle className="w-3 h-3 text-red-400" />{" "}
                              Pontos Fracos
                            </p>
                            <div className="space-y-1">
                              {result.metrics.analysis?.weaknesses?.map(
                                (w: string, i: number) => (
                                  <div
                                    key={i}
                                    className="px-3 py-1.5 bg-red-900/10 border border-red-500/20 rounded text-xs text-red-300"
                                  >
                                    ⚠ {w}
                                  </div>
                                )
                              ) || (
                                <p className="text-xs text-green-600/50 italic">
                                  Nenhuma fraqueza estrutural óbvia.
                                </p>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Recomendações */}
                        {result.metrics.recommendations?.length > 0 && (
                          <div className="space-y-2">
                            <p className="text-xs text-gray-400 font-medium uppercase tracking-wide flex items-center gap-2">
                              <Wand2 className="w-3 h-3 text-purple-400" />{" "}
                              Recomendações Cérebro
                            </p>
                            <div className="p-3 bg-purple-900/10 border border-purple-500/20 rounded-lg space-y-2 text-xs text-purple-200">
                              {result.metrics.recommendations.map(
                                (rec: string, i: number) => (
                                  <p key={i} className="flex gap-2">
                                    <span className="text-purple-500">•</span>
                                    {rec}
                                  </p>
                                )
                              )}
                            </div>
                          </div>
                        )}

                        <div className="space-y-3">
                          <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">
                            Breakdown do Score (0-100%)
                          </p>
                          <ScoreBar
                            label="Curva de Mana"
                            value={result.metrics.breakdown?.curve ?? 0}
                            color="bg-purple-500"
                          />
                          <ScoreBar
                            label="Proporção de Terrenos"
                            value={result.metrics.breakdown?.lands ?? 0}
                            color="bg-blue-500"
                          />
                          <ScoreBar
                            label="Sinergia por Mecânica"
                            value={result.metrics.breakdown?.synergy ?? 0}
                            color="bg-green-500"
                          />
                          <ScoreBar
                            label="Simulação de Turnos"
                            value={result.metrics.breakdown?.simulation ?? 0}
                            color="bg-yellow-500"
                          />
                          <ScoreBar
                            label="Consistência"
                            value={result.metrics.breakdown?.consistency ?? 0}
                            color="bg-cyan-500"
                          />
                          <ScoreBar
                            label="Velocidade"
                            value={result.metrics.breakdown?.speed ?? 0}
                            color="bg-orange-500"
                          />
                          <ScoreBar
                            label="Complexidade"
                            value={result.metrics.breakdown?.complexity ?? 0}
                            color="bg-pink-500"
                          />
                          <ScoreBar
                            label="Estrutura"
                            value={result.metrics.breakdown?.structure ?? 0}
                            color="bg-teal-500"
                          />
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div className="p-2 bg-red-900/20 rounded border border-red-500/20">
                            <Swords className="w-4 h-4 text-red-400 mx-auto mb-1" />
                            <p className="text-white font-bold">
                              {result.metrics.creatureCount}
                            </p>
                            <p className="text-gray-500 text-xs">Criaturas</p>
                          </div>
                          <div className="p-2 bg-blue-900/20 rounded border border-blue-500/20">
                            <Zap className="w-4 h-4 text-yellow-400 mx-auto mb-1" />
                            <p className="text-white font-bold">
                              {result.metrics.spellCount}
                            </p>
                            <p className="text-gray-500 text-xs">Spells</p>
                          </div>
                          <div className="p-2 bg-green-900/20 rounded border border-green-500/20">
                            <Shield className="w-4 h-4 text-green-400 mx-auto mb-1" />
                            <p className="text-white font-bold">
                              {result.metrics.landCount}
                            </p>
                            <p className="text-gray-500 text-xs">Terrenos</p>
                          </div>
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div className="p-2 bg-cyan-900/20 rounded border border-cyan-500/20">
                            <p className="text-cyan-300 font-bold text-lg">
                              {result.metrics.avgWinTurn?.toFixed(1) ?? "-"}
                            </p>
                            <p className="text-gray-500 text-xs">
                              Turno Vitória
                            </p>
                          </div>
                          <div className="p-2 bg-purple-900/20 rounded border border-purple-500/20">
                            <p className="text-purple-300 font-bold text-lg">
                              {result.metrics.consistencyScore?.toFixed(1) ??
                                "-"}
                            </p>
                            <p className="text-gray-500 text-xs">
                              Consistência
                            </p>
                          </div>
                          <div className="p-2 bg-pink-900/20 rounded border border-pink-500/20">
                            <p className="text-pink-300 font-bold text-lg">
                              {result.metrics.comboComplexity?.toFixed(1) ??
                                "-"}
                            </p>
                            <p className="text-gray-500 text-xs">
                              Complexidade
                            </p>
                          </div>
                        </div>
                        {result.metrics.mechanicTagCounts &&
                          Object.keys(result.metrics.mechanicTagCounts).length >
                            0 && (
                            <div className="space-y-2">
                              <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">
                                Tags Mecânicas
                              </p>
                              <div className="flex flex-wrap gap-1.5">
                                {Object.entries(
                                  result.metrics.mechanicTagCounts
                                )
                                  .sort(
                                    ([, a], [, b]) =>
                                      (b as number) - (a as number)
                                  )
                                  .map(([tag, count]) => (
                                    <Badge
                                      key={tag}
                                      className="bg-slate-800 text-gray-300 border-slate-600 text-xs"
                                    >
                                      {tag} ×{count as number}
                                    </Badge>
                                  ))}
                              </div>
                            </div>
                          )}

                        {/* Structure Warnings */}
                        {result.metrics.structureWarnings &&
                          result.metrics.structureWarnings.length > 0 && (
                            <div className="space-y-2">
                              <p className="text-xs text-gray-400 font-medium uppercase tracking-wide">
                                Avisos Estruturais
                              </p>
                              <div className="flex flex-col gap-1">
                                {result.metrics.structureWarnings.map(
                                  (w: string, i: number) => (
                                    <div
                                      key={i}
                                      className="px-2 py-1 bg-red-900/20 border border-red-500/30 rounded text-xs text-red-300"
                                    >
                                      ⚠️ {w}
                                    </div>
                                  )
                                )}
                              </div>
                            </div>
                          )}
                      </div>
                    )}

                    {/* Tab: Exportar */}
                    {activeTab === "export" && (
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-medium text-gray-300">
                              Formato Arena
                            </p>
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  copyToClipboard(result.exportArena || "")
                                }
                                className="border-blue-500/30 text-blue-300 hover:bg-blue-500/10"
                              >
                                <Copy className="w-3 h-3 mr-1" /> Copiar
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  downloadText(
                                    result.exportArena || "",
                                    `deck-arena-${archetype}.txt`
                                  )
                                }
                                className="border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
                              >
                                <Download className="w-3 h-3 mr-1" /> .txt
                              </Button>
                            </div>
                          </div>
                          <pre className="bg-slate-800/60 rounded p-3 text-xs text-gray-300 max-h-48 overflow-y-auto font-mono whitespace-pre-wrap">
                            {result.exportArena}
                          </pre>
                        </div>
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <p className="text-sm font-medium text-gray-300">
                              Formato Texto (com seções)
                            </p>
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  copyToClipboard(result.exportText || "")
                                }
                                className="border-blue-500/30 text-blue-300 hover:bg-blue-500/10"
                              >
                                <Copy className="w-3 h-3 mr-1" /> Copiar
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  downloadText(
                                    result.exportText || "",
                                    `deck-${archetype}-${format}.txt`
                                  )
                                }
                                className="border-purple-500/30 text-purple-300 hover:bg-purple-500/10"
                              >
                                <Download className="w-3 h-3 mr-1" /> .txt
                              </Button>
                            </div>
                          </div>
                          <pre className="bg-slate-800/60 rounded p-3 text-xs text-gray-300 max-h-48 overflow-y-auto font-mono whitespace-pre-wrap">
                            {result.exportText}
                          </pre>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
