/**
 * Le tout premier module évalué par le serveur.
 *
 * Un fichier pour une ligne, parce que l'ordre compte : le SDK Sentry
 * instrumente `http` et Express au moment de son `init`, et ne rattrape pas un
 * module déjà chargé. En ESM les importations s'évaluent dans l'ordre où elles
 * sont écrites, donc `import './instrument.js'` en première ligne d'`index.ts`
 * est la seule façon d'être avant `express`.
 */
import { initSentry } from './lib/sentry.js'

initSentry()
