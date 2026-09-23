// Génère artifact/tuteur-claude.html (page publiée sur claude.ai) en y intégrant
// les formations du dossier courses/. Usage : node artifact/build.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCourse } from "../public/core/agent-core.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const coursesDir = path.join(here, "..", "courses");
const courses = [];
for (const file of (await fs.readdir(coursesDir)).sort()) {
  if (file.endsWith(".json")) courses.push(normalizeCourse(JSON.parse(await fs.readFile(path.join(coursesDir, file), "utf8"))));
}
// Échappe « < » pour qu'aucun contenu ne puisse fermer la balise <script>.
const json = JSON.stringify(courses).replace(/</g, "\\u003c");
const src = await fs.readFile(path.join(here, "tuteur.src.html"), "utf8");
await fs.writeFile(path.join(here, "tuteur-claude.html"), src.replace("__COURSES__", () => json));
console.log(`artifact/tuteur-claude.html généré (${courses.length} formation(s)).`);
