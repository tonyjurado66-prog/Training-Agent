// <training-agent> — widget de tutorat IA intégrable dans n'importe quel site.
//
// Intégration minimale (mode serveur, recommandé) :
//   <script type="module" src="https://VOTRE-SERVEUR/widget/training-agent.js"></script>
//   <training-agent course="excel-tcd"></training-agent>
//
// Attributs :
//   course        identifiant de la formation (mode serveur)
//   endpoint      URL du serveur de l'agent (par défaut : celle d'où est chargé ce script)
//   mode          "floating" (bulle en bas de page, par défaut) | "inline" (dans la page)
//   learner-id    identifiant de l'apprenant sur votre site (sépare les profils)
//   label         titre affiché dans l'en-tête (par défaut : titre de la formation)
//   accent        couleur principale (ex. "#0f766e")
//   position      "right" (défaut) | "left" pour le mode floating
//
// Événements émis (pour synchroniser avec votre LMS) :
//   training-agent:profile   detail = { courseId, learnerId, profile }
//   training-agent:turn      detail = { courseId, learnerId, messages }
//
// Méthodes : configure({ course, transport }), getProfile(), setProfile(p),
//            newSession(), clearData(), open(), close()

import { normalizeCourse, normalizeProfile, emptyProfile, courseVersion, PROGRESS_STATUSES } from "../core/agent-core.js";
import { runAgentTurn, RefusalError } from "../core/agent-runner.js";
import { createServerTransport } from "../core/transports.js";
import { esc, renderInline, renderMarkdown } from "../core/markdown.js";

const DEFAULT_ENDPOINT = new URL("..", import.meta.url).href;
const STORAGE_PREFIX = "training-agent:v1";

const STATUS_LABEL = { non_commencé: "Non commencé", en_cours: "En cours", compris: "Compris", maîtrisé: "Maîtrisé" };
const STATUS_VALUE = { non_commencé: 0, en_cours: 0.35, compris: 0.75, maîtrisé: 1 };

class TrainingAgentElement extends HTMLElement {
  static observedAttributes = ["accent", "label"];

  #root;
  #els = {};
  #course = null; // formation (au moins titre + modules)
  #version = "";  // empreinte de la formation (change => nouvelle session)
  #transport = null;
  #state = { profile: emptyProfile(), session: null };
  #busy = false;
  #abort = null;
  #started = false;
  #pending = null; // configure() appelé avant l'insertion dans la page
  #courseUpdated = false;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    if (this.#started) return;
    this.#started = true;
    this.#render();
    this.#applyAccent();
    if (this.#pending) {
      const cfg = this.#pending;
      this.#pending = null;
      return this.configure(cfg);
    }
    // Mode serveur : on récupère les infos publiques de la formation.
    // (Le studio appelle configure() à la place.)
    const courseId = this.getAttribute("course");
    if (courseId && !this.#course) this.#loadFromServer(courseId);
  }

  disconnectedCallback() {
    this.#abort?.abort();
  }

  attributeChangedCallback(name) {
    if (!this.#started) return;
    if (name === "accent") this.#applyAccent();
    if (name === "label") this.#els.title.textContent = this.#title();
  }

  // ------------------------------------------------------------------ API --

  /** Configure le widget avec une formation et un transport (studio, intégrations avancées). */
  configure({ course, transport }) {
    const normalized = normalizeCourse(course);
    if (!this.#started) {
      this.#pending = { course: normalized, transport };
      return;
    }
    this.#abort?.abort();
    this.#course = normalized;
    this.#version = courseVersion(normalized);
    this.#transport = transport;
    this.#loadState();
    this.#afterCourseLoaded();
  }

  getProfile() {
    return structuredClone(this.#state.profile);
  }

  /** Injecte un profil venant de votre plateforme (ex. profil sauvegardé côté LMS). */
  setProfile(profile) {
    this.#state.profile = normalizeProfile(profile);
    this.#save();
    this.#renderJourney();
  }

  /** Démarre une nouvelle session : la conversation repart de zéro, le profil est conservé. */
  newSession() {
    if (this.#busy) this.#abort?.abort();
    this.#state.session = null;
    this.#save();
    this.#renderConversation();
  }

  /** Efface profil et conversation de cet apprenant pour cette formation. */
  clearData() {
    if (this.#busy) this.#abort?.abort();
    this.#state = { profile: emptyProfile(), session: null };
    try { localStorage.removeItem(this.#storageKey()); } catch { /* stockage indisponible */ }
    this.#emitProfile();
    this.#renderConversation();
    this.#renderJourney();
  }

  open() {
    this.#els.panel.hidden = false;
    this.#els.launcher?.setAttribute("aria-expanded", "true");
    this.#els.input.focus();
  }

  close() {
    if (this.#floating()) {
      this.#els.panel.hidden = true;
      this.#els.launcher?.setAttribute("aria-expanded", "false");
      this.#els.launcher?.focus();
    }
  }

  // ------------------------------------------------------------ Chargement --

  async #loadFromServer(courseId) {
    const endpoint = this.getAttribute("endpoint") || DEFAULT_ENDPOINT;
    try {
      const res = await fetch(`${endpoint.replace(/\/+$/, "")}/api/courses/${encodeURIComponent(courseId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
      this.#course = normalizeCourse(data);
      this.#version = String(data.version || "");
      this.#transport = createServerTransport({ endpoint, courseId: this.#course.id });
      this.#loadState();
      this.#afterCourseLoaded();
    } catch (e) {
      this.#showNotice(`Impossible de charger la formation « ${courseId} » : ${e.message}`, true);
    }
  }

  #afterCourseLoaded() {
    this.#els.title.textContent = this.#title();
    this.#els.input.disabled = false;
    this.#els.send.disabled = false;
    this.#renderConversation();
    this.#renderJourney();
  }

  #title() {
    return this.getAttribute("label") || this.#course?.title || "Tuteur IA";
  }

  #storageKey() {
    const learner = this.getAttribute("learner-id") || "anonyme";
    return `${STORAGE_PREFIX}:${learner}:${this.#course?.id}`;
  }

  #loadState() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(this.#storageKey()) || "null"); } catch { /* ignoré */ }
    const session = saved?.session;
    const valid = session && Array.isArray(session.messages) && session.profileSnapshot;
    // La formation a changé depuis le début de la session : on repart sur une session neuve
    // (le profil de l'apprenant, lui, est conservé).
    const outdated = valid && session.courseVersion !== this.#version;
    this.#state = {
      profile: normalizeProfile(saved?.profile),
      session: valid && !outdated
        ? { profileSnapshot: normalizeProfile(session.profileSnapshot), messages: session.messages, courseVersion: this.#version }
        : null,
    };
    this.#courseUpdated = Boolean(outdated && session.messages.length);
  }

  #save() {
    try {
      localStorage.setItem(this.#storageKey(), JSON.stringify(this.#state));
    } catch {
      /* navigation privée / quota : le widget fonctionne sans persistance */
    }
  }

  #emitProfile() {
    this.dispatchEvent(new CustomEvent("training-agent:profile", {
      bubbles: true, composed: true,
      detail: { courseId: this.#course?.id, learnerId: this.getAttribute("learner-id"), profile: this.getProfile() },
    }));
  }

  // ------------------------------------------------------------- Dialogue --

  async #submit(text) {
    text = text.trim();
    if (!text || this.#busy || !this.#transport) return;

    // Début de session : on fige le profil (le prompt système doit rester identique).
    if (!this.#state.session) {
      this.#state.session = { profileSnapshot: structuredClone(this.#state.profile), messages: [], courseVersion: this.#version };
      this.#state.profile.sessions += 1;
      this.#els.suggestions.hidden = true;
    }
    const session = this.#state.session;
    const before = session.messages;
    const marker = this.#els.messages.lastChild;

    this.#setBusy(true);
    this.#els.input.value = "";
    this.#autoGrow();
    this.#addUserBubble(text);

    let bubble = null;
    let buffer = "";
    this.#abort = new AbortController();
    try {
      const messages = await runAgentTurn({
        transport: this.#transport,
        course: this.#course,
        profileSnapshot: session.profileSnapshot,
        messages: [...before, { role: "user", content: text }],
        getProfile: () => this.#state.profile,
        setProfile: (p) => {
          this.#state.profile = p;
          this.#save();
          this.#renderJourney();
          this.#emitProfile();
        },
        onAssistantMessageStart: () => {
          bubble = null;
          buffer = "";
          this.#typing(true);
        },
        onText: (delta) => {
          if (!bubble) {
            this.#typing(false);
            bubble = this.#addAssistantBubble("");
          }
          buffer += delta;
          bubble.innerHTML = renderMarkdown(buffer);
          this.#scrollToEnd();
        },
        onQuiz: (quiz) => {
          this.#typing(false);
          return this.#askQuiz(quiz);
        },
        signal: this.#abort.signal,
      });
      if (this.#state.session !== session) return; // session réinitialisée entre-temps
      session.messages = messages;
      this.#save();
      this.dispatchEvent(new CustomEvent("training-agent:turn", {
        bubbles: true, composed: true,
        detail: { courseId: this.#course.id, learnerId: this.getAttribute("learner-id"), messages: structuredClone(messages) },
      }));
    } catch (e) {
      if (this.#state.session !== session || e?.name === "AbortError") return;
      // Échec : on retire ce tour de l'écran et on rend le texte pour pouvoir réessayer.
      while (this.#els.messages.lastChild && this.#els.messages.lastChild !== marker) this.#els.messages.lastChild.remove();
      if (!before.length) {
        this.#state.session = null;
        this.#state.profile.sessions = Math.max(0, this.#state.profile.sessions - 1);
        this.#els.suggestions.hidden = false;
      }
      this.#save();
      if (!(e instanceof RefusalError)) this.#els.input.value = text;
      this.#showNotice(e.message || "Une erreur est survenue.", true);
    } finally {
      this.#typing(false);
      this.#setBusy(false);
      this.#abort = null;
    }
  }

  #askQuiz(quiz) {
    const signal = this.#abort?.signal;
    return new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("Session interrompue", "AbortError")), { once: true });
      const card = this.#quizCard(quiz, null, (choice) => resolve(choice));
      this.#els.messages.append(card);
      this.#scrollToEnd();
      card.querySelector("button")?.focus();
    });
  }

  // ------------------------------------------------------------- Rendu UI --

  #render() {
    const floating = this.#floating();
    const left = this.getAttribute("position") === "left";
    this.#root.innerHTML = `
      <style>${STYLES}</style>
      ${floating ? `<button class="launcher ${left ? "left" : ""}" part="launcher" aria-expanded="false" aria-label="Ouvrir le tuteur IA">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.5.4-1.3.1-1.3-.6V16A2.5 2.5 0 0 1 4 13.5v-8Z"/></svg>
      </button>` : ""}
      <section class="panel ${floating ? "floating" : "inline"} ${left ? "left" : ""}" part="panel" ${floating ? "hidden" : ""} aria-label="Tuteur IA">
        <header>
          <div class="avatar" aria-hidden="true">IA</div>
          <div class="heading">
            <h2 class="title">Chargement…</h2>
            <p class="subtitle">Tuteur personnalisé</p>
          </div>
          <button class="icon journey-btn" aria-pressed="false" title="Mon parcours" aria-label="Mon parcours">
            <svg viewBox="0 0 24 24"><path d="M4 19h16M7 16V9m5 7V5m5 11v-4"/></svg>
          </button>
          <button class="icon new-btn" title="Nouvelle session" aria-label="Nouvelle session">
            <svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4"/></svg>
          </button>
          ${floating ? `<button class="icon close-btn" title="Fermer" aria-label="Fermer"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>` : ""}
        </header>
        <div class="body">
          <div class="messages" role="log" aria-live="polite"></div>
          <aside class="journey" hidden></aside>
        </div>
        <div class="suggestions"></div>
        <form class="composer">
          <textarea rows="1" placeholder="Écrivez votre message…" aria-label="Votre message" disabled></textarea>
          <button type="submit" class="send" aria-label="Envoyer" disabled>
            <svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg>
          </button>
        </form>
        <p class="footnote">Réponses générées par IA : elles peuvent contenir des erreurs.</p>
      </section>`;

    const $ = (s) => this.#root.querySelector(s);
    this.#els = {
      launcher: $(".launcher"),
      panel: $(".panel"),
      title: $(".title"),
      messages: $(".messages"),
      journey: $(".journey"),
      journeyBtn: $(".journey-btn"),
      suggestions: $(".suggestions"),
      form: $(".composer"),
      input: $("textarea"),
      send: $(".send"),
    };

    this.#els.launcher?.addEventListener("click", () => (this.#els.panel.hidden ? this.open() : this.close()));
    $(".close-btn")?.addEventListener("click", () => this.close());
    $(".new-btn").addEventListener("click", () => this.newSession());
    this.#els.journeyBtn.addEventListener("click", () => {
      const show = this.#els.journey.hidden;
      this.#els.journey.hidden = !show;
      this.#els.journeyBtn.setAttribute("aria-pressed", String(show));
      if (show) this.#renderJourney();
    });
    this.#els.form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.#submit(this.#els.input.value);
    });
    this.#els.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.#submit(this.#els.input.value);
      }
    });
    this.#els.input.addEventListener("input", () => this.#autoGrow());
    this.#els.panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
  }

  #floating() {
    return (this.getAttribute("mode") || "floating") !== "inline";
  }

  #applyAccent() {
    const accent = this.getAttribute("accent");
    if (accent) this.style.setProperty("--ta-accent", accent);
    else this.style.removeProperty("--ta-accent");
  }

  /** Reconstruit l'affichage à partir de l'historique (source de vérité). */
  #renderConversation() {
    const box = this.#els.messages;
    box.replaceChildren();
    if (!this.#course) return;
    const c = this.#course;
    const welcome = c.welcome ||
      `Bonjour ! Je suis votre tuteur pour la formation **${c.title}**. Je m'adapte à votre niveau et à votre rythme. Par où voulez-vous commencer ?`;
    this.#addAssistantBubble(renderMarkdown(welcome), true);

    const messages = this.#state.session?.messages || [];
    const results = new Map();
    for (const m of messages) {
      if (m.role === "user" && Array.isArray(m.content)) {
        for (const b of m.content) if (b.type === "tool_result") results.set(b.tool_use_id, b.content);
      }
    }
    for (const m of messages) {
      if (m.role === "user") {
        if (typeof m.content === "string") this.#addUserBubble(m.content);
        continue;
      }
      for (const b of m.content || []) {
        if (b.type === "text" && b.text.trim()) this.#addAssistantBubble(renderMarkdown(b.text), true);
        if (b.type === "tool_use" && b.name === "present_quiz") {
          const res = String(results.get(b.id) ?? "");
          if (res.startsWith("Quiz invalide")) continue;
          const match = res.match(/a choisi ([A-F])\)/);
          const choice = match ? match[1].charCodeAt(0) - 65 : res ? null : undefined;
          if (choice !== undefined) box.append(this.#quizCard(b.input, choice));
        }
      }
    }
    if (this.#courseUpdated) {
      this.#courseUpdated = false;
      this.#showNotice("La formation a été mise à jour : une nouvelle session commence (votre parcours est conservé).");
    }
    this.#els.suggestions.hidden = messages.length > 0;
    this.#renderSuggestions();
    this.#scrollToEnd();
  }

  #renderSuggestions() {
    const isReturning = this.#state.profile.sessions > 0;
    const items = isReturning
      ? ["On reprend où j'en étais", "Fais-moi réviser mes points faibles", "Teste-moi avec un quiz"]
      : ["Je débute complètement", "J'ai déjà des bases", "Présente-moi le programme"];
    this.#els.suggestions.replaceChildren(
      ...items.map((t) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = t;
        b.addEventListener("click", () => this.#submit(t));
        return b;
      }),
    );
  }

  #renderJourney() {
    const box = this.#els.journey;
    if (!this.#course || box.hidden) return;
    const p = this.#state.profile;
    const c = this.#course;
    const done = c.modules.filter((m) => ["compris", "maîtrisé"].includes(p.progress[m.id]?.status)).length;
    const pct = c.modules.length
      ? Math.round((c.modules.reduce((s, m) => s + STATUS_VALUE[p.progress[m.id]?.status || "non_commencé"], 0) / c.modules.length) * 100)
      : 0;
    const chips = (list) => list.length ? `<ul class="chips">${list.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="muted">—</p>`;

    box.innerHTML = `
      <h3>Mon parcours</h3>
      ${c.modules.length ? `
        <div class="overall"><div class="bar"><span style="width:${pct}%"></span></div><strong>${pct}%</strong></div>
        <p class="muted">${done} module(s) validé(s) sur ${c.modules.length}</p>
        <ol class="modules">${c.modules.map((m) => {
          const st = p.progress[m.id]?.status || "non_commencé";
          return `<li class="st-${st}" title="${esc(p.progress[m.id]?.evidence || "")}"><span>${esc(m.title)}</span><em>${STATUS_LABEL[st]}</em></li>`;
        }).join("")}</ol>` : ""}
      <dl>
        <dt>Niveau estimé</dt><dd>${esc(p.level || "à évaluer")}</dd>
        ${p.goals ? `<dt>Objectif</dt><dd>${esc(p.goals)}</dd>` : ""}
        ${p.preferred_style ? `<dt>Façon d'apprendre</dt><dd>${esc(p.preferred_style)}</dd>` : ""}
        ${p.pace ? `<dt>Rythme</dt><dd>${esc(p.pace)}</dd>` : ""}
        <dt>Quiz</dt><dd>${p.quiz_stats.answered ? `${p.quiz_stats.correct} / ${p.quiz_stats.answered} bonnes réponses` : "aucun pour l'instant"}</dd>
        <dt>Points forts</dt><dd>${chips(p.strengths)}</dd>
        <dt>À retravailler</dt><dd>${chips(p.difficulties)}</dd>
      </dl>
      <p class="muted small">Ce profil est enregistré dans votre navigateur et permet au tuteur de s'adapter à vous d'une session à l'autre.</p>
      <button type="button" class="link danger">Effacer mes données</button>`;
    box.querySelector(".danger").addEventListener("click", () => {
      if (confirm("Effacer votre profil et votre conversation pour cette formation ?")) this.clearData();
    });
  }

  #quizCard(quiz, answered, onAnswer) {
    const card = document.createElement("div");
    card.className = "quiz";
    card.innerHTML = `
      <p class="quiz-label">Question</p>
      <p class="quiz-q">${renderInline(esc(quiz.question))}</p>
      <div class="quiz-options" role="group" aria-label="Réponses possibles"></div>
      <div class="quiz-feedback" hidden></div>
      <button type="button" class="link skip">Passer la question</button>`;
    const opts = card.querySelector(".quiz-options");
    const feedback = card.querySelector(".quiz-feedback");
    const skip = card.querySelector(".skip");
    const buttons = quiz.options.map((o, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `<span class="letter">${String.fromCharCode(65 + i)}</span><span>${renderInline(esc(o))}</span>`;
      b.addEventListener("click", () => finish(i));
      opts.append(b);
      return b;
    });
    const finish = (choice) => {
      buttons.forEach((b, i) => {
        b.disabled = true;
        if (i === quiz.correct_index) b.classList.add("correct");
        if (i === choice && choice !== quiz.correct_index) b.classList.add("wrong");
      });
      skip.remove();
      feedback.hidden = false;
      const verdict = choice === null ? "Question passée." : choice === quiz.correct_index ? "✅ Bonne réponse !" : "❌ Pas tout à fait.";
      feedback.innerHTML = `<strong>${verdict}</strong> ${renderInline(esc(quiz.explanation || ""))}`;
      this.#scrollToEnd();
      onAnswer?.(choice);
    };
    skip.addEventListener("click", () => finish(null));
    if (answered !== undefined && !onAnswer) finish(answered);
    return card;
  }

  #addUserBubble(text) {
    const div = document.createElement("div");
    div.className = "msg user";
    div.textContent = text;
    this.#els.messages.append(div);
    this.#scrollToEnd();
    return div;
  }

  #addAssistantBubble(html, isHtml = false) {
    const div = document.createElement("div");
    div.className = "msg assistant";
    if (isHtml) div.innerHTML = html;
    this.#els.messages.append(div);
    this.#scrollToEnd();
    return div;
  }

  #typing(on) {
    this.#els.messages.querySelector(".typing")?.remove();
    if (on) {
      const div = document.createElement("div");
      div.className = "msg assistant typing";
      div.setAttribute("aria-label", "Le tuteur réfléchit");
      div.innerHTML = "<span></span><span></span><span></span>";
      this.#els.messages.append(div);
      this.#scrollToEnd();
    }
  }

  #showNotice(text, isError = false) {
    const div = document.createElement("div");
    div.className = `notice ${isError ? "error" : ""}`;
    div.setAttribute("role", isError ? "alert" : "status");
    div.textContent = text;
    this.#els.messages.append(div);
    this.#scrollToEnd();
  }

  #setBusy(on) {
    this.#busy = on;
    this.#els.input.disabled = on;
    this.#els.send.disabled = on;
    this.#els.suggestions.querySelectorAll("button").forEach((b) => (b.disabled = on));
    if (!on) this.#els.input.focus({ preventScroll: true });
  }

  #autoGrow() {
    const t = this.#els.input;
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 140) + "px";
  }

  #scrollToEnd() {
    const box = this.#els.messages;
    box.scrollTop = box.scrollHeight;
  }
}

// ---------------------------------------------------------------------------

const STYLES = `
:host {
  --ta-accent: #4f46e5;
  --ta-bg: #ffffff;
  --ta-surface: #f5f6f8;
  --ta-text: #1c1f26;
  --ta-muted: #636a78;
  --ta-border: #e2e5ea;
  --ta-ok: #15803d;
  --ta-ko: #b91c1c;
  --ta-radius: 14px;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 15px;
  line-height: 1.5;
  color: var(--ta-text);
}
@media (prefers-color-scheme: dark) {
  :host(:not([theme="light"])) {
    --ta-bg: #17191e; --ta-surface: #22252c; --ta-text: #eceef2; --ta-muted: #a0a6b3; --ta-border: #343843;
    --ta-ok: #4ade80; --ta-ko: #f87171;
  }
}
:host([mode="inline"]) { display: block; height: 100%; min-height: 480px; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
button { font: inherit; color: inherit; cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .55; }
svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

.launcher {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  width: 58px; height: 58px; border-radius: 50%; border: 0;
  background: var(--ta-accent); color: #fff; box-shadow: 0 8px 24px rgba(0,0,0,.2);
  display: grid; place-items: center; transition: transform .15s;
}
.launcher.left { right: auto; left: 20px; }
.launcher:hover { transform: scale(1.06); }
.launcher svg { width: 26px; height: 26px; fill: currentColor; stroke: none; }

.panel {
  display: flex; flex-direction: column; background: var(--ta-bg);
  border: 1px solid var(--ta-border); border-radius: var(--ta-radius); overflow: hidden;
}
.panel.inline { height: 100%; }
.panel.floating {
  position: fixed; right: 20px; bottom: 90px; z-index: 2147483000;
  width: min(410px, calc(100vw - 24px)); height: min(640px, calc(100vh - 110px));
  box-shadow: 0 16px 48px rgba(0,0,0,.22);
}
.panel.floating.left { right: auto; left: 20px; }
@media (max-width: 480px) {
  .panel.floating { right: 8px; left: 8px; width: auto; bottom: 84px; height: calc(100vh - 100px); }
  .launcher { right: 12px; bottom: 12px; }
}

header {
  display: flex; align-items: center; gap: 10px; padding: 12px 12px 12px 16px;
  background: var(--ta-accent); color: #fff;
}
.avatar { width: 34px; height: 34px; border-radius: 50%; background: rgba(255,255,255,.2); display: grid; place-items: center; font-weight: 700; font-size: 13px; flex: none; }
.heading { flex: 1; min-width: 0; }
.title { margin: 0; font-size: 15px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.subtitle { margin: 0; font-size: 12px; opacity: .85; }
.icon { background: transparent; border: 0; color: #fff; width: 34px; height: 34px; border-radius: 8px; display: grid; place-items: center; flex: none; }
.icon:hover, .icon[aria-pressed="true"] { background: rgba(255,255,255,.18); }

.body { flex: 1; min-height: 0; position: relative; display: flex; }
.messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; background: var(--ta-bg); }
.msg { max-width: 88%; padding: 10px 13px; border-radius: 14px; overflow-wrap: anywhere; }
.msg.user { align-self: flex-end; background: var(--ta-accent); color: #fff; border-bottom-right-radius: 4px; white-space: pre-wrap; }
.msg.assistant { align-self: flex-start; background: var(--ta-surface); border-bottom-left-radius: 4px; }
.msg p { margin: 0 0 .55em; } .msg p:last-child { margin-bottom: 0; }
.msg p.h { font-weight: 700; }
.msg ul, .msg ol { margin: .3em 0 .6em; padding-left: 1.3em; }
.msg code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; background: rgba(127,127,127,.15); padding: 1px 4px; border-radius: 4px; }
.msg pre { background: rgba(127,127,127,.12); padding: 8px 10px; border-radius: 8px; overflow-x: auto; margin: .4em 0; }
.msg pre code { background: none; padding: 0; }
.msg a { color: var(--ta-accent); }
.typing { display: flex; gap: 4px; padding: 14px; }
.typing span { width: 7px; height: 7px; border-radius: 50%; background: var(--ta-muted); animation: blink 1.2s infinite; }
.typing span:nth-child(2) { animation-delay: .2s; } .typing span:nth-child(3) { animation-delay: .4s; }
@keyframes blink { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .typing span { animation: none; opacity: .6; } .launcher { transition: none; } }
.notice { align-self: center; font-size: 13px; color: var(--ta-muted); text-align: center; padding: 6px 10px; }
.notice.error { color: var(--ta-ko); background: color-mix(in srgb, var(--ta-ko) 10%, transparent); border-radius: 8px; }

.quiz { align-self: stretch; border: 1px solid var(--ta-border); border-radius: 12px; padding: 12px 14px; background: var(--ta-bg); }
.quiz-label { margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--ta-accent); font-weight: 700; }
.quiz-q { margin: 4px 0 10px; font-weight: 600; }
.quiz-options { display: grid; gap: 6px; }
.quiz-options button {
  display: flex; gap: 10px; align-items: flex-start; text-align: left; padding: 8px 10px;
  border: 1px solid var(--ta-border); border-radius: 10px; background: var(--ta-surface);
}
.quiz-options button:not(:disabled):hover { border-color: var(--ta-accent); }
.quiz-options button:disabled { opacity: 1; cursor: default; }
.quiz-options .letter { font-weight: 700; color: var(--ta-accent); flex: none; }
.quiz-options .correct { border-color: var(--ta-ok); background: color-mix(in srgb, var(--ta-ok) 12%, transparent); }
.quiz-options .wrong { border-color: var(--ta-ko); background: color-mix(in srgb, var(--ta-ko) 12%, transparent); }
.quiz-feedback { margin-top: 10px; font-size: 14px; }
.link { background: none; border: 0; padding: 0; margin-top: 8px; color: var(--ta-muted); text-decoration: underline; font-size: 13px; }
.link.danger { color: var(--ta-ko); }

.journey { position: absolute; inset: 0; overflow-y: auto; padding: 16px 18px; background: var(--ta-bg); }
.journey h3 { margin: 0 0 12px; font-size: 16px; }
.overall { display: flex; align-items: center; gap: 10px; }
.bar { flex: 1; height: 8px; background: var(--ta-surface); border-radius: 99px; overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--ta-accent); border-radius: 99px; }
.modules { list-style: none; padding: 0; margin: 10px 0 14px; display: grid; gap: 6px; }
.modules li { display: flex; justify-content: space-between; gap: 8px; padding: 7px 10px; border-radius: 8px; background: var(--ta-surface); font-size: 14px; border-left: 4px solid var(--ta-border); }
.modules em { font-style: normal; font-size: 12px; color: var(--ta-muted); white-space: nowrap; }
.modules .st-en_cours { border-left-color: #d97706; }
.modules .st-compris { border-left-color: #2563eb; }
.modules .st-maîtrisé { border-left-color: var(--ta-ok); }
dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; font-size: 14px; }
dt { color: var(--ta-muted); } dd { margin: 0; }
.chips { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px; }
.chips li { background: var(--ta-surface); border-radius: 99px; padding: 1px 9px; font-size: 13px; }
.muted { color: var(--ta-muted); margin: 4px 0; } .small { font-size: 12px; margin-top: 14px; }

.suggestions { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 8px; background: var(--ta-bg); }
.suggestions button { border: 1px solid var(--ta-accent); color: var(--ta-accent); background: transparent; border-radius: 99px; padding: 4px 11px; font-size: 13px; }
.suggestions button:hover:not(:disabled) { background: color-mix(in srgb, var(--ta-accent) 10%, transparent); }

.composer { display: flex; gap: 8px; align-items: flex-end; padding: 10px 12px; border-top: 1px solid var(--ta-border); background: var(--ta-bg); }
textarea {
  flex: 1; resize: none; font: inherit; color: var(--ta-text); background: var(--ta-surface);
  border: 1px solid var(--ta-border); border-radius: 12px; padding: 9px 12px; max-height: 140px; outline: none;
}
textarea:focus { border-color: var(--ta-accent); }
.send { width: 40px; height: 40px; border-radius: 50%; border: 0; background: var(--ta-accent); color: #fff; display: grid; place-items: center; flex: none; }
.footnote { margin: 0; padding: 0 12px 8px; font-size: 11px; color: var(--ta-muted); text-align: center; background: var(--ta-bg); }
:focus-visible { outline: 2px solid var(--ta-accent); outline-offset: 2px; }
header :focus-visible { outline-color: #fff; }
`;

if (!customElements.get("training-agent")) customElements.define("training-agent", TrainingAgentElement);

export { TrainingAgentElement, PROGRESS_STATUSES };
