import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../dist/src/app.js";
import { readConfig } from "../dist/src/config.js";

const config = readConfig({
  NODE_ENV: "test", PORT: "3000", OIDC_ISSUER: "http://localhost:3000",
  OIDC_CLIENT_ID: "app04-react-demo", OIDC_REDIRECT_URI: "http://localhost:5173/callback",
  OIDC_POST_LOGOUT_REDIRECT_URI: "http://localhost:5173/", OIDC_SCOPES: "openid profile email",
  OIDC_CORS_ORIGIN: "http://localhost:5173",
});
const server = createApp(config).listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), "vt114-chrome-"));
const chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let socket;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, timeoutMs = 8_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  throw new Error("Browser check timed out");
}

try {
  const port = await waitFor(async () => {
    try { return Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); }
    catch { return null; }
  });
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find(item => item.type === "page");
  assert.ok(target?.webSocketDebuggerUrl);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
  await send("Page.navigate", { url: `${baseUrl}/demo-tasks` });
  await waitFor(async () => await evaluate("document.readyState === 'complete' && !!document.querySelector('#task-form')"));
  await evaluate("document.querySelector('#task-form').requestSubmit()");
  const final = await waitFor(async () => {
    const state = await evaluate("({text: document.querySelector('#status').textContent, progress: document.querySelector('#progress').value})");
    return state.text.startsWith("succeeded") ? state : null;
  });
  assert.equal(final.progress, 100);
  console.log(JSON.stringify({ browser: "google-chrome headless", page: "/demo-tasks", finalStatus: final.text, progress: final.progress, pass: true }));
} finally {
  socket?.close();
  chrome.kill("SIGTERM");
  await new Promise(resolve => chrome.once("exit", resolve));
  await rm(profile, { recursive: true, force: true });
  await new Promise(resolve => server.close(() => resolve()));
}
