import { describeError, warnOnce } from "./warn.ts";

/**
 * Nothing we run inside a nanostores listener may throw out of it. The extension's `stringify`
 * runs inside its own `send`, so a value it cannot serialize throws at our call site, and a
 * listener that throws can stop the drain and with it every store listener on the page.
 */
export function catchAndWarn(subject: string, work: () => void): void {
  try {
    work();
  } catch (error) {
    const reason = describeError(error);

    warnOnce(
      "listener-failed",
      subject,
      `Watching "${subject}" failed, so this change is missing from the panel. ${reason}`,
    );
  }
}
