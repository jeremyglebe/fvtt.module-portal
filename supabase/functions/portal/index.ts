import { createHandler } from "./core.ts";

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const origin = Deno.env.get("PORTAL_ORIGIN");
if (!url || !key || !origin)
  throw new Error("Portal configuration missing. Set PORTAL_ORIGIN before deploying.");
Deno.serve(createHandler({ url, key, origin }));
