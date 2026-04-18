/**
 * Thin wrapper sobre a Anthropic Messages API.
 *
 * Sem SDK oficial para evitar mais uma dependência pesada — usa fetch() direto.
 * O teu uso é simples (um modelo, batch semanal de cartas), então não ganhamos
 * muito com o SDK.
 *
 * Pricing table: atualizar quando o Haiku mudar. É consultado em um único
 * lugar, `priceOf()`, então manutenção é baixa.
 *
 * IMPORTANTE: este módulo NÃO verifica o circuit breaker sozinho — quem chama
 * é o ragCache.ts, que gate-keepa via CircuitBreaker.canCall().
 */

export interface HaikuResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  costUsd: number;
}

export interface HaikuCallParams {
  prompt: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  model?: string;
}

/**
 * Tabela de preços em USD por 1M tokens. Ajustar se a Anthropic mudar.
 * Fonte: https://www.anthropic.com/pricing (modelos de texto).
 */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5":         { input: 0.80, output: 4.00 },
  "claude-haiku-4":           { input: 0.25, output: 1.25 },
  "claude-3-5-haiku-20241022":{ input: 0.80, output: 4.00 },
  "claude-3-haiku-20240307":  { input: 0.25, output: 1.25 },
  "claude-sonnet-4-5":        { input: 3.00, output: 15.00 },
  "claude-sonnet-4-6":        { input: 3.00, output: 15.00 },
  "claude-opus-4-7":          { input: 15.00, output: 75.00 },
};

export function priceOf(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING[model] ?? PRICING["claude-haiku-4-5"];
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5";
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export async function callHaiku(params: HaikuCallParams): Promise<HaikuResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY não configurada no .env");
  }

  const model = params.model ?? DEFAULT_MODEL;
  const body: Record<string, unknown> = {
    model,
    max_tokens: params.maxTokens ?? 1024,
    temperature: params.temperature ?? 0.2,
    messages: [{ role: "user", content: params.prompt }],
  };
  if (params.system) body.system = params.system;

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": API_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "(no body)");
    throw new Error(`Anthropic API ${response.status}: ${errorText.slice(0, 500)}`);
  }

  const json: any = await response.json();

  const textBlocks = (json.content ?? []).filter((b: any) => b.type === "text");
  const text = textBlocks.map((b: any) => b.text).join("\n");
  const inputTokens = json.usage?.input_tokens ?? 0;
  const outputTokens = json.usage?.output_tokens ?? 0;
  const costUsd = priceOf(model, inputTokens, outputTokens);

  return { text, inputTokens, outputTokens, model, costUsd };
}
