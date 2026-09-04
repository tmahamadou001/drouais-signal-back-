import { supabaseAdmin } from '../lib/supabaseAdmin.js'

/**
 * Push notifications, through Expo's push service.
 *
 * Called over plain HTTP rather than through `expo-server-sdk`: the payload is
 * a JSON array and the only thing the SDK adds here is chunking, which matters
 * for broadcasts. A citizen has one or two devices, so a dependency would buy
 * nothing.
 *
 * Every failure is swallowed. A push is a courtesy on top of the e-mail that
 * already went out — losing one must never fail the status change or the
 * comment that triggered it.
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const TIMEOUT_MS = 8000

interface PushMessage {
  to: string
  title: string
  body: string
  /** Read by the app to route the tap. */
  data: { reportId: string; kind: 'status' | 'comment' }
  sound: 'default'
  badge?: number
}

async function send(messages: PushMessage[]): Promise<void> {
  if (messages.length === 0) return

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(messages),
      signal: controller.signal,
    })

    if (!response.ok) {
      console.error('[Push] Expo a répondu', response.status)
      return
    }

    const result = (await response.json()) as {
      data?: { status: string; message?: string; details?: { error?: string } }[]
    }

    // Expo answers 200 with per-message errors inside. `DeviceNotRegistered`
    // means the app was uninstalled: keeping the token would mean retrying it
    // forever, and Expo eventually rate-limits senders who do.
    const dead = (result.data ?? [])
      .map((entry, index) => ({ entry, token: messages[index]?.to }))
      .filter(({ entry }) => entry.details?.error === 'DeviceNotRegistered')
      .map(({ token }) => token)
      .filter((token): token is string => Boolean(token))

    if (dead.length > 0) {
      await supabaseAdmin.from('device_tokens').delete().in('token', dead)
      console.log(`[Push] ${dead.length} token(s) obsolète(s) supprimé(s)`)
    }
  } catch (err) {
    console.error('[Push] Exception:', err)
  } finally {
    clearTimeout(timeout)
  }
}

/** Every device the citizen has registered for this commune. */
async function tokensFor(userId: string, tenantId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('device_tokens')
    .select('token')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)

  if (error) {
    console.error('[Push] Lecture des tokens impossible:', error.message)
    return []
  }

  return (data ?? []).map((row) => row.token)
}

const STATUS_TITLES: Record<string, string> = {
  pris_en_charge: 'Votre signalement est pris en charge',
  resolu: 'Votre signalement a été résolu',
}

/** The commune moved a report forward. */
export async function pushStatusChange(params: {
  userId: string
  tenantId: string
  reportId: string
  reportTitle: string
  newStatus: string
}): Promise<void> {
  const title = STATUS_TITLES[params.newStatus]
  // `en_attente` is where a report starts; there is no transition *into* it
  // worth waking a phone for.
  if (!title) return

  const tokens = await tokensFor(params.userId, params.tenantId)

  await send(
    tokens.map((to) => ({
      to,
      title,
      body: params.reportTitle,
      data: { reportId: params.reportId, kind: 'status' as const },
      sound: 'default' as const,
    }))
  )
}

/** An agent wrote on the citizen's report. */
export async function pushAgentComment(params: {
  userId: string
  tenantId: string
  reportId: string
  reportTitle: string
  excerpt: string
}): Promise<void> {
  const tokens = await tokensFor(params.userId, params.tenantId)

  await send(
    tokens.map((to) => ({
      to,
      title: `Message des services · ${params.reportTitle.substring(0, 40)}`,
      // Trimmed here rather than by the OS: a mid-word cut on the notification
      // shade reads as a bug.
      body:
        params.excerpt.length > 120
          ? `${params.excerpt.substring(0, 117)}...`
          : params.excerpt,
      data: { reportId: params.reportId, kind: 'comment' as const },
      sound: 'default' as const,
    }))
  )
}
