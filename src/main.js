import { createClient } from "@supabase/supabase-js";
import "./style.css";

const $ = (id) => document.getElementById(id);
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url || "") && Boolean(key);
let client, session, current, requestDraft;
let refreshSequence = 0;

function notify(message, error = false) {
  $("notice").textContent = message;
  $("notice").className = error ? "notice error" : "notice";
  $("notice").hidden = !message;
}
// All account/module/contact content is inserted as text, never trusted HTML.
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action, className = "") {
  const node = el("button", text, className);
  node.addEventListener("click", () => work(node, action));
  return node;
}
async function work(target, action) {
  target.disabled = true;
  try {
    await action();
  } catch (error) {
    notify(error.message || "Something went wrong.", true);
  } finally {
    target.disabled = false;
  }
}
async function api(path, body) {
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) throw new Error("Please sign in again.");
  const response = await fetch(`${url}/functions/v1/portal/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${data.session.access_token}`,
      apikey: key,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(result.error || "The portal is temporarily unavailable. Try again later.");
  return result;
}
function clearPrivateView() {
  current = null;
  for (const id of [
    "modules",
    "requests",
    "queue",
    "policies",
    "account-email",
    "edit-module",
    "email-access-module",
    "email-access-list",
  ])
    $(id).replaceChildren();
  $("module-form").reset();
  $("email-access-form").reset();
  $("library").hidden = true;
  $("admin").hidden = true;
  $("ticket-url").value = "";
  $("ticket-dialog").close();
  $("request-dialog").close();
}
async function refresh() {
  const sequence = ++refreshSequence;
  if (!session) {
    clearPrivateView();
    $("auth").hidden = false;
    return;
  }
  $("auth").hidden = true;
  const result = await api("dashboard");
  if (sequence !== refreshSequence || !session) return;
  current = result;
  render();
}
function request(module, release, kind) {
  requestDraft = { moduleId: module.id, releaseId: release?.id, kind };
  $("request-title").textContent =
    `${kind === "access" ? "Access" : "Replacement"}: ${module.title}`;
  $("reason").value = "";
  $("request-dialog").showModal();
}
async function claim(release) {
  const result = await api("claim", { releaseId: release.id });
  $("ticket-url").value = result.manifestUrl;
  $("ticket-expiry").textContent =
    `Expires ${new Date(result.expiresAt).toLocaleString()}. One ZIP download; failed transfers also use the link.`;
  $("ticket-dialog").showModal();
  await refresh();
}
function render() {
  const { account, modules, releases, approvals, grants, requests, admin } = current;
  $("library").hidden = false;
  $("account-email").textContent = account.email;
  $("modules").replaceChildren();
  if (!modules.length) $("modules").append(el("p", "No modules have been published yet.", "empty"));
  for (const module of modules) {
    const card = el("article", undefined, "module-card");
    const approved = approvals.some((a) => a.module_id === module.id && a.active);
    card.append(
      el(
        "span",
        module.visibility === "public"
          ? "Public"
          : `${module.visibility === "secret" ? "Secret" : "Private"} · ${approved ? "Approved" : "Approval required"}`,
        `badge ${approved ? "approved" : ""}`,
      ),
      el("h3", module.title),
      el("p", module.id, "module-id"),
    );
    if (module.description) card.append(el("p", module.description));
    if (module.visibility === "public") {
      const input = el("input");
      input.readOnly = true;
      input.value = module.manifest_url;
      input.setAttribute("aria-label", `Public manifest URL for ${module.title}`);
      card.append(
        input,
        button("Copy manifest URL", async () => {
          try {
            await navigator.clipboard.writeText(input.value);
            notify("Manifest URL copied. Paste it into Foundry’s Install Module dialog.");
          } catch {
            input.focus();
            input.select();
            notify("Select and copy the manifest URL manually.");
          }
        }),
      );
      $("modules").append(card);
      continue;
    }
    const available = releases.filter((r) => r.module_id === module.id);
    const latest = available[0];
    card.append(
      el("p", latest ? `Latest release · v${latest.version}` : "No release available", "muted"),
    );
    if (!approved && module.visibility !== "secret") {
      const pending = requests.some(
        (r) => r.module_id === module.id && r.kind === "access" && r.status === "pending",
      );
      if (pending) card.append(el("p", "Your access request is awaiting review.", "muted"));
      else
        card.append(button("Request access", () => request(module, latest, "access"), "secondary"));
    } else if (approved && latest) {
      const select = el("select");
      select.setAttribute("aria-label", `Release of ${module.title}`);
      for (const release of available) {
        const option = el("option", `Version ${release.version}`);
        option.value = release.id;
        select.append(option);
      }
      const actions = el("div", undefined, "release-actions");
      function showActions() {
        const release = available.find((r) => r.id === select.value);
        const used = grants.filter((g) => g.release_id === release.id).length;
        const allowance =
          1 +
          requests.filter(
            (r) =>
              r.release_id === release.id && r.kind === "replacement" && r.status === "approved",
          ).length;
        const pending = requests.some(
          (r) => r.release_id === release.id && r.kind === "replacement" && r.status === "pending",
        );
        actions.replaceChildren(
          el(
            "p",
            account.unlimited_grants
              ? "Unlimited link allowance"
              : `${Math.max(0, allowance - used)} installation link${allowance - used === 1 ? "" : "s"} available`,
            "muted",
          ),
        );
        if (account.unlimited_grants || used < allowance)
          actions.append(button("Generate installation link", () => claim(release)));
        if (pending) actions.append(el("p", "Replacement request awaiting review.", "muted"));
        else if (used)
          actions.append(
            button("Request replacement", () => request(module, release, "replacement"), "quiet"),
          );
      }
      select.addEventListener("change", showActions);
      showActions();
      card.append(select, actions);
    }
    $("modules").append(card);
  }
  $("request-history").hidden = !requests.length;
  $("requests").replaceChildren();
  for (const r of requests)
    $("requests").append(
      el(
        "p",
        `${modules.find((m) => m.id === r.module_id)?.title || r.module_id} · ${r.kind} · ${r.status}`,
        "history-row",
      ),
    );
  $("admin").hidden = !admin;
  if (admin) renderAdmin(admin, modules);
}
function renderAdmin(admin, modules) {
  const editing = $("edit-module").value;
  $("edit-module").replaceChildren(new Option("Add a module", ""));
  $("email-access-module").replaceChildren();
  for (const module of modules) {
    $("edit-module").append(new Option(`${module.title} (${module.visibility})`, module.id));
    if (module.visibility !== "public")
      $("email-access-module").append(new Option(module.title, module.id));
  }
  $("edit-module").value = modules.some((m) => m.id === editing) ? editing : "";
  loadModuleForm();
  $("email-access-list").replaceChildren();
  for (const access of admin.emailAccess || []) {
    if (modules.find((m) => m.id === access.module_id)?.visibility === "public") continue;
    const row = el(
      "p",
      `${modules.find((m) => m.id === access.module_id)?.title || access.module_id} · ${access.email} · ${access.active ? "Granted" : "Revoked"} `,
    );
    row.append(
      button(
        access.active ? "Revoke" : "Grant",
        async () => {
          await api("admin/email-access", {
            moduleId: access.module_id,
            email: access.email,
            active: !access.active,
          });
          await refresh();
        },
        "quiet",
      ),
    );
    $("email-access-list").append(row);
  }
  $("queue").replaceChildren();
  $("policies").replaceChildren();
  if (!admin.queue.length) $("queue").append(el("p", "No pending requests.", "muted"));
  for (const r of admin.queue) {
    const row = el("article", undefined, "admin-row");
    const email = admin.accounts.find((a) => a.user_id === r.user_id)?.email || r.user_id;
    row.append(el("h4", `${email} · ${r.kind}`), el("p", r.module_id, "muted"), el("p", r.reason));
    for (const approve of [true, false])
      row.append(
        button(
          approve ? "Approve" : "Deny",
          async () => {
            await api("admin/decide", { requestId: r.id, approve });
            await refresh();
          },
          approve ? "secondary" : "quiet",
        ),
      );
    $("queue").append(row);
  }
  for (const account of admin.accounts) {
    const row = el("article", undefined, "admin-row");
    row.append(el("h4", account.email));
    const unlimited = el("input");
    unlimited.type = "checkbox";
    unlimited.checked = account.unlimited_grants;
    const label = el("label", undefined, "check-label");
    label.append(unlimited, document.createTextNode(" Unlimited release-link allowance"));
    unlimited.addEventListener("change", () =>
      work(unlimited, async () => {
        try {
          await api("admin/policy", { userId: account.user_id, unlimited: unlimited.checked });
          await refresh();
        } catch (error) {
          unlimited.checked = !unlimited.checked;
          throw error;
        }
      }),
    );
    row.append(label);
    for (const module of modules) {
      if (module.visibility === "public") continue;
      const policy = admin.policies.find(
        (p) => p.user_id === account.user_id && p.module_id === module.id,
      );
      const active = policy
        ? policy.active
        : (admin.emailAccess || []).some(
            (a) =>
              a.module_id === module.id &&
              a.email === account.email.trim().toLowerCase() &&
              a.active,
          );
      row.append(
        button(
          `${active ? "Revoke" : "Approve"} ${module.title}`,
          async () => {
            if (
              !window.confirm(
                `${active ? "Revoke" : "Approve"} access to ${module.title} for ${account.email}?`,
              )
            )
              return;
            await api("admin/policy", {
              userId: account.user_id,
              moduleId: module.id,
              active: !active,
            });
            await refresh();
          },
          "quiet",
        ),
      );
    }
    $("policies").append(row);
  }
}
function updateManifestField() {
  const isPublic = $("module-visibility").value === "public";
  $("module-manifest").disabled = !isPublic;
  $("module-manifest").required = isPublic;
}
function loadModuleForm() {
  const module = current?.modules.find((m) => m.id === $("edit-module").value);
  $("module-id").value = module?.id || "";
  $("module-id").readOnly = Boolean(module);
  $("module-title").value = module?.title || "";
  $("module-description").value = module?.description || "";
  $("module-visibility").value = module?.visibility || "private";
  $("module-manifest").value = module?.manifest_url || "";
  updateManifestField();
}
$("edit-module").addEventListener("change", loadModuleForm);
$("module-visibility").addEventListener("change", updateManifestField);
$("module-form").addEventListener("submit", (event) => {
  event.preventDefault();
  work(event.submitter, async () => {
    const existing = current.modules.find((m) => m.id === $("module-id").value.trim());
    if (
      existing &&
      existing.visibility !== $("module-visibility").value &&
      !window.confirm(
        `Change visibility of ${existing.title} to ${$("module-visibility").value}? Previously shared information cannot be recalled.`,
      )
    )
      return;
    await api("admin/module", {
      moduleId: $("module-id").value.trim(),
      title: $("module-title").value,
      description: $("module-description").value,
      visibility: $("module-visibility").value,
      manifestUrl: $("module-manifest").value.trim(),
    });
    notify("Module saved.");
    await refresh();
  });
});
$("email-access-form").addEventListener("submit", (event) => {
  event.preventDefault();
  work(event.submitter, async () => {
    await api("admin/email-access", {
      moduleId: $("email-access-module").value,
      email: $("email-access-address").value.trim(),
      active: true,
    });
    $("email-access-address").value = "";
    notify("Email access granted. The recipient must verify that address when signing in.");
    await refresh();
  });
});
for (const node of document.querySelectorAll(".close-dialog"))
  node.addEventListener("click", () => node.closest("dialog").close());
$("ticket-dialog").addEventListener("close", () => {
  $("ticket-url").value = "";
});
$("copy-ticket").addEventListener("click", () =>
  work($("copy-ticket"), async () => {
    try {
      await navigator.clipboard.writeText($("ticket-url").value);
      notify("Link copied. Paste it into Foundry’s Install Module dialog.");
    } catch {
      $("ticket-url").focus();
      $("ticket-url").select();
      notify("Select and copy the link manually.");
    }
  }),
);
$("request-form").addEventListener("submit", (event) => {
  event.preventDefault();
  work(event.submitter, async () => {
    await api("request", { ...requestDraft, reason: $("reason").value });
    $("request-dialog").close();
    notify("Request sent. An administrator will review it.");
    await refresh();
  });
});
$("refresh").addEventListener("click", () => work($("refresh"), refresh));
$("signout").addEventListener("click", () =>
  work($("signout"), async () => {
    const { error } = await client.auth.signOut();
    if (error) throw error;
    session = null;
    ++refreshSequence;
    clearPrivateView();
    $("auth").hidden = false;
    notify("Signed out.");
  }),
);
if (!configured) {
  $("setup").hidden = false;
} else {
  client = createClient(url, key, {
    auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true },
  });
  $("signin").addEventListener("submit", (event) => {
    event.preventDefault();
    work(event.submitter, async () => {
      const { error } = await client.auth.signInWithOtp({
        email: $("email").value.trim(),
        options: { emailRedirectTo: `${window.location.origin}${import.meta.env.BASE_URL}` },
      });
      if (error) throw error;
      notify(
        "Check your email for a sign-in link. Open it in this same browser to finish signing in.",
      );
    });
  });
  client.auth.onAuthStateChange((_event, next) => {
    const changed = session?.user.id !== next?.user.id;
    session = next;
    if (changed || !next) clearPrivateView();
    // SDK callbacks run inside an auth lock; defer further auth calls.
    setTimeout(
      () =>
        refresh().catch((error) => {
          notify(error.message, true);
          if (!current) {
            $("auth").hidden = false;
          }
        }),
      0,
    );
  });
}
