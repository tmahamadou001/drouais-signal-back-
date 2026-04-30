import { z } from 'zod'

const MAX_LENGTH = 500

// Message de l'agent
export const agentCommentSchema = z.object({
  content: z
    .string()
    .min(1, 'Le message ne peut pas être vide')
    .max(MAX_LENGTH, `Maximum ${MAX_LENGTH} caractères`)
    .trim(),
  photoUrl: z.string().url().optional(),
  isResolutionPhoto: z.boolean().optional()
    .default(false),
})

// Réponse du citoyen
export const citizenCommentSchema = z.object({
  content: z
    .string()
    .min(1, 'Le message ne peut pas être vide')
    .max(MAX_LENGTH, `Maximum ${MAX_LENGTH} caractères`)
    .trim(),
  parentId: z
    .string()
    .uuid('Référence invalide'),
})
