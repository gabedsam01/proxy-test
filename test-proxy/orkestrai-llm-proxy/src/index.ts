import type { Env, ChatCompletionRequest } from './types';
import { getCorsHeaders, errorResponse, jsonResponse, parseModel } from './utils';
import { getApiKey } from './keys';
import { routeToProvider } from './providers';
import { logUsage } from './logging';

export type { Env };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const cors = getCorsHeaders(request, env.ALLOWED_ORIGINS);

    // ---- Preflight ----
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // ---- Health check ----
    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse({ status: 'ok', proxy: 'orkestraai' }, 200, cors);
    }

    // ---- Only /v1/chat/completions POST from here ----
    if (url.pathname !== '/v1/chat/completions') {
      return errorResponse('Not found', 404, cors);
    }
    if (request.method !== 'POST') {
      return errorResponse('Method not allowed', 405, cors);
    }

    // ---- Auth ----
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || authHeader !== `Bearer ${env.PROXY_SECRET}`) {
      return errorResponse('Unauthorized', 401, cors);
    }

    // ---- Parse body ----
    let body: ChatCompletionRequest;
    try {
      body = (await request.json()) as ChatCompletionRequest;
    } catch {
      return errorResponse('Invalid JSON body', 400, cors);
    }

    if (!body.model || typeof body.model !== 'string') {
      return errorResponse('Model is required', 400, cors);
    }

    const parsed = parseModel(body.model);
    if (!parsed) {
      return errorResponse('Invalid model format. Expected provider:model:user_id', 400, cors);
    }

    const { provider, model, userId } = parsed;

    // ---- Fetch API key ----
    let apiKey: string | null;
    try {
      apiKey = await getApiKey(userId, provider, env);
    } catch {
      return errorResponse('Failed to retrieve API key', 502, cors);
    }
    if (!apiKey) {
      return errorResponse('Could not retrieve API key for this provider', 403, cors);
    }

    // ---- Route to provider ----
    try {
      const response = await routeToProvider(provider, body, apiKey, model, cors);

      // Log usage in the background (non-streaming only)
      if (response.ok && !body.stream) {
        ctx.waitUntil(logUsage(env, userId, provider, model, response.clone()));
      }

      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal Server Error';
      return errorResponse(message, 500, cors);
    }
  },
};
