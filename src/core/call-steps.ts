/** Shared call bodies yield lazy waits only when an asynchronous owner is reached. */
export type CallSteps<T = undefined> = Generator<() => Promise<undefined>, T, undefined>;

/** Direct game imports must finish without starting asynchronous work. */
export function finishCalls<T>(steps: CallSteps<T>): T {
  const step = steps.next();
  if (!step.done) throw new Error("Cannot synchronously finish an asynchronous call");
  return step.value;
}

async function continueCalls<T>(steps: CallSteps<T>, call: () => Promise<undefined>): Promise<T> {
  let pending = call;
  while (true) {
    let failure: { readonly error: unknown } | null = null;
    try { await pending(); }
    catch (error) { failure = { error }; }
    // Only the wait's failure enters throw. A resumed body can throw independently.
    const step = failure === null ? steps.next() : steps.throw(failure.error);
    if (step.done) return step.value;
    pending = step.value;
  }
}

/** Preserve immediate completion; after the first wait, resume each call in order. */
export function runCalls<T>(steps: CallSteps<T>): T | Promise<T> {
  const step = steps.next();
  return step.done ? step.value : continueCalls(steps, step.value);
}

/** Carry an awaited result back into the same body without starting it eagerly. */
export function* waitForCall<T>(call: () => Promise<T>): CallSteps<T> {
  const completion: { result: { readonly value: T } | null } = { result: null };
  yield async () => { completion.result = { value: await call() }; };
  const result = completion.result;
  if (result === null) throw new Error("Call resumed before its wait completed");
  return result.value;
}
