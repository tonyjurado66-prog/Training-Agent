// Boucle agentique côté navigateur : envoie la conversation, exécute les outils
// demandés par Claude (profil, progression, quiz) et relance jusqu'à la réponse finale.

import { MAX_TOOL_ROUNDS, applyStateTool, applyQuizAnswer, validateQuiz } from "./agent-core.js";

export class RefusalError extends Error {}

/**
 * @param {object} o
 * @param {{send: Function}} o.transport
 * @param {object} o.course            formation normalisée
 * @param {object} o.profileSnapshot   profil figé en début de session
 * @param {Array}  o.messages          historique (MessageParam[]) se terminant par un message utilisateur
 * @param {() => object} o.getProfile
 * @param {(p: object) => void} o.setProfile
 * @param {(delta: string) => void} o.onText            texte en streaming
 * @param {() => void} o.onAssistantMessageStart        nouveau message à l'écran
 * @param {(quiz: object) => Promise<number|null>} o.onQuiz  affiche un quiz, résout avec l'index choisi (ou null)
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<Array>} nouvel historique
 */
export async function runAgentTurn(o) {
  const messages = [...o.messages];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    o.onAssistantMessageStart?.();
    const message = await o.transport.send({
      profileSnapshot: o.profileSnapshot,
      messages,
      onText: o.onText,
      signal: o.signal,
    });

    if (message.stop_reason === "refusal") {
      // Toute la chaîne (modèle + repli) a décliné : on n'ajoute pas ce tour à l'historique.
      throw new RefusalError("Je ne peux pas répondre à cette demande. Reformulez-la ou revenons au contenu de la formation.");
    }

    messages.push({ role: "assistant", content: message.content });
    if (message.stop_reason !== "tool_use") return messages;

    const results = [];
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      results.push(await runTool(block, o));
    }
    messages.push({ role: "user", content: results });
  }
  // Garde-fou : trop d'appels d'outils d'affilée. On clôt proprement l'échange.
  messages.push({ role: "user", content: "(Système : limite d'outils atteinte, réponds maintenant directement à l'apprenant.)" });
  o.onAssistantMessageStart?.();
  const last = await o.transport.send({ profileSnapshot: o.profileSnapshot, messages, onText: o.onText, signal: o.signal });
  if (last.stop_reason === "refusal") throw new RefusalError("Je ne peux pas répondre à cette demande.");
  messages.push({ role: "assistant", content: last.content });
  return messages;
}

async function runTool(block, o) {
  const toolResult = (content, isError = false) => ({
    type: "tool_result",
    tool_use_id: block.id,
    content,
    ...(isError ? { is_error: true } : {}),
  });

  if (block.name === "present_quiz") {
    const problem = validateQuiz(block.input);
    if (problem) return toolResult(`Quiz invalide : ${problem}`, true);
    const choice = await o.onQuiz(block.input);
    const { profile, result } = applyQuizAnswer(block.input, choice, o.getProfile());
    o.setProfile(profile);
    return toolResult(result);
  }

  const { profile, result, isError } = applyStateTool(block.name, block.input, o.getProfile(), o.course);
  if (!isError) o.setProfile(profile);
  return toolResult(result, !!isError);
}
