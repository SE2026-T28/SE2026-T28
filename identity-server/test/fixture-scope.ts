import { randomUUID } from "node:crypto";

// All writes must be represented by track() until their database effects settle.
// Closing a scope synchronously blocks allocation/new work, then drains existing work.
export function createFixtureScope(remove: (emails: string[]) => Promise<void>) {
  const runId = randomUUID();
  const emails = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  let phase: "active" | "closing" | "closed" = "active";
  let cleaning: Promise<void> | undefined;
  return {
    email(): string {
      if (phase !== "active") throw new Error("Fixture scope is closing or closed");
      const value = `s3-${runId}-${randomUUID()}@example.test`;
      emails.add(value);
      return value;
    },
    track<T>(operation: () => Promise<T>): Promise<T> {
      if (phase !== "active") throw new Error("Fixture scope is closing or closed");
      const work = Promise.resolve().then(operation);
      pending.add(work);
      void work.then(() => pending.delete(work), () => pending.delete(work));
      return work;
    },
    cleanup(): Promise<void> {
      if (cleaning) return cleaning;
      phase = "closing";
      cleaning = (async () => {
        await Promise.allSettled([...pending]);
        const owned = [...emails];
        if (owned.length) await remove(owned);
        for (const email of owned) emails.delete(email);
        phase = "closed";
      })().catch(error => {
        cleaning = undefined; // retain ownership and keep closed to new work; allow retry
        throw error;
      });
      return cleaning;
    },
  };
}
