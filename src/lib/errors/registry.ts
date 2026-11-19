/**
 * A finite failure-code registry: every code that may reach a user, peer, or
 * persisted status is declared here with its safe text. Parse by exact
 * membership; never accept an unregistered code or a raw exception message.
 */
export function defineFailures<const T extends Record<string, string>>(
  texts: T,
) {
  type Code = Extract<keyof T, string>;
  return {
    codes: Object.keys(texts) as Code[],
    is(value: unknown): value is Code {
      return typeof value === "string" && Object.hasOwn(texts, value);
    },
    text(code: Code): string {
      return texts[code];
    },
  };
}

export type FailureCodeOf<R> = R extends {
  is(value: unknown): value is infer C;
}
  ? C
  : never;
