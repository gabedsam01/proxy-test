import type { ChatCompletionRequest, OpenAIChatCompletion } from './types';
import { errorResponse } from './utils';

const UPSTREAM_TIMEOUT_MS = 25_000;
const MAX_RETRIES = 1;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface ProviderRoute {
  url: string;
  headers: Record<string, string>;
}

function getProviderRoute(provider: string, apiKey: string): ProviderRoute | null {
  switch (provider) {
    case 'openai':
      return {
        url: 'https://api.openai.com/v1/chat/completions',
        headers: { 'Authorization': `Bearer ${apiKey}` },
      };
    case 'google':
      return {
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        headers: { 'Authorization': `Bearer ${apiKey}` },
      };
    case 'openrouter':
      return {
        url: 'https://openrouter.ai/api/v1/chat/completions',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://orkestraai.com',
          'X-Title': 'OrkestraAI',
        },
      };
    default:
      return null;
  }
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, init);
    if (res.status < 500 || attempt === MAX_RETRIES) return res;
    await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error('Unreachable');
}

function proxyResponse(res: Response, corsHeaders: Record<string, string>): Response {
  return new Response(res.body, {
    status: res.status,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'application/json',
      ...corsHeaders,
    },
  });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function routeToProvider(
  provider: string,
  body: ChatCompletionRequest,
  apiKey: string,
  model: string,
  corsHeaders: Record<string, string>,
  isResponsesAPI: boolean = false,
): Promise<Response> {
  if (provider === 'anthropic') {
    const res = await routeAnthropic(body, apiKey, model, corsHeaders);
    if (isResponsesAPI && res.ok) {
      const chatRes = await res.json() as any;
      return convertToResponsesAPI(chatRes, corsHeaders);
    }
    return res;
  }

  let url: string;
  let headers: Record<string, string> = { 'Content-Type': 'application/json' };

  switch (provider) {
    case 'openai':
      url = 'https://api.openai.com/v1/chat/completions';
      headers['Authorization'] = `Bearer ${apiKey}`;
      break;
    case 'google':
      url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      headers = {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      };
      break;
    case 'openrouter':
      url = 'https://openrouter.ai/api/v1/chat/completions';
      headers['Authorization'] = `Bearer ${apiKey}`;
      headers['HTTP-Referer'] = 'https://orkestraai.com';
      headers['X-Title'] = 'OrkestraAI';
      break;
    default:
      return errorResponse(`Unsupported provider: ${provider}`, 400, corsHeaders);
  }

  let upstreamBody: any = { ...body, model };

  if (provider === 'google') {
    // Transform OpenAI messages to Google contents
    // Handle cases where messages might be missing in Responses API format
    const messages = body.messages || [];
    upstreamBody = {
      contents: messages.map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      })),
      generationConfig: {
        temperature: body.temperature,
        topP: body.top_p,
        maxOutputTokens: body.max_tokens,
      },
    };
    // If there is a system message, handle it specially for Gemini
    const systemMsg = messages.find(m => m.role === 'system');
    if (systemMsg) {
      upstreamBody.system_instruction = { parts: [{ text: systemMsg.content }] };
      upstreamBody.contents = upstreamBody.contents.filter((m: any) => m.role !== 'system');
    }
  }

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(upstreamBody),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (res.ok) {
    let finalResJson: any;
    if (provider === 'google') {
      const googleRes = (await res.json()) as any;
      const text = googleRes.candidates?.[0]?.content?.parts?.[0]?.text || '';
      finalResJson = {
        id: `gemini-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    } else {
      finalResJson = await res.json();
    }

    if (isResponsesAPI) {
      return convertToResponsesAPI(finalResJson, corsHeaders);
    }

    return new Response(JSON.stringify(finalResJson), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  return proxyResponse(res, corsHeaders);
}

function convertToResponsesAPI(chatRes: any, corsHeaders: Record<string, string>): Response {
  const content = chatRes.choices?.[0]?.message?.content || '';
  const responsesRes = {
    id: chatRes.id,
    object: 'response',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: content }]
      }
    ]
  };
  return new Response(JSON.stringify(responsesRes), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// ---------------------------------------------------------------------------
// Anthropic  (format conversion + streaming)
// ---------------------------------------------------------------------------

interface AnthropicBody {
  model: string;
  messages: { role: string; content: string }[];
  max_tokens: number;
  system?: string;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
}

function buildAnthropicBody(body: ChatCompletionRequest, model: string): AnthropicBody {
  let systemMessage = '';
  const messages: { role: string; content: string }[] = [];

  for (const msg of body.messages) {
    if (msg.role === 'system') {
      systemMessage += msg.content + '\n';
    } else {
      messages.push({ role: msg.role, content: msg.content });
    }
  }

  const result: AnthropicBody = {
    model,
    messages,
    max_tokens: body.max_tokens || 4096,
  };

  if (systemMessage) result.system = systemMessage.trim();
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;

  return result;
}

function anthropicToOpenAI(raw: Record<string, unknown>, model: string): OpenAIChatCompletion {
  const content = raw.content as { type: string; text: string }[] | undefined;
  const usage = raw.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  const stopReason = raw.stop_reason as string | undefined;

  const text = (content || [])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('');

  const promptTokens = usage?.input_tokens || 0;
  const completionTokens = usage?.output_tokens || 0;

  return {
    id: raw.id as string,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: stopReason === 'end_turn' ? 'stop' : (stopReason || 'stop'),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic SSE → OpenAI SSE transformer
// ---------------------------------------------------------------------------

function createAnthropicStreamTransformer(model: string): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = '';
  let messageId = '';
  const created = Math.floor(Date.now() / 1000);

  function makeChunk(delta: Record<string, unknown>, finishReason: string | null): string {
    const chunk = {
      id: messageId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let eventType = '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(line.slice(6));

            switch (eventType) {
              case 'message_start':
                messageId = (parsed.message?.id as string) || `msg_${Date.now()}`;
                controller.enqueue(encoder.encode(makeChunk({ role: 'assistant', content: '' }, null)));
                break;

              case 'content_block_delta':
                if (parsed.delta?.type === 'text_delta') {
                  controller.enqueue(encoder.encode(makeChunk({ content: parsed.delta.text }, null)));
                }
                break;

              case 'message_delta': {
                const reason = parsed.delta?.stop_reason === 'end_turn'
                  ? 'stop'
                  : (parsed.delta?.stop_reason || 'stop');
                controller.enqueue(encoder.encode(makeChunk({}, reason)));
                break;
              }

              case 'message_stop':
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                break;
            }
          } catch {
            // skip malformed JSON lines
          }
          eventType = '';
        }
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Anthropic router
// ---------------------------------------------------------------------------

async function routeAnthropic(
  body: ChatCompletionRequest,
  apiKey: string,
  model: string,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const isStream = !!body.stream;
  const anthropicBody = buildAnthropicBody(body, model);
  if (isStream) anthropicBody.stream = true;

  const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(anthropicBody),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (!res.ok) {
    return proxyResponse(res, corsHeaders);
  }

  // ---- Streaming ----
  if (isStream) {
    const transformer = createAnthropicStreamTransformer(model);
    const stream = res.body!.pipeThrough(transformer);
    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...corsHeaders,
      },
    });
  }

  // ---- Non-streaming ----
  const anthropicRes = (await res.json()) as Record<string, unknown>;

  if (anthropicRes.type === 'error') {
    const err = anthropicRes.error as { message?: string } | undefined;
    return errorResponse(err?.message || 'Anthropic error', res.status, corsHeaders);
  }

  const openaiRes = anthropicToOpenAI(anthropicRes, model);

  return new Response(JSON.stringify(openaiRes), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}
