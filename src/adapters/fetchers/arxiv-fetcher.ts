/**
 * arXiv fetcher — PRD §10 Pillar 2 (AI Research), §14 (research papers).
 *
 * Uses arXiv's official public API, which returns Atom. Free, documented and
 * explicitly offered for programmatic use.
 *
 * arXiv asks callers to be gentle: one request at a time with a few seconds
 * between them. The polling interval on the source row governs that, and this
 * fetcher makes exactly one request per call.
 */

import type { FetchedItem, SourceFetcher } from '@/ports';
import { type HttpClient, fetchHttp, fetchOk } from '../http';
import { parseFeed, stripHtml } from './feed-fetcher';

export const ARXIV_API = 'https://export.arxiv.org/api/query';

/** The categories relevant to an AI creator brand. */
export const DEFAULT_ARXIV_CATEGORIES = [
  'cs.AI',
  'cs.CL',
  'cs.LG',
  'cs.CV',
] as const;

export interface ArxivOptions {
  readonly http?: HttpClient;
  readonly categories?: readonly string[];
  readonly maxResults?: number;
}

/**
 * Builds a query URL for the given categories, newest first.
 *
 * `url` passed to fetch() overrides this when a source row carries its own
 * fully-formed arXiv query, so an unusual search is configuration rather than
 * a code change (§14).
 */
export function buildArxivUrl(
  categories: readonly string[],
  maxResults: number,
): string {
  const search = categories.map((c) => `cat:${c}`).join('+OR+');
  const params = [
    `search_query=${search}`,
    'sortBy=submittedDate',
    'sortOrder=descending',
    `max_results=${maxResults}`,
  ].join('&');
  return `${ARXIV_API}?${params}`;
}

/**
 * arXiv abstracts arrive as a single blob with hard line wraps from the
 * original LaTeX. Left as-is they produce claim candidates split mid-sentence.
 */
export function normaliseAbstract(input: string): string {
  return stripHtml(input).replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

export function createArxivFetcher(opts: ArxivOptions = {}): SourceFetcher {
  const http = opts.http ?? fetchHttp;
  const categories = opts.categories ?? DEFAULT_ARXIV_CATEGORIES;
  const maxResults = opts.maxResults ?? 25;

  return {
    name: 'arxiv',
    kind: 'ARXIV',
    async fetch({ url, since }) {
      const target =
        url && url.startsWith('http')
          ? url
          : buildArxivUrl(categories, maxResults);

      const response = await fetchOk(http, target);

      const items: FetchedItem[] = parseFeed(response.body)
        .filter((item) => item.url)
        .map((item) => ({
          ...item,
          title: item.title.replace(/\s+/g, ' ').trim(),
          ...(item.summary !== undefined
            ? { summary: normaliseAbstract(item.summary) }
            : {}),
        }));

      if (!since) return items;
      return items.filter(
        (item) => !item.publishedAt || item.publishedAt > since,
      );
    },
  };
}
