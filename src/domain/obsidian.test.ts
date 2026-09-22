import { describe, expect, it } from 'vitest';

import {
  GENERATED_END,
  GENERATED_START,
  frontmatter,
  mergeGenerated,
  notePath,
  renderPublishedNote,
  renderResearchNote,
  slugify,
  wikilink,
  wrapGenerated,
  yamlValue,
} from './obsidian';

describe('slugify — titles come from RSS feeds, so this is security code', () => {
  it('makes an ordinary title into a slug', () => {
    expect(slugify('OpenAI ships a reasoning model')).toBe(
      'openai-ships-a-reasoning-model',
    );
  });

  it('strips path separators', () => {
    // A title is used to build a path on Jatin's machine. It must not be able
    // to escape the vault.
    expect(slugify('../../.ssh/config')).not.toContain('/');
    expect(slugify('../../.ssh/config')).not.toContain('.');
    expect(slugify('a\\b\\c')).not.toContain('\\');
  });

  it('cannot traverse upwards', () => {
    for (const nasty of [
      '../../etc/passwd',
      '..',
      '../..',
      './hidden',
      '....//....//etc',
    ]) {
      const slug = slugify(nasty);
      expect(slug).not.toContain('..');
      expect(slug).not.toContain('/');
      expect(slug.startsWith('.')).toBe(false);
    }
  });

  it('strips null bytes and control characters', () => {
    const slug = slugify('title\u0000with\u0007control');
    expect(slug).not.toContain('\u0000');
    expect(slug).not.toContain('\u0007');
  });

  it('never produces a leading dot, which would hide the file', () => {
    expect(slugify('.hidden').startsWith('.')).toBe(false);
  });

  it('never produces an empty name', () => {
    expect(slugify('')).toBe('untitled');
    expect(slugify('///')).toBe('untitled');
    expect(slugify('...')).toBe('untitled');
    expect(slugify('   ')).toBe('untitled');
  });

  it('avoids names reserved by the operating system', () => {
    expect(slugify('CON')).toBe('con-note');
    expect(slugify('nul')).toBe('nul-note');
  });

  it('caps the length so a long headline cannot break the filesystem', () => {
    expect(slugify('word '.repeat(200)).length).toBeLessThanOrEqual(80);
  });

  it('leaves no trailing hyphen after truncation', () => {
    expect(slugify('word '.repeat(200)).endsWith('-')).toBe(false);
  });

  it('keeps non-Latin scripts rather than emptying the name', () => {
    expect(slugify('एआई मॉडल जारी')).toContain('एआई');
  });

  it('keeps version numbers, which carry the meaning', () => {
    expect(slugify('GPT-5 released')).toContain('5');
  });
});

describe('notePath', () => {
  it('includes the id, so two identical titles cannot collide', () => {
    expect(notePath('Research', 42, 'A title')).toBe('Research/42-a-title.md');
    expect(notePath('Research', 43, 'A title')).toBe('Research/43-a-title.md');
  });

  it('stays inside its folder even for a hostile title', () => {
    const path = notePath('Research', 1, '../../escape');
    expect(path.startsWith('Research/')).toBe(true);
    expect(path.split('/')).toHaveLength(2);
  });
});

describe('yamlValue', () => {
  it('quotes and escapes strings', () => {
    expect(yamlValue('plain')).toBe('"plain"');
    expect(yamlValue('has "quotes"')).toBe('"has \\"quotes\\""');
    expect(yamlValue('back\\slash')).toBe('"back\\\\slash"');
  });

  it('handles a title with a colon, which breaks naive frontmatter', () => {
    expect(yamlValue('OpenAI: a new model')).toBe('"OpenAI: a new model"');
  });

  it('flattens newlines, which are invalid in a quoted scalar', () => {
    expect(yamlValue('two\nlines')).toBe('"two lines"');
  });

  it('passes numbers and booleans through unquoted', () => {
    expect(yamlValue(42)).toBe('42');
    expect(yamlValue(0.82)).toBe('0.82');
    expect(yamlValue(true)).toBe('true');
  });

  it('writes null for absent values', () => {
    expect(yamlValue(null)).toBe('null');
    expect(yamlValue(undefined)).toBe('null');
  });

  it('writes null rather than NaN or Infinity', () => {
    expect(yamlValue(Number.NaN)).toBe('null');
    expect(yamlValue(Number.POSITIVE_INFINITY)).toBe('null');
  });

  it('renders arrays inline', () => {
    expect(yamlValue(['a', 'b'])).toBe('["a", "b"]');
    expect(yamlValue([])).toBe('[]');
  });
});

describe('frontmatter', () => {
  it('produces a delimited block', () => {
    const block = frontmatter({ type: 'research', smos_id: 7 });
    expect(block.startsWith('---\n')).toBe(true);
    expect(block.endsWith('\n---')).toBe(true);
    expect(block).toContain('smos_id: 7');
  });

  it('omits undefined fields but keeps explicit nulls', () => {
    const block = frontmatter({ a: undefined, b: null });
    expect(block).not.toContain('a:');
    expect(block).toContain('b: null');
  });
});

describe('wikilink', () => {
  it('links a note', () => {
    expect(wikilink('42-a-title')).toBe('[[42-a-title]]');
  });

  it('supports an alias', () => {
    expect(wikilink('42-a-title', 'A title')).toBe('[[42-a-title|A title]]');
  });

  it('strips the characters that would break the link', () => {
    // A pipe would be read as an alias separator and ]] would close early.
    expect(wikilink('a|b]]c')).not.toContain('|');
    expect(wikilink('a|b]]c')).toBe('[[a b c]]');
  });

  it('returns nothing rather than an empty link', () => {
    expect(wikilink('')).toBe('');
    expect(wikilink('|||')).toBe('');
  });
});

describe('mergeGenerated — never eat the human’s notes', () => {
  it('replaces only the generated region', () => {
    const existing = wrapGenerated('old body') + 'My own thoughts here.\n';
    const merged = mergeGenerated(existing, 'new body');

    expect(merged).toContain('new body');
    expect(merged).not.toContain('old body');
    // Silently overwriting someone's notes is the kind of data loss that
    // makes a tool untrustworthy after exactly one occurrence.
    expect(merged).toContain('My own thoughts here.');
  });

  it('keeps the "My notes" heading and anything under it', () => {
    const existing = `${wrapGenerated('old')}Something I wrote.`;
    const merged = mergeGenerated(existing, 'new');
    expect(merged).toContain('## My notes');
    expect(merged).toContain('Something I wrote.');
  });

  it('keeps a hand-written note entirely when there are no markers', () => {
    // A file the user created at the same path, or one from an older export.
    const handWritten = '# My own note\n\nEverything I know about this.\n';
    const merged = mergeGenerated(handWritten, 'generated body');

    expect(merged).toContain('Everything I know about this.');
    expect(merged).toContain('generated body');
  });

  it('puts the generated block above pre-existing content', () => {
    const merged = mergeGenerated('Existing text.', 'generated');
    expect(merged.indexOf('generated')).toBeLessThan(
      merged.indexOf('Existing text.'),
    );
  });

  it('is idempotent — merging twice changes nothing further', () => {
    const first = mergeGenerated(wrapGenerated('a') + 'mine', 'b');
    const second = mergeGenerated(first, 'b');
    expect(second).toBe(first);
  });

  it('survives markers in the wrong order rather than mangling the file', () => {
    const broken = `${GENERATED_END}\nstuff\n${GENERATED_START}`;
    const merged = mergeGenerated(broken, 'new');
    expect(merged).toContain('stuff');
    expect(merged).toContain('new');
  });
});

describe('renderResearchNote', () => {
  const note = {
    id: 42,
    title: 'OpenAI: a new model',
    summary: 'A summary.',
    url: 'https://openai.com/news/x',
    sourceName: 'OpenAI Blog',
    credibilityTier: 'PRIMARY' as const,
    publishedAt: Date.parse('2026-09-20T00:00:00Z'),
    discoveredAt: Date.parse('2026-09-21T00:00:00Z'),
    relevanceScore: 0.82,
    status: 'NEW',
    pillarName: 'AI News',
    claims: [
      {
        text: 'OpenAI released a model.',
        claimType: 'FACT' as const,
        verificationStatus: 'VERIFIED' as const,
        evidenceUrl: 'https://openai.com/news/x',
        evidenceTier: 'PRIMARY' as const,
      },
      {
        text: 'It will expand next year.',
        claimType: 'PREDICTION' as const,
        verificationStatus: 'UNVERIFIED' as const,
        evidenceUrl: null,
        evidenceTier: null,
      },
    ],
  };

  it('carries the metadata in frontmatter', () => {
    const md = renderResearchNote(note);
    expect(md).toContain('type: "research"');
    expect(md).toContain('smos_id: 42');
    expect(md).toContain('source_tier: "PRIMARY"');
    expect(md).toContain('relevance: 0.82');
  });

  it('survives a colon in the title', () => {
    expect(renderResearchNote(note)).toContain('title: "OpenAI: a new model"');
  });

  it('shows every claim with its §7.3 type and status', () => {
    const md = renderResearchNote(note);
    expect(md).toContain('**FACT** · VERIFIED');
    expect(md).toContain('**PREDICTION** · UNVERIFIED');
  });

  it('warns about unverified claims rather than letting them read as fact', () => {
    expect(renderResearchNote(note)).toContain('1 of these claims are unverified');
  });

  it('wraps the body in generated markers', () => {
    const md = renderResearchNote(note);
    expect(md).toContain(GENERATED_START);
    expect(md).toContain(GENERATED_END);
  });
});

describe('renderPublishedNote', () => {
  const base = {
    id: 7,
    title: 'A reel',
    platform: 'INSTAGRAM',
    format: 'REEL',
    language: 'EN',
    characterMode: 'HUMAN',
    publishedAt: Date.parse('2026-09-21T00:00:00Z'),
    externalUrl: 'https://instagram.com/p/x',
    hook: 'A hook.',
    body: 'A body.',
    caption: 'A caption.',
    cta: 'Follow.',
    hashtags: 'ai openai',
    pillarName: 'AI News',
    opportunity: { id: 3, title: 'The launch' },
    metrics: null,
  };

  it('links back to the opportunity', () => {
    expect(renderPublishedNote(base)).toContain('[[3-the-launch|The launch]]');
  });

  it('says so plainly when no metrics exist', () => {
    expect(renderPublishedNote(base)).toContain('No metrics captured yet.');
  });

  it('renders an unreported metric as a dash, never zero', () => {
    // §40's absent-versus-zero rule reaches the vault too: a 0 here would
    // read as a post that reached nobody.
    const md = renderPublishedNote({
      ...base,
      metrics: {
        impressions: 10_000,
        reach: null,
        likes: 100,
        comments: null,
        saves: null,
        shares: null,
        follows: 25,
        followsPerThousand: 2.5,
        engagementRatePct: 1.25,
        capturedAt: Date.parse('2026-09-22T00:00:00Z'),
      },
    });

    expect(md).toContain('| Comments | — |');
    expect(md).toContain('| **Follows / 1k** | 2.50 |');
    expect(md).toContain('not reported, not zero');
  });

  it('puts the north star in frontmatter so the vault can sort by it', () => {
    const md = renderPublishedNote({
      ...base,
      metrics: {
        impressions: 1000,
        reach: null,
        likes: null,
        comments: null,
        saves: null,
        shares: null,
        follows: 10,
        followsPerThousand: 10,
        engagementRatePct: null,
        capturedAt: Date.now(),
      },
    });
    expect(md).toContain('follows_per_1k: 10');
  });
});
