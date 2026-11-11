import type { UserRole } from '../types/tenant.js'

/**
 * Les rôles qu'une commune peut attribuer dans son équipe.
 *
 * Trois, et **pas** `super_admin` : celui-là n'est pas un rôle d'équipe, c'est
 * un rôle de plateforme. Il vit dans `app_metadata`, que seule la clé
 * `service_role` peut écrire, et il donne accès à *toutes* les communes —
 * ouvrir ou refermer n'importe laquelle au public, lire le journal d'audit
 * global, créer des collectivités.
 *
 * Ni `POST /users/invite` ni `PATCH /users/:id` ne validaient le rôle reçu :
 * ils le recopiaient tel quel dans `tenant_users`. Une contrainte `CHECK` en
 * base refusait la valeur, ce qui a tenu lieu de garde — mais une contrainte
 * de base est le dernier rempart, pas le premier, et `getUserTenantRole`
 * rendait sans sourciller ce qu'elle y lisait : une ligne `super_admin` dans
 * `tenant_users` aurait été honorée comme telle. Entre un administrateur de
 * commune et la plateforme entière, il ne restait donc qu'une clause `CHECK`
 * écrite dans la migration 006.
 *
 * La règle est ici, en un seul endroit, avec ses tests.
 */
export const ASSIGNABLE_ROLES: readonly UserRole[] = ['admin', 'agent', 'observer']

export function isAssignableRole(value: unknown): value is UserRole {
  return typeof value === 'string' && ASSIGNABLE_ROLES.includes(value as UserRole)
}

/**
 * Le rôle lu dans `tenant_users`, ou `null` s'il n'a rien à y faire.
 *
 * Défense en profondeur : même si une ligne `super_admin` arrivait en base —
 * par une migration, une main sur le tableau de bord, une contrainte oubliée —
 * elle ne confère rien. Le rôle de plateforme ne se lit que dans
 * `app_metadata`, et c'est une propriété qu'on veut vraie quoi qu'il arrive en
 * aval.
 */
export function teamRoleFrom(value: unknown): UserRole | null {
  return isAssignableRole(value) ? value : null
}
