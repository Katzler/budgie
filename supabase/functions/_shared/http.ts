export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

export function handle(fn: (req: Request) => Promise<Response>) {
  return async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    try {
      return await fn(req);
    } catch (e) {
      console.error(e);
      const status = e instanceof HttpError ? e.status : 500;
      return json({ error: e instanceof Error ? e.message : String(e) }, status);
    }
  };
}

/** Användarens IP och webbläsare, så att banken vet att någon aktivt använder appen. */
export function psuFrom(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim();
  const userAgent = req.headers.get("user-agent");
  return ip && userAgent ? { ip, userAgent } : undefined;
}
