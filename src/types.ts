export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  images?: string[]
}

export interface LLMTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface LLMToolCall {
  id: string
  function: {
    name: string
    arguments: string
  }
}

export interface InferRequestBody {
  appId?: string
  provider?: 'cerebras' | 'ollama'
  model?: string
  messages: LLMMessage[]
  tools?: LLMTool[]
  responseFormat?: Record<string, unknown>
  maxTokens?: number
  temperature?: number
  metadata?: Record<string, unknown>
}

export interface InferUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface InferResponse {
  content: string
  toolCalls: LLMToolCall[]
  usage?: InferUsage
}

export interface EmbedRequestBody {
  appId?: string
  model?: string
  input: string[]
}

export interface EmbedResponse {
  embeddings: number[][]
  dimensions: number
}
