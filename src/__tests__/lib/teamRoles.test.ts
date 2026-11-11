import { describe, it, expect } from 'vitest'
import { ASSIGNABLE_ROLES, isAssignableRole, teamRoleFrom } from '../../lib/teamRoles.js'

/**
 * Ce qu'une commune peut attribuer, et ce qu'elle ne peut pas.
 *
 * `super_admin` donne accès à **toutes** les communes : ouvrir ou refermer
 * n'importe laquelle au public, lire le journal d'audit global, créer des
 * collectivités. Il n'appartient pas à une équipe municipale, et le chemin
 * d'invitation ne validait rien — seule une contrainte `CHECK` en base
 * refusait la valeur.
 */

describe('the roles a commune may assign', () => {
  it('are exactly three', () => {
    expect([...ASSIGNABLE_ROLES]).toEqual(['admin', 'agent', 'observer'])
  })

  it('accepts them', () => {
    for (const role of ASSIGNABLE_ROLES) {
      expect(isAssignableRole(role)).toBe(true)
    }
  })

  /** Le cas qui compte : il ne doit jamais traverser l'API. */
  it('refuses the platform role', () => {
    expect(isAssignableRole('super_admin')).toBe(false)
  })

  it('refuses a citizen, which is not a team role either', () => {
    expect(isAssignableRole('citizen')).toBe(false)
  })

  it('refuses anything that is not a string', () => {
    expect(isAssignableRole(undefined)).toBe(false)
    expect(isAssignableRole(null)).toBe(false)
    expect(isAssignableRole(['admin'])).toBe(false)
    expect(isAssignableRole({ role: 'admin' })).toBe(false)
  })
})

/**
 * Défense en profondeur : même si une ligne `super_admin` arrivait en base,
 * elle ne confère rien. Le rôle de plateforme ne se lit que dans
 * `app_metadata`, que seule la clé `service_role` peut écrire.
 */
describe('the role read back from tenant_users', () => {
  it('passes a team role through', () => {
    expect(teamRoleFrom('agent')).toBe('agent')
  })

  it('refuses to honour a platform role found there', () => {
    expect(teamRoleFrom('super_admin')).toBeNull()
  })

  it('refuses a value it does not know', () => {
    expect(teamRoleFrom('maire')).toBeNull()
    expect(teamRoleFrom(null)).toBeNull()
  })
})
