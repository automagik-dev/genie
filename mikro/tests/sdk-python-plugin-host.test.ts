import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

it("Python stdin failures preserve the Node host and settle repeated calls", () => {
	const result = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/python-plugin-host.js", import.meta.url))], {
		encoding: "utf8",
		timeout: 45_000,
	});
	assert.ifError(result.error);
	assert.equal(result.signal, null, result.stderr);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /host survived 3 failures and 3 successful calls/);
	assert.match(result.stdout, /no abort listeners retained/);
});
