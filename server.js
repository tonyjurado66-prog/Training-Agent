// Serveur de l'agent de formation.
//  - garde la clé API Anthropic côté serveur ;
//  - héberge les formations (dossier courses/) ;
//  - sert le studio, la démo et le widget intégrable (dossier public/).
//
// Démarrage : ANTHROPIC_API_KEY=... npm start   puis http://localhost:3000

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildRequest,
  normalizeCourse,
  normalizeProfile,
  publicCourseInfo,
  validateMessages,
} from "./public/core/agent-core.js";
import { describeApiError } from "./public/core/transports.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "public");
const SDK_DIR = path.join(here, "node_modules", "@anthropic-ai", "sdk");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export function createApp({
  anthropic = new Anthropic(),
  coursesDir = process.env.COURSES_DIR || path.join(here, "courses"),
  config = { model: process.env.TA_MODEL, effort: process.env.TA_EFFORT },
  adminToken = process.env.ADMIN_TOKEN || "",
  allowedOrigins = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim()).filter(Boolean),
  rateLimitPerMinute = Number(process.env.RATE_LIMIT_PER_MIN || 30),
} = {}) {
  // --- Formations -----------------------------------------------------------
  let cache = null;
  async function loadCourses() {
    if (cache) return cache;
    const map = new Map();
    await fs.mkdir(coursesDir, { recursive: true });
    for (const file of await fs.readdir(coursesDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const course = normalizeCourse(JSON.parse(await fs.readFile(path.join(coursesDir, file), "utf8")));
        map.set(course.id, course);
      } catch (e) {
        console.warn(`[formations] ${file} ignoré : ${e.message}`);
      }
    }
    return (cache = map);
  }

  // --- Limitation de débit (par IP, fenêtre glissante d'une minute) -----------
  const hits = new Map();
  function rateLimited(ip) {
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
    list.push(now);
    hits.set(ip, list);
    if (hits.size > 10_000) hits.clear();
    return list.length > rateLimitPerMinute;
  }

  // --- Administration (studio) ---------------------------------------------
  // Avec ADMIN_TOKEN : jeton obligatoire. Sans ADMIN_TOKEN : autorisé uniquement
  // pour un accès local direct (http://localhost), pratique pour tester sur son poste.
  function adminDenied(req) {
    if (adminToken) {
      return req.headers.authorization === `Bearer ${adminToken}` ? null : { status: 401, error: "Jeton d'administration invalide." };
    }
    const host = String(req.headers.host || "").replace(/:\d+$/, "");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(host) &&
      !req.headers["x-forwarded-for"] &&
      ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
    return local ? null : { status: 403, error: "Administration désactivée : définissez ADMIN_TOKEN sur le serveur." };
  }

  // --- CORS (nécessaire quand le widget est intégré sur un autre domaine) ----
  function cors(req, res) {
    const origin = req.headers.origin;
    if (!origin) return true;
    const sameOrigin = origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
    const ok = sameOrigin || allowedOrigins.includes("*") || allowedOrigins.includes(origin);
    if (ok) {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigins.includes("*") ? "*" : origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    }
    return ok;
  }

  // --- Routes ---------------------------------------------------------------
  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    if (p.startsWith("/api/")) {
      if (!cors(req, res)) return json(res, 403, { error: "Origine non autorisée." });
      if (req.method === "OPTIONS") return void res.writeHead(204).end();

      if (p === "/api/health") return json(res, 200, { ok: true, admin: adminToken ? "token" : "local" });

      if (p === "/api/courses" && req.method === "GET") {
        const courses = await loadCourses();
        return json(res, 200, { courses: [...courses.values()].map(publicCourseInfo) });
      }

      const m = p.match(/^\/api\/courses\/([a-z0-9-]+)(\/source)?$/);
      if (m && req.method === "GET") {
        const course = (await loadCourses()).get(m[1]);
        if (!course) return json(res, 404, { error: "Formation introuvable." });
        if (!m[2]) return json(res, 200, publicCourseInfo(course));
        const denied = adminDenied(req);
        return denied ? json(res, denied.status, { error: denied.error }) : json(res, 200, course);
      }
      if (m && !m[2] && req.method === "PUT") {
        const denied = adminDenied(req);
        if (denied) return json(res, denied.status, { error: denied.error });
        let course;
        try {
          course = normalizeCourse({ ...(await readJson(req, 2_000_000)), id: m[1] });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
        await fs.writeFile(path.join(coursesDir, `${course.id}.json`), JSON.stringify(course, null, 2));
        cache = null;
        return json(res, 200, publicCourseInfo(course));
      }

      if (p === "/api/chat" && req.method === "POST") return chat(req, res);
      return json(res, 404, { error: "Route inconnue." });
    }

    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "Méthode non autorisée." });
    if (p.startsWith("/vendor/anthropic-sdk/")) {
      // SDK officiel servi au navigateur pour le mode « clé API directe » du studio.
      return serveFile(res, SDK_DIR, p.slice("/vendor/anthropic-sdk/".length), [".mjs"]);
    }
    return serveFile(res, PUBLIC_DIR, p === "/" ? "index.html" : p.slice(1));
  }

  async function chat(req, res) {
    const ip = req.socket.remoteAddress || "?";
    if (rateLimited(ip)) return json(res, 429, { error: "Trop de messages en peu de temps : patientez une minute." });

    let body;
    try {
      body = await readJson(req, 1_000_000);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    const course = (await loadCourses()).get(String(body.courseId || ""));
    if (!course) return json(res, 404, { error: "Formation introuvable." });
    const problem = validateMessages(body.messages);
    if (problem) return json(res, 400, { error: problem });

    const params = buildRequest({
      course,
      profileSnapshot: normalizeProfile(body.profileSnapshot),
      messages: body.messages,
      config,
    });

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const stream = anthropic.beta.messages.stream(params);
    res.on("close", () => {
      if (!res.writableFinished) stream.abort();
    });
    stream.on("text", (text) => send("text", { text }));
    try {
      const message = await stream.finalMessage();
      send("message", { message: { content: message.content, stop_reason: message.stop_reason } });
    } catch (e) {
      if (!res.destroyed) {
        console.error("[chat]", e);
        send("error", { error: describeApiError(Anthropic, e) });
      }
    }
    res.end();
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: "Erreur interne." });
      else res.end();
    });
  });
}

// ---------------------------------------------------------------------------

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readJson(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Requête trop volumineuse.");
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!data || typeof data !== "object") throw new Error();
    return data;
  } catch {
    throw new Error("JSON invalide.");
  }
}

async function serveFile(res, root, rel, allowedExt) {
  const file = path.resolve(root, decodeURIComponent(rel));
  if (!file.startsWith(root + path.sep)) return json(res, 403, { error: "Accès refusé." });
  const ext = path.extname(file);
  if (allowedExt && !allowedExt.includes(ext)) return json(res, 404, { error: "Fichier introuvable." });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      // Le widget est chargé depuis d'autres domaines.
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    json(res, 404, { error: "Fichier introuvable." });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const port = Number(process.env.PORT || 3000);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("⚠️  ANTHROPIC_API_KEY n'est pas défini : l'agent ne pourra pas répondre (voir .env.example).");
  }
  if ((process.env.ALLOWED_ORIGINS || "*") === "*") {
    console.warn("ℹ️  ALLOWED_ORIGINS=* : n'importe quel site peut utiliser ce serveur. Restreignez-le en production.");
  }
  createApp().listen(port, () => {
    console.log(`Agent de formation prêt : http://localhost:${port}`);
    console.log(`  Studio     : http://localhost:${port}/`);
    console.log(`  Démo site  : http://localhost:${port}/demo.html`);
  });
}
