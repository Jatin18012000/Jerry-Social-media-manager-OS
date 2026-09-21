import { describe, expect, it } from 'vitest';

import { HttpError, type HttpClient } from '../http';
import {
  ARXIV_ATOM,
  ATOM,
  EMPTY_RSS,
  HN_JSON,
  HTML_MINIMAL,
  HTML_PAGE,
  RDF,
  RSS_2_0,
  RSS_SINGLE_ITEM,
} from './__fixtures__/feeds';
import {
  buildArxivUrl,
  createArxivFetcher,
  normaliseAbstract,
} from './arxiv-fetcher';
import { createFeedFetcher, parseFeed, stripHtml } from './feed-fetcher';
import {
  buildHnUrl,
  createHackerNewsFetcher,
  parseHnResponse,
} from './hacker-news-fetcher';
import {
  createManualUrlFetcher,
  extractReadableText,
  parsePageMetadata,
} from './manual-url-fetcher';
import { createFetcherRegistry } from './index';

/** A client that returns a fixed body, so no test touches the network. */
const stub = (body: string, status = 200): HttpClient =>
  async (url) => ({ status, body, finalUrl: url });

describe('stripHtml', () => {
  it('removes tags and decodes entities', () => {
    expect(stripHtml('<p>Hello &amp; welcome</p>')).toBe('Hello & welcome');
  });

  it('removes script and style content entirely', () => {
    expect(stripHtml('<script>evil()</script>Text')).toBe('Text');
    expect(stripHtml('<style>.a{}</style>Text')).toBe('Text');
  });

  it('collapses whitespace', () => {
    expect(stripHtml('a\n\n   b')).toBe('a b');
  });
});

describe('parseFeed', () => {
  it('parses RSS 2.0 items', () => {
    const items = parseFeed(RSS_2_0);
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe('We released a new model');
    expect(items[0]?.url).toBe('https://example.com/blog/new-model');
  });

  it('strips markup out of a CDATA description', () => {
    const items = parseFeed(RSS_2_0);
    expect(items[0]?.summary).toBe(
      'Today we released a new model for developers.',
    );
  });

  it('decodes entities in a plain description', () => {
    const items = parseFeed(RSS_2_0);
    expect(items[1]?.summary).toBe('Plain text summary & entity.');
  });

  it('parses RSS publication dates', () => {
    const items = parseFeed(RSS_2_0);
    expect(items[0]?.publishedAt?.toISOString()).toBe(
      '2026-09-20T10:00:00.000Z',
    );
  });

  it('parses Atom entries and picks the alternate link', () => {
    const items = parseFeed(ATOM);
    expect(items).toHaveLength(1);
    // Not the rel="self" link, which is the feed itself.
    expect(items[0]?.url).toBe('https://example.com/posts/atom-entry');
  });

  it('parses RDF / RSS 1.0, where items sit outside channel', () => {
    const items = parseFeed(RDF);
    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe('https://example.com/rdf-item');
    expect(items[0]?.publishedAt?.toISOString()).toBe(
      '2026-09-18T09:00:00.000Z',
    );
  });

  it('handles a feed with exactly one item', () => {
    // The XML parser returns an object rather than an array here; a naive
    // implementation silently returns nothing.
    const items = parseFeed(RSS_SINGLE_ITEM);
    expect(items).toHaveLength(1);
  });

  it('returns an empty list for a feed with no items', () => {
    expect(parseFeed(EMPTY_RSS)).toEqual([]);
  });

  it('returns an empty list for XML that is not a feed', () => {
    expect(parseFeed('<?xml version="1.0"?><something/>')).toEqual([]);
  });
});

describe('feed fetcher', () => {
  it('fetches and parses', async () => {
    const fetcher = createFeedFetcher({ http: stub(RSS_2_0) });
    const items = await fetcher.fetch({ url: 'https://example.com/feed.xml' });
    expect(items).toHaveLength(2);
  });

  it('filters to items newer than the given date', async () => {
    const fetcher = createFeedFetcher({ http: stub(RSS_2_0) });
    // Both fixture items (Sep 20 and Sep 14) are newer than this.
    const items = await fetcher.fetch({
      url: 'https://example.com/feed.xml',
      since: new Date('2026-09-10T00:00:00Z'),
    });
    expect(items).toHaveLength(2);

    const newer = await fetcher.fetch({
      url: 'https://example.com/feed.xml',
      since: new Date('2026-09-19T00:00:00Z'),
    });
    expect(newer).toHaveLength(1);
    expect(newer[0]?.title).toBe('We released a new model');
  });

  it('throws rather than parsing an error page', async () => {
    const fetcher = createFeedFetcher({ http: stub('<html>404</html>', 404) });
    await expect(
      fetcher.fetch({ url: 'https://example.com/missing.xml' }),
    ).rejects.toThrow(HttpError);
  });

  it('drops items with no usable link', async () => {
    const noLink = `<rss version="2.0"><channel><item><title>No link</title></item></channel></rss>`;
    const fetcher = createFeedFetcher({ http: stub(noLink) });
    expect(await fetcher.fetch({ url: 'https://example.com/f' })).toEqual([]);
  });
});

describe('arxiv fetcher', () => {
  it('builds a category query, newest first', () => {
    const url = buildArxivUrl(['cs.AI', 'cs.CL'], 10);
    expect(url).toContain('cat:cs.AI+OR+cat:cs.CL');
    expect(url).toContain('sortBy=submittedDate');
    expect(url).toContain('sortOrder=descending');
    expect(url).toContain('max_results=10');
  });

  it('flattens the hard line wraps in a title', async () => {
    const fetcher = createArxivFetcher({ http: stub(ARXIV_ATOM) });
    const items = await fetcher.fetch({ url: '' });
    expect(items[0]?.title).toBe(
      'Scaling Laws for Retrieval Augmented Models',
    );
  });

  it('flattens the abstract so sentences survive splitting', async () => {
    const fetcher = createArxivFetcher({ http: stub(ARXIV_ATOM) });
    const items = await fetcher.fetch({ url: '' });
    expect(items[0]?.summary).not.toContain('\n');
    expect(items[0]?.summary).toContain(
      'Our experiments suggest that retrieval reduces the parameter count',
    );
  });

  it('normaliseAbstract collapses newlines and repeated spaces', () => {
    expect(normaliseAbstract('one\n  two   three')).toBe('one two three');
  });

  it('uses an explicit query URL when the source row supplies one', async () => {
    let requested = '';
    const spy: HttpClient = async (url) => {
      requested = url;
      return { status: 200, body: ARXIV_ATOM, finalUrl: url };
    };
    const fetcher = createArxivFetcher({ http: spy });
    await fetcher.fetch({ url: 'https://export.arxiv.org/api/query?custom=1' });
    expect(requested).toBe('https://export.arxiv.org/api/query?custom=1');
  });
});

describe('hacker news fetcher', () => {
  it('builds a score-filtered query', () => {
    const url = buildHnUrl('AI', 100, 30);
    expect(url).toContain('numericFilters=points%3E%3D100');
    expect(url).toContain('tags=story');
  });

  it('parses hits and keeps the target URL', () => {
    const items = parseHnResponse(HN_JSON);
    expect(items[0]?.url).toBe('https://github.com/example/server');
  });

  it('falls back to the discussion URL for a story with no link', () => {
    const items = parseHnResponse(HN_JSON);
    const askHn = items.find((i) => i.title.startsWith('Ask HN'));
    expect(askHn?.url).toBe('https://news.ycombinator.com/item?id=41000002');
  });

  it('carries the score, which is why the item is here at all', () => {
    const items = parseHnResponse(HN_JSON);
    expect(items[0]?.summary).toContain('412 points');
  });

  it('skips a hit with no title rather than inventing one', () => {
    const items = parseHnResponse(HN_JSON);
    expect(items.some((i) => i.url === 'https://example.com/no-title')).toBe(
      false,
    );
  });

  it('fails clearly when the API returns something that is not JSON', () => {
    expect(() => parseHnResponse('<html>rate limited</html>')).toThrow(
      /not JSON/,
    );
  });

  it('handles a response with no hits', () => {
    expect(parseHnResponse('{"hits":[]}')).toEqual([]);
  });

  it('fetches end to end', async () => {
    const fetcher = createHackerNewsFetcher({ http: stub(HN_JSON) });
    const items = await fetcher.fetch({ url: '' });
    expect(items.length).toBeGreaterThan(0);
  });
});

describe('manual url fetcher', () => {
  it('prefers Open Graph metadata over the title tag', () => {
    const item = parsePageMetadata(HTML_PAGE, 'https://example.com/original');
    expect(item.title).toBe('The Open Graph Title');
    expect(item.summary).toBe('A description the publisher chose.');
  });

  it('prefers the canonical og:url over the requested URL', () => {
    const item = parsePageMetadata(HTML_PAGE, 'https://example.com/original');
    expect(item.url).toBe('https://example.com/canonical-post');
  });

  it('reads the publication date', () => {
    const item = parsePageMetadata(HTML_PAGE, 'https://example.com/x');
    expect(item.publishedAt?.toISOString()).toBe('2026-09-21T08:00:00.000Z');
  });

  it('falls back to the title tag when there is no Open Graph', () => {
    const item = parsePageMetadata(HTML_MINIMAL, 'https://example.com/min');
    expect(item.title).toBe('Just a title');
    expect(item.url).toBe('https://example.com/min');
  });

  it('extracts body text without navigation, headers or scripts', () => {
    const text = extractReadableText(HTML_PAGE);
    expect(text).toContain('OpenAI released a new reasoning model');
    expect(text).not.toContain('Home About Contact');
    expect(text).not.toContain('Site header text');
    expect(text).not.toContain('Copyright notice');
    expect(text).not.toContain('var tracking');
  });

  it('records where a redirect actually landed', async () => {
    const redirecting: HttpClient = async () => ({
      status: 200,
      body: HTML_MINIMAL,
      finalUrl: 'https://example.com/real-destination',
    });
    const fetcher = createManualUrlFetcher({ http: redirecting });
    const items = await fetcher.fetch({ url: 'https://t.co/shortened' });
    expect(items[0]?.url).toBe('https://example.com/real-destination');
  });
});

describe('fetcher registry', () => {
  it('provides a fetcher for every configurable kind', () => {
    const registry = createFetcherRegistry(stub(''));
    for (const kind of ['RSS', 'ATOM', 'ARXIV', 'HACKER_NEWS', 'MANUAL'] as const) {
      expect(registry[kind], kind).toBeDefined();
      expect(registry[kind].kind).toBe(kind);
    }
  });
});
