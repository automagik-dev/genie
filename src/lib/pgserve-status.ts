/**
 * Shared parser for `<autopg|pgserve> status --json` output.
 *
 * The port can appear at the top level (`port`) or nested under `instance.port`
 * / `runtime.port` depending on the binary version. Consumers MUST tolerate all
 * three shapes — reading only top-level `.port` silently null-resolves on hosts
 * emitting the nested shape. Extracted here so both `genie update` diagnostics
 * and migration 002 (canonical-port discovery) share one implementation.
 */
export function extractPgservePortFromStatus(output: string): string | null {
  try {
    const parsed = JSON.parse(output) as {
      port?: unknown;
      instance?: { port?: unknown };
      runtime?: { port?: unknown };
    };
    const rawPort = parsed.port ?? parsed.instance?.port ?? parsed.runtime?.port;
    if (typeof rawPort === 'number' && Number.isFinite(rawPort)) return String(rawPort);
    if (typeof rawPort === 'string' && rawPort.trim()) return rawPort.trim();
  } catch {
    // best-effort diagnostics only; callers fall back to null.
  }
  return null;
}
