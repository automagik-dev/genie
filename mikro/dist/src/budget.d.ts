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
    budgetHit: string | null;
}
export declare class BudgetTracker {
    private state;
    private limits;
    constructor(limits: BudgetConfig);
    /** Record tokens and cost from an LLM call. Returns true if budget exceeded. */
    record(inputTokens: number, outputTokens: number, cost: number): boolean;
    /** Check if running a sub-call at the given depth would exceed max-depth. */
    checkDepth(depth: number): boolean;
    /** Get current budget state (for stats reporting). */
    getState(): BudgetState;
    /** Check if any budget limit has been exceeded. */
    isExceeded(): boolean;
}
//# sourceMappingURL=budget.d.ts.map