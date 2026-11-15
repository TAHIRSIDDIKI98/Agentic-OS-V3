/**
 * services/llm.ts — LLM Provider Service.
 *
 * Generic OpenAI-compatible provider for:
 *   - Session transcript distillation (replaces heuristicDistill)
 *   - Interactive agent prompts
 *   - Structured data extraction
 *
 * Gracefully degrades when no provider is configured.
 */
import { getEnv, llmConfigured } from '../lib/env.js';
import { safeFetch } from '../lib/http.js';
import { log } from '../lib/logging.js';
import { llmDuration, llmTokensTotal } from './metrics.js';
import { startLLMSpan, recordTokenUsage, recordSpanError, endTracedSpan } from './tracing.js';

export { llmConfigured };

// ── Types ─────────────────────────────────────────────────────

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  /** Optional per-call model override. Required for routed simple/medium/complex model selection. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage: { prompt: number; completion: number; total: number };
}

export interface DistilledMemory {
  kind: 'episodic' | 'semantic' | 'preference' | 'reflexion' | 'fact';
  title: string;
  content: string;
  tags: string[];
  importance: number;
}

// ── Core LLM Call ─────────────────────────────────────────────

export async function callLLM(req: LLMRequest): Promise<LLMResponse> {
  if (!llmConfigured()) {
    throw new Error(
      'LLM provider not configured. Set NEXUS_LLM_BASE_URL, NEXUS_LLM_API_KEY, and NEXUS_LLM_MODEL.'
    );
  }

  const env = getEnv();
  const model = req.model || env.NEXUS_LLM_MODEL;
  const url = `${env.NEXUS_LLM_BASE_URL}/chat/completions`;
  const startTime = performance.now();
  const span = startLLMSpan('llm.call', { agentId: 'system', model });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${env.NEXUS_LLM_API_KEY}`,
  };
  if (model.startsWith('claude')) {
    headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
  }

  const body = {
    model,
    messages: req.messages,
    max_tokens: req.maxTokens ?? 4096,
    temperature: req.temperature ?? 0.7,
  };

  try {
    const response = await safeFetch(url, {
      method: 'POST',
      timeoutMs: 120_000,
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody =
        response.body && typeof response.body === 'object'
          ? JSON.stringify(response.body).slice(0, 500)
          : String(response.body ?? 'unknown').slice(0, 500);
      throw new Error(`LLM request failed (${response.status}): ${errBody}`);
    }

    const data = response.body as {
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      choices?: Array<{ message?: { content?: string } }>;
    };

    const usage = {
      prompt: data.usage?.prompt_tokens ?? 0,
      completion: data.usage?.completion_tokens ?? 0,
      total: data.usage?.total_tokens ?? 0,
    };

    const durationSeconds = (performance.now() - startTime) / 1000;
    llmDuration.observe({ model, status: 'ok' }, durationSeconds);
    llmTokensTotal.inc({ model, kind: 'prompt' }, usage.prompt);
    llmTokensTotal.inc({ model, kind: 'completion' }, usage.completion);

    recordTokenUsage(span, usage);
    await endTracedSpan(span);

    return {
      content: data.choices?.[0]?.message?.content ?? '',
      model: data.model ?? model,
      usage,
    };
  } catch (err) {
    const durationSeconds = (performance.now() - startTime) / 1000;
    llmDuration.observe({ model, status: 'error' }, durationSeconds);
    const errMsg = err instanceof Error ? err.message : String(err);
    recordSpanError(span, errMsg);
    await endTracedSpan(span);
    throw err;
  }
}

export type StreamChunkCallback = (chunk: {
  text: string;
  index: number;
  finishReason?: string;
}) => void;

export async function callLLMStream(
  req: LLMRequest,
  onChunk: StreamChunkCallback,
  signal?: AbortSignal
): Promise<LLMResponse> {
  if (!llmConfigured()) {
    throw new Error(
      'LLM provider not configured. Set NEXUS_LLM_BASE_URL, NEXUS_LLM_API_KEY, and NEXUS_LLM_MODEL.'
    );
  }

  const env = getEnv();
  const model = req.model || env.NEXUS_LLM_MODEL;
  const url = `${env.NEXUS_LLM_BASE_URL}/chat/completions`;
  const startTime = performance.now();
  const span = startLLMSpan('llm.stream', { agentId: 'system', model });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${env.NEXUS_LLM_API_KEY}`,
  };
  if (model.startsWith('claude')) {
    headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
  }

  const body = {
    model,
    messages: req.messages,
    max_tokens: req.maxTokens ?? 4096,
    temperature: req.temperature ?? 0.7,
    stream: true,
  };

  try {
    const httpResp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!httpResp.ok) {
      const errText = await httpResp.text().catch(() => 'unknown');
      throw new Error(`LLM stream request failed (${httpResp.status}): ${errText.slice(0, 500)}`);
    }

    const reader = httpResp.body?.getReader();
    if (!reader) throw new Error('LLM response body is not readable');

    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';
    let usage = { prompt: 0, completion: 0, total: 0 };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // keep partial line

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const jsonStr = trimmed.slice(6);
          if (jsonStr === '[DONE]') break;

          try {
            const parsed = JSON.parse(jsonStr) as {
              choices?: Array<{
                delta?: { content?: string };
                finish_reason?: string | null;
                index: number;
              }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            };

            if (parsed.usage) {
              usage = {
                prompt: parsed.usage.prompt_tokens ?? 0,
                completion: parsed.usage.completion_tokens ?? 0,
                total: parsed.usage.total_tokens ?? 0,
              };
            }

            for (const choice of parsed.choices ?? []) {
              const delta = choice.delta?.content ?? '';
              if (delta) {
                fullContent += delta;
                onChunk({
                  text: delta,
                  index: choice.index,
                  finishReason: choice.finish_reason ?? undefined,
                });
              }
            }
          } catch {
            // Skip malformed JSON chunks (e.g., "[DONE]")
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const durationSeconds = (performance.now() - startTime) / 1000;
    llmDuration.observe({ model, status: 'ok' }, durationSeconds);
    if (usage.prompt > 0 || usage.completion > 0) {
      llmTokensTotal.inc({ model, kind: 'prompt' }, usage.prompt);
      llmTokensTotal.inc({ model, kind: 'completion' }, usage.completion);
      recordTokenUsage(span, usage);
    }
    await endTracedSpan(span);

    return {
      content: fullContent,
      model,
      usage,
    };
  } catch (err) {
    const durationSeconds = (performance.now() - startTime) / 1000;
    llmDuration.observe({ model, status: 'error' }, durationSeconds);
    const errMsg = err instanceof Error ? err.message : String(err);
    recordSpanError(span, errMsg);
    await endTracedSpan(span);
    throw err;
  }
}

// ── Structured Output ─────────────────────────────────────────

/**
 * Call LLM with a JSON schema constraint via system prompt.
 * The LLM is instructed to respond with valid JSON matching the schema.
 */
export async function callLLMStructured<T>(
  systemPrompt: string,
  userMessage: string,
  signal?: AbortSignal
): Promise<T> {
  const result = await callLLM({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.3,
    signal,
  });

  const jsonStr = extractJSON(result.content);
  return JSON.parse(jsonStr) as T;
}

function extractJSON(text: string): string {
  const codeMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeMatch && codeMatch[1]) return codeMatch[1].trim();
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    return text.slice(braceStart, braceEnd + 1);
  }
  return text;
}

// ── Session Distillation ──────────────────────────────────────

const DISTILL_SYSTEM_PROMPT = `You are a memory distillation engine. Analyze the transcript below and extract distinct memories.
For each distinct memory, output a JSON object with these fields:
- "kind": one of "episodic" (an event that happened), "semantic" (a fact or piece of knowledge), "preference" (a personal preference or habit), "reflexion" (an insight or lesson learned), "fact" (objective verifiable fact)
- "title": a short, descriptive title (max 80 chars)
- "content": the full memory content (max 2000 chars)
- "tags": an array of 1-5 relevant tags
- "importance": a number from 0.0 to 1.0 (1.0 = most important)

Rules:
1. Extract ONLY meaningful information — skip filler, greetings, small talk
2. If nothing meaningful is found, return an empty array
3. A single transcript may contain MULTIPLE distinct memories
4. Output valid JSON ONLY: { "memories": [ ... ] }
5. Do NOT wrap in markdown code blocks — return raw JSON`;

export async function distillTranscript(transcript: string): Promise<DistilledMemory[]> {
  if (!llmConfigured()) {
    // Fall back to heuristic extraction
    return heuristicDistill(transcript);
  }

  try {
    const truncated = transcript.slice(0, 24_000);
    const result = await callLLMStructured<{ memories: DistilledMemory[] }>(
      DISTILL_SYSTEM_PROMPT,
      `Transcript:\n\n${truncated}`
    );
    const memories = (result?.memories ?? []).slice(0, 25);
    if (memories.length === 0) {
      return [
        {
          kind: 'episodic',
          title: 'Session summary',
          content: truncated.slice(0, 600),
          tags: ['session'],
          importance: 0.4,
        },
      ];
    }
    return memories;
  } catch (e) {
    log.warn('distill_llm_failed', { error: e instanceof Error ? e.message : String(e) });
    return heuristicDistill(transcript);
  }
}

// ── Heuristic Fallback ────────────────────────────────────────

/** Explicit instruction/preference language. */
const PREFERENCE_SIGNAL = /\b(prefer|always|never|policy|rule|must not|avoid|don't|do not)\b/i;
/** Language that marks an explicit "remember this" moment. */
const REMEMBER_SIGNAL = /\b(remember|note|decided|lesson|learned|todo|fixme|important)\b/i;
/** A concrete, checkable detail: URL, filename, port, dotted version, CONSTANT. */
const CONCRETE_DETAIL =
  /(\bhttps?:\/\/\S+|\b[a-z0-9_.-]+\.(?:json|ya?ml|toml|ts|tsx|js|mjs|cjs|py|sh|md|sql|env|lock)\b|\bport\s*\d{2,5}\b|:\d{4,5}\b|\bv?\d+\.\d+(?:\.\d+)?\b|\b[A-Z][A-Z0-9_]{2,}\b)/;
/** Declarative/config statements about how the project actually works. */
const DECLARATIVE_VERB =
  /\b(is|are|was|were|uses?|deploys?|ships?|runs?|stores?|pins?|targets?|lives?|hosts?|depends?|configures?|requires?)\b/i;

/** Drop chat-speaker prefixes so the stored fact is the sentence itself. */
function stripSpeaker(line: string): string {
  return line.replace(/^\s*(?:user|assistant|system|human|ai|me|you)\s*:\s*/i, '').trim();
}

/**
 * Heuristic extraction used when no LLM is configured (or the call fails).
 *
 * The previous version only matched instruction words, so plain declarative
 * facts ("we deploy with docker compose on port 8080") were dropped into a
 * truncated session summary and mislabeled. A line now counts as a fact when it
 * states something with a concrete, checkable detail.
 */
function heuristicDistill(transcript: string): DistilledMemory[] {
  const out: DistilledMemory[] = [];
  const seen = new Set<string>();

  for (const rawLine of transcript.split(/\n|(?<=[.!?])\s+/)) {
    const content = stripSpeaker(rawLine).replace(/\s+/g, ' ').trim();
    if (content.length <= 8 || content.split(/\s+/).length < 4) continue;
    if (seen.has(content.toLowerCase())) continue;

    const preference = PREFERENCE_SIGNAL.test(content);
    const declarative = CONCRETE_DETAIL.test(content) && DECLARATIVE_VERB.test(content);
    const remembered = REMEMBER_SIGNAL.test(content);
    if (!preference && !declarative && !remembered) continue;

    seen.add(content.toLowerCase());
    out.push({
      kind: preference ? 'preference' : declarative ? 'fact' : 'reflexion',
      title: content.slice(0, 120),
      content,
      tags: [],
      importance: declarative ? 0.7 : 0.6,
    });
  }

  if (!out.length)
    out.push({
      kind: 'episodic',
      title: 'Session summary',
      content: stripSpeaker(transcript.slice(0, 600)),
      tags: ['session'],
      importance: 0.4,
    });
  return out.slice(0, 25);
}

// ── Agent Chat ────────────────────────────────────────────────

export async function agentChat(
  query: string,
  context: string,
  agentName: string,
  signal?: AbortSignal
): Promise<string> {
  const result = await callLLM({
    messages: [
      {
        role: 'system',
        content: `You are ${agentName}, an autonomous AI agent in the NEXUS multi-agent system.
Use the provided context to answer accurately. If context is insufficient, say so.

Context:
${context.slice(0, 32_000)}`,
      },
      { role: 'user', content: query },
    ],
    temperature: 0.7,
    signal,
  });
  return result.content;
}
