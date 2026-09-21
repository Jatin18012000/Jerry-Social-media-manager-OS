/**
 * Feed fixtures.
 *
 * Hand-written to match the shapes real feeds actually use, including the
 * awkward ones: CDATA, HTML inside descriptions, Atom's attribute-based links
 * with several rel values, and RSS 1.0's RDF layout.
 */

export const RSS_2_0 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example AI Blog</title>
    <link>https://example.com</link>
    <item>
      <title>We released a new model</title>
      <link>https://example.com/blog/new-model</link>
      <description><![CDATA[<p>Today we <b>released</b> a new model for developers.</p>]]></description>
      <pubDate>Sun, 20 Sep 2026 10:00:00 GMT</pubDate>
      <guid>https://example.com/blog/new-model</guid>
    </item>
    <item>
      <title>A second post</title>
      <link>https://example.com/blog/second</link>
      <description>Plain text summary &amp; entity.</description>
      <pubDate>Mon, 14 Sep 2026 08:30:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

export const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom Feed</title>
  <entry>
    <title>Atom entry title</title>
    <link rel="self" href="https://example.com/feed/self"/>
    <link rel="alternate" href="https://example.com/posts/atom-entry"/>
    <id>tag:example.com,2026:post-1</id>
    <published>2026-09-19T12:00:00Z</published>
    <summary type="html">&lt;p&gt;An Atom summary with markup.&lt;/p&gt;</summary>
  </entry>
</feed>`;

/** RSS 1.0 — items are siblings of channel, not children. */
export const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://example.com">
    <title>RDF feed</title>
  </channel>
  <item rdf:about="https://example.com/rdf-item">
    <title>An RDF item</title>
    <link>https://example.com/rdf-item</link>
    <description>Summary from an RDF feed.</description>
    <dc:date>2026-09-18T09:00:00Z</dc:date>
  </item>
</rdf:RDF>`;

/** A single-item feed: fast-xml-parser yields an object, not an array. */
export const RSS_SINGLE_ITEM = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>One item</title>
    <item>
      <title>The only post</title>
      <link>https://example.com/only</link>
      <pubDate>Sat, 19 Sep 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

export const EMPTY_RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Nothing here</title></channel></rss>`;

export const ARXIV_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2609.01234v1</id>
    <updated>2026-09-20T17:59:59Z</updated>
    <published>2026-09-20T17:59:59Z</published>
    <title>Scaling Laws for
      Retrieval Augmented Models</title>
    <summary>  We study how retrieval augmentation
interacts with scale. Our experiments suggest that retrieval
reduces the parameter count required.
    </summary>
    <link href="http://arxiv.org/abs/2609.01234v1" rel="alternate" type="text/html"/>
  </entry>
</feed>`;

export const HN_JSON = JSON.stringify({
  hits: [
    {
      objectID: '41000001',
      title: 'Show HN: An open-source LLM inference server',
      url: 'https://github.com/example/server',
      points: 412,
      num_comments: 133,
      created_at: '2026-09-20T09:12:00.000Z',
    },
    {
      objectID: '41000002',
      title: 'Ask HN: How are you using AI agents in production?',
      url: null,
      story_url: null,
      points: 256,
      num_comments: 301,
      created_at: '2026-09-19T14:02:00.000Z',
    },
    {
      objectID: '41000003',
      title: null,
      story_title: null,
      url: 'https://example.com/no-title',
      points: 150,
      created_at: '2026-09-18T10:00:00.000Z',
    },
  ],
});

export const HTML_PAGE = `<!doctype html>
<html>
  <head>
    <title>Fallback title tag</title>
    <meta property="og:title" content="The Open Graph Title" />
    <meta property="og:description" content="A description the publisher chose." />
    <meta property="og:url" content="https://example.com/canonical-post" />
    <meta property="article:published_time" content="2026-09-21T08:00:00Z" />
  </head>
  <body>
    <nav>Home About Contact</nav>
    <header>Site header text</header>
    <article>
      <p>OpenAI released a new reasoning model for developers today.</p>
      <p>The company will expand availability next year.</p>
    </article>
    <footer>Copyright notice</footer>
    <script>var tracking = 1;</script>
  </body>
</html>`;

/** A page with no Open Graph tags at all — the common minimal case. */
export const HTML_MINIMAL = `<!doctype html>
<html><head><title>  Just a title  </title></head>
<body><p>Some body text about a model launch.</p></body></html>`;
