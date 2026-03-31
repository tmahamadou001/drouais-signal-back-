import rateLimit from 'express-rate-limit'

// Global API limiter
export const globalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requêtes par IP
  message: { error: 'rate_limit', message: 'Trop de requêtes. Réessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
})

// Auth endpoints (login, register)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'rate_limit', message: 'Trop de tentatives. Réessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
})

// Create report limiter
export const createReportLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 3,
  message: { error: 'rate_limit', message: 'Trop de signalements. Réessayez dans 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
})

export const duplicateCheckLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  message: { error: 'rate_limit', message: 'Trop de requêtes. Réessayez dans 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
})

export const voteLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 5,
  message: { error: 'rate_limit', message: 'Trop de votes. Réessayez dans 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
})

export const analyzeLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  message: { error: 'rate_limit', message: 'Trop d\'analyses. Réessayez dans 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
})

export const heatmapLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  message: { error: 'rate_limit', message: 'Trop de requêtes heatmap. Réessayez dans 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
})

// Admin slow down (progressive delay)
export const adminSlowDown = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  message: { error: 'rate_limit', message: 'Trop de requêtes admin. Réessayez dans 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
})

export const weeklyReportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 heure
  max: 5,
  message: { error: 'rate_limit', message: 'Trop d\'envois de rapports. Réessayez dans 1 heure.' },
  standardHeaders: true,
  legacyHeaders: false,
})
