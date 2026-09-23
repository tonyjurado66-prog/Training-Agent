// Le SDK Anthropic importe « standardwebhooks » (module CommonJS) pour la
// vérification des webhooks, inutile dans le navigateur. Cette cale le remplace
// quand le SDK est chargé depuis /vendor/anthropic-sdk (voir l'import map du studio).
export class Webhook {
  constructor() {
    throw new Error("La vérification des webhooks n'est pas disponible dans le navigateur.");
  }
}
