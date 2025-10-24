/**
 * URL Shortening Service Integration
 *
 * Security Model: Public service with optional API key
 * - Public: Free tier (rate limited by service)
 * - Company: API key from GENIE_URL_SHORTENER_API_KEY env var (higher limits)
 * - Fallback: Returns full URL on any failure (no errors/warnings)
 *
 * Philosophy: Silent degradation - user never sees errors, just gets URLs
 */

interface ShortenOptions {
  apiKey?: string;
  timeout?: number;
}

interface ShortenResult {
  success: boolean;
  shortUrl?: string;
  fullUrl: string;
  fromCache?: boolean;
}

interface HealthStatus {
  healthy: boolean;
  lastCheck: number;
}

/**
 * URL Shortener Cache - Session-scoped in-memory cache
 * Prevents redundant API calls for same URL
 */
class UrlShortenerCache {
  private urlCache: Map<string, string> = new Map();
  private healthStatus: HealthStatus = { healthy: true, lastCheck: 0 };
  private readonly HEALTH_CACHE_TTL = 60_000; // 60 seconds

  getCachedUrl(longUrl: string): string | undefined {
    return this.urlCache.get(longUrl);
  }

  setCachedUrl(longUrl: string, shortUrl: string): void {
    this.urlCache.set(longUrl, shortUrl);
  }

  getCachedHealth(): HealthStatus | undefined {
    const now = Date.now();
    if (now - this.healthStatus.lastCheck < this.HEALTH_CACHE_TTL) {
      return this.healthStatus;
    }
    return undefined;
  }

  setCachedHealth(healthy: boolean): void {
    this.healthStatus = { healthy, lastCheck: Date.now() };
  }
}

// Singleton cache instance
const cache = new UrlShortenerCache();

/**
 * Health check with caching (60s TTL)
 * Silent on failure - returns false, never throws
 */
export async function isUrlShortenerHealthy(): Promise<boolean> {
  // Check cache first
  const cachedHealth = cache.getCachedHealth();
  if (cachedHealth !== undefined) {
    return cachedHealth.healthy;
  }

  // Perform health check
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000); // 2s timeout

    const response = await fetch('https://url.namastex.ai/health', {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });

    clearTimeout(timeoutId);

    const healthy = response.ok;
    cache.setCachedHealth(healthy);
    return healthy;
  } catch (error) {
    // Silent failure - service down, timeout, network error, etc.
    cache.setCachedHealth(false);
    return false;
  }
}

/**
 * Shorten URL with graceful fallback
 *
 * @param longUrl - Full URL to shorten
 * @param options - Optional configuration (apiKey, timeout)
 * @returns ShortenResult with shortUrl if successful, fullUrl as fallback
 *
 * Philosophy: NEVER throw errors, NEVER log warnings
 * User gets either short URL or full URL, seamlessly
 */
export async function shortenUrl(
  longUrl: string,
  options: ShortenOptions = {}
): Promise<ShortenResult> {
  const { apiKey, timeout = 3000 } = options;

  // Check cache first
  const cachedShortUrl = cache.getCachedUrl(longUrl);
  if (cachedShortUrl) {
    return {
      success: true,
      shortUrl: cachedShortUrl,
      fullUrl: longUrl,
      fromCache: true
    };
  }

  // Try to shorten
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const headers: Record<string, string> = {
      'Accept': 'application/json'
    };

    // Add API key if provided (company mode)
    if (apiKey) {
      headers['X-API-Key'] = apiKey;
    }

    const url = `https://url.namastex.ai/create?url=${encodeURIComponent(longUrl)}`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      // Rate limit, service error, etc. → silent fallback
      return {
        success: false,
        fullUrl: longUrl
      };
    }

    const data = await response.json() as any;

    if (data.success && data.short_url) {
      // Cache successful shortening
      cache.setCachedUrl(longUrl, data.short_url);

      return {
        success: true,
        shortUrl: data.short_url,
        fullUrl: longUrl,
        fromCache: false
      };
    } else {
      // Unexpected response format → silent fallback
      return {
        success: false,
        fullUrl: longUrl
      };
    }
  } catch (error) {
    // Any error (timeout, network, parse, etc.) → silent fallback
    return {
      success: false,
      fullUrl: longUrl
    };
  }
}

/**
 * Helper to get API key from environment
 * Returns undefined if not set (public mode)
 */
export function getApiKeyFromEnv(): string | undefined {
  return process.env.GENIE_URL_SHORTENER_API_KEY;
}
