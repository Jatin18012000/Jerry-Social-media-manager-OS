/**
 * RSS and Atom fetcher — PRD §14, decision D5.
 *
 * Covers the bulk of §14's source categories: official company blogs,
 * technology publications, and anything else publishing a feed. Free, stable,
 * and explicitly offered for machine consumption — which is why §25's ban on
 * building the system around scraping does not bite here.
 *
 * Handles RSS 2.0, RDF (RSS 1.0) and Atom, because real feeds in the wild are
 * all three and a fetcher that only reads one shape will silently miss
 * sources.
 */

import { XMLParser } from 'fast-xml-parser';

import type { FetchedItem, SourceFetcher } from '@/ports';
import { type HttpClient, fetchHttp, fetchOk } from '../http';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  // Feeds wrap content in CDATA constantly; without this, entities double-escape.
  processEntities: true,
  parseTagValue: false,
});

/** A feed element that may be a single object or an array. */
function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Feed values arrive as a string, or as an object carrying text plus
 * attributes, or as a CDATA wrapper. Normalises all three to a string.
 */
function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const inner = record['#text'];
    if (typeof inner === 'string') return inner.trim() || undefined;
  }
  return undefined;
}

/**
 * Atom links are attribute-based and a single entry carries several — the
 * alternate link is the article, but "self" or "enclosure" may come first.
 */
function atomLink(entry: Record<string, unknown>): string | undefined {
  const links = toArray(entry['link'] as unknown);

  const hrefOf = (link: unknown): { href?: string; rel?: string } => {
    if (typeof link === 'string') return { href: link };
    if (link && typeof link === 'object') {
      const record = link as Record<string, unknown>;
      return {
        href:
          typeof record['@_href'] === 'string' ? record['@_href'] : undefined,
        rel: typeof record['@_rel'] === 'string' ? record['@_rel'] : undefined,
      };
    }
    return {};
  };

  const parsed = links.map(hrefOf).filter((l) => l.href);
  const alternate = parsed.find((l) => l.rel === 'alternate' || l.rel === undefined);
  return (alternate ?? parsed[0])?.href;
}

/** Strips markup from a feed summary without pulling in a DOM. */
export function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDate(value: unknown): Date | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

const MAX_SUMMARY_CHARS = 2_000;

function summarise(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const raw = text(candidate);
    if (raw) {
      const clean = stripHtml(raw);
      if (clean) return clean.slice(0, MAX_SUMMARY_CHARS);
    }
  }
  return undefined;
}

/**
 * Parses feed XML into items.
 *
 * Exported separately from fetching so it can be tested against fixtures, and
 * so a malformed feed produces a clear parse failure rather than a confusing
 * network error.
 */
export function parseFeed(xml: string): FetchedItem[] {
  const doc = parser.parse(xml) as Record<string, unknown>;

  // RSS 2.0: rss > channel > item
  const rss = doc['rss'] as Record<string, unknown> | undefined;
  if (rss) {
    const channel = rss['channel'] as Record<string, unknown> | undefined;
    return toArray(channel?.['item'] as unknown).map(parseRssItem);
  }

  // RDF / RSS 1.0: rdf:RDF > item (siblings of channel, not children)
  const rdf = (doc['rdf:RDF'] ?? doc['RDF']) as
    | Record<string, unknown>
    | undefined;
  if (rdf) {
    return toArray(rdf['item'] as unknown).map(parseRssItem);
  }

  // Atom: feed > entry
  const feed = doc['feed'] as Record<string, unknown> | undefined;
  if (feed) {
    return toArray(feed['entry'] as unknown).map(parseAtomEntry);
  }

  return [];
}

function parseRssItem(raw: unknown): FetchedItem {
  const item = (raw ?? {}) as Record<string, unknown>;
  const title = text(item['title']) ?? '(untitled)';
  const link =
    text(item['link']) ??
    text(item['guid']) ??
    '';

  const summary = summarise(
    item['description'],
    item['content:encoded'],
    item['summary'],
  );
  const publishedAt = parseDate(item['pubDate'] ?? item['dc:date']);

  return {
    title,
    url: link,
    ...(summary !== undefined ? { summary } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
  };
}

function parseAtomEntry(raw: unknown): FetchedItem {
  const entry = (raw ?? {}) as Record<string, unknown>;
  const title = text(entry['title']) ?? '(untitled)';
  const link = atomLink(entry) ?? text(entry['id']) ?? '';

  const summary = summarise(entry['summary'], entry['content']);
  const publishedAt = parseDate(entry['published'] ?? entry['updated']);

  return {
    title,
    url: link,
    ...(summary !== undefined ? { summary } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
  };
}

export interface FeedFetcherOptions {
  readonly http?: HttpClient;
  readonly kind?: 'RSS' | 'ATOM';
}

export function createFeedFetcher(
  opts: FeedFetcherOptions = {},
): SourceFetcher {
  const http = opts.http ?? fetchHttp;

  return {
    name: 'feed',
    kind: opts.kind ?? 'RSS',
    async fetch({ url, since }) {
      const response = await fetchOk(http, url);
      const items = parseFeed(response.body).filter((item) => item.url);

      if (!since) return items;
      // An item with no date is kept: dropping it would silently lose
      // anything from a feed that omits timestamps.
      return items.filter(
        (item) => !item.publishedAt || item.publishedAt > since,
      );
    },
  };
}
