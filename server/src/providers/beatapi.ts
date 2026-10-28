import type { ChatCompletionChunk, ChatCompletionResponse } from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type KeyValidationResult } from './base.js';

export const BEATAPI_BASE_URL = 'https://api.beatapi.io/v1';

/** Chat completion integration for beatapi.io.
 * Supports models like deepseek-v4.1-flash-free, deepseek-v4.1-flash, etc. */
export class BeatApiProvider extends BaseProvider {
  readonly platform = 'beatapi' as const;
  readonly name = 'BeatAPI';

  async validateKey(apiKey: string): Promise<KeyValidationResult> {
    const res = await this.fetchWithTimeout(`${BEATAPI_BASE_URL}/models`, {
      method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${apiKey}` },
    }, 10_000, { timeoutBounds: 'request' });
    if ([401, 403].includes(res.status)) return this.validationResult(res);
    if (!res.ok) throw providerHttpError(res, 'BeatAPI key validation is inconclusive');
    const body = await res.json().catch(() => null) as { data?: unknown; error?: unknown } | null;
    if (!Array.isArray(body?.data) || body?.error) {
      throw Object.assign(new Error('BeatAPI returned an invalid model list'), { status: 502 });
    }
    return true;
  }

  async chatCompletion(
    apiKey: string,
    messages: { role: string; content: string }[],
    modelId: string,
    options: Record<string, unknown>,
    quotaContext: unknown
  ): Promise<ChatCompletionResponse> {
    const res = await this.fetchWithTimeout(`${BEATAPI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        stream: false,
        ...options,
      }),
    }, 30_000, { timeoutBounds: 'request' });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw providerHttpError(res, `BeatAPI chat completion failed: ${text.slice(0, 200)}`);
    }

    const data = await res.json();

    return {
      id: data.id,
      object: data.object,
      created: data.created,
      model: data.model ?? modelId,
      choices: (data.choices ?? []).map((c: any) => ({
        index: c.index,
        message: {
          role: c.message?.role ?? 'assistant',
          content: c.message?.content ?? '',
        },
        finish_reason: c.finish_reason,
      })),
      usage: data.usage ?? {
        prompt_tokens: data.usage?.prompt_tokens ?? 0,
        completion_tokens: data.usage?.completion_tokens ?? 0,
        total_tokens: data.usage?.total_tokens ?? 0,
      },
    };
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: { role: string; content: string }[],
    modelId: string,
    options: Record<string, unknown>,
    quotaContext: unknown
  ): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.fetchWithTimeout(`${BEATAPI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        stream: true,
        ...options,
      }),
    }, 30_000, { timeoutBounds: 'request' });

    if (!res.ok) {
      throw providerHttpError(res, 'BeatAPI stream chat completion failed');
    }

    const reader = res.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') return;
            try {
              const chunk = JSON.parse(payload);
              if (chunk.choices && chunk.choices.length > 0) {
                yield {
                  id: chunk.id,
                  object: chunk.object,
                  created: chunk.created,
                  model: chunk.model,
                  choices: chunk.choices.map((c: any) => ({
                    index: c.index,
                    delta: {
                      role: c.delta?.role,
                      content: c.delta?.content ?? '',
                    },
                    finish_reason: c.finish_reason,
                  })),
                };
              }
            } catch {
              // Ignore non-JSON data lines
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}