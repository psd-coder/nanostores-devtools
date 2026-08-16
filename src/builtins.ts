/**
 * Every prototype a global constructor carries, which is how a getter the platform wrote is told
 * from one the app did. `PointerEvent.prototype`, `DOMRect.prototype` and `URL.prototype` are all
 * here; a class the app declared in a module is not, because a module binding is no global.
 *
 * Built once and cached. A constructor the page adds afterwards is missed, which costs a label
 * rather than correctness, and rebuilding on every miss would walk the globals for every plain
 * object the panel draws.
 */
let known: WeakSet<object> | undefined;

/**
 * Whether the platform, rather than the app, defined this prototype.
 *
 * Read through descriptors throughout: a global is a data property in every engine we target, and
 * a plain read of `globalThis[key]` runs whatever getter stands behind a name, which is exactly the
 * app code this whole question is about not running.
 */
export function builtinPrototype(value: object): boolean {
  known ??= collectPrototypes();

  return known.has(value);
}

/** A fresh page is a fresh set, so a test that swaps the globals is not answered from the last one. */
export function forgetBuiltins(): void {
  known = undefined;
}

function collectPrototypes(): WeakSet<object> {
  const prototypes = new WeakSet<object>();

  try {
    for (const key of Object.getOwnPropertyNames(globalThis)) {
      const holder = dataValue(globalThis, key);

      if (typeof holder !== "function") {
        continue;
      }

      const prototype = dataValue(holder, "prototype");

      if (typeof prototype === "object" && prototype !== null) {
        prototypes.add(prototype);
      }
    }
  } catch {
    return prototypes;
  }

  return prototypes;
}

/** What a data property holds, and nothing at all for an accessor or a read that threw. */
function dataValue(holder: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(holder, key);

    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
