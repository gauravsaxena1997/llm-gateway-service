import { Router } from 'express'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { embedWithLocalOllama, OllamaProviderError } from '../providers/ollama.js'

const embedSchema = z.object({
  appId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  input: z.array(z.string().trim().min(1).max(16_000)).min(1).max(16),
})

export const embedRouter = Router()

embedRouter.post('/embed', authMiddleware, async (req, res) => {
  const parsed = embedSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      requestId: req.requestId,
      error: { code: 'VALIDATION_ERROR', message: parsed.error.issues[0]?.message || 'Invalid request body' },
    })
  }

  try {
    const result = await embedWithLocalOllama(parsed.data)
    return res.json({
      success: true,
      requestId: req.requestId,
      appId: req.gatewayClientId || parsed.data.appId || 'unknown-client',
      model: parsed.data.model,
      embeddings: result.embeddings,
      dimensions: result.dimensions,
    })
  } catch (error) {
    const providerError = error instanceof OllamaProviderError ? error : null
    return res.status(providerError?.status ?? 500).json({
      success: false,
      requestId: req.requestId,
      error: {
        code: 'EMBEDDING_PROVIDER_ERROR',
        message: providerError?.message || 'Local embedding request failed',
        retryable: providerError?.retryable ?? true,
      },
    })
  }
})
