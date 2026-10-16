// Phase 4 stub: deck evaluation against a fixed opponent panel.
// Uses mock data until the `deck_evaluations` table and `evaluation.*` tRPC
// procedures exist (see /workspace/mtg/ui_fase4.md). Not routed yet.
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export interface OpponentResult {
  opponentDeckId: string;
  name: string;
  archetype: string;
  n: number;
  wins: number;
}

export interface DeckEvaluation {
  id: number;
  deckSha256: string;
  deckName: string;
  pilot: "forge_ai" | "rl_champion";
  pilotVersion: string;
  panelVersion: string;
  status: "pending" | "running" | "completed" | "failed";
  n: number;
  wins: number;
  avgTurns: number | null;
  perOpponent: OpponentResult[];
}

const MIN_GAMES = 20;

/** Wilson score interval, 95%. */
export function wilson95(wins: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(center - margin) / denom, (center + margin) / denom];
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const MOCK: DeckEvaluation = {
  id: 1,
  deckSha256: "mock",
  deckName: "Mono-Red Aggro (mock)",
  pilot: "forge_ai",
  pilotVersion: "forge-ai",
  panelVersion: "v2-holdout",
  status: "completed",
  n: 60,
  wins: 34,
  avgTurns: 8.2,
  perOpponent: [
    { opponentDeckId: "p1", name: "Azorius Control", archetype: "control", n: 20, wins: 9 },
    { opponentDeckId: "p2", name: "Golgari Midrange", archetype: "midrange", n: 20, wins: 12 },
    { opponentDeckId: "p3", name: "Izzet Tempo", archetype: "tempo", n: 20, wins: 13 },
  ],
};

function WinRateBadge({ wins, n }: { wins: number; n: number }) {
  const [lo, hi] = wilson95(wins, n);
  const wr = n ? wins / n : 0;
  const variant = n < MIN_GAMES ? "secondary" : lo >= 0.5 ? "default" : "destructive";
  return (
    <Badge variant={variant}>
      {pct(wr)} [{pct(lo)}–{pct(hi)}] n={n}
    </Badge>
  );
}

export default function DeckEvaluation() {
  const ev = MOCK;
  return (
    <div className="container mx-auto space-y-4 py-6">
      <Card>
        <CardHeader>
          <CardTitle>{ev.deckName}</CardTitle>
          <CardDescription>
            Piloto {ev.pilot} ({ev.pilotVersion}) · Painel {ev.panelVersion} · {ev.status}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          <WinRateBadge wins={ev.wins} n={ev.n} />
          {ev.avgTurns !== null && <span className="text-sm">Turnos médios: {ev.avgTurns}</span>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Por oponente</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left">
                <th>Oponente</th>
                <th>Arquétipo</th>
                <th>WR (IC95)</th>
              </tr>
            </thead>
            <tbody>
              {ev.perOpponent.map(o => (
                <tr key={o.opponentDeckId}>
                  <td>{o.name}</td>
                  <td>{o.archetype}</td>
                  <td>
                    <WinRateBadge wins={o.wins} n={o.n} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
