# OrkestraAI LLM Proxy

A Cloudflare Worker that acts as an OpenAI-compatible proxy for LLM requests. It intercepts requests (e.g., from an n8n OpenAI node), validates a proxy secret, fetches the real user API key from Supabase Vault, and routes the request to the correct AI provider.

## Model Field Format

The `model` field is used to pass routing instructions. The format is:
`provider:model-name:user_id`

### Examples
- `openai:gpt-4o-mini:abc123`
- `google:gemini-2.5-flash:abc123`
- `anthropic:claude-haiku-4-5-20251001:abc123`
- `openrouter:meta-llama/llama-3.3-70b-instruct:abc123`

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy the environment variables example:
   ```bash
   cp .dev.vars.example .dev.vars
   ```
4. Fill in the values in `.dev.vars`
5. Run the development server:
   ```bash
   npm run dev
   ```

## Deploy

Configure the secrets in Cloudflare before deploying:

```bash
npx wrangler secret put PROXY_SECRET
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_KEY
```

Then deploy:

```bash
npm run deploy
```

## n8n Configuration

To use this proxy in n8n via the OpenAI node:
- **Base URL:** `https://your-worker-url.workers.dev/v1`
- **API Key:** The value of your `PROXY_SECRET`
- **Model:** Enter the custom model string in the format described above (e.g., `openai:gpt-4o:user123`)
