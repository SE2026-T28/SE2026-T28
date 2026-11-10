export function ownedDocker(command: (executable: string, args: string[]) => string, runId: string): {
  start(args: string[]): any;
  cleanup(): void;
};
export function cleanupSteps(steps: [string, () => unknown | Promise<unknown>][] ): Promise<string[]>;
