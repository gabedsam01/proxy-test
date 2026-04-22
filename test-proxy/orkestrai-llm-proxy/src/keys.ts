import type { Env } from './types';

const PROVIDER_MAP: Record<string, string> = {
  openai: 'openai',
  google: 'google',
  anthropic: 'anthropic',
  openrouter: 'openrouter',
};

export async function getApiKey(
  userId: string,
  provider: string,
  env: Env,
): Promise<string | null> {
  const supabaseProvider = PROVIDER_MAP[provider];
  if (!supabaseProvider) return null;

  const queryUrl = `${env.SUPABASE_URL}/rest/v1/user_api_keys?user_id=eq.${encodeURIComponent(userId)}&provider=eq.${encodeURIComponent(supabaseProvider)}&is_active=eq.true&order=created_at.asc&limit=1`;

  const headers: Record<string, string> = {
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
  };

  const keyRes = await fetch(queryUrl, { headers });
  if (!keyRes.ok) return null;

  const keys = (await keyRes.json()) as { vault_secret_id: string }[];
  if (!keys?.length || !keys[0].vault_secret_id) return null;

  const decryptRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/rpc/get_secret_for_worker`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_vault_id: keys[0].vault_secret_id }),
    },
  );

  if (!decryptRes.ok) return null;

  const secretData = await decryptRes.json();
  // Supabase RPC returns the raw value or an object depending on the implementation
  return typeof secretData === 'string' ? secretData : (secretData as any)?.toString() ?? null;
}
