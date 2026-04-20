import type { Env, UsageInfo } from './types';

interface UsageLogEntry {
  user_id: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  created_at: string;
}

/**
 * Logs token usage to Supabase. Designed to run inside ctx.waitUntil()
 * so it never blocks the response to the client.
 */
export async function logUsage(
  env: Env,
  userId: string,
  provider: string,
  model: string,
  response: Response,
): Promise<void> {
  try {
    const body = (await response.json()) as { usage?: UsageInfo };
    if (!body?.usage) return;

    const entry: UsageLogEntry = {
      user_id: userId,
      provider,
      model,
      prompt_tokens: body.usage.prompt_tokens || 0,
      completion_tokens: body.usage.completion_tokens || 0,
      total_tokens: body.usage.total_tokens || 0,
      created_at: new Date().toISOString(),
    };

    await fetch(`${env.SUPABASE_URL}/rest/v1/usage_logs`, {
      method: 'POST',
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(entry),
    });
  } catch {
    // Fire-and-forget: logging failures must never affect the client response
  }
}
