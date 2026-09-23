import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyQuizAnswer,
  applyStateTool,
  buildRequest,
  buildSystemPrompt,
  courseVersion,
  emptyProfile,
  normalizeCourse,
  normalizeProfile,
  validateMessages,
  validateQuiz,
} from "../public/core/agent-core.js";
import { renderMarkdown } from "../public/core/markdown.js";

const course = normalizeCourse({
  title: "Cuisine : les sauces de base",
  modules: [
    { title: "La béchamel", content: "Roux blanc + lait." },
    { title: "La mayonnaise", content: "Émulsion jaune d'œuf + huile." },
  ],
});

test("normalizeCourse génère des identifiants stables et exige un titre", () => {
  assert.equal(course.id, "cuisine-les-sauces-de-base");
  assert.deepEqual(course.modules.map((m) => m.id), ["la-bechamel", "la-mayonnaise"]);
  assert.throws(() => normalizeCourse({ modules: [] }), /title/);
});

test("le prompt système est déterministe et contient formation + profil", () => {
  const p = emptyProfile();
  const a = buildSystemPrompt(course, p);
  assert.equal(a, buildSystemPrompt(course, normalizeProfile(JSON.parse(JSON.stringify(p)))));
  assert.match(a, /Roux blanc/);
  assert.match(a, /module id="la-mayonnaise"/);
  assert.match(a, /Nouvel apprenant/);

  const known = { ...p, level: "avancé", difficulties: ["émulsions"], sessions: 2 };
  const b = buildSystemPrompt(course, known);
  assert.match(b, /Session n° 3/);
  assert.match(b, /Difficultés : émulsions/);
});

test("update_learner_profile fusionne et valide", () => {
  let { profile, isError } = applyStateTool("update_learner_profile", { level: "débutant", goals: "cuisiner pour ma famille" }, emptyProfile(), course);
  assert.ok(!isError);
  assert.equal(profile.level, "débutant");
  ({ profile, isError } = applyStateTool("update_learner_profile", { difficulties: ["roux"] }, profile, course));
  assert.equal(profile.goals, "cuisiner pour ma famille");
  assert.deepEqual(profile.difficulties, ["roux"]);
  const bad = applyStateTool("update_learner_profile", { level: "génie" }, profile, course);
  assert.ok(bad.isError);
  assert.equal(bad.profile, profile);
});

test("record_progress refuse un module inconnu", () => {
  const ok = applyStateTool("record_progress", { module_id: "la-bechamel", status: "compris", evidence: "a expliqué le roux" }, emptyProfile(), course);
  assert.equal(ok.profile.progress["la-bechamel"].status, "compris");
  const ko = applyStateTool("record_progress", { module_id: "hollandaise", status: "compris", evidence: "x" }, emptyProfile(), course);
  assert.ok(ko.isError);
  assert.match(ko.result, /la-bechamel/);
});

test("quiz : validation et score", () => {
  const quiz = { question: "Base de la béchamel ?", options: ["Roux", "Œuf"], correct_index: 0, explanation: "Un roux blanc." };
  assert.equal(validateQuiz(quiz), null);
  assert.ok(validateQuiz({ ...quiz, correct_index: 5 }));
  const good = applyQuizAnswer(quiz, 0, emptyProfile());
  assert.deepEqual(good.profile.quiz_stats, { answered: 1, correct: 1 });
  assert.match(good.result, /BONNE/);
  const skipped = applyQuizAnswer(quiz, null, good.profile);
  assert.deepEqual(skipped.profile.quiz_stats, { answered: 1, correct: 1 });
});

test("buildRequest : réflexion adaptative et repli serveur selon le modèle", () => {
  const messages = [{ role: "user", content: "Bonjour" }];
  const opus = buildRequest({ course, profileSnapshot: emptyProfile(), messages });
  assert.equal(opus.model, "claude-opus-5");
  assert.deepEqual(opus.thinking, { type: "adaptive" });
  assert.equal(opus.fallbacks, "default");
  assert.deepEqual(opus.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(opus.tools.length, 3);

  const haiku = buildRequest({ course, profileSnapshot: emptyProfile(), messages, config: { model: "claude-haiku-4-5" } });
  assert.equal(haiku.thinking, undefined);
  assert.equal(haiku.fallbacks, undefined);

  const sonnet = buildRequest({ course, profileSnapshot: emptyProfile(), messages, config: { model: "claude-sonnet-5", effort: "" } });
  assert.deepEqual(sonnet.output_config, { effort: "medium" });
  assert.equal(sonnet.fallbacks, undefined);
});

test("validateMessages", () => {
  assert.equal(validateMessages([{ role: "user", content: "a" }]), null);
  assert.ok(validateMessages([]));
  assert.ok(validateMessages([{ role: "system", content: "x" }]));
  assert.ok(validateMessages([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]));
});

test("courseVersion change quand le contenu change", () => {
  const v1 = courseVersion(course);
  assert.equal(v1, courseVersion(normalizeCourse(course)));
  const edited = normalizeCourse({ ...course, modules: [...course.modules, { title: "Hollandaise" }] });
  assert.notEqual(v1, courseVersion(edited));
});

test("le rendu markdown échappe le HTML", () => {
  const html = renderMarkdown("**gras** <img src=x onerror=alert(1)>\n- a\n- b");
  assert.match(html, /<strong>gras<\/strong>/);
  assert.match(html, /&lt;img/);
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
});
