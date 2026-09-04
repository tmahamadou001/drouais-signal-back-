import { Router, Request, Response, NextFunction, type Router as ExpressRouter } from 'express'
import { supabaseAdmin } from '../lib/supabaseAdmin.js'

const router: ExpressRouter = Router()

/**
 * ─── GET /api/tenants/public — Directory of live communes ───
 *
 * Exists for the mobile app, which has no sub-domain to read a tenant from and
 * therefore has to ask the user which commune they are in before it can send a
 * single scoped request. The web front never needs this: `dreux.onsignale.fr`
 * already names its tenant.
 *
 * Deliberately unauthenticated and deliberately thin — slug, display name and
 * enough to tell two communes apart in a list. It is a public directory of who
 * uses OnSignale, not a window into any commune's data.
 *
 * `resolveTenant` runs ahead of this on `/api/`, but calls `next()` untouched
 * when no slug is present, which is exactly the case here.
 */
router.get('/public', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('tenants')
      .select('slug, name, tenant_configs(city_name, department_code, city_population, logo_url, map_lat, map_lng)')
      // Suspended communes are excluded: listing one would let a citizen pick
      // it and then hit a 403 wall on the very next request.
      .in('status', ['active', 'trial', 'demo'])
      .order('name', { ascending: true })

    if (error) throw error

    // `tenant_configs` is a one-to-one relation, but PostgREST types an
    // embedded row as an array. A commune without a config row still belongs in
    // the list — it just has nothing to show beyond its name.
    const tenants = (data ?? []).map((tenant) => {
      const config = Array.isArray(tenant.tenant_configs)
        ? tenant.tenant_configs[0]
        : tenant.tenant_configs

      return {
        slug: tenant.slug,
        name: tenant.name,
        city_name: config?.city_name ?? tenant.name,
        department_code: config?.department_code ?? null,
        city_population: config?.city_population ?? null,
        logo_url: config?.logo_url ?? null,
        // The mobile app offers the nearest commune at first launch. Comparing
        // a GPS fix to a town-hall coordinate is far more reliable than
        // matching a reverse-geocoded city name against `city_name`, which
        // differs on accents, hyphens and "Ville de" prefixes.
        map_lat: config?.map_lat ?? null,
        map_lng: config?.map_lng ?? null,
      }
    })

    res.json(tenants)
  } catch (err) {
    next(err)
  }
})

export default router
