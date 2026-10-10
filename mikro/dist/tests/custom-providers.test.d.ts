/**
 * Config-declared providers (src/custom-providers.ts).
 *
 * The bug these guard against: a microagent pinned to a provider pi-ai has
 * never heard of (`wafer/GLM-5.3-Flash`) was advertised by `mikro mcp` and
 * then died on its first call with `Unknown model … Try updating MODEL.md` —
 * a file that does not exist. Everything below is offline: the provider is
 * registered on a real pi-ai runtime and resolved, but nothing is called.
 */
export {};
//# sourceMappingURL=custom-providers.test.d.ts.map