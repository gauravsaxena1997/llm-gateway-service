import { env } from '../config/env.js'
import { logger } from '../logger.js'
import type { InferRequestBody, InferResponse } from '../types.js'

let currentKeyIndex = 0

interface SelectedKey {
  key: string
  index: number
  fingerprint: string
}

export class CerebrasProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean
  ) {
    super(message)
    this.name = 'CerebrasProviderError'
  }
}

function fingerprintKey(key: string): string {
  return `${key.slice(0, 8)}...${key.slice(-6)}`
}

function nextKey(): SelectedKey {
  const index = currentKeyIndex
  const key = env.cerebrasApiKeys[index]
  currentKeyIndex = (currentKeyIndex + 1) % env.cerebrasApiKeys.length
  return { key, index, fingerprint: fingerprintKey(key) }
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), timeoutMs)
  return controller.signal
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function reasoningParams(model: string): Record<string, string> {
  if (model === 'gpt-oss-120b') {
    return { reasoning_effort: 'low' }
  }

  if (model === 'zai-glm-4.7') {
    return { reasoning_effort: 'none' }
  }

  return {}
}

export async function inferWithCerebras(body: InferRequestBody): Promise<InferResponse> {
  let lastError: CerebrasProviderError | null = null

  for (let attempt = 0; attempt < env.cerebrasApiKeys.length; attempt++) {
    const selectedKey = nextKey()
    const model = body.model || env.cerebrasModel
    logger.info(
      {
        attempt,
        keyIndex: selectedKey.index,
        keyFingerprint: selectedKey.fingerprint,
        model,
      },
      'cerebras_request_started'
    )

    const response = await fetch(`${env.cerebrasBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${selectedKey.key}`,
      },
      body: JSON.stringify({
        model,
        messages: body.messages,
        max_completion_tokens: body.maxTokens ?? 1024,
        temperature: body.temperature ?? 0.3,
        stream: false,
        ...(body.tools && body.tools.length > 0 ? { tools: body.tools } : {}),
        ...(body.responseFormat ? { response_format: body.responseFormat } : {}),
        ...reasoningParams(model),
      }),
      signal: timeoutSignal(env.requestTimeoutMs),
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error')
      const retryable = response.status === 429 || response.status >= 500
      logger.warn(
        {
          attempt,
          keyIndex: selectedKey.index,
          keyFingerprint: selectedKey.fingerprint,
          status: response.status,
          retryable,
          errorBody: errorBody.slice(0, 500),
        },
        'cerebras_request_failed'
      )

      lastError = new CerebrasProviderError(
        `Cerebras API error (HTTP ${response.status}): ${errorBody.slice(0, 240)}`,
        response.status,
        retryable
      )

      if (retryable && attempt < env.cerebrasApiKeys.length - 1) {
        await sleep(2_000 * (attempt + 1))
        continue
      }

      throw lastError
    }

    const data = await response.json()
    const firstChoice = data?.choices?.[0]
    const choice = firstChoice?.message?.content
    const toolCalls = Array.isArray(firstChoice?.message?.tool_calls)
      ? firstChoice.message.tool_calls.filter((toolCall: unknown): toolCall is { id: string; function: { name: string; arguments: string } } => {
        if (!toolCall || typeof toolCall !== 'object') return false
        const value = toolCall as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
        return typeof value.id === 'string' && typeof value.function?.name === 'string' && typeof value.function?.arguments === 'string'
      })
      : []

    if ((!choice || typeof choice !== 'string') && toolCalls.length === 0) {
      logger.warn(
        {
          attempt,
          keyIndex: selectedKey.index,
          keyFingerprint: selectedKey.fingerprint,
          model,
          finishReason: firstChoice?.finish_reason,
          messageKeys: firstChoice?.message ? Object.keys(firstChoice.message) : [],
          reasoningChars:
            typeof firstChoice?.message?.reasoning === 'string' ? firstChoice.message.reasoning.length : 0,
          usage: data?.usage,
        },
        'cerebras_empty_response'
      )

      lastError = new CerebrasProviderError('Provider returned empty response content', 502, true)

      if (attempt < env.cerebrasApiKeys.length - 1) {
        await sleep(2_000 * (attempt + 1))
        continue
      }

      throw lastError
    }

    return {
      content: typeof choice === 'string' ? choice : '',
      toolCalls,
      usage: data?.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            totalTokens: data.usage.total_tokens ?? 0,
          }
        : undefined,
    }
  }

  throw lastError ?? new CerebrasProviderError('Cerebras provider request failed', 500, true)
}

export async function* streamWithCerebras(body: InferRequestBody): AsyncGenerator<string> {
  const selectedKey = nextKey()
  const model = body.model || env.cerebrasModel
  const response = await fetch(`${env.cerebrasBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${selectedKey.key}` },
    body: JSON.stringify({
      model,
      messages: body.messages,
      max_completion_tokens: body.maxTokens ?? 1024,
      temperature: body.temperature ?? 0.3,
      stream: true,
      ...reasoningParams(model),
    }),
    signal: timeoutSignal(env.requestTimeoutMs),
  })
  if (!response.ok || !response.body) {
    const errorBody = await response.text().catch(() => 'Unknown error')
    throw new CerebrasProviderError(`Cerebras streaming error (HTTP ${response.status}): ${errorBody.slice(0, 240)}`, response.status, response.status >= 500 || response.status === 429)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') return
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content
        if (typeof delta === 'string' && delta) yield delta
      } catch { /* wait for a complete SSE record */ }
    }
  }
}
