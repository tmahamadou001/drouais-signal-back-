import { supabaseAdmin } from './supabaseAdmin.js'

/**
 * Le chemin d'une photo dans le bucket `photos`, retrouvé depuis son URL.
 *
 * Les photos sont servies par des URL signées valables un an : le chemin de
 * stockage n'est pas conservé en base, il se relit dans l'URL. Cette extraction
 * était recopiée à chaque endroit qui supprime une photo — suppression simple,
 * suppression en masse, et maintenant la purge de conservation. Trois copies
 * d'une expression régulière, c'est trois occasions de n'en corriger que deux.
 *
 * `null` quand l'URL n'a pas la forme attendue : une photo dont on ne sait pas
 * retrouver le fichier ne doit pas faire échouer la suppression du signalement.
 */
export function storagePathFromUrl(photoUrl: string | null | undefined): string | null {
  if (!photoUrl) return null

  try {
    const { pathname } = new URL(photoUrl)
    const match = pathname.match(/\/storage\/v1\/object\/sign\/photos\/(.+)$/)
    if (!match?.[1]) return null

    const path = decodeURIComponent(match[1])
    // Les URL anciennes portaient le dossier dans la signature, les nouvelles non.
    return path.startsWith('reports/') ? path : `reports/${path}`
  } catch {
    return null
  }
}

/** Supprime le fichier s'il est retrouvable. Ne jette jamais. */
export async function removePhoto(photoUrl: string | null | undefined): Promise<boolean> {
  const path = storagePathFromUrl(photoUrl)
  if (!path) return false

  try {
    const { error } = await supabaseAdmin.storage.from('photos').remove([path])
    if (error) {
      console.error('Suppression de photo impossible :', error.message)
      return false
    }
    return true
  } catch (err) {
    console.error('Suppression de photo impossible :', err)
    return false
  }
}
