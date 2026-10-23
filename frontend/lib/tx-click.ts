// TxButton's click handler, kept pure so it can be tested without React.
// run(call) is ALWAYS awaited, with or without an onDone callback. The old inline form
// `onDone?.(await run(call))` skipped evaluating run() entirely when onDone was absent,
// so buttons without a callback never signed anything.
export async function runThenNotify<C, S>(call: C | null | undefined, run: (c: C) => Promise<S>, onDone?: (s: S) => void): Promise<S | undefined> {
  if (!call) return undefined;
  const result = await run(call);
  if (onDone) onDone(result);
  return result;
}
