/**
 * Ollama provider — local structured output, free (§32, §34, §36).
 *
 * Runs Qwen (or whatever model is configured) on the MacBook for the
 * repetitive judgement work: is this a duplicate, which pillar, how relevant,
 * what language. The automation guide is explicit that this is a worker, not a
 * strategic brain, and decision D3 keeps content generation human either way.
 *
 * Three rules shape this adapter:
 *
 *   The model is never trusted to produce the right shape. Its JSON is parsed
 *   and then validated by the caller's own parser. Anything that does not
 *   satisfy it returns null, not a half-filled object — a half-parsed
 *   classification is worse than none because it looks usable.
 *
 *   Unavailability is a normal outcome, not an error. The laptop may not be
 *   running Ollama. `available()` says so and the caller falls back to the
 *   deterministic heuristics rather than failing.
 *
 *   The model name is configuration, never hardcoded. §7.1 forbids inventing
 *   model capabilities, and the exact tag has not been verified from the
 *   development sandbox. Whatever `ollama list` reports on the real machine is
 *   what goes in OLLAMA_MODEL.
 */

import type { StructuredProvider, StructuredRun, StructuredTask } from '@/ports';

export interface OllamaOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 60_000;

interface OllamaChatResponse {
  readonly message?: { readonly content?: string };
  readonly error?: string;
}

/**
 * Pulls a JSON object out of a model response.
 *
 * Even asked for JSON, models wrap it in prose or a code fence often enough
 * that refusing those responses would throw away usable output. This is the
 * same tolerance the generation parser applies, for the same reason.
 */
export function extractJson(content: string): unknown | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const candidates: string[] = [];

  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));

  candidates.push(trimmed);

  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      // `typeof [] === 'object'`, so arrays must be excluded explicitly.
      // The contract is a single object; an array means the model answered
      // a different question.
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value;
      }
    } catch {
      // Try the next shape.
    }
  }

  return null;
}

export function createOllamaProvider(opts: OllamaOptions): StructuredProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call(
    path: string,
    init: RequestInit,
    ms: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await doFetch(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: 'ollama',
    model: opts.model,

    async available() {
      try {
        // /api/tags is the cheapest liveness check and needs no model loaded.
        const response = await call('/api/tags', { method: 'GET' }, 3_000);
        return response.ok;
      } catch {
        return false;
      }
    },

    async run<T>(task: StructuredTask<T>): Promise<StructuredRun<T>> {
      const started = Date.now();

      const fail = (
        status: StructuredRun<T>['status'],
        error: string,
      ): StructuredRun<T> => ({
        output: null,
        provider: 'ollama',
        model: opts.model,
        durationMs: Date.now() - started,
        status,
        error,
      });

      let response: Response;
      try {
        response = await call(
          '/api/chat',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: opts.model,
              stream: false,
              // Ask for JSON. The output is validated regardless.
              format: 'json',
              options: { temperature: task.temperature ?? 0 },
              messages: [
                {
                  role: 'system',
                  content:
                    `${task.instruction}\n\n` +
                    'Reply with a single JSON object and nothing else. ' +
                    'If you are unsure of a field, omit it rather than ' +
                    'guessing.',
                },
                { role: 'user', content: JSON.stringify(task.input) },
              ],
            }),
          },
          timeoutMs,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail('UNAVAILABLE', message);
      }

      if (!response.ok) {
        return fail('ERROR', `HTTP ${response.status}`);
      }

      let body: OllamaChatResponse;
      try {
        body = (await response.json()) as OllamaChatResponse;
      } catch {
        return fail('INVALID_OUTPUT', 'response was not JSON');
      }

      if (body.error) return fail('ERROR', body.error);

      const content = body.message?.content;
      if (!content) return fail('INVALID_OUTPUT', 'no content in response');

      const raw = extractJson(content);
      if (raw === null) {
        return fail('INVALID_OUTPUT', 'no JSON object found in content');
      }

      // The caller's parser is the authority on shape. A model that returns
      // something plausible-looking but wrong must not get through.
      const parsed = task.parse(raw);
      if (parsed === null) {
        return fail('INVALID_OUTPUT', 'output did not satisfy the schema');
      }

      return {
        output: parsed,
        provider: 'ollama',
        model: opts.model,
        durationMs: Date.now() - started,
        status: 'OK',
      };
    },
  };
}

/**
 * Builds the provider from environment, or returns null when it is not
 * configured.
 *
 * Null is a normal state: the system is designed to run entirely without a
 * local model, on deterministic heuristics.
 */
export function ollamaFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): StructuredProvider | null {
  const baseUrl = env['OLLAMA_BASE_URL'];
  const model = env['OLLAMA_MODEL'];
  if (!baseUrl || !model) return null;
  return createOllamaProvider({ baseUrl, model });
}
