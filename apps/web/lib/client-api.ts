"use client";

/** Browser-side mutation helper — same-origin /api proxy, uniform error shape. */
export async function clientApi<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const payload = (await res.json().catch(() => null)) as
      | ({ error?: { message?: string } } & T)
      | null;
    if (!res.ok) {
      return {
        ok: false,
        message: payload?.error?.message ?? `request failed (${res.status})`,
      };
    }
    return { ok: true, data: payload as T };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "control plane unreachable",
    };
  }
}
