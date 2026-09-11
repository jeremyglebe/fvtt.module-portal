import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export function publishingSettings(env) {
  const base = env.SUPABASE_URL?.replace(/\/$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!base || !key || key === "YOUR_SERVICE_ROLE_KEY") {
    const project = /^https:\/\/([a-z0-9-]+)\.supabase\.co$/.exec(base || "")?.[1];
    const dashboard = project
      ? `https://supabase.com/dashboard/project/${project}/settings/api-keys`
      : "https://supabase.com/dashboard (select your project, then Settings > API Keys)";
    throw new Error(
      [
        "Missing Supabase publishing configuration.",
        "Set SUPABASE_URL in .env.repo and SUPABASE_SERVICE_ROLE_KEY in ignored .env.local (or the release environment).",
        "To obtain the credential for the current uploader:",
        `1. Open ${dashboard}`,
        "2. Open Legacy anon, service_role API keys; reveal and copy service_role, NOT anon or the public publishable key.",
        "3. In your module project's .env.local, add SUPABASE_SERVICE_ROLE_KEY=<copied value>.",
        "4. Rerun npm run release, or node scripts/init/configure-release-publishing.mjs if initialization was interrupted. The standalone portal uploader requires these variables in its shell environment instead.",
        "This is one-time setup, NOT a single-use key. Reuse it for every release until it is rotated, revoked, or expires.",
        "Never commit the key, share it with players, or put it in the public site or a VITE_ variable.",
        "Full instructions: docs/releases/Authenticated Site.md (Getting the publishing credential), or distribution-site/README.md.",
      ].join("\n"),
    );
  }
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base))
    throw new Error("Expected your hosted Supabase project URL.");
  return { base, key };
}

// Never include response bodies, credentials, or underlying fetch errors in release logs.
async function request(fetcher, url, options) {
  try {
    return await fetcher(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new Error(
      "Portal request failed or timed out. Retry initialization or the same unchanged release to resume safely.",
    );
  }
}

// Create with the intended visibility in one insert: never briefly create a private listing
// for a secret module. Duplicate IDs do not overwrite existing visibility, metadata, or grants.
export async function registerModule({ module, visibility, env = process.env, fetcher = fetch }) {
  const { base, key } = publishingSettings(env);
  if (!["private", "secret"].includes(visibility))
    throw new Error(
      "AUTHENTICATED_SITE_VISIBILITY must be private or secret. Public modules use their GitHub manifest.",
    );
  if (
    !module ||
    typeof module.id !== "string" ||
    !/^[a-z0-9][a-z0-9-]*$/.test(module.id) ||
    typeof module.title !== "string" ||
    !module.title.trim() ||
    module.title.length > 200 ||
    (module.description !== undefined &&
      (typeof module.description !== "string" || module.description.length > 2000))
  )
    throw new Error(
      "Module registration requires a valid ID, a title of 1–200 characters, and a description of at most 2000 characters.",
    );
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const result = await request(fetcher, `${base}/rest/v1/portal_modules?on_conflict=id`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify({
      id: module.id,
      title: module.title,
      description: module.description ?? "",
      visibility,
      manifest_url: null,
    }),
  });
  if (!result.ok)
    throw new Error(
      `Module registration failed (${result.status}). Check backend deployment and publishing credentials; initialization is not complete.`,
    );
  const confirmation = await request(
    fetcher,
    `${base}/rest/v1/portal_modules?id=eq.${module.id}&select=id,visibility,manifest_url`,
    { headers },
  );
  if (!confirmation.ok)
    throw new Error(
      `Module registration could not be confirmed (${confirmation.status}). Retry with the same module ID and visibility.`,
    );
  let rows;
  try {
    rows = await confirmation.json();
  } catch {
    throw new Error(
      "Module registration returned an invalid response; registration is not confirmed.",
    );
  }
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    rows[0]?.id !== module.id ||
    !["public", "private", "secret"].includes(rows[0]?.visibility)
  )
    throw new Error(
      "Module registration returned an invalid response; registration is not confirmed.",
    );
  if (rows[0].visibility !== visibility || rows[0].manifest_url !== null)
    throw new Error(
      "This module ID already has different portal visibility. No existing settings were changed. Choose another ID, or explicitly reconcile Administration > Module settings with AUTHENTICATED_SITE_VISIBILITY before retrying.",
    );
  return { moduleId: module.id, visibility };
}

export function validateRelease(metadata, manifest, notice, zip, base) {
  if (
    metadata.schemaVersion !== 1 ||
    !/^[a-z0-9][a-z0-9-]*$/.test(metadata.moduleId) ||
    !/^\d+\.\d+\.\d+$/.test(metadata.version)
  )
    throw new Error("Invalid release identity or schema.");
  const path = `${metadata.moduleId}/${metadata.version}/module.zip`;
  if (
    metadata.storagePath !== path ||
    manifest.id !== metadata.moduleId ||
    manifest.version !== metadata.version ||
    notice.id !== metadata.moduleId ||
    notice.version !== metadata.version
  )
    throw new Error("Release files do not share the same identity.");
  if (zip.length > 50 * 1024 * 1024)
    throw new Error(
      "This portal limits ZIPs to 50 MiB. Test larger delivery separately before changing this limit.",
    );
  if (
    zip.length !== metadata.bytes ||
    createHash("sha256").update(zip).digest("hex") !== metadata.sha256
  )
    throw new Error("ZIP integrity check failed.");
  const expected = `${base}/functions/v1/portal/public/${metadata.moduleId}/module.json`;
  if (
    metadata.manifestUrl !== expected ||
    manifest.manifest !== expected ||
    notice.manifest !== expected
  )
    throw new Error(
      `Configure AUTHENTICATED_SITE_MANIFEST_URL=${expected} and rebuild the release.`,
    );
  for (const value of [manifest, notice])
    if ("download" in value || value.protected || value.exclusive)
      throw new Error("Persistent manifests must not contain download links or premium flags.");
  const publicKeys = ["id", "title", "description", "version", "compatibility", "url", "manifest"];
  if (Object.keys(notice).some((key) => !publicKeys.includes(key)))
    throw new Error("Unexpected fields in public notification manifest.");
  return path;
}
export async function publishRelease({ directory, env = process.env, fetcher = fetch }) {
  const { base, key } = publishingSettings(env);
  if (!directory) throw new Error("A release artifact directory is required.");
  const json = async (path) => JSON.parse(await readFile(resolve(directory, path), "utf8"));
  const [metadata, manifest, notice, zip] = await Promise.all([
    json("private/release.json"),
    json("private/module.json"),
    json("public/module.json"),
    readFile(resolve(directory, "private/module.zip")),
  ]);
  const path = validateRelease(metadata, manifest, notice, zip, base);
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const existing = await request(
    fetcher,
    `${base}/rest/v1/portal_releases?module_id=eq.${metadata.moduleId}&version=eq.${metadata.version}&select=storage_path,sha256,bytes,manifest,public_manifest,published`,
    { headers },
  );
  if (!existing.ok)
    throw new Error(
      `Catalog preflight failed (${existing.status}). Check backend deployment and credentials.`,
    );
  const rows = await existing.json();
  if (rows.length) {
    const release = rows[0];
    if (
      rows.length === 1 &&
      release.published &&
      release.storage_path === path &&
      release.sha256 === metadata.sha256 &&
      Number(release.bytes) === metadata.bytes &&
      isDeepStrictEqual(release.manifest, manifest) &&
      isDeepStrictEqual(release.public_manifest, notice)
    )
      return {
        moduleId: metadata.moduleId,
        version: metadata.version,
        manifestUrl: metadata.manifestUrl,
        alreadyPublished: true,
      };
    throw new Error(
      "That version already exists with different content or is unpublished. Releases are immutable; choose a new version.",
    );
  }
  // Never upsert. Recover an interrupted upload only after verifying the stored bytes.
  const upload = await request(fetcher, `${base}/storage/v1/object/module-releases/${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/zip", "x-upsert": "false" },
    body: zip,
  });
  if (!upload.ok) {
    if (![400, 409].includes(upload.status))
      throw new Error(
        `Private upload failed (${upload.status}). No catalog publication was attempted.`,
      );
    const stored = await request(
      fetcher,
      `${base}/storage/v1/object/authenticated/module-releases/${path}`,
      { headers },
    );
    if (!stored.ok)
      throw new Error(
        `Private upload failed (${upload.status}); could not verify an existing object.`,
      );
    const bytes = Buffer.from(await stored.arrayBuffer());
    if (
      bytes.length !== metadata.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== metadata.sha256
    )
      throw new Error(
        "An existing private object has different content. Choose a new version; no overwrite was performed.",
      );
  }
  const registration = await request(fetcher, `${base}/rest/v1/rpc/portal_publish`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      p_manifest: manifest,
      p_public: notice,
      p_path: path,
      p_sha: metadata.sha256,
      p_bytes: metadata.bytes,
    }),
  });
  if (!registration.ok)
    throw new Error(
      `Catalog publication failed (${registration.status}). Retry the same unchanged release; the private upload will be verified and reused.`,
    );
  return {
    moduleId: metadata.moduleId,
    version: metadata.version,
    manifestUrl: metadata.manifestUrl,
    alreadyPublished: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  publishRelease({ directory: process.argv[2] })
    .then((result) => {
      console.log(
        `${result.alreadyPublished ? "Already published" : "Published"} ${result.moduleId} v${result.version}.`,
      );
      console.log(`Public notification manifest: ${result.manifestUrl}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
