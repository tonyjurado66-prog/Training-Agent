// Studio : créer / modifier une formation, tester le tuteur, générer le code d'intégration.

import { normalizeCourse, slug, DEFAULT_CONFIG } from "./core/agent-core.js";
import { createDirectTransport } from "./core/transports.js";

const $ = (s) => document.querySelector(s);
const DRAFT_KEY = "training-agent:studio:draft";
const KEY_KEY = "training-agent:studio:api-key";

const state = {
  server: false,          // serveur de l'agent joignable ?
  mode: "server",         // "server" | "direct"
  courses: [],            // formations du serveur (infos publiques)
  selected: "",           // id de la formation serveur sélectionnée ("" = brouillon)
  dirty: false,           // éditeur modifié depuis le dernier chargement/enregistrement
};

// ---------------------------------------------------------------- Démarrage --

init();

async function init() {
  wireEvents();
  try { $("#api-key").value = sessionStorage.getItem(KEY_KEY) || ""; } catch { /* ignoré */ }

  try {
    const res = await fetch("api/health");
    state.server = res.ok;
  } catch {
    state.server = false;
  }

  if (state.server) {
    $("#server-status").textContent = "✅ Serveur de l'agent connecté : la clé API est gérée côté serveur.";
    await refreshCourseList();
  } else {
    $("#server-status").textContent = "Aucun serveur détecté (hébergement statique) : utilisez le mode « Clé API ».";
    setMode("direct");
    $('#mode input[value="server"]').disabled = true;
  }

  const draft = readDraft();
  if (draft && (!state.courses.length || draft.__selected === "")) {
    fillEditor(draft);
    state.selected = "";
  } else if (state.courses.length) {
    await selectServerCourse(state.courses[0].id);
  } else {
    fillEditor(draft || { title: "", modules: [{}] });
  }
  renderSelect();
  refreshPreview();
}

async function refreshCourseList() {
  try {
    const res = await fetch("api/courses");
    state.courses = (await res.json()).courses || [];
  } catch {
    state.courses = [];
  }
}

function renderSelect() {
  const sel = $("#course-select");
  sel.replaceChildren();
  if (state.courses.length) {
    const group = document.createElement("optgroup");
    group.label = "Sur le serveur";
    for (const c of state.courses) group.append(new Option(c.title, c.id));
    sel.append(group);
  }
  sel.append(new Option("✎ Brouillon (éditeur ci-dessous)", ""));
  sel.value = state.selected;
}

async function selectServerCourse(id) {
  state.selected = id;
  const res = await fetch(`api/courses/${id}/source`, { headers: authHeaders() });
  if (res.ok) {
    fillEditor(await res.json());
    status("");
  } else {
    const info = state.courses.find((c) => c.id === id);
    fillEditor({ title: info?.title || id, id, modules: [] });
    status("Contenu non modifiable sans jeton d'administration : l'aperçu utilise la version du serveur.");
  }
  state.dirty = false;
}

// ------------------------------------------------------------------ Éditeur --

function fillEditor(course) {
  const f = $("#course-form");
  for (const name of ["title", "id", "language", "audience", "description", "tone", "welcome", "instructions"]) {
    f.elements[name].value = course[name] ?? (name === "language" ? "fr" : "");
  }
  f.elements.objectives.value = (course.objectives || []).join("\n");
  f.elements.prerequisites.value = (course.prerequisites || []).join("\n");
  $("#modules").replaceChildren();
  for (const m of course.modules || []) addModule(m);
  renumber();
  updateEmbed();
}

function readEditor() {
  const f = $("#course-form").elements;
  const lines = (v) => v.split("\n").map((s) => s.trim()).filter(Boolean);
  return {
    id: f.id.value.trim() || slug(f.title.value || "formation"),
    title: f.title.value.trim(),
    language: f.language.value.trim() || "fr",
    audience: f.audience.value,
    description: f.description.value,
    objectives: lines(f.objectives.value),
    prerequisites: lines(f.prerequisites.value),
    tone: f.tone.value,
    welcome: f.welcome.value,
    instructions: f.instructions.value,
    modules: [...document.querySelectorAll("#modules .module")].map((li, i) => ({
      id: slug(li.querySelector('[data-f="title"]').value || `module-${i + 1}`),
      title: li.querySelector('[data-f="title"]').value.trim(),
      objectives: lines(li.querySelector('[data-f="objectives"]').value),
      content: li.querySelector('[data-f="content"]').value,
    })),
  };
}

function addModule(m = {}) {
  const li = $("#module-template").content.firstElementChild.cloneNode(true);
  li.querySelector('[data-f="title"]').value = m.title || "";
  li.querySelector('[data-f="objectives"]').value = (m.objectives || []).join("\n");
  li.querySelector('[data-f="content"]').value = m.content || "";
  li.querySelector(".remove").addEventListener("click", () => {
    li.remove();
    renumber();
    onEdit();
  });
  li.querySelector(".up").addEventListener("click", () => {
    li.previousElementSibling?.before(li);
    renumber();
    onEdit();
  });
  li.querySelector(".down").addEventListener("click", () => {
    li.nextElementSibling?.after(li);
    renumber();
    onEdit();
  });
  li.querySelector(".import-text").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const ta = li.querySelector('[data-f="content"]');
    ta.value = (ta.value ? ta.value + "\n\n" : "") + (await file.text());
    if (!li.querySelector('[data-f="title"]').value) li.querySelector('[data-f="title"]').value = file.name.replace(/\.\w+$/, "");
    e.target.value = "";
    onEdit();
  });
  $("#modules").append(li);
  return li;
}

function renumber() {
  document.querySelectorAll("#modules .module").forEach((li, i) => {
    li.querySelector(".module-num").textContent = `Module ${i + 1}`;
  });
}

let editTimer;
function onEdit() {
  state.dirty = true;
  clearTimeout(editTimer);
  editTimer = setTimeout(() => {
    saveDraft();
    updateEmbed();
    if (state.mode === "direct" || !state.selected) refreshPreview();
    else status("Modifications non enregistrées : l'aperçu utilise la version du serveur. Cliquez sur « Enregistrer sur le serveur ».");
  }, 800);
}

function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...readEditor(), __selected: state.selected })); } catch { /* ignoré */ }
}
function readDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch { return null; }
}

// ------------------------------------------------------------------- Aperçu --

function refreshPreview() {
  const box = $("#preview");
  const hint = $("#preview-hint");
  const el = document.createElement("training-agent");
  el.setAttribute("mode", "inline");
  el.setAttribute("learner-id", $("#learner-id").value.trim() || "test");

  if (state.mode === "server") {
    if (!state.selected) {
      box.replaceChildren(placeholder("Enregistrez ce brouillon sur le serveur pour le tester, ou passez en mode « Clé API »."));
      hint.textContent = "";
      return;
    }
    el.setAttribute("course", state.selected);
    hint.textContent = `Formation « ${state.selected} » servie par le serveur.`;
  } else {
    let course;
    try {
      course = normalizeCourse(readEditor());
    } catch (e) {
      box.replaceChildren(placeholder(e.message));
      return;
    }
    const apiKey = $("#api-key").value.trim();
    if (!apiKey) {
      box.replaceChildren(placeholder("Saisissez votre clé API Anthropic pour tester (étape 1)."));
      hint.textContent = "";
      return;
    }
    const config = { model: $("#model").value.trim() || DEFAULT_CONFIG.model, effort: $("#effort").value };
    el.configure({ course, transport: createDirectTransport({ apiKey, course, config }) });
    hint.textContent = `Brouillon testé directement avec ${config.model}.`;
  }
  el.addEventListener("training-agent:profile", () => {
    if (!$("#profile-json").hidden) showProfile();
  });
  box.replaceChildren(el);
}

function placeholder(text) {
  const p = document.createElement("div");
  p.className = "placeholder";
  p.textContent = text;
  return p;
}

function currentAgent() {
  return $("#preview training-agent");
}

function showProfile() {
  const agent = currentAgent();
  const pre = $("#profile-json");
  pre.textContent = agent ? JSON.stringify(agent.getProfile(), null, 2) : "Aucun aperçu actif.";
  pre.hidden = false;
}

// -------------------------------------------------------------- Intégration --

function updateEmbed() {
  const base = new URL(".", location.href).href.replace(/\/$/, "");
  const id = state.selected || readEditor().id;
  const inline = document.querySelector('input[name="embed"]:checked').value === "inline";
  const code =
`<!-- Tuteur IA : ${readEditor().title || id} -->
<script type="module" src="${base}/widget/training-agent.js"></script>
<training-agent
  course="${id}"
  endpoint="${base}"${inline ? `\n  mode="inline"\n  style="display:block;height:600px"` : ""}
  learner-id="IDENTIFIANT_APPRENANT"
  accent="#4f46e5">
</training-agent>`;
  $("#embed-code").textContent = code;
}

// ------------------------------------------------------------------ Actions --

function wireEvents() {
  document.querySelectorAll('#mode input[name="mode"]').forEach((r) =>
    r.addEventListener("change", () => {
      setMode(r.value);
      refreshPreview();
    }),
  );
  $("#api-key").addEventListener("change", () => {
    try { sessionStorage.setItem(KEY_KEY, $("#api-key").value.trim()); } catch { /* ignoré */ }
    refreshPreview();
  });
  $("#model").addEventListener("change", refreshPreview);
  $("#effort").addEventListener("change", refreshPreview);

  $("#course-select").addEventListener("change", async (e) => {
    if (e.target.value) await selectServerCourse(e.target.value);
    else {
      state.selected = "";
      const draft = readDraft();
      if (draft) fillEditor(draft);
    }
    saveDraft();
    updateEmbed();
    refreshPreview();
  });

  $("#new-course").addEventListener("click", () => {
    if (state.dirty && !confirm("Abandonner les modifications en cours ?")) return;
    state.selected = "";
    fillEditor({ title: "", language: "fr", modules: [{}] });
    renderSelect();
    saveDraft();
    refreshPreview();
    $("#course-form").elements.title.focus();
  });

  $("#import-json").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const course = normalizeCourse(JSON.parse(await file.text()));
      state.selected = "";
      fillEditor(course);
      renderSelect();
      saveDraft();
      refreshPreview();
      status(`Formation « ${course.title} » importée comme brouillon.`);
    } catch (err) {
      status(`Import impossible : ${err.message}`, true);
    }
  });

  $("#export-json").addEventListener("click", () => {
    const course = readEditor();
    const blob = new Blob([JSON.stringify(course, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${course.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("#add-module").addEventListener("click", () => {
    addModule().querySelector('[data-f="title"]').focus();
    renumber();
    onEdit();
  });
  $("#course-form").addEventListener("input", onEdit);
  $("#course-form").addEventListener("submit", (e) => e.preventDefault());

  $("#save-server").addEventListener("click", saveToServer);

  $("#learner-id").addEventListener("change", refreshPreview);
  $("#show-profile").addEventListener("click", showProfile);
  $("#reset-learner").addEventListener("click", () => {
    currentAgent()?.clearData();
    if (!$("#profile-json").hidden) showProfile();
  });

  document.querySelectorAll('input[name="embed"]').forEach((r) => r.addEventListener("change", updateEmbed));
  $("#copy-embed").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#embed-code").textContent);
      $("#copy-embed").textContent = "Copié ✓";
      setTimeout(() => ($("#copy-embed").textContent = "Copier le code"), 1500);
    } catch {
      status("Copie impossible : sélectionnez le code manuellement.", true);
    }
  });
}

function setMode(mode) {
  state.mode = mode;
  document.querySelector(`#mode input[value="${mode}"]`).checked = true;
  $("#direct-fields").hidden = mode !== "direct";
  $("#save-box").hidden = !state.server;
}

async function saveToServer() {
  let course;
  try {
    course = normalizeCourse(readEditor());
  } catch (e) {
    return status(e.message, true);
  }
  const res = await fetch(`api/courses/${course.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(course),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return status(data.error || `Erreur ${res.status}`, true);
  state.selected = data.id;
  state.dirty = false;
  await refreshCourseList();
  renderSelect();
  saveDraft();
  updateEmbed();
  refreshPreview();
  status(`✅ Formation « ${data.title} » enregistrée sur le serveur.`);
}

function authHeaders() {
  const token = $("#admin-token").value.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function status(text, isError = false) {
  const el = $("#course-status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}
