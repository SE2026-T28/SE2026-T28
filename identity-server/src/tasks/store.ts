import { randomUUID } from "node:crypto";

export type TaskStatus = "queued" | "running" | "succeeded" | "failed";
export type TaskInput = { workUnits: number; failAt?: number };
export type TaskSnapshot = { id: string; status: TaskStatus; progress: number };

type TaskRecord = TaskSnapshot & { input: TaskInput; fingerprint: string };
type SubmitResult =
  | { kind: "accepted"; task: TaskSnapshot; replayed: boolean }
  | { kind: "conflict" | "capacity" };

const MAX_RECORDS = 10_000;

/** In-process demonstration store. It is not a durable or distributed queue. */
export class TaskStore {
  private readonly byKey = new Map<string, TaskRecord>();
  private readonly byId = new Map<string, TaskRecord>();

  constructor(private readonly options: {
    stepDelayMs?: number;
    onComplete?: (task: TaskSnapshot) => void | Promise<void>;
  } = {}) {}

  submit(key: string, input: TaskInput): SubmitResult {
    const fingerprint = JSON.stringify({ workUnits: input.workUnits, failAt: input.failAt ?? null });
    const existing = this.byKey.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { kind: "conflict" };
      return { kind: "accepted", task: this.snapshot(existing), replayed: true };
    }
    // Never evict a key while this process lives: eviction would allow a retry
    // to create a second task and invoke the completion effect again.
    if (this.byKey.size >= MAX_RECORDS) return { kind: "capacity" };
    const record: TaskRecord = { id: randomUUID(), status: "queued", progress: 0, input, fingerprint };
    this.byKey.set(key, record);
    this.byId.set(record.id, record);
    queueMicrotask(() => { void this.run(record); });
    return { kind: "accepted", task: this.snapshot(record), replayed: false };
  }

  get(id: string): TaskSnapshot | undefined {
    const record = this.byId.get(id);
    return record ? this.snapshot(record) : undefined;
  }

  private snapshot(record: TaskRecord): TaskSnapshot {
    return { id: record.id, status: record.status, progress: record.progress };
  }

  private async run(record: TaskRecord): Promise<void> {
    if (record.status !== "queued") return;
    record.status = "running";
    try {
      for (let unit = 1; unit <= record.input.workUnits; unit++) {
        await new Promise<void>(resolve => setTimeout(resolve, this.options.stepDelayMs ?? 40));
        if (record.input.failAt === unit) {
          record.status = "failed";
          return;
        }
        // Reserve 100 for the completion effect. A failed effect must not be
        // reported to users as a successful task.
        record.progress = Math.min(99, Math.floor(unit * 100 / record.input.workUnits));
      }
      await this.options.onComplete?.(this.snapshot(record));
      record.progress = 100;
      record.status = "succeeded";
    } catch {
      record.status = "failed";
    }
  }
}
