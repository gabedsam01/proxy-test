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

  const queryUrl = `${env.SUPABASE_URL}/rest/v1/user_api_keys?user_id=eq.${encodeURIComponent(userId)}&provider=eq.${encodeURIComponent(supabaseProvider)}&is_active=eq.true&order=priority.asc&limit=1`;

  const headers: Record<string, string> = {
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
  };

  const keyRes = await fetch(queryUrl, { headers });
  if (!keyRes.ok) return null;

  const keys = (await keyRes.json()) as { vault_id?: string }[];
  if (!keys?.length || !keys[0].vault_id) return null;

  const decryptRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/rpc/vault_get_secret`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret_id: keys[0].vault_id }),
    },
  );

  if (!decryptRes.ok) return null;

  const secretData = (await decryptRes.json()) as
    | string
    | { decrypted_secret?: string };

  return typeof secretData === 'string'
    ? secretData
    : secretData?.decrypted_secret ?? null;
}
