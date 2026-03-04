export interface Model {
  id: string;
  created: number;
  owned_by: string;
}

interface ModelsResponse {
  data: Model[];
  object: string;
}

type ConnectionResult =
  | { success: true; modelCount: number; models: Model[] }
  | { success: false; error: 'auth_failure' | 'network_error' | 'invalid_url' | 'unknown'; message: string };

function classifyNetworkError(error: unknown, apiUrl: string): ConnectionResult {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? (error.cause as Record<string, unknown>) : undefined;
  const name = error instanceof Error ? error.name : '';

  if (cause?.code === 'ECONNREFUSED' || message?.includes('ECONNREFUSED')) {
    return {
      success: false,
      error: 'network_error',
      message: `Connection refused. Is the server running at ${apiUrl}?`,
    };
  }
  if (cause?.code === 'ENOTFOUND' || message?.includes('ENOTFOUND')) {
    return { success: false, error: 'network_error', message: `Could not resolve hostname. Check the URL: ${apiUrl}` };
  }
  if (name === 'AbortError' || message?.includes('timeout')) {
    return {
      success: false,
      error: 'network_error',
      message: 'Connection timed out. Check your network and the server URL.',
    };
  }
  return { success: false, error: 'network_error', message: `Network error: ${message || 'Unknown error'}` };
}

export async function testConnection(apiUrl: string, apiKey: string): Promise<ConnectionResult> {
  try {
    new URL(apiUrl);
  } catch {
    return { success: false, error: 'invalid_url', message: `Invalid URL format: ${apiUrl}` };
  }

  try {
    const response = await fetch(`${apiUrl}/v1/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.status === 401 || response.status === 403) {
      return { success: false, error: 'auth_failure', message: 'Authentication failed. Check your API key.' };
    }

    if (!response.ok) {
      return {
        success: false,
        error: 'unknown',
        message: `Server returned ${response.status}: ${response.statusText}`,
      };
    }

    const data = (await response.json()) as ModelsResponse;
    const models = data.data || [];

    return { success: true, modelCount: models.length, models };
  } catch (error) {
    return classifyNetworkError(error, apiUrl);
  }
}
