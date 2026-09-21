import { describe, expect, it } from 'vitest';

import {
  type PillarTerms,
  TRIAGE_THRESHOLD,
  meetsTriageThreshold,
  scoreRelevance,
} from './relevance';

/** The §10 pillars, as they will be seeded. */
const PILLARS: PillarTerms[] = [
  {
    pillarId: 1,
    slug: 'ai-news',
    terms: ['released', 'launch', 'announces', 'model release', 'available'],
    weakTerms: ['update', 'version'],
  },
  {
    pillarId: 2,
    slug: 'ai-research',
    terms: ['paper', 'arxiv', 'benchmark', 'research', 'study'],
    weakTerms: ['results', 'evaluation'],
  },
  {
    pillarId: 3,
    slug: 'ai-careers',
    terms: ['jobs', 'hiring', 'career', 'salary', 'roles', 'skills'],
    weakTerms: ['team', 'recruiting'],
  },
  {
    pillarId: 4,
    slug: 'practical-ai',
    terms: ['workflow', 'tutorial', 'how to use', 'productivity', 'automation'],
    weakTerms: ['tool', 'tips'],
  },
];

describe('scoreRelevance', () => {
  it('attributes a release story to the news pillar', () => {
    const result = scoreRelevance(
      {
        title: 'OpenAI announces GPT-5, now available to developers',
        summary: 'The model is available today.',
      },
      PILLARS,
    );
    expect(result.pillarSlug).toBe('ai-news');
    expect(result.score).toBeGreaterThan(TRIAGE_THRESHOLD);
  });

  it('attributes a paper to the research pillar', () => {
    const result = scoreRelevance(
      {
        title: 'New arxiv paper sets a benchmark record for reasoning',
        summary: 'The research introduces a novel method.',
      },
      PILLARS,
    );
    expect(result.pillarSlug).toBe('ai-research');
  });

  it('attributes a hiring story to the careers pillar', () => {
    const result = scoreRelevance(
      {
        title: 'AI jobs and hiring trends: which roles are growing',
        summary: 'Salary data across engineering careers.',
      },
      PILLARS,
    );
    expect(result.pillarSlug).toBe('ai-careers');
  });

  it('weights the title above the summary', () => {
    const inTitle = scoreRelevance(
      { title: 'A new benchmark paper', summary: 'Unrelated text here.' },
      PILLARS,
    );
    const inSummary = scoreRelevance(
      { title: 'Unrelated text here', summary: 'A new benchmark paper.' },
      PILLARS,
    );
    expect(inTitle.score).toBeGreaterThan(inSummary.score);
  });

  it('scores off-topic items at zero', () => {
    const result = scoreRelevance(
      { title: 'Local bakery wins regional pastry award', summary: 'Cakes.' },
      PILLARS,
    );
    expect(result.score).toBe(0);
    expect(result.pillarId).toBeNull();
    expect(meetsTriageThreshold(result.score)).toBe(false);
  });

  it('still surfaces a clearly-AI item that matches no pillar', () => {
    const result = scoreRelevance(
      {
        title: 'Anthropic and OpenAI comment on machine learning policy',
        summary: 'A discussion of artificial intelligence governance.',
      },
      PILLARS,
    );
    expect(result.pillarId).toBeNull();
    expect(result.score).toBeGreaterThan(0);
  });

  it('saturates rather than growing without bound', () => {
    const result = scoreRelevance(
      {
        title:
          'paper arxiv benchmark research study paper arxiv benchmark research study',
        summary: 'paper arxiv benchmark research study',
      },
      PILLARS,
    );
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('explains itself by returning the matched terms', () => {
    const result = scoreRelevance(
      { title: 'New benchmark paper released', summary: '' },
      PILLARS,
    );
    expect(result.matched.length).toBeGreaterThan(0);
  });

  it('handles a missing summary', () => {
    expect(() =>
      scoreRelevance({ title: 'Something about AI' }, PILLARS),
    ).not.toThrow();
  });

  it('handles an empty pillar list', () => {
    const result = scoreRelevance(
      { title: 'OpenAI releases a model' },
      [],
    );
    expect(result.pillarId).toBeNull();
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('does not match a term inside a longer word', () => {
    // "study" must not match "studying rocks"; whole-word matching only.
    const result = scoreRelevance(
      { title: 'Geology students studies rocks in Wales', summary: '' },
      PILLARS,
    );
    expect(result.pillarSlug).not.toBe('ai-research');
  });
});
