import { describe, expect, it } from 'vitest';

import { createOllamaProvider, extractJson, ollamaFromEnv } from './ollama-provider';

/** A fetch that answers from a script, so no test needs Ollama running. */
function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });

function provider(fetchImpl: typeof fetch) {
  return createOllamaProvider({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'test-model',
    fetchImpl,
  });
}

/** Accepts {ok:true}; rejects anything else. Stands in for a real schema. */
const parseOkFlag = (raw: unknown): { ok: true } | null => {
  if (raw && typeof raw === 'object' && (raw as { ok?: unknown }).ok === true) {
    return { ok: true };
  }
  return null;
};

const task = {
  task: 'test',
  instruction: 'do the thing',
  input: { a: 1 },
  parse: parseOkFlag,
};

describe('extractJson', () => {
  it('reads a bare JSON object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads JSON out of a code fence', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('reads JSON surrounded by prose', () => {
    // Models do this constantly, even when asked not to.
    expect(extractJson('Sure! {"a":1} Hope that helps.')).toEqual({ a: 1 });
  });

  it('returns null for text with no JSON', () => {
    expect(extractJson('I cannot help with that.')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(extractJson('{"a": ')).toBeNull();
  });

  it('returns null for a bare array — the contract is an object', () => {
    expect(extractJson('[1,2,3]')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractJson('   ')).toBeNull();
  });
});

describe('available()', () => {
  it('is true when the daemon answers', async () => {
    const p = provider(stubFetch(() => ok({ models: [] })));
    expect(await p.available()).toBe(true);
  });

  it('is false when the daemon is not running', async () => {
    // A normal state, not an error: the caller falls back to heuristics.
    const p = provider(
      stubFetch(() => {
        throw new Error('ECONNREFUSED');
      }),
    );
    expect(await p.available()).toBe(false);
  });

  it('is false on a non-2xx response', async () => {
    const p = provider(stubFetch(() => new Response('', { status: 500 })));
    expect(await p.available()).toBe(false);
  });
});

describe('run() — success', () => {
  it('returns parsed output with metadata', async () => {
    const p = provider(
      stubFetch(() => ok({ message: { content: '{"ok":true}' } })),
    );
    const run = await p.run(task);

    expect(run.status).toBe('OK');
    expect(run.output).toEqual({ ok: true });
    expect(run.provider).toBe('ollama');
    expect(run.model).toBe('test-model');
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('sends the configured model and asks for JSON', async () => {
    let sent: Record<string, unknown> = {};
    const p = provider(
      stubFetch((_url, init) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return ok({ message: { content: '{"ok":true}' } });
      }),
    );
    await p.run(task);

    expect(sent['model']).toBe('test-model');
    expect(sent['format']).toBe('json');
    expect(sent['stream']).toBe(false);
  });
});

describe('run() — the model is never trusted', () => {
  it('rejects output that does not satisfy the parser', async () => {
    // A plausible-looking but wrong object must not get through. A
    // half-parsed classification is worse than none: it looks usable.
    const p = provider(
      stubFetch(() => ok({ message: { content: '{"ok":"yes"}' } })),
    );
    const run = await p.run(task);

    expect(run.status).toBe('INVALID_OUTPUT');
    expect(run.output).toBeNull();
  });

  it('rejects a response containing no JSON', async () => {
    const p = provider(
      stubFetch(() =>
        ok({ message: { content: 'I am not able to classify this.' } }),
      ),
    );
    expect((await p.run(task)).status).toBe('INVALID_OUTPUT');
  });

  it('rejects a response with no content at all', async () => {
    const p = provider(stubFetch(() => ok({ message: {} })));
    expect((await p.run(task)).status).toBe('INVALID_OUTPUT');
  });

  it('never returns a partial object', async () => {
    const p = provider(
      stubFetch(() => ok({ message: { content: '{"unrelated":1}' } })),
    );
    expect((await p.run(task)).output).toBeNull();
  });
});

describe('run() — failures are reported, never thrown', () => {
  it('reports an unreachable daemon as UNAVAILABLE', async () => {
    const p = provider(
      stubFetch(() => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const run = await p.run(task);
    expect(run.status).toBe('UNAVAILABLE');
    expect(run.error).toContain('ECONNREFUSED');
  });

  it('reports an HTTP error', async () => {
    const p = provider(stubFetch(() => new Response('', { status: 404 })));
    const run = await p.run(task);
    expect(run.status).toBe('ERROR');
    expect(run.error).toContain('404');
  });

  it('reports an error field in the body', async () => {
    const p = provider(stubFetch(() => ok({ error: 'model not found' })));
    const run = await p.run(task);
    expect(run.status).toBe('ERROR');
    expect(run.error).toBe('model not found');
  });

  it('reports a non-JSON response body', async () => {
    const p = provider(stubFetch(() => new Response('<html>', { status: 200 })));
    expect((await p.run(task)).status).toBe('INVALID_OUTPUT');
  });

  it('does not throw on any of these', async () => {
    const p = provider(
      stubFetch(() => {
        throw new Error('anything');
      }),
    );
    await expect(p.run(task)).resolves.toBeTruthy();
  });
});

describe('ollamaFromEnv', () => {
  it('builds a provider when both settings are present', () => {
    const p = ollamaFromEnv({
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
      OLLAMA_MODEL: 'qwen',
    });
    expect(p?.model).toBe('qwen');
  });

  it('returns null with no model configured', () => {
    // Null is a normal state: the system runs on heuristics without it.
    expect(
      ollamaFromEnv({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434' }),
    ).toBeNull();
  });

  it('returns null with no base URL configured', () => {
    expect(ollamaFromEnv({ OLLAMA_MODEL: 'qwen' })).toBeNull();
  });

  it('returns null with nothing configured', () => {
    expect(ollamaFromEnv({})).toBeNull();
  });
});
