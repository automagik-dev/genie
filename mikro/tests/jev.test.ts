import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { extractWithJev, JevExtractionError, type JevExtractionRequest } from "../src/jev.js";

const KEY = "test-private-key-do-not-echo";

// Deliberately permissive wire fixtures let negative cases send malformed scalar values.
interface ReplyFixture {
  model: unknown;
  answers: {
    selection: { type: unknown; choice: unknown; probabilities: Record<string, unknown>; confidence: unknown };
    noul?: { type: unknown; noul: unknown };
    score?: { type: unknown; score: unknown; legend: Record<string, unknown>; probabilities: Record<string, unknown>; confidence: unknown };
    [key: string]: unknown;
  };
  usage: { input_tokens?: unknown; output_tokens?: unknown };
  [key: string]: unknown;
}

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (endpoint: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}/custom/systemone`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

interface FixtureRequest extends JevExtractionRequest {
  state: { snapshot: string };
  sourceSnapshot: { id: string; content: { text: string } };
  candidates: { id: string; text: string; source: string }[];
}

function request(endpoint: string): FixtureRequest {
  return {
    endpoint, model: "jev-1.13.0", apiKey: KEY,
    state: { snapshot: "Observed write failure at line 12" },
    sourceSnapshot: { id: "local-source-snapshot-only", content: { text: "Observed write failure at line 12" } },
    candidates: [
      { id: "c1", text: "Write failed", source: "snapshot:sha256:abc#L12-L12" },
      { id: "c2", text: "Read failed", source: "snapshot:sha256:abc#L17-L17" },
    ],
  };
}

function reply(): ReplyFixture {
  return {
    model: "jev-1.13.0",
    answers: { selection: { type: "choice", choice: "c1", probabilities: { c1: 0.8, c2: 0.1, abstain: 0.1 }, confidence: 0.7 } },
    usage: { input_tokens: 318, output_tokens: 34 },
  };
}

function safeFailure(code: string, status?: number): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof JevExtractionError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.ok(!String(error).includes(KEY));
    assert.equal(error.cause, undefined, "underlying errors and response bodies must not expose credentials");
    return true;
  };
}

async function body(request: IncomingMessage): Promise<{
  state: unknown; model: unknown;
  questions: Record<string, { type: unknown; criteria: unknown; instructions: unknown }>;
}> {
  let value = "";
  for await (const chunk of request) value += chunk;
  return JSON.parse(value);
}

describe("manual JEV extraction", () => {
  it("makes one explicit POST, preserves typed optional answers and observed usage, and reattaches a local snapshot", async () => {
    let calls = 0;
    let input: FixtureRequest;
    await serve((incoming, response) => {
      calls++;
      void (async () => {
        assert.equal(incoming.method, "POST");
        assert.equal(incoming.url, "/custom/systemone");
        assert.equal(incoming.headers.authorization, `Bearer ${KEY}`);
        const payload = await body(incoming);
        assert.deepEqual(payload.state, { snapshot: "Observed write failure at line 12" });
        assert.equal(payload.model, "jev-1.13.0");
        assert.deepEqual(Object.keys(payload.questions).sort(), ["noul", "score", "selection"]);
        assert.equal(payload.questions.selection.type, "choice");
        assert.deepEqual(payload.questions.selection.criteria, {
          c1: "Write failed", c2: "Read failed",
          abstain: "None of these candidates is supported by the state, or evidence is insufficient.",
        });
        assert.equal(JSON.stringify(payload).includes("snapshot:sha256:abc"), false, "source references stay local");
        assert.equal(JSON.stringify(payload).includes(KEY), false, "key goes only in the header");
        assert.equal(JSON.stringify(payload).includes("local-source-snapshot-only"), false, "local provenance is not transmitted");
        assert.deepEqual(payload.questions.noul, { type: "noul", instructions: "Is this a failure?" });
        assert.deepEqual(payload.questions.score, { type: "score", instructions: "Rate severity", criteria: ["Low", "High"] });
        // Mutation after sending must not rewrite the source that produced the request.
        // The fixture created this mutable object; readonly is only the caller's API view.
        const mutableCandidate = input.candidates[0];
        mutableCandidate.text = "mutated";
        mutableCandidate.source = "mutated";
        input.state.snapshot = "mutated state";
        input.sourceSnapshot.content.text = "mutated snapshot";
        const result = reply();
        result.answers.noul = { type: "noul", noul: 0.95 };
        result.answers.score = { type: "score", score: 0.75, legend: { "0": "Low", "1": "High" }, probabilities: { "0": 0.25, "1": 0.75 }, confidence: 0.5 };
        response.end(JSON.stringify(result));
      })().catch((error) => response.destroy(error));
    }, async (endpoint) => {
      input = request(endpoint);
      input.noul = { instructions: "Is this a failure?" };
      input.score = { instructions: "Rate severity", criteria: ["Low", "High"] };
      const result = await extractWithJev(input);
      assert.equal(result.model, "jev-1.13.0");
      assert.deepEqual(result.usage, { input_tokens: 318, output_tokens: 34 });
      assert.deepEqual(result.selection, { kind: "selected", candidate: { id: "c1", text: "Write failed", source: "snapshot:sha256:abc#L12-L12" } });
      assert.equal(result.candidates[0].text, "Write failed");
      assert.deepEqual(result.sourceSnapshot, {
        id: "local-source-snapshot-only", content: { text: "Observed write failure at line 12" },
      });
      const snapshot = result.sourceSnapshot;
      assert.ok(snapshot !== null && typeof snapshot === "object" && "content" in snapshot);
      const content = snapshot.content;
      assert.ok(content !== null && typeof content === "object" && "text" in content && typeof content.text === "string");
      assert.throws(() => { content.text = "changed receipt"; }, TypeError);
      assert.equal(result.answers.selection.probabilities.c1, 0.8);
      assert.equal(result.answers.selection.confidence, 0.7);
      assert.deepEqual(result.answers.noul, { type: "noul", noul: 0.95 });
      assert.equal(result.answers.score?.score, 0.75);
      assert.deepEqual(result.answers.score?.legend, { "0": "Low", "1": "High" });
    });
    assert.equal(calls, 1);
  });

  it("accepts an explicit documented alias and retains the actual version and evaluated state", async () => {
    await serve((incoming, response) => {
      void body(incoming).then((payload) => {
        if (payload.model !== "jev-latest") {
          response.writeHead(422);
          response.end("{}");
          return;
        }
        const actual = reply();
        actual.model = "jev-1.14.0";
        response.end(JSON.stringify(actual));
      }).catch((error) => response.destroy(error));
    }, async (endpoint) => {
      const input: JevExtractionRequest = request(endpoint);
      input.model = "jev-latest";
      delete input.sourceSnapshot;
      const result = await extractWithJev(input);
      assert.equal(result.model, "jev-1.14.0");
      assert.deepEqual(result.sourceSnapshot, { snapshot: "Observed write failure at line 12" });
      assert.deepEqual(result.selection, {
        kind: "selected", candidate: { id: "c1", text: "Write failed", source: "snapshot:sha256:abc#L12-L12" },
      });
    });
  });

  for (const serialization of ["toJSON", "getter"]) {
    it(`retains the exact transmitted state when ${serialization} is evaluated once`, async () => {
      let evaluations = 0;
      let receivedState: unknown;
      const state = serialization === "toJSON"
        ? { toJSON(key: string) { return { serializedKey: key, evaluation: ++evaluations }; } }
        : { get observation() { return ++evaluations; } };
      await serve((incoming, response) => {
        void body(incoming).then((payload) => {
          receivedState = payload.state;
          response.end(JSON.stringify(reply()));
        }).catch((error) => response.destroy(error));
      }, async (endpoint) => {
        const input: JevExtractionRequest = { ...request(endpoint), state };
        delete input.sourceSnapshot;
        const result = await extractWithJev(input);
        assert.deepEqual(result.sourceSnapshot, receivedState);
        assert.equal(evaluations, 1, "wire and fallback provenance must share one evaluation");
        assert.deepEqual(receivedState, serialization === "toJSON"
          ? { serializedKey: "state", evaluation: 1 }
          : { observation: 1 });
        assert.ok(Object.isFrozen(result.sourceSnapshot));
      });
    });
  }

  it("returns explicit abstention rather than inventing a selected source and sends no unsolicited questions", async () => {
    await serve((incoming, response) => {
      void body(incoming).then((payload) => {
        assert.deepEqual(Object.keys(payload.questions), ["selection"]);
        const result = reply();
        result.answers.selection.choice = "abstain";
        result.answers.selection.probabilities = { c1: 0.1, c2: 0.1, abstain: 0.8 };
        result.usage = { input_tokens: 0, output_tokens: 0 };
        response.end(JSON.stringify(result));
      }).catch((error) => response.destroy(error));
    }, async (endpoint) => {
      const result = await extractWithJev(request(endpoint));
      assert.deepEqual(result.selection, { kind: "abstained" });
      assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0 });
      assert.equal(result.candidates.length, 2);
    });
  });

  const malformed: [string, (value: ReplyFixture) => void][] = [
    ["unknown model", (v) => { v.model = "jev-latest"; }],
    ["missing answer", (v) => { Reflect.deleteProperty(v.answers, "selection"); }],
    ["unsolicited answer", (v) => { v.answers.extra = { type: "noul", noul: 0.5 }; }],
    ["wrong type", (v) => { v.answers.selection.type = "noul"; }],
    ["unknown choice", (v) => { v.answers.selection.choice = "generated-text"; }],
    ["nonmaximum choice", (v) => { v.answers.selection.choice = "c2"; }],
    ["missing option", (v) => { delete v.answers.selection.probabilities.abstain; }],
    ["unknown option", (v) => { v.answers.selection.probabilities.extra = 0; }],
    ["negative probability", (v) => { v.answers.selection.probabilities.c2 = -0.1; }],
    ["probability above one", (v) => { v.answers.selection.probabilities.c1 = 1.1; }],
    ["nonnumeric probability", (v) => { v.answers.selection.probabilities.c1 = "0.8"; }],
    ["unnormalized distribution", (v) => { v.answers.selection.probabilities.c1 = 0.7; }],
    ["invalid confidence", (v) => { v.answers.selection.confidence = 1.2; }],
    ["missing usage", (v) => { Reflect.deleteProperty(v, "usage"); }],
    ["missing output usage", (v) => { delete v.usage.output_tokens; }],
    ["negative usage", (v) => { v.usage.input_tokens = -1; }],
    ["fractional usage", (v) => { v.usage.output_tokens = 1.5; }],
    ["unsafe usage", (v) => { v.usage.input_tokens = Number.MAX_SAFE_INTEGER + 1; }],
  ];
  for (const [name, mutate] of malformed) {
    it(`rejects ${name} without retrying or exposing raw content`, async () => {
      let calls = 0;
      await serve((_incoming, response) => {
        calls++;
        const result = reply();
        mutate(result);
        result.secret = KEY;
        response.end(JSON.stringify(result));
      }, async (endpoint) => {
        await assert.rejects(extractWithJev(request(endpoint)), safeFailure("response"));
      });
      assert.equal(calls, 1);
    });
  }

  it("validates optional Noul and Score against their actual wire schemas", async () => {
    for (const invalid of ["noul", "legend", "score", "distribution", "confidence"]) {
      await serve((_incoming, response) => {
        const result = reply();
        result.answers.noul = { type: "noul", noul: 0.8 };
        result.answers.score = { type: "score", score: 0.75, legend: { "0": "Low", "1": "High" }, probabilities: { "0": 0.25, "1": 0.75 }, confidence: 0.5 };
        if (invalid === "noul") result.answers.noul.noul = -0.1;
        if (invalid === "legend") result.answers.score.legend["1"] = "Invented";
        if (invalid === "score") result.answers.score.score = 0.1;
        if (invalid === "distribution") result.answers.score.probabilities = { "0": 0.5, "2": 0.5 };
        if (invalid === "confidence") result.answers.score.confidence = "0.5";
        response.end(JSON.stringify(result));
      }, async (endpoint) => {
        await assert.rejects(extractWithJev({ ...request(endpoint), noul: { instructions: "Failure?" }, score: { instructions: "Severity?", criteria: ["Low", "High"] } }), safeFailure("response"));
      });
    }
  });

  for (const status of [401, 422, 429, 529]) {
    it(`fails HTTP ${status} once, without returning the server's secret-bearing body`, async () => {
      let calls = 0;
      await serve((_incoming, response) => {
        calls++;
        response.writeHead(status);
        response.end(KEY);
      }, async (endpoint) => {
        await assert.rejects(extractWithJev(request(endpoint)), safeFailure("http", status));
      });
      assert.equal(calls, 1);
    });
  }

  it("does not follow redirects or leak authorization to a different endpoint", async () => {
    let calls = 0;
    await serve((_incoming, response) => {
      calls++;
      response.writeHead(302, { Location: "/other" });
      response.end(KEY);
    }, async (endpoint) => {
      await assert.rejects(extractWithJev(request(endpoint)), safeFailure("transport"));
    });
    assert.equal(calls, 1);
  });

  it("fails explicitly on invalid JSON or unavailable transport", async () => {
    for (const mode of ["json", "socket"]) {
      let calls = 0;
      await serve((_incoming, response) => {
        calls++;
        if (mode === "socket") response.destroy();
        else response.end(`not JSON ${KEY}`);
      }, async (endpoint) => {
        await assert.rejects(extractWithJev(request(endpoint)), safeFailure(mode === "socket" ? "transport" : "response"));
      });
      assert.equal(calls, 1);
    }
  });

  it("cancels before transport and during streamed response consumption without retry", async () => {
    let calls = 0;
    const controller = new AbortController();
    await serve((_incoming, response) => {
      calls++;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"model":');
      controller.abort();
    }, async (endpoint) => {
      const already = new AbortController();
      already.abort();
      await assert.rejects(extractWithJev({ ...request(endpoint), signal: already.signal }), safeFailure("cancelled"));
      assert.equal(calls, 0);
      await assert.rejects(extractWithJev({ ...request(endpoint), signal: controller.signal }), safeFailure("cancelled"));
    });
    assert.equal(calls, 1);
  });

  it("rejects invalid manual configuration and ambiguous or unbounded candidates before any request", async () => {
    let calls = 0;
    await serve((_incoming, response) => { calls++; response.end(JSON.stringify(reply())); }, async (endpoint) => {
      const invalid: Partial<JevExtractionRequest>[] = [
        { endpoint: "" }, { endpoint: "file:///tmp/jev" }, { endpoint: "http://user:secret@localhost/jev" },
        { model: "jev-unknown" }, { apiKey: "" }, { apiKey: `${KEY}\n` }, { state: null },
        { candidates: [] },
        { candidates: [{ id: "abstain", text: "text", source: "source" }] },
        { candidates: [{ id: "not a safe id", text: "text", source: "source" }] },
        { candidates: [{ id: "c1", text: "text\u0000", source: "source" }] },
        { candidates: [{ id: "c1", text: "x".repeat(16_001), source: "source" }] },
        { candidates: [request(endpoint).candidates[0], request(endpoint).candidates[0]] },
        { candidates: Array.from({ length: 255 }, (_, index) => ({ id: `c${index}`, text: "text", source: "source" })) },
        { score: { instructions: "Rate", criteria: ["Only level"] } },
      ];
      const circular: Record<string, unknown> = {}; circular.self = circular;
      invalid.push({ state: circular });
      for (const override of invalid) {
        await assert.rejects(extractWithJev({ ...request(endpoint), ...override }), safeFailure("request"));
      }
    });
    assert.equal(calls, 0);
  });
});
