import crypto from 'crypto'
import { supabaseAdmin } from './supabaseAdmin.js'

/**
 * Les liens d'action remis aux services extérieurs.
 *
 * Une régie d'éclairage, un prestataire de collecte, une police municipale :
 * ces gens ne créeront jamais un compte pour trois signalements par mois.
 * Leur demander d'apprendre une interface, c'est la garantie qu'ils ne le
 * feront pas — et que la mairie continuera de relancer au téléphone.
 *
 * Le lien reçu dans l'e-mail **est** l'autorisation. Ce n'est pas un mot de
 * passe et il n'ouvre aucune session : il vaut pour **un signalement**, **deux
 * transitions** — « je m'en occupe », « c'est fait » — et rien d'autre. Ni
 * liste, ni recherche, ni suppression, ni données personnelles de l'habitant.
 *
 * Seule l'empreinte est conservée. Une fuite de `service_handoffs` ne doit pas
 * donner le droit d'agir, exactement comme une fuite de table d'utilisateurs ne
 * doit pas donner leurs mots de passe.
 */

/** 32 octets : hors de portée d'une énumération, court assez pour tenir dans une URL. */
const TOKEN_BYTES = 32

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export interface HandoffTarget {
  reportId: string
  tenantId: string
  recipient: string
  serviceName: string | null
  category: string
}

/**
 * Crée un lien pour un destinataire, et rend le jeton **en clair une seule
 * fois** — il part dans l'e-mail et n'est plus jamais récupérable ensuite.
 */
export async function createHandoff(target: HandoffTarget): Promise<string | null> {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url')

  const { error } = await supabaseAdmin.from('service_handoffs').insert({
    report_id: target.reportId,
    tenant_id: target.tenantId,
    token_hash: hashToken(token),
    recipient: target.recipient,
    service_name: target.serviceName,
    category: target.category,
  })

  if (error) {
    console.error('[Handoff] Création impossible :', error.message)
    return null
  }

  return token
}

export interface Handoff {
  id: string
  report_id: string
  tenant_id: string
  recipient: string
  service_name: string | null
  category: string
  expires_at: string
  acknowledged_at: string | null
  completed_at: string | null
}

export type HandoffLookup =
  | { ok: true; handoff: Handoff }
  | { ok: false; reason: 'unknown' | 'expired' }

/**
 * Retrouve un lien depuis son jeton.
 *
 * La recherche porte sur l'empreinte : le jeton en clair n'existe nulle part en
 * base, donc il n'y a rien à comparer en temps constant — l'empreinte suffit,
 * et une collision SHA-256 n'est pas un scénario.
 */
export async function findHandoff(token: string, now = new Date()): Promise<HandoffLookup> {
  const { data } = await supabaseAdmin
    .from('service_handoffs')
    .select('id, report_id, tenant_id, recipient, service_name, category, expires_at, acknowledged_at, completed_at')
    .eq('token_hash', hashToken(token))
    .maybeSingle()

  if (!data) return { ok: false, reason: 'unknown' }
  if (Date.parse(data.expires_at) < now.getTime()) return { ok: false, reason: 'expired' }

  return { ok: true, handoff: data as Handoff }
}

/** Le lien complet, tel qu'il part dans l'e-mail. */
export function handoffUrl(token: string): string {
  const base = (process.env.CLIENT_URL || 'https://onsignale.fr').replace(/\/$/, '')
  return `${base}/service/${token}`
}
