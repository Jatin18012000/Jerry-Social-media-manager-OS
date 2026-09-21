/**
 * Manual URL fetcher — decision D5.
 *
 * The escape hatch. X/Twitter has no free API tier, a lot of AI news breaks
 * there first, and plenty of newsletters and Discords publish no feed at all.
 * Without this the system would be structurally blind to a meaningful slice of
 * §10's Pillar 1, and §14's premise — that the system monitors sources — would
 * quietly become "the system monitors the sources that happen to have RSS".
 *
 * Given a URL, this reads the page's own metadata. It extracts what the page
 * states about itself (title, description, publication date) and nothing more.
 * It does not crawl, follow links, or harvest a site — §25 rules out building
 * the system on scraping, and fetching one page a human explicitly pasted is
 * not that.
 */

import type { FetchedItem, SourceFetcher } from '@/ports';
import { type HttpClient, fetchHttp, fetchOk } from '../http';
import { stripHtml } from './feed-fetcher';

/** Reads a <meta> value by property or name, whichever the page uses. */
function metaContent(html: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`,
      'i',
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`,
      'i',
    ),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) {
      const value = stripHtml(match[1]);
      if (value) return value;
    }
  }
  return undefined;
}

function titleTag(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match?.[1]) return undefined;
  const value = stripHtml(match[1]);
  return value || undefined;
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

const MAX_SUMMARY_CHARS = 2_000;

/**
 * Extracts what a page says about itself.
 *
 * Open Graph first, because it is what the publisher chose to present, then
 * standard meta tags, then the title element.
 */
export function parsePageMetadata(html: string, url: string): FetchedItem {
  const title =
    metaContent(html, 'og:title') ??
    metaContent(html, 'twitter:title') ??
    titleTag(html) ??
    url;

  const summaryRaw =
    metaContent(html, 'og:description') ??
    metaContent(html, 'description') ??
    metaContent(html, 'twitter:description');

  const publishedAt =
    parseDate(metaContent(html, 'article:published_time')) ??
    parseDate(metaContent(html, 'datePublished')) ??
    parseDate(metaContent(html, 'og:updated_time'));

  const canonical = metaContent(html, 'og:url');

  return {
    title,
    url: canonical ?? url,
    ...(summaryRaw ? { summary: summaryRaw.slice(0, MAX_SUMMARY_CHARS) } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    rawContent: extractReadableText(html),
  };
}

/**
 * A crude readable-text extraction for claim candidate proposal.
 *
 * Not a full readability implementation. It removes non-content elements and
 * flattens the rest. Claim extraction proposes candidates for a human to
 * confirm (§7.4), so imperfect input degrades the proposal rather than
 * producing a false claim.
 */
export function extractReadableText(html: string): string {
  const withoutChrome = html
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');

  // Keep paragraph boundaries so sentence splitting has something to work with.
  const withBreaks = withoutChrome
    .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, '$&\n');

  return stripHtml(withBreaks).slice(0, 20_000);
}

export interface ManualUrlOptions {
  readonly http?: HttpClient;
}

export function createManualUrlFetcher(
  opts: ManualUrlOptions = {},
): SourceFetcher {
  const http = opts.http ?? fetchHttp;

  return {
    name: 'manual-url',
    kind: 'MANUAL',
    async fetch({ url }) {
      const response = await fetchOk(http, url);
      // Use the post-redirect URL: a shortened link should be recorded as
      // where it actually landed, or dedupe cannot do its job.
      return [parsePageMetadata(response.body, response.finalUrl || url)];
    },
  };
}
