export interface BrowserFetchResult {
  ok: boolean;
  status: number;
  data: unknown;
}

const REQUEST_TIMEOUT_MS = 35_000;

export async function browserFetch(
  method: string,
  path: string,
  apiKey: string,
  browserUrl: string,
  body?: unknown
): Promise<BrowserFetchResult> {
  const url = `${browserUrl.replace(/\/$/, "")}${path}`;
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const response = await fetch(url, init);
  let data: unknown;
  const contentType = response.headers.get("content-type") ?? "";
  data = contentType.includes("application/json") ? await response.json() : await response.text();

  return { ok: response.ok, status: response.status, data };
}

export function browserError(result: BrowserFetchResult): string {
  if (typeof result.data === "object" && result.data !== null && "error" in result.data) {
    return String((result.data as { error: unknown }).error);
  }
  return `HTTP ${result.status}`;
}
