/**
 * Permission hooks — Wish B Group 2.
 *
 * A permission hook runs before a tool call and decides whether the
 * call proceeds, is denied, or is modified. Hooks are composable: the
 * SDK walks the chain in order and the FIRST non-"allow" decision
 * wins. Pure `allow` short-circuits successfully.
 *
 * This module ships the type + composition helpers only. Wiring the
 * chain into the rlm.ts tool-dispatch path happens when `runAgent()`
 * lands (Group 2b / 3). Keeping the contract narrow now means the
 * downstream wire-up is mechanical.
 *
 * Spec: `.genie/wishes/rlmx-sdk-upgrade/WISH.md` L23.
 */
/** Canonical allow decision — pre-frozen to avoid needless allocation. */
export const ALLOW = Object.freeze({ decision: "allow" });
/**
 * Walk the hook chain in order. Returns the first non-allow decision;
 * if every hook allows, returns the shared `ALLOW` sentinel. A `modify`
 * decision rewrites `args` for the remaining hooks — chain authors can
 * intentionally compose redactors by ordering hooks (redact first,
 * policy check second).
 */
export async function runPermissionChain(hooks, ctx) {
    let current = ctx;
    let lastModify = null;
    for (const hook of hooks) {
        const result = await hook(current);
        switch (result.decision) {
            case "allow":
                continue;
            case "deny":
                return result;
            case "modify":
                lastModify = result;
                current = { ...current, args: result.modifiedArgs };
                continue;
        }
    }
    return lastModify ?? ALLOW;
}
/**
 * Compose an ordered chain into a single hook function. Useful when
 * a consumer wants to pass "one hook" at the `runAgent` boundary
 * without caring about the internal composition order.
 */
export function composeHooks(...hooks) {
    return (ctx) => runPermissionChain(hooks, ctx);
}
//# sourceMappingURL=permissions.js.map