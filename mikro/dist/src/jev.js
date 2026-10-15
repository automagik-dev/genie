export class JevExtractionError extends Error {
    code;
    status;
    constructor(code, status) {
        super(`JEV extraction failed (${code}${status === undefined ? "" : `; HTTP ${status}`}).`);
        this.code = code;
        this.status = status;
        this.name = "JevExtractionError";
    }
}
const ABSTAIN = "abstain";
const VERSIONED_MODEL = /^jev-\d+\.\d+\.\d+$/;
const TOLERANCE = 1e-6;
function fail(code) {
    throw new JevExtractionError(code);
}
function record(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        fail("response");
    return value;
}
function text(value) {
    return typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
function probability(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
        fail("response");
    return value;
}
function sameKeys(value, keys) {
    if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
        fail("response");
}
function distribution(value, keys) {
    const input = record(value);
    sameKeys(input, keys);
    const result = Object.create(null);
    let sum = 0;
    for (const key of keys) {
        result[key] = probability(input[key]);
        sum += result[key];
    }
    if (Math.abs(sum - 1) > TOLERANCE)
        fail("response");
    return result;
}
function choiceAnswer(value, keys) {
    const answer = record(value);
    if (answer.type !== "choice" || typeof answer.choice !== "string" || !keys.includes(answer.choice))
        fail("response");
    const probabilities = distribution(answer.probabilities, keys);
    if (keys.some((key) => probabilities[key] > probabilities[answer.choice] + TOLERANCE))
        fail("response");
    return { type: "choice", choice: answer.choice, probabilities, confidence: probability(answer.confidence) };
}
function scoreAnswer(value, criteria) {
    const answer = record(value);
    const keys = criteria.map((_, index) => String(index));
    const legend = record(answer.legend);
    sameKeys(legend, keys);
    if (keys.some((key, index) => legend[key] !== criteria[index]))
        fail("response");
    const probabilities = distribution(answer.probabilities, keys);
    const weighted = keys.reduce((sum, key) => sum + Number(key) * probabilities[key], 0);
    if (answer.type !== "score" || typeof answer.score !== "number" || !Number.isFinite(answer.score)
        || Math.abs(answer.score - weighted) > TOLERANCE)
        fail("response");
    return {
        type: "score", score: answer.score, legend: Object.fromEntries(keys.map((key) => [key, legend[key]])),
        probabilities, confidence: probability(answer.confidence),
    };
}
function tokens(value) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
        fail("response");
    return value;
}
function freezeSnapshot(value) {
    if (value !== null && typeof value === "object") {
        if (Array.isArray(value)) {
            for (const child of value)
                freezeSnapshot(child);
        }
        else {
            for (const key in value) {
                if (Object.hasOwn(value, key))
                    freezeSnapshot(value[key]);
            }
        }
        Object.freeze(value);
    }
    return value;
}
/** Explicit trusted manual caller only: caller must sanitize/redact state and candidate text before calling. */
export async function extractWithJev(request) {
    const signal = request.signal;
    const requestedModel = request.model;
    const alias = requestedModel === "jev-latest" || requestedModel === "jev-preview";
    if (signal?.aborted)
        fail("cancelled");
    let endpoint;
    try {
        endpoint = new URL(request.endpoint);
    }
    catch {
        return fail("request");
    }
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash
        || typeof requestedModel !== "string" || (!alias && !VERSIONED_MODEL.test(requestedModel))
        || !text(request.apiKey) || /[\r\n]/.test(request.apiKey)
        || !Array.isArray(request.candidates) || request.candidates.length < 1 || request.candidates.length > 254)
        fail("request");
    // Copy before awaiting transport so caller mutation cannot change source reattachment.
    const candidates = request.candidates.map(({ id, text: span, source }) => ({ id, text: span, source }));
    const ids = candidates.map(({ id }) => id);
    if (new Set(ids).size !== ids.length || candidates.some(({ id, text: span, source }) => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id) || id === ABSTAIN || !text(span) || !text(source)
        || span.length > 16_000) || candidates.reduce((size, candidate) => size + candidate.text.length, 0) > 128_000)
        fail("request");
    if (!(typeof request.state === "string" || (request.state !== null && typeof request.state === "object")))
        fail("request");
    const criteria = Object.fromEntries(candidates.map(({ id, text: span }) => [id, span]));
    criteria[ABSTAIN] = "None of these candidates is supported by the state, or evidence is insufficient.";
    const questions = {
        selection: { type: "choice", instructions: "Select the candidate best supported by the state. Abstain when none is supported or evidence is insufficient.", criteria },
    };
    if (request.noul) {
        if (!text(request.noul.instructions) || (request.noul.criteria && Object.values(request.noul.criteria).some((value) => !text(value))))
            fail("request");
        questions.noul = { type: "noul", instructions: request.noul.instructions, ...(request.noul.criteria ? { criteria: request.noul.criteria } : {}) };
    }
    const scoreCriteria = request.score ? [...request.score.criteria] : undefined;
    if (request.score) {
        if (!text(request.score.instructions) || !scoreCriteria || scoreCriteria.length < 2 || scoreCriteria.length > 10
            || scoreCriteria.some((value) => !text(value)))
            fail("request");
        questions.score = { type: "score", instructions: request.score.instructions, criteria: scoreCriteria };
    }
    let body;
    let sourceSnapshot;
    try {
        body = JSON.stringify({ state: request.state, model: requestedModel, questions });
        // Parse our serialized envelope so fallback provenance shares the exact wire evaluation.
        const evaluated = JSON.parse(body);
        if (evaluated.state === undefined)
            return fail("request");
        const snapshot = request.sourceSnapshot === undefined
            ? evaluated.state
            : JSON.parse(JSON.stringify(request.sourceSnapshot));
        sourceSnapshot = freezeSnapshot(snapshot);
    }
    catch {
        return fail("request");
    }
    let response;
    try {
        response = await fetch(endpoint, {
            method: "POST", redirect: "error", signal,
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${request.apiKey}` }, body,
        });
    }
    catch {
        return fail(signal?.aborted ? "cancelled" : "transport");
    }
    if (!response.ok)
        throw new JevExtractionError("http", response.status);
    let raw;
    try {
        raw = await response.json();
    }
    catch {
        return fail(signal?.aborted ? "cancelled" : "response");
    }
    if (signal?.aborted)
        fail("cancelled");
    const reply = record(raw);
    if (typeof reply.model !== "string" || !VERSIONED_MODEL.test(reply.model)
        || (!alias && reply.model !== requestedModel))
        fail("response");
    const observed = record(reply.answers);
    sameKeys(observed, Object.keys(questions));
    const answers = { selection: choiceAnswer(observed.selection, [...ids, ABSTAIN]) };
    if (Object.hasOwn(questions, "noul")) {
        const answer = record(observed.noul);
        if (answer.type !== "noul")
            fail("response");
        answers.noul = { type: "noul", noul: probability(answer.noul) };
    }
    if (scoreCriteria)
        answers.score = scoreAnswer(observed.score, scoreCriteria);
    const usage = record(reply.usage);
    const selected = candidates.find(({ id }) => id === answers.selection.choice);
    return {
        model: reply.model, answers, sourceSnapshot,
        usage: { input_tokens: tokens(usage.input_tokens), output_tokens: tokens(usage.output_tokens) },
        selection: selected ? { kind: "selected", candidate: selected } : { kind: "abstained" }, candidates,
    };
}
//# sourceMappingURL=jev.js.map