import { createApp } from './app.js'
import { env } from './config/env.js'
import { logger } from './logger.js'

const app = createApp()

app.listen(env.port, () => {
  logger.info({ port: env.port }, 'llm-gateway-service started')
})
