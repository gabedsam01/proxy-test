export interface Env {
  PROXY_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  ALLOWED_ORIGINS?: string;
}

export interface ParsedModel {
  provider: string;
  model: string;
  userId: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  [key: string]: unknown;
}

export interface UsageInfo {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenAIChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }[];
  usage: UsageInfo;
}
