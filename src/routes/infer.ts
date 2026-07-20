import { Router } from 'express'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { CerebrasProviderError, inferWithCerebras } from '../providers/cerebras.js'
import { inferWithOllama, OllamaProviderError } from '../providers/ollama.js'
import { env } from '../config/env.js'

const maxImageBase64Characters = 6_000_000

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().min(1),
  toolCallId: z.string().min(1).optional(),
  images: z.array(z.string().min(16).max(maxImageBase64Characters)).min(1).max(1).optional(),
})

const toolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    parameters: z.record(z.unknown()),
  }),
})

const inferSchema = z.object({
  appId: z.string().min(1).optional(),
  provider: z.enum(['cerebras', 'ollama']).optional(),
  model: z.string().min(1).optional(),
  messages: z.array(messageSchema).min(1),
  tools: z.array(toolSchema).optional(),
  responseFormat: z.record(z.unknown()).optional(),
  maxTokens: z.number().int().positive().max(4096).optional(),
  temperature: z.number().min(0).max(2).optional(),
  metadata: z.record(z.unknown()).optional(),
}).superRefine((body, context) => {
  for (const [index, message] of body.messages.entries()) {
    if (message.images && message.role !== 'user') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Images are only allowed on user messages', path: ['messages', index, 'images'] })
    }
  }
})

export const inferRouter = Router()

inferRouter.post('/infer', authMiddleware, async (req, res) => {
  const parsed = inferSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      requestId: req.requestId,
      error: {
        code: 'VALIDATION_ERROR',
        message: parsed.error.issues[0]?.message || 'Invalid request body',
      },
    })
  }

  const body = parsed.data
  const appId = req.gatewayClientId || body.appId || 'unknown-client'
  const provider = body.provider || env.providerDefault

  try {
    if (provider !== 'cerebras' && provider !== 'ollama') {
      return res.status(400).json({
        success: false,
        requestId: req.requestId,
        error: {
          code: 'UNSUPPORTED_PROVIDER',
          message: `Provider not supported: ${provider}`,
        },
      })
    }

    const result = provider === 'ollama' ? await inferWithOllama(body) : await inferWithCerebras(body)

    return res.json({
      success: true,
      requestId: req.requestId,
      appId,
      provider,
      model: body.model || (provider === 'ollama' ? env.ollamaModel : env.cerebrasModel),
      output: {
        text: result.content,
        json: null,
        toolCalls: result.toolCalls,
      },
      usage: result.usage,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    const status =
      error instanceof CerebrasProviderError || error instanceof OllamaProviderError
        ? error.status
        : message.includes('HTTP 429')
          ? 429
          : message.includes('HTTP 5')
            ? 502
            : 500
    const retryable =
      error instanceof CerebrasProviderError || error instanceof OllamaProviderError
        ? error.retryable
        : status === 429 || status >= 500

    return res.status(status).json({
      success: false,
      requestId: req.requestId,
      error: {
        code: 'PROVIDER_ERROR',
        message,
        retryable,
      },
    })
  }
})
