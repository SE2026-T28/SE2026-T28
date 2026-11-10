export function assertTestDatabase(env?: Record<string, string | undefined>): string;
export function assertManagedDatabase(env?: NodeJS.ProcessEnv): string;
export function readManagedSession(env?: NodeJS.ProcessEnv): Record<string, any>;
export function digest(value: string | Uint8Array): string;
export const projectRoot: string;
export const lockedConfig: string;
export const lockedSchema: string;
export const lockedMigrations: string;
export const runtimeRoot: string;
