/**
 * Hacker News fetcher — PRD §14 (developer communities).
 *
 * Uses Algolia's public HN search API: free, no key, and it supports filtering
 * by score and date, which the official Firebase API does not. That filtering
 * matters — the value of HN here is signal, not volume, and an unfiltered
 * firehose would bury the research queue.
 *
 * HN is a *signal* source, not a primary one. A story here points at something
 * worth reading; the story's own link is the thing with authority. Items are
 * therefore recorded with the target URL, and §7.2 tiering treats them as
 * OTHER unless the target says better.
 */

import type { FetchedItem, SourceFetcher } from '@/ports';
import { type HttpClient, fetchHttp, fetchOk } from '../http';

export const HN_SEARCH_API = 'https://hn.algolia.com/api/v1/search_by_date';

export interface HackerNewsOptions {
  readonly http?: HttpClient;
  readonly query?: string;
  /** Stories below this score are noise for our purposes. */
  readonly minPoints?: number;
  readonly hitsPerPage?: number;
}

interface AlgoliaHit {
  readonly objectID?: string;
  readonly title?: string | null;
  readonly story_title?: string | null;
  readonly url?: string | null;
  readonly story_url?: string | null;
  readonly points?: number | null;
  readonly created_at?: string | null;
  readonly num_comments?: number | null;
}

export function buildHnUrl(
  query: string,
  minPoints: number,
  hitsPerPage: number,
): string {
  const params = new URLSearchParams({
    query,
    tags: 'story',
    numericFilters: `points>=${minPoints}`,
    hitsPerPage: String(hitsPerPage),
  });
  return `${HN_SEARCH_API}?${params.toString()}`;
}

/** The HN discussion, used when a story has no external link (an Ask HN). */
function discussionUrl(objectId: string): string {
  return `https://news.ycombinator.com/item?id=${objectId}`;
}

export function parseHnResponse(body: string): FetchedItem[] {
  let parsed: { hits?: AlgoliaHit[] };
  try {
    parsed = JSON.parse(body) as { hits?: AlgoliaHit[] };
  } catch {
    throw new Error('Hacker News API returned a response that is not JSON');
  }

  const hits = parsed.hits ?? [];

  return hits
    .map((hit): FetchedItem | null => {
      const title = hit.title ?? hit.story_title;
      if (!title) return null;

      const url =
        hit.url ??
        hit.story_url ??
        (hit.objectID ? discussionUrl(hit.objectID) : null);
      if (!url) return null;

      const publishedAt = hit.created_at
        ? new Date(hit.created_at)
        : undefined;

      const points = hit.points ?? 0;
      const comments = hit.num_comments ?? 0;

      return {
        title: title.trim(),
        url,
        // The score is the reason this item is here, so it travels with it.
        summary: `Hacker News: ${points} points, ${comments} comments.`,
        ...(publishedAt && !Number.isNaN(publishedAt.getTime())
          ? { publishedAt }
          : {}),
      };
    })
    .filter((item): item is FetchedItem => item !== null);
}

export function createHackerNewsFetcher(
  opts: HackerNewsOptions = {},
): SourceFetcher {
  const http = opts.http ?? fetchHttp;
  const query = opts.query ?? 'AI OR LLM OR "machine learning"';
  const minPoints = opts.minPoints ?? 100;
  const hitsPerPage = opts.hitsPerPage ?? 30;

  return {
    name: 'hacker-news',
    kind: 'HACKER_NEWS',
    async fetch({ url, since }) {
      const target =
        url && url.startsWith('http')
          ? url
          : buildHnUrl(query, minPoints, hitsPerPage);

      const response = await fetchOk(http, target);
      const items = parseHnResponse(response.body);

      if (!since) return items;
      return items.filter(
        (item) => !item.publishedAt || item.publishedAt > since,
      );
    },
  };
}
