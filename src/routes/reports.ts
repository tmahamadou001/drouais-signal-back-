import { Router, Request, Response, NextFunction, type Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { verifyToken, verifyTokenOptional } from '../middleware/auth.js'
import { resolve as resolveLocation, isPlausiblePosition } from '../services/geoRouting.js'
import { ensureProspectTenant } from '../services/prospectService.js'
import { resolveCategories, resolveCategory } from '../services/categoryService.js'
import { readLimit } from '../lib/pagination.js'
import { removePhoto } from '../lib/photoStorage.js'
import { resolveCitizenContact } from '../lib/citizenContact.js'
import { ownsReport } from '../lib/reportOwnership.js'
import { applyReportFilters, overdueFilter, readReportFilters, sortColumns } from '../lib/reportFilters.js'
import { createReportSchema, updateReportSchema, paginationSchema, transmitReportSchema, bulkTransmitSchema } from '../schemas/report.schema.js'
import { transmitReport, transmitReports } from '../services/transmitService.js'
import { isFinal, isRollback } from '../lib/statusFlow.js'
import { upload } from '../middleware/upload.js'
import crypto from 'crypto'
import { validate } from '../middleware/validate.js'
import { sendStatusChangeNotification, sendServiceNotification } from '../services/notificationService.js'
import { requireTenantAdmin, requireAgent } from '../middleware/roleGuard.js'
import { auditReportStatusChanged, auditReportDeleted, auditReportBulkDeleted, createAuditLog } from '../services/auditService.js'
import { createReportLimiter } from '../middleware/rateLimits.js'
import { AppError, notFound, badRequest, forbidden } from '../middleware/errorHandler.js'

const router: ExpressRouter = Router()

// ─── GET /api/reports — Public list of all reports with pagination ───
/**
 * Les colonnes de la liste, typées `string` et non littéral.
 *
 * `supabase-js` analyse la chaîne de `select()` pour en déduire le type des
 * lignes. Avec les filtres génériques par-dessus, l'inférence explose
 * (« Type instantiation is excessively deep »). Élargir le type ici coûte le
 * typage des lignes de cette requête — que le client ne consomme de toute façon
 * qu'à travers son propre type `Report`.
 */
const LIST_COLUMNS: string =
  'id, reference, title, category, status, created_at, address_approx, lat, lng, photo_url, description, vote_count'

router.get('/', validate(paginationSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1
    const limit = readLimit(req.query.limit)
    const offset = (page - 1) * limit
    const tenantId = req.tenant?.id
    const filters = readReportFilters(req.query as Record<string, unknown>)

    /**
     * La liste publique ne montre que ce qui est publié.
     *
     * Un signalement reçu en commune prospect reste lisible par son auteur —
     * `/mine`, et le détail par identifiant — mais n'apparaît ni ici ni sur la
     * carte. Publier l'inventaire des dégradations d'une mairie qui n'a rien
     * demandé serait une démarche commerciale hostile.
     */
    // Calculées une fois, partagées par les deux requêtes : elles dépendent de
    // l'heure, et deux appels séparés donneraient deux instants différents.
    const overdueClauses = filters.overdue ? await overdueFilter(tenantId) : ''

    const countQuery = applyReportFilters(
      supabaseAdmin.from('reports').select('*', { count: 'exact', head: true }).eq('is_published', true),
      filters,
      tenantId,
      overdueClauses
    )

    const { count, error: countError } = await countQuery
    if (countError) throw countError

    let dataQuery = applyReportFilters(
      supabaseAdmin
        .from('reports')
        .select(LIST_COLUMNS)
        .eq('is_published', true),
      filters,
      tenantId,
      overdueClauses
    )

    for (const { column, ascending } of sortColumns(filters.sort)) {
      dataQuery = dataQuery.order(column, { ascending })
    }
    dataQuery = dataQuery.range(offset, offset + limit - 1)

    const { data, error } = await dataQuery
    if (error) throw error

    res.json({
      data,
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/reports/mine — Reports of the logged-in user ───
/**
 * Les signalements de l'appelant — **toutes communes confondues**.
 *
 * Ils étaient filtrés par `X-Tenant-Slug`, c'est-à-dire par la commune où se
 * trouve le téléphone *maintenant*. Un habitant de Dreux qui passe à La Loupe
 * voyait donc « Mes signalements » se vider : le trou devant chez lui avait
 * disparu, et il ne pouvait plus savoir s'il avait été réparé.
 *
 * L'en-tête de commune cadre les **listes publiques** — « ce qui est signalé
 * ici ». Il n'a rien à dire de ce qui appartient à l'appelant : ses
 * signalements sont les siens où qu'il se trouve, et son adresse ne change pas
 * quand il se déplace.
 */
router.get('/mine', verifyToken, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('reports')
      .select('*')
      .eq('user_id', req.userId!)
      .order('created_at', { ascending: false })

    if (error) throw error
    res.json(data)
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/reports/anonymous/:token — Get anonymous report by token ───
router.get('/anonymous/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params

    /**
     * Pas de filtre de commune : **le jeton est la preuve**, et il ne vaut que
     * pour ce signalement.
     *
     * Ce lien voyage dans un e-mail de suivi, donc il est ouvert depuis
     * n'importe où — un bureau, un train, une autre commune. Le croiser avec
     * la commune détectée du moment rendait le lien mort exactement là où il
     * sert : loin de chez soi.
     */
    const reportResult = await supabaseAdmin
      .from('reports')
      .select('id, reference, title, category, status, created_at, address_approx, lat, lng, photo_url')
      .eq('anonymous_token', token)
      .eq('is_anonymous', true)
      .single()

    if (reportResult.error) throw notFound('Signalement')

    res.json(reportResult.data)
  } catch (err) {
    next(err)
  }
})

/**
 * Les adresses que la commune connaît déjà.
 *
 * Deux sources, parce qu'un agent pense en termes de « la régie », pas en
 * termes de table : celles configurées sur ses catégories, et celles à qui elle
 * a déjà transmis. Proposer une liste évite de retaper une adresse — et une
 * adresse retapée est une adresse mal tapée.
 */
router.get('/service-recipients', verifyToken, requireAgent, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.tenant?.id
    if (!tenantId) throw badRequest('Tenant requis.')

    const [categories, handoffs] = await Promise.all([
      resolveCategories(tenantId),
      supabaseAdmin
        .from('service_handoffs')
        .select('recipient, service_name, created_at')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(200),
    ])

    const known = new Map<string, { email: string; serviceName: string | null; source: string }>()

    for (const category of categories) {
      for (const email of category.service_emails ?? []) {
        if (!known.has(email)) {
          known.set(email, {
            email,
            serviceName: category.service_name ?? null,
            source: `Catégorie ${category.label}`,
          })
        }
      }
    }

    for (const handoff of (handoffs.data ?? []) as any[]) {
      if (!known.has(handoff.recipient)) {
        known.set(handoff.recipient, {
          email: handoff.recipient,
          serviceName: handoff.service_name ?? null,
          source: 'Déjà utilisée',
        })
      }
    }

    res.json({ recipients: [...known.values()] })
  } catch (err) {
    next(err)
  }
})

// ─── GET /api/reports/:id — Single report with history ───
// `verifyTokenOptional` : la route reste ouverte, mais si un jeton est présent
// on sait qui appelle — et c'est ce qui permet à l'auteur d'un signalement non
// publié de lire le sien. Sans lui, `req.userId` est toujours vide et seul le
// jeton de suivi `X-Report-Token` ferait preuve.
router.get('/:id', verifyTokenOptional, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params

    /**
     * Le détail se lit sans filtre de commune, et se referme sur la
     * publication.
     *
     * Le filtre par `X-Tenant-Slug` rendait introuvable, depuis une autre
     * commune, un signalement pourtant public — y compris le sien, y compris
     * celui qu'une notification venait d'annoncer résolu. Ce n'est pas la
     * commune du téléphone qui décide de ce qui est lisible : c'est la
     * publication, plus bas.
     */
    const [reportResult, historyResult] = await Promise.all([
      supabaseAdmin.from('reports').select('*').eq('id', id).single(),
      supabaseAdmin
        .from('status_history')
        .select('*')
        .eq('report_id', id)
        .order('changed_at', { ascending: true }),
    ])

    if (reportResult.error) throw notFound('Signalement')

    /**
     * Un signalement non publié n'est lisible que par son auteur.
     *
     * `is_published` est faux pour les communes prospects : leurs signalements
     * sont collectés sans que la mairie ait rien demandé, et publier
     * l'inventaire des dégradations d'une commune qui n'a rien demandé serait
     * une démarche commerciale hostile. La liste et la carte les écartaient
     * déjà ; **cette route ne les écartait pas** — le filtre de commune y
     * tenait lieu de protection, par accident, et il vient de tomber.
     *
     * Son auteur, lui, y a toujours droit : par son compte, ou par le jeton de
     * suivi que le serveur lui a remis une fois.
     */
    if (!reportResult.data.is_published && !ownsReport(req, reportResult.data)) {
      throw notFound('Signalement')
    }

    /**
     * Comment joindre l'auteur — calculé ici, pas deviné par le client.
     *
     * Un agent qui écrit à un signalement déposé sans compte et sans adresse
     * écrit dans le vide : rien ne part, et il n'a aucun moyen de le savoir.
     * L'écran a besoin de le lui dire, donc la règle remonte avec le
     * signalement. L'adresse elle-même n'y est pas : le back-office affiche
     * qu'un contact existe, pas lequel.
     */
    const contact = await resolveCitizenContact(reportResult.data)

    res.json({
      report: reportResult.data,
      history: historyResult.data || [],
      contact: { channel: contact.channel, reachable: contact.reachable },
    })
  } catch (err) {
    next(err)
  }
})

// ─── POST /api/reports — Create a new report (authenticated or anonymous) ───
router.post('/', verifyTokenOptional, createReportLimiter, upload.single('photo'), validate(createReportSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, category, description, lat, lng, address_approx, anonymous_email,
            position_accuracy, position_captured_at } = req.body
    const ai_assisted = req.body.ai_assisted === 'true' || req.body.ai_assisted === true

    /**
     * Une session anonyme Supabase n'est pas une identité.
     *
     * Elle servait de « preuve d'application » à `requireTrustedOrigin`, guard
     * retiré depuis : n'importe qui pouvait en obtenir une, et son seul effet
     * réel était de rendre le parcours sans compte dépendant d'un réglage du
     * tableau de bord Supabase. Il n'en reste qu'un usage légitime — servir de
     * seau de rate limiting par installation (`middleware/rateLimits.ts`).
     *
     * Un tel citoyen est donc traité comme un appelant sans jeton : un jeton de
     * suivi, et aucun `user_id` rattachant le signalement à un compte jetable
     * dans lequel il ne pourra jamais se reconnecter.
     */
    const isAnonymous = !req.userId || req.isAnonymousUser === true

    const anonymousToken = isAnonymous ? crypto.randomBytes(32).toString('hex') : null

    /**
     * ─── Le tenant est dérivé de la position, jamais annoncé par le client ───
     *
     * `X-Tenant-Slug` est délibérément ignoré ici. Ce n'est pas une simple
     * dépriorisation : un repli sur l'en-tête quand le géocodage échoue serait
     * un contournement complet — il suffirait d'envoyer une coordonnée
     * irrésoluble pour reprendre la main sur le tenant. Or `tenant_id` décide
     * de qui voit la donnée, qui la traite, et demain de ce qu'on facture.
     *
     * L'en-tête reste légitime en lecture, où il ne fait que cadrer la requête.
     * Il perd toute autorité en écriture.
     */
    if (!isPlausiblePosition(lat, lng)) {
      throw badRequest('La position transmise est invalide.')
    }

    const location = await resolveLocation(lat, lng)

    // Échec fermé. Sans commune il n'y a pas de tenant, et `tenant_id` est NOT
    // NULL : rien ne peut porter ce signalement. Le client réessaiera — cette
    // résilience appartient à sa file d'attente hors ligne, pas à un état
    // intermédiaire en base.
    if (!location) {
      throw new AppError(
        503,
        'geocoding_unavailable',
        'Impossible de localiser votre commune pour le moment. Réessayez dans un instant.'
      )
    }

    /**
     * Commune identifiée mais pas encore partenaire.
     *
     * Le signalement est accueilli — l'app a prévenu le citoyen avant qu'il
     * envoie, et il a choisi de continuer. Il atterrit dans un tenant prospect
     * et n'est pas publié : ni dans la liste publique, ni sur la carte. Son
     * auteur seul le voit.
     *
     * Le refuser ici ferait perdre la seule chose qui convaincra cette mairie
     * de rejoindre la plateforme — la preuve que ses habitants signalent déjà.
     */
    const tenant = location.tenant
      ?? (await ensureProspectTenant(location.inseeCode, location.communeName))

    if (!tenant) {
      // La création a échoué : rien ne peut porter ce signalement.
      throw new AppError(
        503,
        'tenant_unavailable',
        'Impossible d’enregistrer votre signalement pour le moment. Réessayez dans un instant.'
      )
    }

    /**
     * La couverture se lit sur le **statut** du tenant, pas sur son existence.
     *
     * Elle se déduisait de `location.tenant !== null`, ce qui n'était juste que
     * pour le tout premier signalement d'une commune : le suivant retrouvait le
     * tenant prospect créé par le précédent, concluait « couverte », et
     * publiait. L'inventaire des dégradations d'une mairie qui n'a rien demandé
     * devenait public à partir du deuxième habitant — précisément ce que le
     * dispositif prospect existe pour éviter.
     */
    const covered = tenant.status !== 'prospect'

    /**
     * La catégorie est validée contre la liste **nationale**, pas contre celle
     * du tenant.
     *
     * `reports.category` porte désormais un slug canonique : c'est ce qui rend
     * comparables deux signalements de deux communes et mesurable la justesse
     * de l'IA. La commune ne décide plus de ce qui existe, seulement de ce
     * qu'elle traite — d'où le second filtre, sur ce qu'elle a désactivé.
     *
     * Un tenant prospect n'a aucune ligne de configuration : la liste nationale
     * s'applique alors telle quelle, ce qui est exactement le comportement
     * voulu pendant l'amorçage.
     */
    const available = await resolveCategories(tenant.id)

    if (available.length > 0) {
      const match = available.find((item) => item.slug === category)

      if (!match) throw badRequest(`Catégorie invalide : "${category}"`)
      if (!match.is_active) {
        throw badRequest(`Cette commune ne traite pas les signalements « ${match.label} ».`)
      }
    }

    // Upload photo to Supabase Storage if present
    let photo_url: string | null = null
    if (req.file) {
      const ext = req.file.mimetype.split('/')[1] || 'jpg'
      const fileName = `${crypto.randomUUID()}.${ext}`
      const filePath = `reports/${fileName}`

      const { error: uploadError } = await supabaseAdmin.storage
        .from('photos')
        .upload(filePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: false,
        })

      if (uploadError) throw uploadError

      const { data: urlData, error: urlError } = await supabaseAdmin.storage
        .from('photos')
        .createSignedUrl(filePath, 31536000)

      if (urlError) throw urlError

      photo_url = urlData.signedUrl
    }

    const { data, error } = await supabaseAdmin
      .from('reports')
      .insert({
        title: title.trim(),
        category,
        description: description?.trim() || null,
        photo_url,
        lat,
        lng,
        // L'adresse de la BAN fait foi sur celle proposée par le client : elle
        // vient de la même source que le routage, donc les deux ne peuvent pas
        // se contredire dans le back-office.
        address_approx: location.addressLabel ?? address_approx?.trim() ?? null,
        insee_code: location.inseeCode,
        geo_resolved: true,
        // Non publié en commune prospect : publier l'inventaire des
        // dégradations d'une mairie qui n'a rien demandé fermerait le marché
        // qu'on cherche à ouvrir.
        is_published: covered,
        position_accuracy: position_accuracy ?? null,
        position_captured_at: position_captured_at ?? null,
        status: 'en_attente',
        user_id: isAnonymous ? null : req.userId,
        is_anonymous: isAnonymous,
        anonymous_token: anonymousToken,
        anonymous_email: isAnonymous && anonymous_email ? anonymous_email.trim() : null,
        ai_assisted,
        tenant_id: tenant.id,
      })
      // `reference` est attribuée par le trigger de la migration 032 : elle
      // n'existe qu'après l'insertion, et l'application l'affiche aussitôt à
      // l'habitant comme numéro de suivi.
      .select('id, reference, anonymous_token')
      .single()

    if (error) throw error

    // Historique initial — RPC garantit l'atomicité même si la connexion coupe après l'insert report
    await supabaseAdmin.rpc('insert_initial_status_history', {
      p_report_id: data.id,
      p_tenant_id: tenant.id,
    })

    createAuditLog({
      // Same reasoning as the insert above: an anonymous sign-in is not an
      // author. Passing its id would send `enrichUserData` looking up a
      // throwaway account with no e-mail and no tenant role.
      userId: isAnonymous ? undefined : req.userId,
      action: 'report.created',
      entityType: 'report',
      entityId: data.id,
      // Le tenant résolu depuis la position, pas celui annoncé par le
      // client : l'audit doit consigner la décision du serveur.
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      metadata: {
        category,
        is_anonymous: isAnonymous,
        ai_assisted,
        has_photo: !!photo_url,
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch(err => console.error('[Audit] Erreur:', err))

    // Transmission asynchrone au service municipal concerné (non bloquant)
    sendServiceNotification({
      reportId: data.id,
      reportTitle: title.trim(),
      category,
      description: description?.trim() || null,
      addressApprox: address_approx?.trim() || null,
      photoUrl: photo_url || null,
      createdAt: new Date().toISOString(),
      isAnonymous,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
    }).catch(err => console.error('[ServiceNotif] Erreur:', err))

    const response: { id: string; reference: string; anonymous_token?: string } =
      { id: data.id, reference: data.reference }
    if (isAnonymous) {
      response.anonymous_token = data.anonymous_token
    }
    res.status(201).json(response)
  } catch (err) {
    next(err)
  }
})

/**
 * Transmet un signalement à un service, à la demande d'un agent.
 *
 * La transmission n'existait qu'au dépôt, en effet de bord de la création. Trois
 * situations la rendaient impossible alors qu'elle était légitime : un
 * destinataire configuré après coup, un agent qui juge que ça relève finalement
 * de la régie, un premier envoi rebondi.
 */
router.post('/:id/transmit', verifyToken, requireAgent, validate(transmitReportSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenant = req.tenant
    if (!tenant?.id) throw badRequest('Tenant requis.')

    const { recipients, serviceName, remember } = req.body as {
      recipients?: string[]
      serviceName?: string
      remember?: boolean
    }

    const outcome = await transmitReport(req.params.id, {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      recipients,
      serviceName,
      remember,
    })

    if (!outcome.ok) {
      throw new AppError(
        outcome.reason === 'Signalement introuvable.' ? 404 : 502,
        'transmission_failed',
        outcome.reason ?? 'La transmission a échoué.'
      )
    }

    res.json({ recipients: recipients ?? null })
  } catch (err) {
    next(err)
  }
})

/**
 * Transmet une sélection de signalements au même service.
 *
 * Le cas qui l'appelle : une tournée de la régie, sept lampadaires éteints dans
 * le même quartier. Les ouvrir un à un pour répéter sept fois le même geste
 * était la seule façon de le faire.
 *
 * Pas d'option « enregistrer pour la catégorie » ici, contrairement à la
 * transmission à l'unité : la sélection couvre souvent plusieurs catégories, et
 * il n'y a alors aucune réponse honnête à la question de savoir laquelle règle
 * ce destinataire. Ce réglage se prend sur une fiche, où le contexte existe.
 *
 * Rend le détail signalement par signalement : une transmission partielle est
 * un résultat courant — un signalement déjà résolu, une catégorie sans
 * destinataire — et l'agent a besoin de savoir lesquels sont partis.
 */
router.post('/transmit', verifyToken, requireAgent, validate(bulkTransmitSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenant = req.tenant
    if (!tenant?.id) throw badRequest('Tenant requis.')

    const { ids, recipients, serviceName } = req.body as {
      ids: string[]
      recipients?: string[]
      serviceName?: string
    }

    const outcomes = await transmitReports(ids, {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      recipients,
      serviceName,
    })

    res.json({
      transmitted: outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.id),
      failed: outcomes
        .filter((outcome) => !outcome.ok)
        .map(({ id, reference, reason }) => ({ id, reference, reason })),
    })
  } catch (err) {
    next(err)
  }
})

// ─── PATCH /api/reports/:id/status — Admin: update report status ───
router.patch('/:id/status', verifyToken, requireAgent, validate(updateReportSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params
    const { status, comment } = req.body

    const { data: currentReport, error: fetchError } = await supabaseAdmin
      .from('reports')
      .select('id, title, status, category, address_approx, photo_url, created_at, user_id, tenant_id, is_anonymous, anonymous_token')
      .eq('id', id)
      .single()

    if (fetchError || !currentReport) throw notFound('Signalement')

    const oldStatus = currentReport.status
    const tenantId = req.tenant?.id ?? currentReport.tenant_id

    /**
     * « Résolu » est terminal.
     *
     * Clore un signalement prévient l'habitant que c'est fait. Le rouvrir
     * ensuite ferait de cette annonce quelque chose qu'on reprend, et priverait
     * les statistiques de résolution de toute valeur — un signalement pourrait
     * être compté résolu plusieurs fois. Le back-office avertit avant le clic
     * plutôt que de laisser le découvrir après ; le serveur, lui, refuse, parce
     * qu'un avertissement d'interface n'est pas une garantie.
     *
     * L'erreur reste un signalement supprimable, et la conversation avec
     * l'habitant reste ouverte : il peut dire que ce n'est pas réglé.
     */
    if (status && isFinal(oldStatus)) {
      throw new AppError(
        409,
        'status_final',
        'Ce signalement est résolu : son statut ne peut plus être modifié.'
      )
    }

    /**
     * Le retour en arrière est permis, et nommé.
     *
     * Un agent qui clique « Prendre en charge » sur la mauvaise ligne n'avait
     * aucun moyen de se corriger. Rien n'empêchait techniquement le retour —
     * c'est l'interface qui ne l'offrait pas — donc rien ne le traçait non
     * plus : le journal d'audit montrait une succession de changements sans
     * distinguer la marche avant du rattrapage.
     */
    const rollback = status ? isRollback(oldStatus, status) : false

    const { data: rows, error: rpcError } = await supabaseAdmin.rpc(
      'update_report_status_atomic',
      {
        p_report_id:  id,
        p_new_status: status,
        p_agent_id:   req.userId,
        p_tenant_id:  tenantId,
        p_comment:    comment ?? (rollback ? `Retour à « ${status} »` : null),
      }
    )

    if (rpcError) throw rpcError

    const updatedReport = Array.isArray(rows) ? rows[0] : rows
    res.json({ data: updatedReport })

    auditReportStatusChanged({
      reportId: id,
      reportTitle: currentReport.title,
      oldStatus,
      newStatus: status,
      changedBy: req.userId!,
      tenantId: req.tenant?.id,
      tenantSlug: req.tenant?.slug,
      comment,
      rollback,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch(err => console.error('[Audit] Erreur:', err))

    sendStatusChangeNotification({
      reportId: currentReport.id,
      reportTitle: currentReport.title,
      newStatus: status,
      previousStatus: oldStatus,
      category: currentReport.category,
      addressApprox: currentReport.address_approx,
      photoUrl: currentReport.photo_url,
      createdAt: currentReport.created_at,
      userId: currentReport.user_id,
      tenantId: req.tenant?.id,
      isAnonymous: currentReport.is_anonymous,
      anonymousToken: currentReport.anonymous_token,
    }).catch(err => {
      console.error('[Notification] Erreur background:', err)
    })
  } catch (err) {
    next(err)
  }
})

// ─── DELETE /api/reports/:id — Admin: delete a report ───
router.delete('/:id', verifyToken, requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params

    const { data: currentReport, error: fetchError } = await supabaseAdmin
      .from('reports')
      .select('id, title, tenant_id, photo_url')
      .eq('id', id)
      .single()

    if (fetchError || !currentReport) throw notFound('Signalement')

    if (req.tenant?.id && currentReport.tenant_id !== req.tenant.id) {
      throw forbidden('Vous ne pouvez supprimer que les signalements de votre tenant.')
    }

    await removePhoto(currentReport.photo_url)

    await supabaseAdmin.from('status_history').delete().eq('report_id', id)

    const { error: deleteError } = await supabaseAdmin
      .from('reports')
      .delete()
      .eq('id', id)

    if (deleteError) throw deleteError

    auditReportDeleted({
      reportId: id,
      reportTitle: currentReport.title,
      deletedBy: req.userId!,
      tenantId: req.tenant?.id,
      tenantSlug: req.tenant?.slug,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch(err => console.error('[Audit] Erreur:', err))

    res.json({ success: true, message: 'Signalement supprimé avec succès.' })
  } catch (err) {
    next(err)
  }
})

// ─── DELETE /api/reports/bulk — Admin: delete multiple reports ───
router.delete('/', verifyToken, requireTenantAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ids } = req.body

    if (!Array.isArray(ids) || ids.length === 0) {
      throw badRequest('Liste d\'IDs requise.')
    }

    const { data: reports, error: fetchError } = await supabaseAdmin
      .from('reports')
      .select('id, tenant_id, photo_url')
      .in('id', ids)

    if (fetchError) throw fetchError

    if (!reports || reports.length === 0) {
      throw notFound('Signalements')
    }

    const invalidReports = reports.filter(r => r.tenant_id !== req.tenant?.id)
    if (invalidReports.length > 0) {
      throw forbidden('Vous ne pouvez supprimer que les signalements de votre tenant.')
    }

    for (const report of reports) {
      await removePhoto(report.photo_url)
    }

    await supabaseAdmin.from('status_history').delete().in('report_id', ids)

    const { error: deleteError } = await supabaseAdmin
      .from('reports')
      .delete()
      .in('id', ids)

    if (deleteError) throw deleteError

    auditReportBulkDeleted({
      reportIds: ids,
      deletedBy: req.userId!,
      tenantId: req.tenant?.id,
      tenantSlug: req.tenant?.slug,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    }).catch(err => console.error('[Audit] Erreur:', err))

    res.json({
      success: true,
      message: `${reports.length} signalement(s) supprimé(s) avec succès.`,
      deletedCount: reports.length,
    })
  } catch (err) {
    next(err)
  }
})

export default router
