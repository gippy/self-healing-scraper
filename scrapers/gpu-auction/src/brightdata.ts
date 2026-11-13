import type { BrightDataConfig } from './config.ts';

const BRIGHTDATA_REQUEST_URL = 'https://api.brightdata.com/request';
const ATTEMPT_TIMEOUT_MS = 60_000;

/** A failed fetch of the target page, from Bright Data or from the site behind it. */
export class UpstreamError extends Error {
  isRetryable: boolean;
  /** The HTTP status, or `timeout` / `network` when no answer came. Groups the Sentry issues. */
  status: number | 'timeout' | 'network';

  constructor(message: string, options: { isRetryable: boolean; status: number | 'timeout' | 'network'; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = 'UpstreamError';
    this.isRetryable = options.isRetryable;
    this.status = options.status;
  }
}

export type FetchResult = {
  body: string;
  /** The first attempt's failure when the retry succeeded. */
  recoveredFrom?: UpstreamError;
};

export type PageFetcher = (url: string) => Promise<FetchResult>;

// Bright Data answers 200 once its unlocker ran and reports the target's status in a header.
function getTargetStatus(response: Response): number {
  const targetStatus = Number(response.headers.get('x-brd-status-code'));
  return response.ok && Number.isInteger(targetStatus) && targetStatus > 0 ? targetStatus : response.status;
}

function describeBrightDataError(response: Response): string {
  const code = response.headers.get('x-brd-error-code') ?? response.headers.get('x-brd-err-code');
  const message = response.headers.get('x-brd-error') ?? response.headers.get('x-brd-err-msg');
  return code || message ? ` (Bright Data: ${[code, message].filter(Boolean).join(' ')})` : '';
}

async function fetchOnce(request: () => Promise<Response>): Promise<string> {
  let response: Response;
  try {
    response = await request();
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'TimeoutError';
    throw new UpstreamError(`Fetching the target page ${isTimeout ? 'timed out' : 'failed'}: ${String(error)}`, {
      isRetryable: true,
      status: isTimeout ? 'timeout' : 'network',
      cause: error,
    });
  }
  const status = getTargetStatus(response);
  if (status >= 400) {
    throw new UpstreamError(`Fetching the target page answered ${status}${describeBrightDataError(response)}`, {
      isRetryable: status >= 500,
      status,
    });
  }
  return response.text();
}

/**
 * Creates the page fetcher: Bright Data's Web Unlocker (`POST /request`, `format: "raw"`), or a direct fetch when
 * Bright Data is faked. Retries once on a 5xx answer, a timeout or a network error.
 */
export function createPageFetcher(brightData: BrightDataConfig, fetchImpl: typeof fetch = fetch): PageFetcher {
  const request = (url: string) => () => {
    const signal = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
    if (brightData.isFake) {
      return fetchImpl(url, { signal });
    }
    return fetchImpl(BRIGHTDATA_REQUEST_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${brightData.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ zone: brightData.zone, url, format: 'raw' }),
      signal,
    });
  };

  return async (url) => {
    try {
      return { body: await fetchOnce(request(url)) };
    } catch (error) {
      if (!(error instanceof UpstreamError) || !error.isRetryable) {
        throw error;
      }
      return { body: await fetchOnce(request(url)), recoveredFrom: error };
    }
  };
}
