/**
 * HTTP access for fetchers.
 *
 * Injected rather than called directly so that fetcher tests run against
 * fixtures with no network. A test suite that depends on a live feed fails for
 * reasons that have nothing to do with the code.
 */

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
  readonly finalUrl: string;
}

export type HttpClient = (
  url: string,
  init?: { readonly timeoutMs?: number },
) => Promise<HttpResponse>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The real client.
 *
 * Identifies itself honestly in the User-Agent. §25 rules out disguising the
 * system as a browser to get around a publisher's wishes; a feed reader should
 * look like a feed reader.
 */
export const fetchHttp: HttpClient = async (url, init) => {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    init?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'SocialMediaOS/0.1 (feed reader)',
        Accept:
          'application/rss+xml, application/atom+xml, application/xml, application/json, text/html;q=0.8',
      },
    });

    const body = await response.text();
    return { status: response.status, body, finalUrl: response.url || url };
  } finally {
    clearTimeout(timeout);
  }
};

/** Throws on a non-2xx response so callers do not parse an error page. */
export async function fetchOk(
  http: HttpClient,
  url: string,
  init?: { timeoutMs?: number },
): Promise<HttpResponse> {
  const response = await http(url, init);
  if (response.status < 200 || response.status >= 300) {
    throw new HttpError(response.status, url);
  }
  return response;
}
