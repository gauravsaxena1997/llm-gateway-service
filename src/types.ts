export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface InferRequestBody {
  appId?: string
  provider?: 'cerebras'
  model?: string
  messages: LLMMessage[]
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
  usage?: InferUsage
}
