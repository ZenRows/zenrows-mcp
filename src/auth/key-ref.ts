/**
 * An API key as the tools see it: a fixed string (hosted, tests), or a holder whose value
 * appears once the stdio server has resolved or provisioned a key. Tools read it at call
 * time, never at registration.
 */
export type KeyRef = string | { readonly current: string };

export function keyOf(k: KeyRef): string {
  return typeof k === "string" ? k : k.current;
}
