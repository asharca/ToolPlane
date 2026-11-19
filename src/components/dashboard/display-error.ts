/**
 * A thrown failure whose message is display-safe: translated text, a server's
 * `{ error }` text from `apiRequest`, or a known code the catcher translates.
 * UI that catches an exception shows its text only through `displayErrorText`,
 * so a raw exception message (network, parser, runtime) never reaches the page.
 */
export class DisplayError extends Error {}

export function displayErrorText(cause: unknown, fallback: string): string {
  return cause instanceof DisplayError ? cause.message : fallback;
}
