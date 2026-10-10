/**
 * tools/fetch-url.mjs — HTTP GET + basic HTML→text extraction.
 *
 * Demonstrates:
 *   - Tool that touches the outside world (network). The consumer
 *     should pair this with a permission hook that blocks internal
 *     hosts — see the example below + the smoke test.
 *   - Abort-at-boundaries via ctx.signal.
 *   - Structured return shape for downstream validate/citations.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

export default async function fetchUrl(args, ctx) {
	if (!args || typeof args !== "object") {
		throw new TypeError("fetch-url: args must be an object");
	}
	const url = typeof args.url === "string" ? args.url : null;
	if (!url) {
		throw new TypeError("fetch-url: args.url must be a string");
	}

	const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : DEFAULT_TIMEOUT_MS;
	const timer = AbortSignal.timeout(timeoutMs);
	// Compose caller's abort with the tool-level timeout so whichever
	// fires first cancels the fetch.
	const signal = AbortSignal.any([ctx.signal, timer]);

	let res;
	try {
		res = await fetch(url, { signal });
	} catch (err) {
		throw new Error(`fetch-url: request failed — ${err.message}`);
	}

	const contentType = res.headers.get("content-type") ?? "";
	const body = await res.text();
	const text = contentType.includes("text/html")
		? stripHtml(body)
		: body;

	return {
		url: res.url,
		status: res.status,
		text: text.slice(0, 8_000), // keep payloads bounded
	};
}

function stripHtml(html) {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
