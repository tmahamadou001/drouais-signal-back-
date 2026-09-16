import { z } from 'zod'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../lib/pagination.js'

/**
 * Une coordonnée, arrivée en chaîne.
 *
 * Le signalement est envoyé en multipart à cause de la photo, donc tout arrive
 * en texte. Ces deux champs étaient typés `z.string()` sans aucune contrainte :
 * `lat: "banane"` passait la validation, et la seule chose qui rattrapait une
 * coordonnée absurde était le contrôle de rayon du tenant — lequel disparaît
 * maintenant que le tenant est *dérivé* de la position.
 *
 * Une valeur qui cesse d'être vérifiée par autre chose et devient elle-même
 * l'autorité a besoin de plus de contrôle, pas moins.
 */
function coordinate(label: string, bound: number) {
  return z
    .union([z.string(), z.number()])
    .transform((value) => (typeof value === 'number' ? value : Number(value.trim())))
    .refine(Number.isFinite, `${label} doit être un nombre`)
    .refine((value) => Math.abs(value) <= bound, `${label} doit être compris entre -${bound} et ${bound}`)
}

export const createReportSchema = z.object({
  body: z.object({
    title: z.string().min(1, 'Le titre doit contenir au moins 1 caractère').max(200, 'Le titre ne peut pas dépasser 200 caractères'),
    description: z.string().max(4000, 'La description ne peut pas dépasser 4000 caractères').optional().default(''),
    category: z.string().min(1, 'La catégorie est requise'),
    // La plausibilité *territoriale* n'est pas vérifiée ici : le schéma valide
    // la forme, `geoRouting.isPlausiblePosition` valide le territoire.
    lat: coordinate('La latitude', 90),
    lng: coordinate('La longitude', 180),
    address_approx: z.string().optional(),
    anonymous_email: z.string().email('Email invalide').optional(),

    /**
     * Métadonnées de la mesure, facultatives — un client plus ancien ne les
     * envoie pas, et leur absence ne doit pas empêcher un signalement.
     */
    position_accuracy: z
      .union([z.string(), z.number()])
      .transform((value) => (typeof value === 'number' ? value : Number(value.trim())))
      .refine((value) => Number.isFinite(value) && value >= 0, 'La précision doit être un nombre positif')
      .optional(),
    position_captured_at: z.string().datetime({ offset: true }).optional(),
  })
})

export const updateReportSchema = z.object({
  body: z.object({
    status: z.enum(['en_attente', 'transmis', 'pris_en_charge', 'resolu']).optional(),
    admin_note: z.string().max(1000, 'La note admin ne peut pas dépasser 1000 caractères').optional(),
    /**
     * Le motif du changement, repris dans `status_history` et dans l'audit.
     *
     * La route le lisait déjà dans `req.body` — mais `validate` remplace le
     * corps par le résultat de Zod, qui écarte les clés inconnues : le motif
     * n'arrivait jamais jusqu'à la base. Il compte surtout pour un retour en
     * arrière, où « pourquoi » est la seule chose que l'historique ne peut pas
     * deviner.
     */
    comment: z.string().trim().max(500, 'Le motif ne peut pas dépasser 500 caractères').optional(),
  }).refine((data) => Object.keys(data).length > 0, {
    message: 'Au moins un champ doit être fourni pour la mise à jour',
  })
})

/** La transmission groupée, depuis la sélection du tableau. */
export const bulkTransmitSchema = z.object({
  body: z.object({
    ids: z
      .array(z.string().uuid('Identifiant invalide'))
      .min(1, 'Au moins un signalement')
      .max(50, 'Cinquante signalements au maximum'),
    recipients: z
      .array(z.string().trim().toLowerCase().email('Adresse e-mail invalide'))
      .min(1, 'Au moins un destinataire')
      .max(5, 'Cinq destinataires au maximum')
      .optional(),
    serviceName: z.string().trim().max(120).optional(),
  }),
})

/**
 * La transmission manuelle.
 *
 * `recipients` absent = on prend ceux de la catégorie. Présent = l'agent a saisi
 * une adresse, qu'on valide ici plutôt que de découvrir le problème dans un
 * rebond Resend une heure plus tard.
 */
export const transmitReportSchema = z.object({
  body: z.object({
    recipients: z
      .array(z.string().trim().toLowerCase().email('Adresse e-mail invalide'))
      .min(1, 'Au moins un destinataire')
      .max(5, 'Cinq destinataires au maximum')
      .optional(),
    serviceName: z.string().trim().max(120).optional(),
    /** Enregistrer ces adresses sur la catégorie, pour les prochaines fois. */
    remember: z.boolean().optional(),
  }),
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
      .default(String(DEFAULT_PAGE_SIZE))
      .transform(val => parseInt(val, 10))
      .pipe(
        z.number()
          .int()
          .min(1, 'Limite doit être >= 1')
          .max(MAX_PAGE_SIZE, `Limite maximale : ${MAX_PAGE_SIZE}`)
      ),
    
    status: z
      .enum(['en_attente', 'transmis', 'pris_en_charge', 'resolu', 'all'])
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

    /** Fenêtre en jours. Absent = pas de borne. */
    since: z
      .string()
      .optional()
      .transform((value) => (value === undefined ? undefined : parseInt(value, 10)))
      .refine((value) => value === undefined || (Number.isFinite(value) && value > 0), 'Période invalide'),

    sort: z.enum(['recent', 'oldest', 'votes']).optional().default('recent'),

    /** Seulement ce qui dépasse le délai de sa catégorie. */
    overdue: z.enum(['true', 'false']).optional(),
  }),
})