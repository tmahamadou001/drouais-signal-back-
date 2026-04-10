import { z } from 'zod'

export const createReportSchema = z.object({
  body: z.object({
    title: z.string().min(3, 'Le titre doit contenir au moins 3 caractères').max(200, 'Le titre ne peut pas dépasser 200 caractères'),
    description: z.string().min(1, 'La description doit contenir au moins 10 caractères').max(2000, 'La description ne peut pas dépasser 2000 caractères'),
    category: z.string().min(1, 'La catégorie est requise'),
    lat: z.string(),
    lng: z.string(),
    address_approx: z.string().optional(),
  })
})

export const updateReportSchema = z.object({
  body: z.object({
    status: z.enum(['en_attente', 'pris_en_charge', 'resolu']).optional(),
    admin_note: z.string().max(1000, 'La note admin ne peut pas dépasser 1000 caractères').optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: 'Au moins un champ doit être fourni pour la mise à jour',
  })
})

export const voteReportSchema = z.object({
  body: z.object({
    vote_type: z.enum(['up', 'down']),
  })
})

export const paginationSchema = z.object({
  query: z.object({
    page: z
      .string()
      .optional()
      .default('1')
      .transform(val => parseInt(val, 10))
      .pipe(z.number().int().min(1, 'Page doit être >= 1')),
    
    limit: z
      .string()
      .optional()
      .default('20')
      .transform(val => parseInt(val, 10))
      .pipe(
        z.number()
          .int()
          .min(1, 'Limite doit être >= 1')
          .max(100, 'Limite maximale : 100')
      ),
    
    status: z
      .enum(['en_attente', 'pris_en_charge', 'resolu', 'all'])
      .optional()
      .default('all'),
    
    category: z
      .string()
      .optional()
      .default('all'),
    
    search: z
      .string()
      .max(100, 'Recherche trop longue')
      .trim()
      .optional(),
  }),
})