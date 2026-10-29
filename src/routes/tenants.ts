import { Router, Request, Response, NextFunction, type Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { resolve as resolveLocation, isPlausiblePosition } from '../services/geoRouting.js'
import { badRequest } from '../middleware/errorHandler.js'
import { joinWaitlist } from '../services/prospectService.js'
import { z } from 'zod'
import { publicTenantsLimiter } from '../middleware/rateLimits.js'

const router: ExpressRouter = Router()

/**
 * Les statuts d'une commune consultable.
 *
 * `prospect` en est exclu — rien n'y est publié. `suspended` aussi : une
 * commune dont l'accès est coupé ne doit pas rester dans un sélecteur qui
 * promet des signalements.
 */
const PUBLIC_STATUSES = ['active', 'trial', 'demo']

/**
 * ─── GET /api/tenants/public — Les communes qu'on peut consulter ───
 *
 * Cet endpoint avait été supprimé en v2, et le commentaire qui le remplaçait
 * disait pourquoi : le sélecteur de commune du premier lancement avait disparu,
 * la position suffisait, et publier la liste des clients n'avait plus d'autre
 * effet que de la rendre aspirable. Le raisonnement était juste — il ne l'est
 * plus, parce que le besoin est revenu et qu'il est différent.
 *
 * L'app confondait « la commune où je suis » et « la commune qui m'intéresse ».
 * Elles coïncident la plupart du temps et divergent le reste : au travail, en
 * vacances, en visite. Un habitant de Dreux qui passait à La Loupe ne pouvait
 * plus voir si le trou devant chez lui avait été bouché — il n'avait pas
 * déposé ce signalement, donc `/mine` ne l'aidait pas, et la liste publique
 * était celle de La Loupe.
 *
 * Ce que cet annuaire rend possible, c'est de **choisir** ce qu'on regarde. Il
 * ne publie rien de nouveau : `GET /api/reports` est déjà ouvert sans compte,
 * et c'est chaque commune qui décide de publier les siens. Il rend navigable
 * une publication qui existait déjà.
 *
 * Ce qu'il expose, en revanche, doit rester le strict minimum : **un nom et un
 * slug**. Ni plan, ni contact, ni volumétrie — la liste de nos clients est
 * lisible par nos concurrents, c'est assumé, mais leur contrat ne l'est pas.
 *
 * Les prospects en sont exclus : leurs signalements ne sont publiés nulle part,
 * et les faire apparaître dans un sélecteur ne mènerait qu'à des écrans vides.
 */
router.get('/public', publicTenantsLimiter, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('tenants')
      .select('slug, name')
      .in('status', PUBLIC_STATUSES)
      .order('name')

    if (error) throw error

    res.json({ tenants: data ?? [] })
  } catch (err) {
    next(err)
  }
})

/**
 * ─── GET /api/tenants/resolve?lat=&lng= — Quelle commune, quel tenant ───
 *
 * Le pendant lecture de la dérivation serveur : l'app a besoin de savoir où
 * elle se trouve *avant* de composer un signalement, pour afficher la commune
 * détectée et pour cadrer l'écran Explorer. Sans cet endpoint elle devrait
 * géocoder elle-même, et deux géocodeurs divergeraient tôt ou tard.
 *
 * Répond toujours 200 quand la commune est identifiée, même sans tenant :
 * « commune connue, non couverte » est une réponse utile, pas une erreur. Le
 * client s'en sert pour afficher l'écran hors couverture.
 */
router.get('/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lat = Number(req.query.lat)
    const lng = Number(req.query.lng)

    if (!isPlausiblePosition(lat, lng)) {
      throw badRequest('Coordonnées invalides.')
    }

    const location = await resolveLocation(lat, lng)

    if (!location) {
      // Les deux géocodeurs sont muets. 503 plutôt que 404 : la commune existe,
      // c'est nous qui ne savons pas la nommer à cet instant.
      res.status(503).json({
        error: 'geocoding_unavailable',
        message: 'Impossible de déterminer votre commune pour le moment.',
      })
      return
    }

    /**
     * Un tenant **prospect** ne compte pas comme une couverture.
     *
     * Il est créé automatiquement au premier signalement d'une commune non
     * cliente, pour porter la donnée. Le rendre ici comme n'importe quel tenant
     * revenait à dire « commune couverte » à tous les habitants suivants : leur
     * app adoptait un slug sans configuration, sans catégories et sans agents.
     * La coquille n'est pas une adhésion.
     */
    const tenant = location.tenant?.status === 'prospect' ? null : location.tenant

    res.json({
      insee_code: location.inseeCode,
      commune_name: location.communeName,
      address_label: location.addressLabel,
      // `null` = commune identifiée mais pas encore partenaire.
      tenant: tenant
        ? { slug: tenant.slug, name: tenant.name, status: tenant.status }
        : null,
    })
  } catch (err) {
    next(err)
  }
})

const waitlistSchema = z.object({
  insee_code: z.string().regex(/^[0-9AB][0-9]{4}$/, 'Code INSEE invalide'),
  commune_name: z.string().max(120).optional(),
  email: z.string().email('Email invalide'),
})

/**
 * ─── POST /api/tenants/waitlist — « Prévenez-moi quand ma commune rejoindra » ───
 *
 * Le seul geste qu'un habitant puisse faire quand sa commune n'est pas
 * partenaire. Il produit le chiffre qui vend : « 312 de vos habitants
 * attendent » vaut infiniment mieux qu'une carte publiée sans permission.
 *
 * Répond 204 même sur un doublon : réinscrire la même adresse n'est pas une
 * erreur du point de vue du citoyen, et lui dire « vous êtes déjà inscrit »
 * révélerait qui figure sur la liste.
 */
router.post('/waitlist', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = waitlistSchema.safeParse(req.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Requête invalide.')

    await joinWaitlist({
      inseeCode: parsed.data.insee_code,
      communeName: parsed.data.commune_name ?? '',
      email: parsed.data.email,
    })

    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

export default router
