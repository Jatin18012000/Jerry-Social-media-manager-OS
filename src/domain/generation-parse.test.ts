import { describe, expect, it } from 'vitest';

import {
  normaliseHashtags,
  parseGeneration,
  parseHeadings,
} from './generation-parse';

const WELL_FORMED = `Here you go!

\`\`\`json
{
  "hook": "OpenAI just shipped something quietly significant.",
  "body": "Line one.\\nLine two.",
  "caption": "The caption as posted.",
  "cta": "Follow for more.",
  "hashtags": ["#AI", "OpenAI", "#ai"],
  "altText": "A screenshot of the announcement."
}
\`\`\`

Let me know if you want a variant.`;

describe('normaliseHashtags', () => {
  it('strips leading hashes and deduplicates case-insensitively', () => {
    expect(normaliseHashtags(['#AI', 'ai', '#OpenAI'])).toEqual([
      'AI',
      'OpenAI',
    ]);
  });

  it('accepts a space-separated string', () => {
    expect(normaliseHashtags('#ai #tech')).toEqual(['ai', 'tech']);
  });

  it('accepts a comma-separated string', () => {
    expect(normaliseHashtags('ai, tech, careers')).toEqual([
      'ai',
      'tech',
      'careers',
    ]);
  });

  it('returns nothing for unusable input', () => {
    expect(normaliseHashtags(null)).toEqual([]);
    expect(normaliseHashtags(42)).toEqual([]);
    expect(normaliseHashtags(['', '  ', '#'])).toEqual([]);
  });
});

describe('parseGeneration — fenced JSON, the contracted shape', () => {
  it('extracts every field', () => {
    const result = parseGeneration(WELL_FORMED);
    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('FENCED_JSON');
    expect(result.parsed.hook).toContain('quietly significant');
    expect(result.parsed.body).toBe('Line one.\nLine two.');
    expect(result.parsed.caption).toBe('The caption as posted.');
    expect(result.parsed.cta).toBe('Follow for more.');
    expect(result.parsed.altText).toContain('screenshot');
    expect(result.missing).toEqual([]);
  });

  it('deduplicates hashtags from the response', () => {
    expect(parseGeneration(WELL_FORMED).parsed.hashtags).toEqual([
      'AI',
      'OpenAI',
    ]);
  });

  it('ignores prose before and after the block', () => {
    expect(parseGeneration(WELL_FORMED).parsed.hook).not.toContain('Here you go');
  });

  it('handles a bare ``` fence with no language tag', () => {
    const input = '```\n{"hook":"H","body":"B","caption":"C"}\n```';
    expect(parseGeneration(input).strategy).toBe('FENCED_JSON');
  });
});

describe('parseGeneration — tolerating what models actually return', () => {
  it('falls back to bare JSON with no fence', () => {
    const input = '{"hook":"H","body":"B","caption":"C","hashtags":["x"]}';
    const result = parseGeneration(input);
    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('BARE_JSON');
  });

  it('accepts synonym keys rather than demanding a re-run', () => {
    const input = '{"Hook Line":"H","content":"B","post":"C"}';
    const result = parseGeneration(input);
    expect(result.parsed.hook).toBe('H');
    expect(result.parsed.body).toBe('B');
    expect(result.parsed.caption).toBe('C');
  });

  it('flattens a body given as a list of slides', () => {
    const input = JSON.stringify({
      hook: 'H',
      caption: 'C',
      body: ['First slide', 'Second slide'],
    });
    const result = parseGeneration(input);
    expect(result.parsed.body).toBe('1. First slide\n2. Second slide');
  });

  it('flattens slides given as objects', () => {
    const input = JSON.stringify({
      hook: 'H',
      caption: 'C',
      slides: [{ title: 'One', text: 'Body one' }],
    });
    expect(parseGeneration(input).parsed.body).toContain('One — Body one');
  });

  it('accepts hashtags as a single string', () => {
    const input = '{"hook":"H","body":"B","caption":"C","hashtags":"#ai #ml"}';
    expect(parseGeneration(input).parsed.hashtags).toEqual(['ai', 'ml']);
  });
});

describe('parseGeneration — heading fallback', () => {
  const MARKDOWN = `## Hook
This is the hook line.

## Body
First paragraph.
Second paragraph.

## Caption
The caption text.

## Hashtags
#ai #careers

## Alt text
An illustration.`;

  it('recovers fields from markdown headings', () => {
    const result = parseGeneration(MARKDOWN);
    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('HEADINGS');
    expect(result.parsed.hook).toBe('This is the hook line.');
    expect(result.parsed.body).toBe('First paragraph.\nSecond paragraph.');
    expect(result.parsed.hashtags).toEqual(['ai', 'careers']);
    expect(result.parsed.altText).toBe('An illustration.');
  });

  it('recovers from bold labels', () => {
    const input = '**Hook**\nThe hook.\n\n**Caption**\nThe caption.';
    const result = parseGeneration(input);
    expect(result.parsed.hook).toBe('The hook.');
    expect(result.parsed.caption).toBe('The caption.');
  });

  it('recovers from inline "Label: value" lines', () => {
    const input = 'Hook: The hook line\nCaption: The caption line';
    const result = parseHeadings(input);
    expect(result.hook).toBe('The hook line');
    expect(result.caption).toBe('The caption line');
  });

  it('reports which fields it could not find', () => {
    const result = parseGeneration('## Hook\nOnly a hook here.');
    expect(result.ok).toBe(true);
    expect(result.missing).toContain('caption');
    expect(result.missing).toContain('body');
  });
});

describe('parseGeneration — never losing the human’s work', () => {
  it('keeps the whole paste as the body when nothing parses', () => {
    // Under D3 this text cost real effort. It must survive a parse failure.
    const raw = 'Just some unstructured prose the model wrote.';
    const result = parseGeneration(raw);
    expect(result.ok).toBe(false);
    expect(result.strategy).toBe('NONE');
    expect(result.parsed.body).toBe(raw);
    expect(result.error).toContain('kept as the body');
  });

  it('does not throw on malformed JSON — it degrades', () => {
    const raw = '```json\n{"hook": "unterminated\n```';
    expect(() => parseGeneration(raw)).not.toThrow();
    expect(parseGeneration(raw).parsed.body).toContain('unterminated');
  });

  it('does not throw on JSON that is an array', () => {
    expect(() => parseGeneration('[1,2,3]')).not.toThrow();
  });

  it('reports empty input as empty rather than as a parse failure', () => {
    const result = parseGeneration('   ');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Nothing was pasted.');
    expect(result.parsed.body).toBeNull();
  });

  it('treats a JSON object with no usable fields as unparsed', () => {
    const result = parseGeneration('{"unrelated": "value"}');
    expect(result.ok).toBe(false);
    // Still keeps the text rather than discarding it.
    expect(result.parsed.body).toContain('unrelated');
  });
});
