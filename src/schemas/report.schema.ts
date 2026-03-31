import { z } from 'zod'

export const createReportSchema = z.object({
  title: z.string().min(3, 'Le titre doit contenir au moins 3 caractères').max(200, 'Le titre ne peut pas dépasser 200 caractères'),
  description: z.string().min(10, 'La description doit contenir au moins 10 caractères').max(2000, 'La description ne peut pas dépasser 2000 caractères'),
  category: z.enum(['voirie', 'eclairage', 'dechets', 'autre']),
  lat: z.string(),
  lng: z.string(),
  address_approx: z.string().optional(),
})

export const updateReportSchema = z.object({
  status: z.enum(['en_attente', 'pris_en_charge', 'resolu']).optional(),
  admin_note: z.string().max(1000, 'La note admin ne peut pas dépasser 1000 caractères').optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: 'Au moins un champ doit être fourni pour la mise à jour',
})

export const voteReportSchema = z.object({
  vote_type: z.enum(['up', 'down']),
})
