export interface Env {
  PROXY_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
}

interface ParsedModel {
  provider: string;
  model: string;
  userId: string;
}

function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function parseModel(raw: string): ParsedModel | null {
  const parts = raw.split(':');
  if (parts.length < 3) return null;
  const provider = parts[0];
  const userId = parts[parts.length - 1];
  const model = parts.slice(1, -1).join(':');
  return { provider, model, userId };
}

async function getApiKey(userId: string, provider: string, env: Env): Promise<string | null> {
  const providerMapping: Record<string, string> = {
    openai: 'openai',
    google: 'gemini',
    anthropic: 'anthropic',
    openrouter: 'openrouter',
  };
  const supabaseProvider = providerMapping[provider];
  if (!supabaseProvider) return null;

  const queryUrl = `${env.SUPABASE_URL}/rest/v1/user_api_keys?user_id=eq.${encodeURIComponent(userId)}&provider=eq.${encodeURIComponent(supabaseProvider)}&is_active=eq.true&order=priority.asc&limit=1`;
  
  const headers = {
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`
  };

  const keyRes = await fetch(queryUrl, { headers });
  if (!keyRes.ok) return null;

  const keys = await keyRes.json() as any[];
  if (!keys || keys.length === 0) return null;

  const vaultId = keys[0].vault_id;
  if (!vaultId) return null;

  const decryptUrl = `${env.SUPABASE_URL}/rest/v1/rpc/vault_get_secret`;
  const decryptRes = await fetch(decryptUrl, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ secret_id: vaultId })
  });

  if (!decryptRes.ok) return null;

  const secretData = await decryptRes.json() as any;
  if (typeof secretData === 'string') {
     return secretData;
  }
  return secretData?.decrypted_secret || null;
}

async function routeOpenAI(reqUrl: string, method: string, headers: Headers, body: any, apiKey: string, model: string): Promise<Response> {
  const upstreamUrl = 'https://api.openai.com/v1/chat/completions';
  body.model = model;
  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  };
  const res = await fetch(upstreamUrl, init);
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json' },
  });
}

async function routeGoogle(reqUrl: string, method: string, headers: Headers, body: any, apiKey: string, model: string): Promise<Response> {
  const upstreamUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
  body.model = model;
  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  };
  const res = await fetch(upstreamUrl, init);
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json' },
  });
}

async function routeOpenRouter(reqUrl: string, method: string, headers: Headers, body: any, apiKey: string, model: string): Promise<Response> {
  const upstreamUrl = 'https://openrouter.ai/api/v1/chat/completions';
  body.model = model;
  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://orkestraai.com',
      'X-Title': 'OrkestraAI',
    },
    body: JSON.stringify(body),
  };
  const res = await fetch(upstreamUrl, init);
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json' },
  });
}

async function routeAnthropic(reqUrl: string, method: string, headers: Headers, body: any, apiKey: string, model: string): Promise<Response> {
  const upstreamUrl = 'https://api.anthropic.com/v1/messages';
  
  let systemMessage = '';
  const messages = body.messages || [];
  const anthropicMessages = [];
  
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemMessage += msg.content + '\n';
    } else {
      anthropicMessages.push(msg);
    }
  }

  const anthropicBody: any = {
    model: model,
    messages: anthropicMessages,
    max_tokens: body.max_tokens || 1024,
  };
  
  if (systemMessage) {
    anthropicBody.system = systemMessage.trim();
  }

  if (body.temperature !== undefined) anthropicBody.temperature = body.temperature;
  if (body.top_p !== undefined) anthropicBody.top_p = body.top_p;

  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(anthropicBody),
  };
  
  const res = await fetch(upstreamUrl, init);
  const isJson = res.headers.get('Content-Type')?.includes('application/json');
  
  if (!res.ok || !isJson) {
    return new Response(res.body, {
      status: res.status,
      headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/json' },
    });
  }

  if (body.stream) {
      return errorResponse('Streaming not supported for Anthropic yet', 400);
  }

  const anthropicRes = await res.json() as any;
  
  if (anthropicRes.type === 'error') {
     return errorResponse(anthropicRes.error?.message || 'Anthropic Error', res.status);
  }

  const openaiRes = {
    id: anthropicRes.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: anthropicRes.content?.[0]?.text || '',
        },
        finish_reason: anthropicRes.stop_reason === 'end_turn' ? 'stop' : (anthropicRes.stop_reason || 'stop'),
      }
    ],
    usage: {
      prompt_tokens: anthropicRes.usage?.input_tokens || 0,
      completion_tokens: anthropicRes.usage?.output_tokens || 0,
      total_tokens: (anthropicRes.usage?.input_tokens || 0) + (anthropicRes.usage?.output_tokens || 0),
    }
  };

  return new Response(JSON.stringify(openaiRes), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', proxy: 'orkestraai' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname !== '/v1/chat/completions') {
      return errorResponse('Not found', 404);
    }

    if (request.method !== 'POST') {
      return errorResponse('Method not allowed', 405);
    }

    const authHeader = request.headers.get('Authorization');
    if (!authHeader || authHeader !== `Bearer ${env.PROXY_SECRET}`) {
      return errorResponse('Unauthorized', 401);
    }

    let body: any;
    try {
      body = await request.json();
    } catch (e) {
      return errorResponse('Invalid JSON body', 400);
    }

    if (!body.model || typeof body.model !== 'string') {
      return errorResponse('Model is required', 400);
    }

    const parsedModel = parseModel(body.model);
    if (!parsedModel) {
      return errorResponse('Invalid model format. Expected provider:model:user_id', 400);
    }

    const { provider, model, userId } = parsedModel;

    const apiKey = await getApiKey(userId, provider, env);
    if (!apiKey) {
      return errorResponse(`Could not fetch API key for user ${userId} and provider ${provider}`, 403);
    }

    try {
      switch (provider) {
        case 'openai':
          return await routeOpenAI(request.url, request.method, request.headers, body, apiKey, model);
        case 'google':
          return await routeGoogle(request.url, request.method, request.headers, body, apiKey, model);
        case 'anthropic':
          return await routeAnthropic(request.url, request.method, request.headers, body, apiKey, model);
        case 'openrouter':
          return await routeOpenRouter(request.url, request.method, request.headers, body, apiKey, model);
        default:
          return errorResponse(`Unsupported provider: ${provider}`, 400);
      }
    } catch (error: any) {
      return errorResponse(error.message || 'Internal Server Error', 500);
    }
  },
};
