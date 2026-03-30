import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import reportsRouter from './routes/reports.js'
import adminRouter from './routes/admin.js'
import duplicatesRouter from './routes/duplicates.js'
import votesRouter from './routes/votes.js'
import analyzeRouter from './routes/analyze.js'
import mapRouter from './routes/map.js'
import heatmapRouter from './routes/heatmap.js'
import weeklyReportRouter from './routes/weeklyReport.js'
import './cron/weeklyReport.js'

const app = express()
const PORT = parseInt(process.env.PORT || '3001', 10)

// ─── Middleware ───
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
}))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// ─── Rate Limiting ───
const duplicateCheckLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  message: { error: 'rate_limit', message: 'Trop de requêtes. Réessayez dans 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
})

const voteLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 5,
  message: { error: 'rate_limit', message: 'Trop de votes. Réessayez dans 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
})

const analyzeLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  message: { error: 'rate_limit', message: 'Trop d\'analyses. Réessayez dans 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
})

const heatmapLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { error: 'rate_limit', message: 'Trop de requêtes heatmap. Réessayez dans 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
})

// ─── Routes ───
app.use('/api/reports', reportsRouter)
app.use('/api/admin', adminRouter)
app.use('/api/reports', duplicateCheckLimiter, duplicatesRouter)
app.use('/api/reports', voteLimiter, votesRouter)
app.use('/api/analyze-photo', analyzeLimiter, analyzeRouter)
app.use('/api/map', mapRouter)
app.use('/api/admin', heatmapLimiter, heatmapRouter)
app.use('/api/admin', weeklyReportRouter)

// ─── Health check ───
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ─── Error handler ───
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Erreur non gérée:', err)
  res.status(500).json({ error: err.message || 'Erreur interne du serveur.' })
})

// ─── Start ───
app.listen(PORT, () => {
  console.log(`🛡️  DrouaisSignal API démarrée sur http://localhost:${PORT}`)
  console.log(`   Client attendu sur: ${process.env.CLIENT_URL || 'http://localhost:5173'}`)
})
