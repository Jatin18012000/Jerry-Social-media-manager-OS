import { describe, expect, it } from 'vitest';

import {
  canonicalUrl,
  classifyDuplicate,
  dedupeKey,
  significantTokens,
  stem,
  titleSimilarity,
} from './dedupe';

describe('canonicalUrl', () => {
  it('strips tracking parameters but keeps meaningful ones', () => {
    expect(
      canonicalUrl('https://example.com/post?utm_source=x&id=42&fbclid=abc'),
    ).toBe('https://example.com/post?id=42');
  });

  it('lowercases the host and drops www', () => {
    expect(canonicalUrl('https://WWW.Example.COM/Post')).toBe(
      'https://example.com/Post',
    );
  });

  it('keeps path case — paths can be case-sensitive', () => {
    expect(canonicalUrl('https://example.com/AbC')).toContain('/AbC');
  });

  it('drops the fragment', () => {
    expect(canonicalUrl('https://example.com/post#section-2')).toBe(
      'https://example.com/post',
    );
  });

  it('normalises a trailing slash', () => {
    expect(canonicalUrl('https://example.com/post/')).toBe(
      canonicalUrl('https://example.com/post'),
    );
  });

  it('orders query parameters so order is not an identity', () => {
    expect(canonicalUrl('https://example.com/p?b=2&a=1')).toBe(
      canonicalUrl('https://example.com/p?a=1&b=2'),
    );
  });

  it('returns unparseable input rather than throwing', () => {
    // Throwing here would silently drop a research item.
    expect(canonicalUrl('not a url')).toBe('not a url');
  });
});

describe('significantTokens', () => {
  it('drops stopwords and punctuation', () => {
    expect(significantTokens('The release of a new model!')).toEqual([
      'release',
      'model',
    ]);
  });

  it('keeps version numbers, which carry the meaning in AI news', () => {
    expect(significantTokens('GPT-5 and Claude 4')).toContain('5');
    expect(significantTokens('GPT-5 and Claude 4')).toContain('4');
  });
});

describe('dedupeKey', () => {
  it('is stable across word order', () => {
    expect(dedupeKey('OpenAI releases GPT-5')).toBe(
      dedupeKey('GPT-5 released by OpenAI'),
    );
  });

  it('differs for genuinely different stories', () => {
    expect(dedupeKey('OpenAI releases GPT-5')).not.toBe(
      dedupeKey('Anthropic releases Claude'),
    );
  });
});

describe('titleSimilarity', () => {
  it('is 1 for identical titles', () => {
    expect(titleSimilarity('AI model released', 'AI model released')).toBe(1);
  });

  it('is 0 for disjoint titles', () => {
    expect(titleSimilarity('quantum computing paper', 'new phone launch')).toBe(
      0,
    );
  });

  it('is high for the same story worded differently', () => {
    const score = titleSimilarity(
      'OpenAI announces GPT-5 model',
      'OpenAI GPT-5 model announced',
    );
    expect(score).toBeGreaterThan(0.6);
  });
});

describe('classifyDuplicate', () => {
  const existing = [
    {
      id: 1,
      title: 'OpenAI announces GPT-5',
      url: 'https://openai.com/blog/gpt-5',
      publishedAt: new Date('2026-09-20T10:00:00Z'),
    },
  ];

  it('treats the same canonical URL as decisive', () => {
    const verdict = classifyDuplicate(
      {
        title: 'Completely different headline',
        url: 'https://www.openai.com/blog/gpt-5?utm_source=twitter',
      },
      existing,
    );
    expect(verdict.isDuplicate).toBe(true);
    expect(verdict.reason).toBe('SAME_URL');
    expect(verdict.of).toBe(1);
  });

  it('flags the same story reported by another source', () => {
    const verdict = classifyDuplicate(
      {
        title: 'GPT-5 announced by OpenAI',
        url: 'https://techcrunch.com/openai-gpt-5',
        publishedAt: new Date('2026-09-20T14:00:00Z'),
      },
      existing,
    );
    expect(verdict.isDuplicate).toBe(true);
    expect(verdict.reason).toBe('SIMILAR_TITLE');
    expect(verdict.of).toBe(1);
  });

  it('does not merge unrelated stories', () => {
    const verdict = classifyDuplicate(
      {
        title: 'Google publishes quantum error correction results',
        url: 'https://example.com/quantum',
        publishedAt: new Date('2026-09-20T12:00:00Z'),
      },
      existing,
    );
    expect(verdict.isDuplicate).toBe(false);
    expect(verdict.reason).toBe('DISTINCT');
  });

  it('does not merge a recurring topic across months', () => {
    // "OpenAI announces a new model" in January and June are two stories.
    const verdict = classifyDuplicate(
      {
        title: 'OpenAI announces GPT-5',
        url: 'https://example.com/later-coverage',
        publishedAt: new Date('2027-03-01T10:00:00Z'),
      },
      existing,
    );
    expect(verdict.isDuplicate).toBe(false);
  });

  it('still matches when a publication date is unknown', () => {
    const verdict = classifyDuplicate(
      { title: 'GPT-5 announced by OpenAI', url: 'https://example.com/x' },
      existing,
    );
    expect(verdict.isDuplicate).toBe(true);
  });

  it('reports no duplicate against an empty store', () => {
    const verdict = classifyDuplicate(
      { title: 'Anything', url: 'https://example.com/a' },
      [],
    );
    expect(verdict.isDuplicate).toBe(false);
  });
});

describe('stem', () => {
  it('collapses inflections of one verb', () => {
    const forms = ['release', 'releases', 'released'].map(stem);
    expect(new Set(forms).size).toBe(1);
  });

  it('collapses announce/announces/announced', () => {
    const forms = ['announce', 'announces', 'announced'].map(stem);
    expect(new Set(forms).size).toBe(1);
  });

  it('never merges tokens containing digits', () => {
    // "gpt-5" and "gpt-4" are different products, not inflections.
    expect(stem('gpt5')).not.toBe(stem('gpt4'));
    expect(stem('4o')).toBe('4o');
  });

  it('leaves short tokens alone', () => {
    expect(stem('ai')).toBe('ai');
    expect(stem('llm')).toBe('llm');
  });

  it('does not over-strip into an ambiguous stub', () => {
    expect(stem('model').length).toBeGreaterThan(3);
  });
});
