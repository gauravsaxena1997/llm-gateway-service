import express from 'express'
import { logger } from './logger.js'
import { requestIdMiddleware } from './middleware/request-id.js'
import { healthRouter } from './routes/health.js'
import { inferRouter } from './routes/infer.js'

export function createApp() {
  const app = express()

  app.use(express.json({ limit: '1mb' }))
  app.use(requestIdMiddleware)
  app.use((req, _res, next) => {
    const startedAt = Date.now()
    logger.info(
      {
        requestId: req.requestId,
        method: req.method,
        path: req.path,
      },
      'request_started'
    )

    req.on('close', () => {
      logger.info(
        {
          requestId: req.requestId,
          method: req.method,
          path: req.path,
          durationMs: Date.now() - startedAt,
        },
        'request_finished'
      )
    })

    next()
  })

  app.use('/health', healthRouter)
  app.use('/v1', inferRouter)

  app.use((_req, res) => {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } })
  })

  return app
}
