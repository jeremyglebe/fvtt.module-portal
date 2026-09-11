import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migration = await readFile(
  new URL("../supabase/migrations/202609110001_portal.sql", import.meta.url),
  "utf8",
);
const user = "11111111-1111-4111-8111-111111111111";
const admin = "22222222-2222-4222-8222-222222222222";
const hash = (n) => n.toString(16).padStart(64, "0");

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key, email_confirmed_at timestamptz, banned_until timestamptz);
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  `);
  await db.exec(migration);
  await db.query("insert into auth.users(id,email_confirmed_at) values ($1,now()),($2,now())", [
    user,
    admin,
  ]);
  await db.query(
    "insert into public.portal_accounts(user_id,email,is_admin) values($1,$3,false),($2,$4,true)",
    [user, admin, "friend@example.com", "owner@example.com"],
  );
  const manifest = {
    id: "test-module",
    title: "Test module",
    version: "1.0.0",
    manifest: "https://example.com/module.json",
  };
  const release = (
    await db.query("select public.portal_publish($1,$2,$3,$4,$5) as id", [
      manifest,
      manifest,
      "test-module/1.0.0/module.zip",
      hash(999),
      100,
    ])
  ).rows[0].id;
  return {
    db,
    release,
    async approve() {
      await db.query("insert into public.portal_approvals(user_id,module_id) values($1,$2)", [
        user,
        "test-module",
      ]);
    },
  };
}
test("schema denies direct browser access and service RPC execution", async () => {
  const { db } = await fixture();
  try {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query("select * from public.portal_grants"), /permission denied/);
      await assert.rejects(
        db.query("select public.portal_ticket($1,false)", [hash(1)]),
        /permission denied/,
      );
      await assert.rejects(
        db.query("update public.portal_accounts set is_admin=true"),
        /permission denied/,
      );
      await assert.rejects(
        db.query("select public.portal_issue($1,$2,$3)", [user, admin, hash(1)]),
        /permission denied/,
      );
      await db.exec("reset role");
    }
    const bucket = (await db.query("select * from storage.buckets")).rows[0];
    assert.equal(bucket.public, false);
  } finally {
    await db.close();
  }
});
test("approval, atomic allowance, repeated manifest reads and one redemption", async () => {
  const { db, release, approve } = await fixture();
  try {
    await assert.rejects(
      db.query("select public.portal_issue($1,$2,$3)", [user, release, hash(1)]),
      /Approval required/,
    );
    await approve();
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map((n) =>
        db.query("select public.portal_issue($1,$2,$3)", [user, release, hash(n)]),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const grant = (await db.query("select * from public.portal_grants")).rows[0];
    assert.notEqual(grant.token_hash, null);
    await db.query("select public.portal_ticket($1,false)", [grant.token_hash]);
    await db.query("select public.portal_ticket($1,false)", [grant.token_hash]);
    const downloads = await Promise.allSettled(
      [true, true].map(() => db.query("select public.portal_ticket($1,true)", [grant.token_hash])),
    );
    assert.equal(downloads.filter((r) => r.status === "fulfilled").length, 1);
    await assert.rejects(
      db.query("select public.portal_ticket($1,false)", [grant.token_hash]),
      /expired or already used/,
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int as n from public.portal_audit where action='grant-redeemed'",
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await db.close();
  }
});
test("replacement decisions grant exactly one additional allowance and require admin", async () => {
  const { db, release, approve } = await fixture();
  try {
    await approve();
    await db.query("select public.portal_issue($1,$2,$3)", [user, release, hash(1)]);
    const req = (
      await db.query("select public.portal_request($1,$2,$3,$4,$5) as id", [
        user,
        "test-module",
        release,
        "replacement",
        "My download failed during transfer.",
      ])
    ).rows[0].id;
    await assert.rejects(
      db.query("select public.portal_decide($1,$2,true)", [user, req]),
      /Administrator required/,
    );
    await assert.rejects(
      db.query("select public.portal_issue($1,$2,$3)", [user, release, hash(2)]),
      /Allowance used/,
    );
    await db.query("select public.portal_decide($1,$2,true)", [admin, req]);
    await assert.rejects(
      db.query("select public.portal_decide($1,$2,true)", [admin, req]),
      /already resolved/,
    );
    await db.query("select public.portal_issue($1,$2,$3)", [user, release, hash(2)]);
    await assert.rejects(
      db.query("select public.portal_issue($1,$2,$3)", [user, release, hash(3)]),
      /Allowance used/,
    );
  } finally {
    await db.close();
  }
});
test("expiry, revocation, bans and unconfirmed email block outstanding tickets", async () => {
  const { db, release, approve } = await fixture();
  try {
    await approve();
    await db.query("select public.portal_issue($1,$2,$3)", [user, release, hash(1)]);
    await db.exec("update public.portal_approvals set active=false");
    await assert.rejects(
      db.query("select public.portal_ticket($1,false)", [hash(1)]),
      /Approval revoked/,
    );
    await db.exec("update public.portal_approvals set active=true");
    await db.query("update auth.users set email_confirmed_at=null where id=$1", [user]);
    await assert.rejects(
      db.query("select public.portal_ticket($1,true)", [hash(1)]),
      /Account unavailable/,
    );
    await db.query(
      "update auth.users set email_confirmed_at=now(),banned_until=now()+interval '1 day' where id=$1",
      [user],
    );
    await assert.rejects(
      db.query("select public.portal_ticket($1,true)", [hash(1)]),
      /Account unavailable/,
    );
    await db.query("update auth.users set banned_until=null where id=$1", [user]);
    await db.exec("update public.portal_grants set expires_at=now()-interval '1 minute'");
    await assert.rejects(
      db.query("select public.portal_ticket($1,true)", [hash(1)]),
      /expired or already used/,
    );
    await assert.rejects(
      db.query("select public.portal_issue($1,$2,$3)", [user, release, hash(2)]),
      /Allowance used/,
    );
  } finally {
    await db.close();
  }
});
test("unlimited accounts do not bypass approvals; release identity is immutable", async () => {
  const { db, release, approve } = await fixture();
  try {
    await db.query("select public.portal_set_policy($1,$2,null,null,true)", [admin, user]);
    await assert.rejects(
      db.query("select public.portal_issue($1,$2,$3)", [user, release, hash(1)]),
      /Approval required/,
    );
    await approve();
    for (const n of [1, 2, 3])
      await db.query("select public.portal_issue($1,$2,$3)", [user, release, hash(n)]);
    assert.equal(
      (await db.query("select count(*)::int as n from public.portal_grants")).rows[0].n,
      3,
    );
    const manifest = { id: "test-module", title: "Test", version: "1.0.0" };
    await assert.rejects(
      db.query("select public.portal_publish($1,$2,$3,$4,$5)", [
        manifest,
        manifest,
        "test-module/1.0.0/module.zip",
        hash(900),
        120,
      ]),
      /duplicate key/,
    );
  } finally {
    await db.close();
  }
});
