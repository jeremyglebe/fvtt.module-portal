import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (key) {
    let legacyRole;
    try {
      legacyRole = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString()).role;
    } catch {
      /* Not a legacy JWT. */
    }
    if (!key.startsWith("sb_publishable_") && legacyRole !== "anon") {
      throw new Error("Only a Supabase publishable or legacy anon key may enter the public build.");
    }
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(env.VITE_SUPABASE_URL || ""))
      throw new Error("Set a valid hosted Supabase URL.");
  } else if (env.VITE_SUPABASE_URL)
    throw new Error("Set both public Supabase configuration values, or leave both blank.");
  return {
    base: env.VITE_BASE_PATH || "/fvtt.module-portal/",
    build: { sourcemap: false },
    // Vite development injects style tags and uses a WebSocket; production retains the strict CSP.
    plugins:
      command === "serve"
        ? [
            {
              name: "local-development-csp",
              transformIndexHtml: {
                order: "pre",
                handler: (html) =>
                  html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ""),
              },
            },
          ]
        : [],
  };
});
