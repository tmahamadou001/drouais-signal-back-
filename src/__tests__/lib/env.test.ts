import { describe, it, expect } from 'vitest'
import { readEnv, missingInProduction } from '../../lib/env.js'

/**
 * La configuration, vérifiée au démarrage.
 *
 * Une variable absente ne produisait aucune erreur : chaque lecteur avait son
 * repli, écrit loin de la configuration, et le repli devenait la vérité sans
 * que personne le décide. C'est ainsi qu'un lien de réinitialisation a fini
 * par mener au site de présentation.
 */

const MINIMAL = {
  SUPABASE_URL: 'https://projet.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'une-cle-service-role-assez-longue',
}

describe('what the server refuses to start without', () => {
  it('accepts a minimal configuration', () => {
    expect(() => readEnv(MINIMAL as NodeJS.ProcessEnv)).not.toThrow()
  })

  it('refuses a missing Supabase URL', () => {
    expect(() => readEnv({ SUPABASE_SERVICE_ROLE_KEY: MINIMAL.SUPABASE_SERVICE_ROLE_KEY } as NodeJS.ProcessEnv))
      .toThrow(/SUPABASE_URL/)
  })

  it('refuses a Supabase URL that is not one', () => {
    expect(() => readEnv({ ...MINIMAL, SUPABASE_URL: 'projet.supabase.co' } as NodeJS.ProcessEnv))
      .toThrow(/SUPABASE_URL/)
  })

  it('refuses a missing service role key', () => {
    expect(() => readEnv({ SUPABASE_URL: MINIMAL.SUPABASE_URL } as NodeJS.ProcessEnv))
      .toThrow(/SUPABASE_SERVICE_ROLE_KEY/)
  })

  /** Une URL malformée vaut une absence : mieux vaut le dire au démarrage. */
  it('refuses a malformed client URL', () => {
    expect(() => readEnv({ ...MINIMAL, CLIENT_URL: 'pas-une-url' } as NodeJS.ProcessEnv))
      .toThrow(/CLIENT_URL/)
  })
})

describe('what is merely expected in production', () => {
  const PROD = { ...MINIMAL, NODE_ENV: 'production' }

  it('says nothing outside production', () => {
    expect(missingInProduction({ ...MINIMAL, NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toEqual([])
  })

  /** Le défaut réel : sans elle, les liens d'e-mail mènent au site vitrine. */
  it('names a missing CLIENT_URL, and says what it costs', () => {
    const missing = missingInProduction(PROD as NodeJS.ProcessEnv)

    expect(missing.some((line) => line.startsWith('CLIENT_URL'))).toBe(true)
    expect(missing.join(' ')).toContain('site de présentation')
  })

  it('names the mail key and the unsubscribe secret', () => {
    const missing = missingInProduction(PROD as NodeJS.ProcessEnv).join(' ')

    expect(missing).toContain('RESEND_API_KEY')
    expect(missing).toContain('UNSUBSCRIBE_SECRET')
  })

  it('says nothing when everything is there', () => {
    expect(
      missingInProduction({
        ...PROD,
        CLIENT_URL: 'https://dreux.onsignale.fr',
        RESEND_API_KEY: 're_xxx',
        UNSUBSCRIBE_SECRET: 'un-secret-assez-long-pour-signer',
      } as NodeJS.ProcessEnv)
    ).toEqual([])
  })

  /** Prévenir n'est pas bloquer : une erreur de configuration ne doit pas couper le service. */
  it('is a warning, not a refusal to start', () => {
    expect(() => readEnv(PROD as NodeJS.ProcessEnv)).not.toThrow()
  })
})
