import { z } from 'zod'

// Schéma pour ajouter un destinataire
export const addRecipientSchema = z.object({
  email: z.email(),
  name: z.string().min(1, 'Le nom est requis'),
  role: z.string().optional(),
})

// Schéma pour mettre à jour un destinataire
export const updateRecipientSchema = z.object({
  email: z.email().optional(),
  name: z.string().min(1, 'Le nom ne peut pas être vide').optional(),
  role: z.string().optional(),
  is_active: z.boolean().optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: 'Au moins un champ doit être fourni pour la mise à jour',
})

// Schéma pour supprimer un destinataire (validation du paramètre ID)
export const deleteRecipientSchema = z.object({
  id: z.string().uuid('ID invalide'),
})
