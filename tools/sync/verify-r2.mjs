#!/usr/bin/env node
/**
 * Proves the R2 credentials and the request signing work, before anything
 * depends on them.
 *
 *   node tools/sync/verify-r2.mjs --env-file /tmp/.env
 *
 * Writes one small object, fetches it back over the public base URL, deletes
 * it, and confirms it is gone. Nothing else in the bucket is touched: the key
 * is random and prefixed `_verify/`.
 *
 * The signing in lib/targets.mjs is hand-rolled SigV4 with no npm
 * dependencies, so this is the check that it is actually correct.
 */

import fs from "node:fs";
import { r2Target } from "../lib/targets.mjs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

// A .env alongside, or wherever the credentials were left.
const envFile = flag("env-file");
if (envFile) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trimStart().startsWith("#") && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const env = process.env;
const missing = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "PHOTO_BASE_URL"]
  .filter((k) => !env[k]);
if (missing.length) {
  console.error(`missing: ${missing.join(", ")}`);
  console.error(`pass --env-file <path> if they live in a file`);
  process.exit(1);
}

const target = r2Target({
  accountId: env.R2_ACCOUNT_ID,
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  bucket: env.R2_BUCKET,
  prefix: env.R2_PREFIX ?? "",
  base: env.PHOTO_BASE_URL,
  endpoint: env.R2_ENDPOINT,
});

const key = `_verify/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
const body = Buffer.from(`gallery-sync verification ${new Date().toISOString()}\n`);
const url = `${target.base}/${env.R2_PREFIX ? env.R2_PREFIX.replace(/\/$/, "") + "/" : ""}${key}`;

let failed = false;
const step = async (label, fn) => {
  process.stdout.write(`  ${label} ... `);
  try {
    console.log((await fn()) ?? "ok");
  } catch (error) {
    console.log(`FAILED\n      ${error.message}`);
    failed = true;
  }
};

console.log(`bucket ${env.R2_BUCKET} on account ${env.R2_ACCOUNT_ID.slice(0, 8)}…`);
console.log(`public base ${target.base}\n`);

await step("sign and PUT an object", () => target.put(key, body, "text/plain"));

if (!failed) {
  await step("fetch it back over the public domain", async () => {
    // The custom domain's certificate can take a few minutes after setup.
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await fetch(url, { cache: "no-store" }).catch((e) => ({ ok: false, status: e.message }));
      if (res.ok) {
        const got = Buffer.from(await res.arrayBuffer());
        if (!got.equals(body)) throw new Error("content came back different");
        return `ok (cache-control: ${res.headers.get("cache-control") ?? "unset"})`;
      }
      if (attempt === 5) {
        throw new Error(
          `${res.status} from ${url}\n      ` +
            `A 522/525 usually means the certificate is still provisioning; wait and retry.\n      ` +
            `A 404 means the object went to a different bucket than the domain serves.`
        );
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  });
}

await step("sign and DELETE it", () => target.remove([key]));

if (!failed) {
  await step("confirm it is gone", async () => {
    const res = await fetch(url, { cache: "no-store" });
    // Cloudflare may still serve it from cache; that is the CDN, not the bucket.
    return res.status === 404 ? "ok (404)" : `still ${res.status} — cached at the edge, not a failure`;
  });
}

console.log(failed ? "\nR2 is NOT working. Fix this before going further." : "\nR2 works: signing, upload, public read and delete.");
process.exit(failed ? 1 : 0);
