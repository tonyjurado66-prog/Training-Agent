import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server.js";
import { createFakeAnthropic } from "./fake-anthropic.js";

let server, base, dir, fake;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ta-"));
  await fs.writeFile(path.join(dir, "demo.json"), JSON.stringify({ id: "demo", title: "Démo", modules: [{ id: "m1", title: "Intro", content: "SECRET-CONTENU" }] }));
  fake = createFakeAnthropic([[{ type: "text", text: "Bonjour, quel est votre niveau ?" }]]);
  server = createApp({ anthropic: fake, coursesDir: dir, adminToken: "t0k", allowedOrigins: ["https://site.example"] });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test("liste publique des formations sans le contenu", async () => {
  const res = await fetch(`${base}/api/courses/demo`);
  const body = await res.json();
  assert.equal(body.title, "Démo");
  assert.match(body.version, /^[0-9a-f]{8}$/);
  assert.ok(!JSON.stringify(body).includes("SECRET-CONTENU"));
});

test("chat : streaming SSE puis message final", async () => {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ courseId: "demo", profileSnapshot: {}, messages: [{ role: "user", content: "Salut" }] }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /event: text/);
  assert.match(text, /event: message/);
  const params = fake.calls.at(-1);
  assert.match(params.system, /SECRET-CONTENU/);
  assert.equal(params.fallbacks, "default");
});

test("chat : validations", async () => {
  const post = (body) => fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ courseId: "nope", messages: [{ role: "user", content: "x" }] })).status, 404);
  assert.equal((await post({ courseId: "demo", messages: [] })).status, 400);
});

test("CORS : origine non autorisée refusée", async () => {
  const res = await fetch(`${base}/api/courses`, { headers: { Origin: "https://pirate.example" } });
  assert.equal(res.status, 403);
  const ok = await fetch(`${base}/api/courses`, { headers: { Origin: "https://site.example" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://site.example");
});

test("administration : jeton requis pour lire la source et enregistrer", async () => {
  assert.equal((await fetch(`${base}/api/courses/demo/source`)).status, 401);
  const src = await fetch(`${base}/api/courses/demo/source`, { headers: { Authorization: "Bearer t0k" } });
  assert.match(JSON.stringify(await src.json()), /SECRET-CONTENU/);

  const put = await fetch(`${base}/api/courses/nouvelle`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: "Bearer t0k" },
    body: JSON.stringify({ title: "Nouvelle formation" }),
  });
  assert.equal(put.status, 200);
  const list = await (await fetch(`${base}/api/courses`)).json();
  assert.ok(list.courses.some((c) => c.id === "nouvelle"));
});

test("fichiers statiques et SDK navigateur", async () => {
  assert.equal((await fetch(`${base}/widget/training-agent.js`)).status, 200);
  assert.equal((await fetch(`${base}/vendor/anthropic-sdk/index.mjs`)).status, 200);
  assert.equal((await fetch(`${base}/vendor/anthropic-sdk/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/..%2Fserver.js`)).status, 403);
});
