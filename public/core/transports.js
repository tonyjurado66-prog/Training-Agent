// Deux façons de joindre Claude depuis le navigateur :
//  - serveur  : via le serveur Node du projet (clé API côté serveur) — mode production ;
//  - direct   : le navigateur appelle l'API Anthropic avec la clé saisie par l'utilisateur —
//               réservé aux tests du formateur, JAMAIS sur un site public.

import { buildRequest } from "./agent-core.js";

export class TransportError extends Error {}

/** Transport « serveur » : POST /api/chat, réponse en Server-Sent Events. */
export function createServerTransport({ endpoint = "", courseId }) {
  const base = endpoint.replace(/\/+$/, "");
  return {
    async send({ profileSnapshot, messages, onText, signal }) {
      let res;
      try {
        res = await fetch(`${base}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ courseId, profileSnapshot, messages }),
          signal,
        });
      } catch (e) {
        if (e.name === "AbortError") throw e;
        throw new TransportError("Impossible de joindre le serveur de l'agent. Vérifiez votre connexion.");
      }
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new TransportError(body.error || `Erreur serveur (${res.status}).`);
      }

      let final = null;
      for await (const { event, data } of readSSE(res.body)) {
        if (event === "text") onText?.(data.text);
        else if (event === "message") final = data.message;
        else if (event === "error") throw new TransportError(data.error || "Erreur de l'agent.");
      }
      if (!final) throw new TransportError("Réponse interrompue. Réessayez.");
      return final;
    },
  };
}

async function* readSSE(stream) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message";
      const dataLines = [];
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length) yield { event, data: JSON.parse(dataLines.join("\n")) };
    }
  }
}

// ---------------------------------------------------------------------------

const SDK_VERSION = "0.128.0";
const SDK_SOURCES = [
  // Servi par le serveur Node du projet (copie locale de node_modules).
  new URL("../vendor/anthropic-sdk/index.mjs", import.meta.url).href,
  // Hébergement statique (GitHub Pages, Netlify…) : CDN.
  `https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@${SDK_VERSION}/+esm`,
];

let sdkPromise = null;
function loadSDK() {
  sdkPromise ??= (async () => {
    for (const src of SDK_SOURCES) {
      try {
        const mod = await import(/* @vite-ignore */ src);
        return mod.default ?? mod.Anthropic;
      } catch {
        /* source suivante */
      }
    }
    sdkPromise = null;
    throw new TransportError("Impossible de charger le SDK Anthropic dans le navigateur.");
  })();
  return sdkPromise;
}

/** Transport « direct » : SDK officiel Anthropic exécuté dans le navigateur. */
export function createDirectTransport({ apiKey, course, config }) {
  if (!apiKey) throw new TransportError("Clé API manquante.");
  let client = null;
  return {
    async send({ profileSnapshot, messages, onText, signal }) {
      const Anthropic = await loadSDK();
      client ??= new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
      const params = buildRequest({ course, profileSnapshot, messages, config });
      try {
        const stream = client.beta.messages.stream(params, { signal });
        stream.on("text", (delta) => onText?.(delta));
        return await stream.finalMessage();
      } catch (e) {
        throw new TransportError(describeApiError(Anthropic, e));
      }
    },
  };
}

export function describeApiError(Anthropic, e) {
  if (e instanceof Anthropic.AuthenticationError) return "Clé API invalide.";
  if (e instanceof Anthropic.PermissionDeniedError) return "Cette clé API n'a pas accès à ce modèle.";
  if (e instanceof Anthropic.NotFoundError) return "Modèle introuvable : vérifiez le nom du modèle.";
  if (e instanceof Anthropic.RateLimitError) return "Trop de requêtes : patientez quelques secondes puis réessayez.";
  if (e instanceof Anthropic.BadRequestError) return `Requête refusée par l'API : ${e.message}`;
  if (e instanceof Anthropic.InternalServerError) return "Le service IA est momentanément indisponible. Réessayez.";
  if (e instanceof Anthropic.APIConnectionError) return "Connexion au service IA impossible. Vérifiez votre réseau.";
  if (e instanceof Anthropic.APIError) return `Erreur du service IA (${e.status ?? "?"}).`;
  if (e?.name === "AbortError" || e instanceof Anthropic.APIUserAbortError) return "Réponse interrompue.";
  return e?.message || "Erreur inconnue.";
}
