import { z } from 'zod'

/**
 * Les charges utiles de l'authentification.
 *
 * Elles n'existaient pas : le navigateur appelait Supabase directement, donc
 * aucune validation ne s'interposait — ni sur la forme, ni sur la longueur, ni
 * sur la casse de l'adresse. Le serveur voit désormais chaque tentative, ce qui
 * lui permet de la valider, de la limiter et de la tracer.
 */

/**
 * L'adresse, normalisée avant tout usage.
 *
 * Supabase compare les adresses en minuscules ; un client qui envoyait
 * `Agent@Mairie.fr` créait une seconde identité pour la même personne selon le
 * chemin emprunté. La normalisation appartient au serveur, pas à chaque appelant.
 */
const email = z
  .string()
  .trim()
  .toLowerCase()
  .email('Adresse e-mail invalide')
  .max(320, 'Adresse e-mail trop longue')

/**
 * Le mot de passe, borné des deux côtés.
 *
 * Huit caractères au minimum, comme `POST /auth/set-password`. Le plafond n'est
 * pas une politique de sécurité : c'est une protection contre le hachage d'un
 * mégaoctet envoyé exprès.
 */
const password = z
  .string()
  .min(8, 'Le mot de passe doit contenir au moins 8 caractères')
  .max(200, 'Mot de passe trop long')

export const loginSchema = z.object({
  body: z.object({
    email,
    password,
  }),
})

export const registerSchema = z.object({
  body: z.object({
    email,
    password,
    firstName: z.string().trim().max(80).optional(),
  }),
})

export const forgotPasswordSchema = z.object({
  body: z.object({ email }),
})

export const setPasswordSchema = z.object({
  body: z.object({ password }),
})
