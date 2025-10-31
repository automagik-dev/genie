const assert = require('assert');
const {
  sleep,
  retryWithBackoff,
  withTimeout,
  runSequential,
  TimeoutError
} = require('../.genie/cli/dist/lib/async.js');

// Test: retryWithBackoff succeeds on first attempt
(async function testRetryWithBackoffSuccessImmediate() {
  let attempts = 0;
  const result = await retryWithBackoff(() => {
    attempts += 1;
    return Promise.resolve('ok');
  }, 3, 5);

  assert.strictEqual(result, 'ok', 'should resolve with expected value');
  assert.strictEqual(attempts, 1, 'should invoke factory exactly once on immediate success');
})();

// Test: retryWithBackoff succeeds after initial failures
(async function testRetryWithBackoffSucceedsAfterFailures() {
  let attempts = 0;
  const result = await retryWithBackoff(() => {
    attempts += 1;
    if (attempts < 3) {
      return Promise.reject(new Error(`Transient failure ${attempts}`));
    }
    return Promise.resolve('eventual-success');
  }, 4, 5);

  assert.strictEqual(result, 'eventual-success', 'should resolve after retrying failures');
  assert.strictEqual(attempts, 3, 'should attempt until success is reached');
})();

// Test: retryWithBackoff fails after exhausting attempts
(async function testRetryWithBackoffFailsAfterMaxAttempts() {
  let attempts = 0;
  const expectedError = new Error('permanent failure');
  try {
    await retryWithBackoff(() => {
      attempts += 1;
      return Promise.reject(expectedError);
    }, 3, 5);
    assert.fail('retryWithBackoff should throw after max attempts');
  } catch (error) {
    assert.strictEqual(error, expectedError, 'should throw the last encountered error');
    assert.strictEqual(attempts, 3, 'should attempt exactly maxAttempts times');
  }
})();

// Test: withTimeout resolves before deadline
(async function testWithTimeoutResolvesBeforeDeadline() {
  const value = await withTimeout(
    (async () => {
      await sleep(10);
      return 'done';
    })(),
    50
  );

  assert.strictEqual(value, 'done', 'should resolve with underlying promise value');
})();

// Test: withTimeout rejects using default TimeoutError
(async function testWithTimeoutRejectsDefaultError() {
  try {
    await withTimeout(new Promise(() => {}), 25);
    assert.fail('withTimeout should reject when duration elapses');
  } catch (error) {
    assert.ok(error instanceof TimeoutError, 'should throw TimeoutError by default');
    assert.strictEqual(error.message, 'Operation timed out after 25 ms', 'should include timeout duration');
  }
})();

// Test: withTimeout rejects using custom error
(async function testWithTimeoutRejectsCustomError() {
  const customError = new Error('custom timeout');
  try {
    await withTimeout(new Promise(() => {}), 20, customError);
    assert.fail('withTimeout should reject with the provided custom error');
  } catch (error) {
    assert.strictEqual(error, customError, 'should reject with the supplied error instance');
  }
})();

// Test: runSequential executes tasks sequentially
(async function testRunSequentialSuccess() {
  const order = [];
  const results = await runSequential([
    async () => {
      await sleep(5);
      order.push('first');
      return 1;
    },
    async () => {
      order.push('second');
      await sleep(5);
      return 2;
    }
  ]);

  assert.deepStrictEqual(results, [1, 2], 'should return collected results in order');
  assert.deepStrictEqual(order, ['first', 'second'], 'should execute tasks sequentially');
})();

// Test: runSequential stops on first error when stopOnError is true
(async function testRunSequentialStopOnError() {
  const order = [];
  const expectedError = new Error('sequential failure');
  try {
    await runSequential([
      async () => {
        order.push('task-1');
        return 'ok';
      },
      async () => {
        order.push('task-2');
        throw expectedError;
      },
      async () => {
        order.push('task-3');
        return 'should-not-run';
      }
    ]);
    assert.fail('runSequential should throw on first error when stopOnError is true');
  } catch (error) {
    assert.strictEqual(error, expectedError, 'should propagate the encountered error');
    assert.deepStrictEqual(order, ['task-1', 'task-2'], 'should stop executing remaining tasks');
  }
})();

// Test: runSequential collects settlements when stopOnError is false
(async function testRunSequentialCollectsSettlements() {
  const order = [];
  const settlements = await runSequential(
    [
      async () => {
        order.push('task-a');
        return 'alpha';
      },
      async () => {
        order.push('task-b');
        throw new Error('task-b failed');
      },
      async () => {
        order.push('task-c');
        return 'gamma';
      }
    ],
    false
  );

  assert.deepStrictEqual(order, ['task-a', 'task-b', 'task-c'], 'should continue executing all tasks');
  assert.strictEqual(settlements.length, 3, 'should return a settlement for each task');
  assert.deepStrictEqual(
    settlements[0],
    { status: 'fulfilled', value: 'alpha' },
    'first task should be marked fulfilled'
  );
  assert.strictEqual(settlements[1].status, 'rejected', 'second task should be rejected');
  assert.ok(settlements[1].reason instanceof Error, 'rejected tasks should include an Error reason');
  assert.strictEqual(settlements[1].reason.message, 'task-b failed', 'reason should retain original message');
  assert.deepStrictEqual(
    settlements[2],
    { status: 'fulfilled', value: 'gamma' },
    'third task should be fulfilled'
  );
})();
