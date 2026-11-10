import { OpenFoodFactsClient } from '../services/openFoodFacts';

export const APP_NAME = 'NutriApp';
/** Versión que se reporta en el User-Agent. En la app real, léela de app.json (p. ej. con expo-constants). */
export const APP_VERSION = '0.1.0';

/**
 * Crea el cliente de Open Food Facts con el contacto de TU proyecto (email o URL).
 * Define EXPO_PUBLIC_OFF_CONTACT en `.env`; Expo incorpora al bundle las variables con ese prefijo.
 * Se accede con notación de punto porque Expo solo sustituye apariciones literales de `process.env.EXPO_PUBLIC_*`.
 * Si falta, el cliente lanza OffError('CONFIG'): preferimos fallar a mandar un User-Agent anónimo.
 */
export function createOffClient(contact: string | undefined = process.env.EXPO_PUBLIC_OFF_CONTACT): OpenFoodFactsClient {
  return new OpenFoodFactsClient({ appName: APP_NAME, appVersion: APP_VERSION, contact: contact ?? '' });
}
