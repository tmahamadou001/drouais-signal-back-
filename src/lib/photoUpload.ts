import crypto from 'crypto'
import { supabaseAdmin } from './supabaseAdmin.js'

/**
 * Une photo envoyée par un habitant, stockée et signée.
 *
 * Le code vivait au milieu de la création d'un signalement. Le constat de
 * réparation (migration 040) a le même besoin et exactement les mêmes règles —
 * même bucket, même durée de signature, même nommage aléatoire — et les
 * recopier aurait garanti qu'ils divergent à la première correction.
 *
 * Un an de validité : c'est la durée de conservation côté purge RGPD, et une
 * URL signée plus courte ferait disparaître les photos d'un dossier encore
 * ouvert.
 */
const SIGNED_URL_TTL_SECONDS = 31_536_000

export async function uploadPhoto(file: {
  buffer: Buffer
  mimetype: string
}): Promise<string> {
  const ext = file.mimetype.split('/')[1] || 'jpg'
  const path = `reports/${crypto.randomUUID()}.${ext}`

  const { error: uploadError } = await supabaseAdmin.storage
    .from('photos')
    .upload(path, file.buffer, { contentType: file.mimetype, upsert: false })

  if (uploadError) throw uploadError

  const { data, error } = await supabaseAdmin.storage
    .from('photos')
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS)

  if (error) throw error

  return data.signedUrl
}
