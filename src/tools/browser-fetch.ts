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
  body?: unknown,
  clientName?: string,
  toolName?: string
): Promise<BrowserFetchResult> {
  const url = `${browserUrl.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    ...(clientName ? { "x-mcp-client-name": clientName } : {}),
    ...(toolName ? { "x-mcp-tool": toolName } : {}),
  };
  const init: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const response = await fetch(url, init);
  let data: unknown;
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  // Errors come back as application/problem+json (e.g. 402 AUTH014), so match any JSON type.
  data = text;
  if (text && /[/+]json\b/.test(contentType)) {
    try {
      data = JSON.parse(text);
    } catch {
      // keep the raw text
    }
  }

  return { ok: response.ok, status: response.status, data };
}

export function browserError(result: BrowserFetchResult): string {
  if (typeof result.data === "object" && result.data !== null && "error" in result.data) {
    return String((result.data as { error: unknown }).error);
  }
  if (typeof result.data === "object" && result.data !== null && "code" in result.data) {
    const d = result.data as { code: unknown; detail?: unknown; title?: unknown };
    return `HTTP ${result.status} (${String(d.code)}): ${String(d.detail ?? d.title ?? "")}`.trim();
  }
  if (typeof result.data === "string" && result.data.trim()) {
    return `HTTP ${result.status}: ${result.data.trim().slice(0, 300)}`;
  }
  return `HTTP ${result.status}`;
}
