import type { ParsedModel } from './types';

function buildCorsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
}

export function getCorsHeaders(request: Request, allowedOrigins?: string): Record<string, string> {
  const origin = request.headers.get('Origin') || '';

  if (allowedOrigins) {
    const origins = allowedOrigins.split(',').map(o => o.trim());
    if (origins.includes(origin)) {
      return buildCorsHeaders(origin);
    }
    return buildCorsHeaders(origins[0]);
  }

  return buildCorsHeaders('*');
}

export function errorResponse(
  message: string,
  status: number,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

export function jsonResponse(
  data: unknown,
  status: number,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

export function parseModel(raw: string): ParsedModel | null {
  const parts = raw.trim().split(':');
  if (parts.length < 3) return null;
  return {
    provider: parts[0],
    userId: parts[parts.length - 1],
    model: parts.slice(1, -1).join(':'),
  };
}
