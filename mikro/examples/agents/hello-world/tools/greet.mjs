/**
 * tools/greet.mjs — the minimum-viable mikro tool.
 *
 * Demonstrates the default-export-is-an-async-function contract the
 * SDK's plugin loader resolves. Runs in-process (no subprocess), so
 * the only dependency is the function signature.
 */

export default async function greet(args, ctx) {
	if (ctx.signal.aborted) {
		throw new Error("greet: aborted");
	}
	const name =
		typeof args === "object" && args !== null && typeof args.name === "string"
			? args.name.trim() || "stranger"
			: "stranger";
	return { greeting: `Hello, ${name}!` };
}
