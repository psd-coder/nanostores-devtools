import { getDevtoolsGlobal } from "./global.ts";

const PREFIX = "[nanostores-devtools]";

/**
 * `kind` plus `subject` is the whole dedup key: one message per kind of problem per thing it
 * happened to. Once per page hides a second, different bug behind the first; once per
 * occurrence floods the console from inside a loop.
 */
export function warnOnce(kind: string, subject: string, message: string): void {
  const { warned } = getDevtoolsGlobal();
  const key = `${kind}:${subject}`;

  if (warned.has(key)) {
    return;
  }

  warned.add(key);
  console.warn(`${PREFIX} ${message}`);
}

/** A `catch` binding is whatever was thrown, so a string or an object has to read as well. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
