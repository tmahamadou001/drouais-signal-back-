import express, { type Application, type Router } from 'express'
import { errorHandler } from '../../middleware/errorHandler.js'

export function createTestApp(path: string, router: Router): Application {
  const app = express()
  app.use(express.json())
  app.use(path, router)
  app.use(errorHandler)
  return app
}
