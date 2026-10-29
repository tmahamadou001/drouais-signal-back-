import crypto from 'crypto'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'
import { resolve as resolveLocation, isPlausiblePosition } from './geoRouting.js'
import { resolveCategories } from './categoryService.js'
import { AppError, badRequest } from '../middleware/errorHandler.js'

/**
 * La saisie d'un signalement depuis le back-office.
 *
 * La majorité de ce qu'une mairie traite n'arrive pas par l'application :
 * l'appel téléphonique, le passage à l'accueil, le mail d'un élu, le potelet
 * qu'un agent voit pendant sa tournée. Sans cet écran, tout cela vit dans un
 * carnet, et le tableau de bord mesure l'application plutôt que la commune.
 *
 * **Ce n'est pas la même règle que le dépôt citoyen, et c'est pour ça que ce
 * n'est pas la même route.**
 *
 *  - pour l'habitant, la position *décide* de la commune : `POST /api/reports`
 *    ignore délibérément `X-Tenant-Slug`, parce qu'un repli sur l'en-tête
 *    suffirait à reprendre la main sur `tenant_id` ;
 *  - pour l'agent, la commune est **connue** — c'est la sienne, vérifiée par
 *    `requireAgent` — et la position doit être vérifiée comme étant dedans.
 *
 * Réutiliser la route publique avec un drapeau « ne pas router » aurait rouvert
 * exactement le trou que la première protège. Ici, la position est résolue de
 * la même façon, puis **confrontée** au territoire de la commune : une épingle
 * posée de l'autre côté de la limite est refusée, au lieu d'écrire dans le
 * tenant du voisin ou de créer un prospect pour une mairie qui n'a rien demandé.
 */

export interface ManualReportInput {
  title: string
  description?: string
  category: string
  lat: number
  lng: number
}

export interface ManualReportPhoto {
  buffer: Buffer
  mimetype: string
}

export interface ManualReportResult {
  id: string
  reference: string | null
}

/**
 * Vérifie que la position tombe bien dans la commune de l'agent.
 *
 * On compare des **codes INSEE**, pas des noms : c'est `tenant_territories`
 * qui fait autorité sur ce qu'une commune couvre, et c'est déjà lui qui route
 * les signalements des habitants. Une commune peut porter plusieurs codes
 * (communes déléguées), d'où le `in`.
 */
async function coversInsee(tenantId: string, inseeCode: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('tenant_territories')
    .select('insee_code')
    .eq('tenant_id', tenantId)
    .eq('insee_code', inseeCode)
    .maybeSingle()

  return Boolean(data)
}

async function uploadPhoto(photo: ManualReportPhoto): Promise<string> {
  const ext = photo.mimetype.split('/')[1] || 'jpg'
  const filePath = `reports/${crypto.randomUUID()}.${ext}`

  const { error: uploadError } = await supabaseAdmin.storage
    .from('photos')
    .upload(filePath, photo.buffer, { contentType: photo.mimetype, upsert: false })

  if (uploadError) throw uploadError

  const { data, error } = await supabaseAdmin.storage
    .from('photos')
    .createSignedUrl(filePath, 31536000)

  if (error) throw error

  return data.signedUrl
}

export async function createManualReport(
  tenantId: string,
  input: ManualReportInput,
  photo?: ManualReportPhoto
): Promise<ManualReportResult> {
  if (!isPlausiblePosition(input.lat, input.lng)) {
    throw badRequest('La position transmise est invalide.')
  }

  const location = await resolveLocation(input.lat, input.lng)

  if (!location) {
    throw new AppError(
      503,
      'geocoding_unavailable',
      'Impossible de localiser ce point pour le moment. Réessayez dans un instant.'
    )
  }

  if (!(await coversInsee(tenantId, location.inseeCode))) {
    throw new AppError(
      422,
      'outside_territory',
      `Ce point est situé à ${location.communeName}, hors du territoire de votre commune.`
    )
  }

  /**
   * La catégorie est validée deux fois, comme pour un dépôt citoyen : elle doit
   * exister dans la taxonomie **nationale** — c'est ce qui rend deux communes
   * comparables — et ne pas avoir été désactivée par celle-ci.
   */
  const available = await resolveCategories(tenantId)
  const match = available.find((item) => item.slug === input.category)

  if (available.length > 0) {
    if (!match) throw badRequest(`Catégorie invalide : "${input.category}"`)
    if (!match.is_active) {
      throw badRequest(`Cette commune ne traite pas les signalements « ${match.label} ».`)
    }
  }

  const photoUrl = photo ? await uploadPhoto(photo) : null

  const { data, error } = await supabaseAdmin
    .from('reports')
    .insert({
      title: input.title.trim(),
      category: input.category,
      description: input.description?.trim() || null,
      photo_url: photoUrl,
      lat: input.lat,
      lng: input.lng,
      // L'adresse de la BAN fait foi, comme au dépôt : elle vient de la même
      // source que le code INSEE qu'on vient de vérifier, donc le libellé
      // affiché et le territoire ne peuvent pas se contredire.
      address_approx: location.addressLabel,
      insee_code: location.inseeCode,
      geo_resolved: true,
      is_published: true,
      status: 'en_attente',
      /**
       * Aucun auteur, et c'est délibéré.
       *
       * Mettre l'agent dans `user_id` paraîtrait naturel et casserait trois
       * choses en silence : `resolveCitizenContact` trouverait un compte, donc
       * la commune s'enverrait un e-mail à elle-même à chaque changement de
       * statut ; le signalement apparaîtrait dans « Mes signalements » de
       * l'agent sur mobile ; et l'onglet Échanges proposerait d'écrire à
       * l'habitant — qui serait l'agent. Qui a saisi se lit dans l'audit.
       */
      user_id: null,
      is_anonymous: false,
      anonymous_token: null,
      anonymous_email: null,
      ai_assisted: false,
      source: 'agent',
      tenant_id: tenantId,
    })
    .select('id, reference')
    .single()

  if (error) throw error

  await supabaseAdmin.rpc('insert_initial_status_history', {
    p_report_id: data.id,
    p_tenant_id: tenantId,
  })

  return { id: data.id, reference: data.reference ?? null }
}
