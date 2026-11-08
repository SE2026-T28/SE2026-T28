import { Router, type Express } from "express";
import { TaskStore, type TaskInput } from "./store.js";

const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>APP-04 · Tác vụ demo</title></head><body><main><h1>Tác vụ bất đồng bộ</h1><p>Demo tiến trình trong một server process; không dùng dữ liệu cá nhân.</p><form id="task-form"><label>Số bước <input name="workUnits" type="number" min="1" max="5" value="5" required></label><button type="submit">Bắt đầu</button></form><p id="status" role="status">Chưa có tác vụ</p><progress id="progress" max="100" value="0"></progress></main><script defer src="/demo-tasks.js"></script></body></html>`;

const script = `const form=document.querySelector('#task-form');const status=document.querySelector('#status');const progress=document.querySelector('#progress');form.addEventListener('submit',async event=>{event.preventDefault();form.querySelector('button').disabled=true;status.textContent='Đang tạo tác vụ';try{const key=crypto.randomUUID();const response=await fetch('/api/demo-tasks',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':key},body:JSON.stringify({workUnits:Number(form.elements.workUnits.value)})});if(!response.ok)throw new Error('Không thể tạo tác vụ');const task=await response.json();for(;;){const current=await fetch(task.statusUrl);if(!current.ok)throw new Error('Không thể đọc tiến trình');const data=await current.json();progress.value=data.progress;status.textContent=data.status+' — '+data.progress+'%';if(data.status==='succeeded'||data.status==='failed')break;await new Promise(resolve=>setTimeout(resolve,150));}}catch{status.textContent='Tác vụ lỗi; vui lòng thử lại';}finally{form.querySelector('button').disabled=false;}});`;

function parseInput(value: unknown): TaskInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => key !== "workUnits" && key !== "failAt")) return null;
  const workUnits = body.workUnits;
  const failAt = body.failAt;
  // This boundary is deliberately mutated from > to >= in the VT-114 test.
  if (!Number.isInteger(workUnits) || (workUnits as number) < 1 || (workUnits as number) > 5) return null;
  if (failAt !== undefined && (!Number.isInteger(failAt) || (failAt as number) < 1 || (failAt as number) > (workUnits as number))) return null;
  return failAt === undefined ? { workUnits: workUnits as number } : { workUnits: workUnits as number, failAt: failAt as number };
}

export function taskRouter(store: TaskStore): Router {
  const router = Router();
  router.post("/", (req, res) => {
    const key = req.get("Idempotency-Key");
    const input = parseInput(req.body);
    if (!key || !/^[A-Za-z0-9_-]{8,64}$/.test(key) || !input) {
      return res.status(400).json({ error: "INVALID_TASK_REQUEST" });
    }
    const result = store.submit(key, input);
    if (result.kind === "accepted") {
      return res.status(202).json({ ...result.task, statusUrl: `/api/demo-tasks/${result.task.id}`, replayed: result.replayed });
    }
    if (result.kind === "conflict") return res.status(409).json({ error: "IDEMPOTENCY_CONFLICT" });
    return res.status(503).json({ error: "TASK_CAPACITY_REACHED" });
  });
  router.get("/:id", (req, res) => {
    const task = store.get(String(req.params.id));
    return task ? res.json(task) : res.status(404).json({ error: "TASK_NOT_FOUND" });
  });
  return router;
}

export function mountDemoTaskPage(router: Express): void {
  router.get("/demo-tasks", (_req, res) => res.type("html").send(html));
  router.get("/demo-tasks.js", (_req, res) => res.type("application/javascript").send(script));
}
