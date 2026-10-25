export function rewriteRequest(request: Request, prefix: "/api"): Request | null {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${prefix}/`)) return null;
  url.pathname = url.pathname.slice(prefix.length);
  return new Request(url, request);
}

/** Trusted page origins are configured by the host, never reflected indiscriminately. */
export async function withPageBoundary(
  request: Request,
  origins: ReadonlySet<string>,
  next: () => Response | Promise<Response>,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && !origins.has(origin)) return new Response(null, { status: 403 });
  if (request.method === "OPTIONS") {
    const method = request.headers.get("access-control-request-method");
    const headers =
      request.headers
        .get("access-control-request-headers")
        ?.toLowerCase()
        .split(",")
        .map((item) => item.trim()) ?? [];
    if (
      !origin ||
      !["GET", "POST"].includes(method ?? "") ||
      headers.some((header) => header !== "content-type")
    )
      return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "Content-Type",
        Vary: "Origin",
      },
    });
  }
  const response = await next();
  if (!origin) return response;
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("Access-Control-Allow-Origin", origin);
  responseHeaders.set("Vary", "Origin");
  responseHeaders.set(
    "Access-Control-Expose-Headers",
    [...responseHeaders.keys()].filter((name) => name !== "set-cookie").join(", "),
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}
