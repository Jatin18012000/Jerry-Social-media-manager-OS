import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HttpError, fetchHttp, fetchOk } from './http';
import { createFeedFetcher } from './fetchers/feed-fetcher';
import { RSS_2_0 } from './fetchers/__fixtures__/feeds';

/**
 * The only test that exercises the real HTTP client.
 *
 * Every other fetcher test injects a stub, which is right — a suite that
 * depends on a live feed fails for reasons unrelated to the code. But that
 * leaves fetchHttp itself untested, so this runs it against a local server on
 * an ephemeral port: real sockets, real redirects, no external network.
 */

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';

    if (url === '/feed.xml') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      res.end(RSS_2_0);
      return;
    }

    if (url === '/redirect') {
      res.writeHead(302, { Location: '/feed.xml' });
      res.end();
      return;
    }

    if (url === '/boom') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('internal error');
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('fetchHttp', () => {
  it('fetches a document over a real socket', async () => {
    const response = await fetchHttp(`${base}/feed.xml`);
    expect(response.status).toBe(200);
    expect(response.body).toContain('We released a new model');
  });

  it('follows a redirect and reports where it landed', async () => {
    const response = await fetchHttp(`${base}/redirect`);
    expect(response.status).toBe(200);
    expect(response.finalUrl).toContain('/feed.xml');
  });

  it('returns a non-2xx status rather than throwing', async () => {
    const response = await fetchHttp(`${base}/missing`);
    expect(response.status).toBe(404);
  });

  it('aborts a request that exceeds its timeout', async () => {
    const slow = createServer((_req, res) => {
      // Never responds, so only the timeout can end this.
      void res;
    });
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const { port } = slow.address() as AddressInfo;

    try {
      await expect(
        fetchHttp(`http://127.0.0.1:${port}/hang`, { timeoutMs: 150 }),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => {
        slow.closeAllConnections?.();
        slow.close(() => resolve());
      });
    }
  });
});

describe('fetchOk', () => {
  it('passes a 2xx response through', async () => {
    const response = await fetchOk(fetchHttp, `${base}/feed.xml`);
    expect(response.status).toBe(200);
  });

  it('throws on 404 so callers never parse an error page', async () => {
    await expect(fetchOk(fetchHttp, `${base}/missing`)).rejects.toThrow(
      HttpError,
    );
  });

  it('throws on 500', async () => {
    await expect(fetchOk(fetchHttp, `${base}/boom`)).rejects.toThrow(HttpError);
  });
});

describe('feed fetcher over real HTTP', () => {
  it('fetches and parses a feed end to end', async () => {
    // The full path with nothing stubbed: socket, HTTP, XML parse, mapping.
    const fetcher = createFeedFetcher();
    const items = await fetcher.fetch({ url: `${base}/feed.xml` });
    expect(items).toHaveLength(2);
    expect(items[0]?.url).toBe('https://example.com/blog/new-model');
    expect(items[0]?.summary).toBe(
      'Today we released a new model for developers.',
    );
  });
});
