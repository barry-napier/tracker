// The Electron main process passes the Hono server's URL as a query param;
// the fallback serves `vite dev` against a separately started server.
const params = new URLSearchParams(window.location.search);
export const apiBase = params.get("apiBase") ?? "http://127.0.0.1:4400";

export async function apiGet<T>(route: string): Promise<T> {
  const res = await fetch(`${apiBase}${route}`);
  if (!res.ok) throw new Error(`GET ${route} → ${res.status}`);
  return (await res.json()) as T;
}

export async function apiPost<T>(route: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiBase}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${route} → ${res.status}`);
  return (await res.json()) as T;
}
