import { getDb } from "../db";
import { apiBudgetLedger } from "../../drizzle/schema";
import { eq, sql } from "drizzle-orm";

/**
 * Pillar 4 — Circuit Breaker (A Barreira Financeira)
 *
 * Três camadas sobrepostas de defesa antes de uma chamada à API do Claude:
 *
 *   L2a  — CALL RATE LIMIT:  N chamadas / hora
 *   L2b  — BUDGET LIMIT:     $X / hora
 *   L3   — CIRCUIT BREAKER:  trava por 1h se qualquer limite estoura, OU se a API
 *                            retornou 3 erros consecutivos
 *
 * Persiste o contador no banco (api_budget_ledger), então mesmo após reinício
 * do processo Node o limite da hora atual é respeitado.
 *
 * Estados:
 *   CLOSED     — tudo OK, chamadas passam
 *   OPEN       — bloqueio total, retorna erro sem hit ao DB
 *   HALF_OPEN  — cooldown expirou, permite 1 chamada de prova
 */

export type BreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface BreakerConfig {
  hourlyCallLimit: number;
  hourlyCostLimitUsd: number;
  cooldownMs: number;
  consecutiveErrorThreshold: number;
}

export interface BreakerGate {
  ok: boolean;
  reason?: "RATE_EXCEEDED" | "BUDGET_EXCEEDED" | "CIRCUIT_OPEN" | "DB_UNAVAILABLE";
  detail?: string;
  cooldownRemainingMs?: number;
}

export interface BreakerStatus {
  state: BreakerState;
  consecutiveErrors: number;
  openedAt: number | null;
  cooldownRemainingMs: number;
  callsThisHour: number;
  costThisHourUsd: number;
}

const DEFAULT_CONFIG: BreakerConfig = {
  hourlyCallLimit: 500,
  hourlyCostLimitUsd: 2.0,
  cooldownMs: 60 * 60 * 1000, // 1h
  consecutiveErrorThreshold: 3,
};

/**
 * Circuit breaker singleton. Module-level state (simple, process-scoped).
 * If you need multi-process sync, move `state` to Redis or the DB — but the
 * api_budget_ledger already handles the critical counter persistently.
 */
class CircuitBreakerImpl {
  private state: BreakerState = "CLOSED";
  private consecutiveErrors = 0;
  private openedAt: number | null = null;
  private config: BreakerConfig = { ...DEFAULT_CONFIG };

  configure(partial: Partial<BreakerConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  getConfig(): Readonly<BreakerConfig> {
    return this.config;
  }

  /** Zera state do breaker — usado em testes e em comando admin. */
  reset(): void {
    this.state = "CLOSED";
    this.consecutiveErrors = 0;
    this.openedAt = null;
  }

  /** Abre o circuito com motivo. Idempotente. */
  trip(reason: string): void {
    if (this.state === "OPEN") return;
    console.error(`[CircuitBreaker] 🔴 OPEN: ${reason}`);
    this.state = "OPEN";
    this.openedAt = Date.now();
    void this.recordTrip(reason);
  }

  /**
   * Gate antes de cada chamada. Consulta DB para os limites persistidos.
   * Retorna { ok: false, reason } em qualquer falha → caller deve NÃO chamar a API.
   */
  async canCall(): Promise<BreakerGate> {
    const now = Date.now();

    // Estado OPEN → verifica cooldown
    if (this.state === "OPEN") {
      const elapsed = now - (this.openedAt ?? 0);
      if (elapsed < this.config.cooldownMs) {
        return {
          ok: false,
          reason: "CIRCUIT_OPEN",
          detail: `Cooldown ativo por mais ${Math.ceil((this.config.cooldownMs - elapsed) / 60000)}min`,
          cooldownRemainingMs: this.config.cooldownMs - elapsed,
        };
      }
      // Cooldown expirou → HALF_OPEN para testar 1 chamada
      this.state = "HALF_OPEN";
      console.warn("[CircuitBreaker] 🟡 HALF_OPEN — permitindo chamada de prova");
    }

    // Verifica limites persistidos no DB
    const db = await getDb();
    if (!db) {
      return { ok: false, reason: "DB_UNAVAILABLE", detail: "Sem conexão com o banco — bloqueando por segurança" };
    }

    const windowStart = this.currentWindowStart();
    const rows = await db
      .select()
      .from(apiBudgetLedger)
      .where(eq(apiBudgetLedger.windowStart, windowStart))
      .limit(1);

    const calls = rows[0]?.callCount ?? 0;
    const cost = Number(rows[0]?.costUsd ?? 0);

    if (calls >= this.config.hourlyCallLimit) {
      this.trip(`Rate limit ${this.config.hourlyCallLimit}/h excedido (${calls} chamadas na janela)`);
      return { ok: false, reason: "RATE_EXCEEDED", detail: `${calls}/${this.config.hourlyCallLimit}` };
    }
    if (cost >= this.config.hourlyCostLimitUsd) {
      this.trip(`Budget $${this.config.hourlyCostLimitUsd}/h excedido (acumulado $${cost.toFixed(4)})`);
      return { ok: false, reason: "BUDGET_EXCEEDED", detail: `$${cost.toFixed(4)}/$${this.config.hourlyCostLimitUsd}` };
    }

    return { ok: true };
  }

  /**
   * Registra uma chamada bem-sucedida. Atualiza ledger via UPSERT.
   * Recupera o state (fecha circuito se estava HALF_OPEN).
   */
  async recordSuccess(params: { inputTokens: number; outputTokens: number; costUsd: number }): Promise<void> {
    this.consecutiveErrors = 0;
    if (this.state === "HALF_OPEN") {
      console.log("[CircuitBreaker] 🟢 CLOSED — chamada de prova passou, circuito fechado");
      this.state = "CLOSED";
      this.openedAt = null;
    }

    const db = await getDb();
    if (!db) return;

    const windowStart = this.currentWindowStart();
    // UPSERT com ON CONFLICT — single-statement, atômico
    await db.execute(sql`
      INSERT INTO api_budget_ledger (window_start, call_count, input_tokens, output_tokens, cost_usd)
      VALUES (${windowStart.toISOString()}, 1, ${params.inputTokens}, ${params.outputTokens}, ${params.costUsd})
      ON CONFLICT (window_start) DO UPDATE SET
        call_count    = api_budget_ledger.call_count + 1,
        input_tokens  = api_budget_ledger.input_tokens + ${params.inputTokens},
        output_tokens = api_budget_ledger.output_tokens + ${params.outputTokens},
        cost_usd      = api_budget_ledger.cost_usd + ${params.costUsd},
        updated_at    = NOW()
    `);
  }

  /** Registra uma falha. Se 3 consecutivas → abre circuito. */
  recordFailure(error: unknown): void {
    this.consecutiveErrors++;
    if (this.consecutiveErrors >= this.config.consecutiveErrorThreshold) {
      const msg = error instanceof Error ? error.message : String(error);
      this.trip(`${this.consecutiveErrors} falhas consecutivas. Último erro: ${msg}`);
    }
  }

  async getStatus(): Promise<BreakerStatus> {
    const db = await getDb();
    let callsThisHour = 0;
    let costThisHourUsd = 0;
    if (db) {
      const windowStart = this.currentWindowStart();
      const rows = await db
        .select()
        .from(apiBudgetLedger)
        .where(eq(apiBudgetLedger.windowStart, windowStart))
        .limit(1);
      callsThisHour = rows[0]?.callCount ?? 0;
      costThisHourUsd = Number(rows[0]?.costUsd ?? 0);
    }
    const cooldownRemaining =
      this.state === "OPEN" && this.openedAt
        ? Math.max(0, this.config.cooldownMs - (Date.now() - this.openedAt))
        : 0;
    return {
      state: this.state,
      consecutiveErrors: this.consecutiveErrors,
      openedAt: this.openedAt,
      cooldownRemainingMs: cooldownRemaining,
      callsThisHour,
      costThisHourUsd,
    };
  }

  private currentWindowStart(): Date {
    const hour = 60 * 60 * 1000;
    return new Date(Math.floor(Date.now() / hour) * hour);
  }

  private async recordTrip(reason: string): Promise<void> {
    const db = await getDb();
    if (!db) return;
    try {
      const windowStart = this.currentWindowStart();
      await db.execute(sql`
        INSERT INTO api_budget_ledger (window_start, trip_count)
        VALUES (${windowStart.toISOString()}, 1)
        ON CONFLICT (window_start) DO UPDATE SET
          trip_count = api_budget_ledger.trip_count + 1,
          updated_at = NOW()
      `);
    } catch (err) {
      console.warn("[CircuitBreaker] Failed to persist trip:", err);
    }
  }
}

export const CircuitBreaker = new CircuitBreakerImpl();
