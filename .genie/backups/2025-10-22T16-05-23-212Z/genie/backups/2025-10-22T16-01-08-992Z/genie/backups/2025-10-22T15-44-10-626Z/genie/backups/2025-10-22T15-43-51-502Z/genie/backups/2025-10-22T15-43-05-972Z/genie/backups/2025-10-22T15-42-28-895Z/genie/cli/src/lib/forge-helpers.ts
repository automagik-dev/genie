export const FORGE_RECOVERY_HINT =
  "Run 'genie forge restart' to recover the Automagik Forge backend.";

export function describeForgeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
