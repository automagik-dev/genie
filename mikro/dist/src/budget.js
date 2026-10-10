/**
 * Budget tracking and enforcement for RLM runs.
 *
 * Prevents cost runaway by tracking cumulative spend, tokens, and recursion depth
 * against configurable limits from BudgetConfig.
 */
export class BudgetTracker {
    state;
    limits;
    constructor(limits) {
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
    record(inputTokens, outputTokens, cost) {
        this.state.totalInputTokens += inputTokens;
        this.state.totalOutputTokens += outputTokens;
        this.state.totalCost += cost;
        if (this.limits.maxCost !== null && this.state.totalCost >= this.limits.maxCost) {
            if (!this.state.budgetHit)
                this.state.budgetHit = "max-cost";
            return true;
        }
        const totalTokens = this.state.totalInputTokens + this.state.totalOutputTokens;
        if (this.limits.maxTokens !== null && totalTokens >= this.limits.maxTokens) {
            if (!this.state.budgetHit)
                this.state.budgetHit = "max-tokens";
            return true;
        }
        return false;
    }
    /** Check if running a sub-call at the given depth would exceed max-depth. */
    checkDepth(depth) {
        this.state.currentDepth = depth;
        if (this.limits.maxDepth !== null && depth >= this.limits.maxDepth) {
            if (!this.state.budgetHit)
                this.state.budgetHit = "max-depth";
            return true;
        }
        return false;
    }
    /** Get current budget state (for stats reporting). */
    getState() {
        return { ...this.state };
    }
    /** Check if any budget limit has been exceeded. */
    isExceeded() {
        return this.state.budgetHit !== null;
    }
}
//# sourceMappingURL=budget.js.map