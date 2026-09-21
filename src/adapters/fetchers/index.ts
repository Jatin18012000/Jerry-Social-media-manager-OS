/**
 * Fetcher registry — maps a source's configured kind to its implementation.
 *
 * §14 requires the source list to be configurable. A source row names its
 * fetcher kind; this resolves it. Adding a fetcher means adding a case here
 * and nothing else — no caller knows which kind it is dealing with.
 */

import type { SourceFetcher } from '@/ports';
import type { HttpClient } from '../http';
import { createArxivFetcher } from './arxiv-fetcher';
import { createFeedFetcher } from './feed-fetcher';
import { createHackerNewsFetcher } from './hacker-news-fetcher';
import { createManualUrlFetcher } from './manual-url-fetcher';

export type FetcherKind = SourceFetcher['kind'];

export function createFetcherRegistry(
  http?: HttpClient,
): Record<FetcherKind, SourceFetcher> {
  const opts = http ? { http } : {};
  return {
    RSS: createFeedFetcher({ ...opts, kind: 'RSS' }),
    ATOM: createFeedFetcher({ ...opts, kind: 'ATOM' }),
    ARXIV: createArxivFetcher(opts),
    HACKER_NEWS: createHackerNewsFetcher(opts),
    MANUAL: createManualUrlFetcher(opts),
  };
}

export * from './feed-fetcher';
export * from './arxiv-fetcher';
export * from './hacker-news-fetcher';
export * from './manual-url-fetcher';
