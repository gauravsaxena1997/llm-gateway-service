import { env } from '../config/env.js'
import { logger } from '../logger.js'
import type { InferRequestBody, InferResponse } from '../types.js'

let currentKeyIndex = 0

interface SelectedKey {
  key: string
  index: number
}

interface OllamaChatResponse {
  done?: boolean
  error?: string
  eval_count?: number
  message?: {
    content?: string
  }
  prompt_eval_count?: number
}

export class OllamaProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean
  ) {
    super(message)
    this.name = 'OllamaProviderError'
  }
}

function nextKey(): SelectedKey {
  const index = currentKeyIndex
  const key = env.ollamaApiKeys[index]
  currentKeyIndex = (currentKeyIndex + 1) % env.ollamaApiKeys.length
  return { key, index }
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), timeoutMs)
  return controller.signal
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveModel(requestedModel?: string): string {
  const model = requestedModel || env.ollamaModel
  if (!env.ollamaAllowedModels.includes(model)) {
    throw new OllamaProviderError(`Ollama model is not allowed: ${model}`, 400, false)
  }
  return model
}

export async function inferWithOllama(body: InferRequestBody): Promise<InferResponse> {
  let lastError: OllamaProviderError | null = null
  const model = resolveModel(body.model)

  for (let attempt = 0; attempt < env.ollamaApiKeys.length; attempt += 1) {
    const selectedKey = nextKey()
    logger.info({ attempt, keyIndex: selectedKey.index, model }, 'ollama_request_started')

    const response = await fetch(`${env.ollamaBaseUrl}/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${selectedKey.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: body.messages,
        options: { temperature: body.temperature ?? 0.2 },
        stream: false,
      }),
      signal: timeoutSignal(env.requestTimeoutMs),
    })

    const payload = await response.json().catch(() => ({})) as OllamaChatResponse
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500
      lastError = new OllamaProviderError(
        `Ollama API error (HTTP ${response.status}): ${(payload.error || 'Unknown error').slice(0, 240)}`,
        response.status,
        retryable
      )
      logger.warn({ attempt, keyIndex: selectedKey.index, model, status: response.status, retryable }, 'ollama_request_failed')
      if (retryable && attempt < env.ollamaApiKeys.length - 1) {
        await sleep(2_000 * (attempt + 1))
        continue
      }
      throw lastError
    }

    const content = payload.message?.content
    if (!content) {
      lastError = new OllamaProviderError('Ollama returned empty response content', 502, true)
      if (attempt < env.ollamaApiKeys.length - 1) {
        await sleep(2_000 * (attempt + 1))
        continue
      }
      throw lastError
    }

    const promptTokens = payload.prompt_eval_count ?? 0
    const completionTokens = payload.eval_count ?? 0
    return {
      content,
      toolCalls: [],
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    }
  }

  throw lastError ?? new OllamaProviderError('Ollama provider request failed', 500, true)
}
