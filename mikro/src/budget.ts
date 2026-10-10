/**
 * Budget tracking and enforcement for RLM runs.
 *
 * Prevents cost runaway by tracking cumulative spend, tokens, and recursion depth
 * against configurable limits from BudgetConfig.
 */

import type { BudgetConfig } from "./config.js";

export interface BudgetState {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  currentDepth: number;
  budgetHit: string | null; // "max-cost" | "max-tokens" | "max-depth" | null
}

export class BudgetTracker {
  private state: BudgetState;
  private limits: BudgetConfig;

  constructor(limits: BudgetConfig) {
    this.limits = limits;
    this.state = {
      totalCost: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      currentDepth: 0,
      budgetHit: null,
    };
  }

  /** Record tokens and cost from an LLM call. Returns true if budget exceeded. */
  record(inputTokens: number, outputTokens: number, cost: number): boolean {
    this.state.totalInputTokens += inputTokens;
    this.state.totalOutputTokens += outputTokens;
    this.state.totalCost += cost;

    if (this.limits.maxCost !== null && this.state.totalCost >= this.limits.maxCost) {
      if (!this.state.budgetHit) this.state.budgetHit = "max-cost";
      return true;
    }

    const totalTokens = this.state.totalInputTokens + this.state.totalOutputTokens;
    if (this.limits.maxTokens !== null && totalTokens >= this.limits.maxTokens) {
      if (!this.state.budgetHit) this.state.budgetHit = "max-tokens";
      return true;
    }

    return false;
  }

  /** Check if running a sub-call at the given depth would exceed max-depth. */
  checkDepth(depth: number): boolean {
    this.state.currentDepth = depth;
    if (this.limits.maxDepth !== null && depth >= this.limits.maxDepth) {
      if (!this.state.budgetHit) this.state.budgetHit = "max-depth";
      return true;
    }
    return false;
  }

  /** Get current budget state (for stats reporting). */
  getState(): BudgetState {
    return { ...this.state };
  }

  /** Check if any budget limit has been exceeded. */
  isExceeded(): boolean {
    return this.state.budgetHit !== null;
  }
}
