// The Electron main process passes the Hono server's URL as a query param;
// the fallback serves `vite dev` against a separately started server.
const params = new URLSearchParams(window.location.search);
export const apiBase = params.get("apiBase") ?? "http://127.0.0.1:4400";

/**
 * A non-2xx API answer with its body intact: the message is the server's own
 * error text, and structured fields (e.g. the verdict route's `drift`
 * reasons) stay readable without parsing prose.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function throwApiError(method: string, route: string, res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const message =
    typeof body.error === "string" ? body.error : `${method} ${route} → ${res.status}`;
  throw new ApiError(message, res.status, body);
}

export async function apiGet<T>(route: string): Promise<T> {
  const res = await fetch(`${apiBase}${route}`);
  if (!res.ok) await throwApiError("GET", route, res);
  return (await res.json()) as T;
}

export async function apiPost<T>(route: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiBase}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwApiError("POST", route, res);
  return (await res.json()) as T;
}
