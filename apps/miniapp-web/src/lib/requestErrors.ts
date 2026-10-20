export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.name = 'ApiError'; this.status = status; }
}
export function retryableWriteError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && error.name === 'AbortError') ||
    (error instanceof ApiError && [408, 429, 500, 502, 503, 504].includes(error.status));
}
export async function withRequestDeadline<T>(action: (signal: AbortSignal) => Promise<T>, milliseconds = 15000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), milliseconds);
  try { return await action(controller.signal); } finally { clearTimeout(timeout); }
}
