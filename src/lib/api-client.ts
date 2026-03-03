export interface Model {
  id: string;
  created: number;
  owned_by: string;
}

export interface ModelsResponse {
  data: Model[];
  object: string;
}

export type ConnectionResult =
  | { success: true; modelCount: number; models: Model[] }
  | { success: false; error: 'auth_failure' | 'network_error' | 'invalid_url' | 'unknown'; message: string };

export async function testConnection(apiUrl: string, apiKey: string): Promise<ConnectionResult> {
  try {
    // Validate URL format
    try {
      new URL(apiUrl);
    } catch {
      return {
        success: false,
        error: 'invalid_url',
        message: `Invalid URL format: ${apiUrl}`,
      };
    }

    const response = await fetch(`${apiUrl}/v1/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.status === 401 || response.status === 403) {
      return {
        success: false,
        error: 'auth_failure',
        message: 'Authentication failed. Check your API key.',
      };
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

    return {
      success: true,
      modelCount: models.length,
      models,
    };
  } catch (error: any) {
    // Network errors (connection refused, timeout, DNS failure, etc.)
    if (error.cause?.code === 'ECONNREFUSED' || error.message?.includes('ECONNREFUSED')) {
      return {
        success: false,
        error: 'network_error',
        message: `Connection refused. Is the server running at ${apiUrl}?`,
      };
    }
    if (error.cause?.code === 'ENOTFOUND' || error.message?.includes('ENOTFOUND')) {
      return {
        success: false,
        error: 'network_error',
        message: `Could not resolve hostname. Check the URL: ${apiUrl}`,
      };
    }
    if (error.name === 'AbortError' || error.message?.includes('timeout')) {
      return {
        success: false,
        error: 'network_error',
        message: 'Connection timed out. Check your network and the server URL.',
      };
    }
    return {
      success: false,
      error: 'network_error',
      message: `Network error: ${error.message || 'Unknown error'}`,
    };
  }
}

export async function getModels(apiUrl: string, apiKey: string): Promise<Model[]> {
  const result = await testConnection(apiUrl, apiKey);
  if (result.success) {
    return result.models;
  }
  throw new Error(result.message);
}

export async function validateApiKeyAndGetModels(apiUrl: string, apiKey: string): Promise<Model[] | null> {
  const result = await testConnection(apiUrl, apiKey);
  if (result.success) {
    return result.models;
  }
  return null;
}
