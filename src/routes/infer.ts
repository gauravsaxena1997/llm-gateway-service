import { Router } from 'express'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { inferWithCerebras } from '../providers/cerebras.js'
import { env } from '../config/env.js'

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1),
})

const inferSchema = z.object({
  appId: z.string().min(1).optional(),
  provider: z.enum(['cerebras']).optional(),
  model: z.string().min(1).optional(),
  messages: z.array(messageSchema).min(1),
  maxTokens: z.number().int().positive().max(4096).optional(),
  temperature: z.number().min(0).max(2).optional(),
  metadata: z.record(z.unknown()).optional(),
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
    if (provider !== 'cerebras') {
      return res.status(400).json({
        success: false,
        requestId: req.requestId,
        error: {
          code: 'UNSUPPORTED_PROVIDER',
          message: `Provider not supported: ${provider}`,
        },
      })
    }

    const result = await inferWithCerebras(body)

    return res.json({
      success: true,
      requestId: req.requestId,
      appId,
      provider,
      model: body.model || env.cerebrasModel,
      output: {
        text: result.content,
        json: null,
      },
      usage: result.usage,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    const status = message.includes('HTTP 429') ? 429 : message.includes('HTTP 5') ? 502 : 500

    return res.status(status).json({
      success: false,
      requestId: req.requestId,
      error: {
        code: 'PROVIDER_ERROR',
        message,
        retryable: status >= 500,
      },
    })
  }
})
