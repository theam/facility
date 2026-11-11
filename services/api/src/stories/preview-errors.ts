export class PreviewConvergenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PreviewConvergenceError";
  }
}
