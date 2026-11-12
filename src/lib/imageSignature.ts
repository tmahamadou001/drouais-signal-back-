/**
 * Ce qu'un fichier **est**, par ses premiers octets.
 *
 * `multer` ne contrôlait que le `mimetype`, c'est-à-dire ce que le client
 * déclare. Rien n'empêchait d'envoyer une archive, un script ou un PDF
 * annoncés `image/jpeg` : ils finissaient dans le bucket `photos`, servis par
 * une URL signée d'un an, sous notre nom de domaine. Le bucket étant par
 * ailleurs resté listable par la clé anon jusqu'au 12 novembre 2026, c'était
 * un hébergeur de fichiers à nos frais.
 *
 * Quelques octets suffisent à lever le doute, et sans dépendance : les formats
 * d'image ont tous un en-tête reconnaissable. On refuse ce qu'on ne reconnaît
 * pas, plutôt que d'accepter ce qu'on ne sait pas nommer.
 */

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'gif'

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false

  return bytes.every((byte, index) => buffer[offset + index] === byte)
}

/** Le format réel du fichier, ou `null` si ce n'est pas une image connue. */
export function imageFormatOf(buffer: Buffer): ImageFormat | null {
  // JPEG : FF D8 FF
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'jpeg'

  // PNG : 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'

  // GIF : "GIF87a" ou "GIF89a"
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return 'gif'

  // WebP : "RIFF" .... "WEBP" — la taille s'intercale entre les deux.
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'webp'
  }

  return null
}

/**
 * Le type déclaré correspond-il au contenu ?
 *
 * On ne se contente pas de « c'est une image » : un PNG annoncé `image/jpeg`
 * trahit soit un client cassé, soit une tentative. Dans les deux cas on
 * préfère refuser et le dire.
 */
export function matchesDeclaredType(buffer: Buffer, mimetype: string): boolean {
  const format = imageFormatOf(buffer)
  if (!format) return false

  return mimetype === `image/${format}`
}
