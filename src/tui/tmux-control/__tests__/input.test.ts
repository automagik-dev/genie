import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import {
  PASTE_FALLBACK_THRESHOLD_BYTES,
  encodeHex,
  sendInput,
  shouldUsePasteFallback,
  writeViaPasteBuffer,
} from '../input.js';

function collect(stream: PassThrough): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

describe('encodeHex', () => {
  test('encodes ASCII byte-for-byte, space-delimited', () => {
    expect(encodeHex('AB')).toBe('41 42');
  });

  test('encodes UTF-8 multibyte (日 = e6 97 a5)', () => {
    expect(encodeHex('日')).toBe('e6 97 a5');
  });

  test('encodes emoji surrogate pair as 4 bytes', () => {
    expect(encodeHex('🚀')).toBe('f0 9f 9a 80');
  });

  test('pads single-digit hex to two chars', () => {
    expect(encodeHex(Buffer.from([0x0a, 0x01, 0x7f]))).toBe('0a 01 7f');
  });

  test('empty input → empty string', () => {
    expect(encodeHex('')).toBe('');
    expect(encodeHex(Buffer.alloc(0))).toBe('');
  });
});

describe('shouldUsePasteFallback', () => {
  test('false for short ASCII without semicolons', () => {
    expect(shouldUsePasteFallback('hello world')).toBe(false);
  });

  test('true for any payload containing a semicolon byte', () => {
    expect(shouldUsePasteFallback('a;b')).toBe(true);
  });

  test('true when length crosses the threshold', () => {
    const big = 'a'.repeat(PASTE_FALLBACK_THRESHOLD_BYTES);
    expect(shouldUsePasteFallback(big)).toBe(true);
  });

  test('false just under the threshold without semicolons', () => {
    const justUnder = 'a'.repeat(PASTE_FALLBACK_THRESHOLD_BYTES - 1);
    expect(shouldUsePasteFallback(justUnder)).toBe(false);
  });
});

describe('sendInput — fast path (send-keys -H)', () => {
  test('writes hex-encoded send-keys command for ASCII', async () => {
    const stdin = new PassThrough();
    const collected = collect(stdin);
    sendInput({ stdin }, '%3', 'AB');
    stdin.end();
    expect(await collected).toBe("send-keys -H -t '%3' 41 42\n");
  });

  test('writes correct command for UTF-8 multibyte', async () => {
    const stdin = new PassThrough();
    const collected = collect(stdin);
    sendInput({ stdin }, '%1', '日');
    stdin.end();
    expect(await collected).toBe("send-keys -H -t '%1' e6 97 a5\n");
  });

  test('escapes single quotes inside the pane id', async () => {
    const stdin = new PassThrough();
    const collected = collect(stdin);
    sendInput({ stdin }, "weird'name", 'A');
    stdin.end();
    expect(await collected).toBe("send-keys -H -t 'weird'\\''name' 41\n");
  });

  test('returns false when stdin is null', () => {
    expect(sendInput({ stdin: null }, '%1', 'A')).toBe(false);
  });

  test('empty payload short-circuits as success without write', async () => {
    const stdin = new PassThrough();
    let chunks = 0;
    stdin.on('data', () => {
      chunks += 1;
    });
    const ok = sendInput({ stdin }, '%1', '');
    stdin.end();
    await new Promise((r) => setImmediate(r));
    expect(ok).toBe(true);
    expect(chunks).toBe(0);
  });
});

describe('sendInput — paste fallback', () => {
  test('semicolon payload routes through load-buffer + paste-buffer -p', async () => {
    const stdin = new PassThrough();
    const collected = collect(stdin);
    sendInput({ stdin }, '%1', 'a;b');
    stdin.end();
    const out = await collected;
    expect(out).toContain('load-buffer -b genie-tui-paste');
    expect(out).toContain("paste-buffer -p -b genie-tui-paste -t '%1' -d");
    // No send-keys -H emitted on the fallback path
    expect(out).not.toContain('send-keys -H');
    // Semicolon is encoded as a printable ASCII char inside the buffer literal
    expect(out).toContain('a;b');
  });

  test('large payload routes through buffer', async () => {
    const stdin = new PassThrough();
    const collected = collect(stdin);
    const big = 'x'.repeat(PASTE_FALLBACK_THRESHOLD_BYTES + 100);
    sendInput({ stdin }, '%1', big);
    stdin.end();
    const out = await collected;
    expect(out).toContain('load-buffer -b genie-tui-paste');
    expect(out).not.toContain('send-keys -H');
  });

  test('writeViaPasteBuffer escapes non-printable bytes as octal', async () => {
    const stdin = new PassThrough();
    const collected = collect(stdin);
    writeViaPasteBuffer(stdin, '%1', Buffer.from([0x1b, 0x5b, 0x41]));
    stdin.end();
    const out = await collected;
    // 0x1b → \033, 0x5b → '[', 0x41 → 'A'
    expect(out).toContain("'\\033[A'");
  });

  test('writeViaPasteBuffer escapes embedded single quotes', async () => {
    const stdin = new PassThrough();
    const collected = collect(stdin);
    writeViaPasteBuffer(stdin, '%1', "it's");
    stdin.end();
    const out = await collected;
    expect(out).toContain("'it'\\''s'");
  });
});
