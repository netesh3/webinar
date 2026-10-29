// Object stores for publish.mjs. All expose the same small async interface:
//   head(key)                         -> { size, metadata } | null
//   getText(key)                      -> string | null
//   putFile(key, path, opts)          opts: { contentType, cacheControl, metadata }
//   putText(key, text, opts)
//   copy(srcKey, dstKey, opts)        server-side copy, headers and metadata replaced
//
// AwsStore    Cloudflare R2 through the AWS CLI (S3 API, region auto).
// DirStore    a local directory standing in for the bucket (tests, --fake-bucket).
// DryRunStore reads through to another store (or nothing) and only logs writes.

import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { fileInfo } from "./lib.mjs";

const run = promisify(execFile);

const isNotFound = (err) =>
  /\(404\)|NoSuchKey|Not Found|not found|does not exist/i.test(`${err?.stderr ?? ""} ${err?.message ?? ""}`);

export class AwsStore {
  constructor({ bucket, endpoint, aws = "aws" }) {
    if (!bucket) throw new Error("bucket is required");
    if (!endpoint) throw new Error("endpoint is required (R2_DOWNLOADS_ACCOUNT_ID)");
    this.bucket = bucket;
    this.endpoint = endpoint;
    this.aws = aws;
  }

  async #s3api(args) {
    const env = {
      ...process.env,
      AWS_DEFAULT_REGION: "auto",
      AWS_REGION: "auto",
      // AWS CLI 2.23+ sends CRC checksums by default; R2 wants them only when required.
      AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
      AWS_RESPONSE_CHECKSUM_VALIDATION: "when_required",
      AWS_PAGER: "",
    };
    const { stdout } = await run(
      this.aws,
      ["s3api", ...args, "--bucket", this.bucket, "--endpoint-url", this.endpoint, "--output", "json"],
      { env, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout;
  }

  #headerArgs({ contentType, cacheControl, metadata }) {
    const args = [];
    if (contentType) args.push("--content-type", contentType);
    if (cacheControl) args.push("--cache-control", cacheControl);
    if (metadata && Object.keys(metadata).length) args.push("--metadata", JSON.stringify(metadata));
    return args;
  }

  async head(key) {
    try {
      const out = JSON.parse(await this.#s3api(["head-object", "--key", key]));
      return { size: Number(out.ContentLength), metadata: out.Metadata ?? {} };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async getText(key) {
    const dir = await mkdtemp(join(tmpdir(), "downloads-"));
    const file = join(dir, "object");
    try {
      await this.#s3api(["get-object", "--key", key, file]);
      return await readFile(file, "utf8");
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async putFile(key, path, opts = {}) {
    await this.#s3api(["put-object", "--key", key, "--body", path, ...this.#headerArgs(opts)]);
  }

  async putText(key, text, opts = {}) {
    const dir = await mkdtemp(join(tmpdir(), "downloads-"));
    const file = join(dir, "body");
    try {
      await writeFile(file, text);
      await this.putFile(key, file, opts);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async copy(srcKey, dstKey, opts = {}) {
    await this.#s3api([
      "copy-object",
      "--key",
      dstKey,
      "--copy-source",
      `${this.bucket}/${srcKey}`,
      "--metadata-directive",
      "REPLACE",
      ...this.#headerArgs(opts),
    ]);
  }
}

/** Cloudflare R2 through `wrangler r2 object` (OAuth). Used on this Mac when the S3 API keys
 *  are not in the environment. Custom object metadata is not available, so `head` hashes the
 *  downloaded bytes. */
export class WranglerR2Store {
  constructor({ bucket }) {
    if (!bucket) throw new Error("bucket is required");
    this.bucket = bucket;
  }

  async #wrangler(args) {
    try {
      const { stdout, stderr } = await run("npx", ["--yes", "wrangler@4", ...args, "--remote"], {
        cwd: tmpdir(),
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, CI: "1" },
      });
      return { stdout, stderr };
    } catch (err) {
      const detail = `${err.stderr ?? ""} ${err.stdout ?? ""} ${err.message ?? ""}`;
      err.message = detail.trim() || err.message;
      throw err;
    }
  }

  #objectPath(key) {
    return `${this.bucket}/${key}`;
  }

  async head(key) {
    const dir = await mkdtemp(join(tmpdir(), "r2-head-"));
    const file = join(dir, "object");
    try {
      await this.#wrangler(["r2", "object", "get", this.#objectPath(key), "--file", file]);
      const info = await fileInfo(file);
      return { size: info.size, metadata: { sha256: info.sha256 } };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async getText(key) {
    const dir = await mkdtemp(join(tmpdir(), "r2-get-"));
    const file = join(dir, "object");
    try {
      await this.#wrangler(["r2", "object", "get", this.#objectPath(key), "--file", file]);
      return await readFile(file, "utf8");
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async putFile(key, path, opts = {}) {
    const args = ["r2", "object", "put", this.#objectPath(key), "--file", path, "-y"];
    if (opts.contentType) args.push("--content-type", opts.contentType);
    if (opts.cacheControl) args.push("--cache-control", opts.cacheControl);
    await this.#wrangler(args);
  }

  async putText(key, text, opts = {}) {
    const dir = await mkdtemp(join(tmpdir(), "r2-put-"));
    const file = join(dir, "body");
    try {
      await writeFile(file, text);
      await this.putFile(key, file, opts);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async copy(srcKey, dstKey, opts = {}) {
    const dir = await mkdtemp(join(tmpdir(), "r2-copy-"));
    const file = join(dir, "object");
    try {
      await this.#wrangler(["r2", "object", "get", this.#objectPath(srcKey), "--file", file]);
      await this.putFile(dstKey, file, opts);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** A directory as a bucket. Headers and metadata go to <root>/.meta/<key>.json. */
export class DirStore {
  constructor(root) {
    this.root = root;
  }

  #path(key) {
    if (key.split("/").some((p) => p === ".." || p === "")) throw new Error(`bad key ${key}`);
    return join(this.root, key);
  }
  #metaPath(key) {
    return join(this.root, ".meta", `${key}.json`);
  }
  async #writeMeta(key, opts) {
    const path = this.#metaPath(key);
    await mkdir(dirname(path), { recursive: true });
    const { size } = await stat(this.#path(key));
    await writeFile(
      path,
      JSON.stringify({
        size,
        contentType: opts.contentType ?? null,
        cacheControl: opts.cacheControl ?? null,
        metadata: opts.metadata ?? {},
      }),
    );
  }

  async headers(key) {
    try {
      return JSON.parse(await readFile(this.#metaPath(key), "utf8"));
    } catch {
      return null;
    }
  }

  async head(key) {
    const h = await this.headers(key);
    return h ? { size: h.size, metadata: h.metadata } : null;
  }

  async getText(key) {
    try {
      return await readFile(this.#path(key), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  async putFile(key, path, opts = {}) {
    await mkdir(dirname(this.#path(key)), { recursive: true });
    await copyFile(path, this.#path(key));
    await this.#writeMeta(key, opts);
  }

  async putText(key, text, opts = {}) {
    await mkdir(dirname(this.#path(key)), { recursive: true });
    await writeFile(this.#path(key), text);
    await this.#writeMeta(key, opts);
  }

  async copy(srcKey, dstKey, opts = {}) {
    await this.putFile(dstKey, this.#path(srcKey), opts);
  }
}

/** Reads go to `inner` (or find nothing); writes are only logged. */
export class DryRunStore {
  constructor(inner, log, overrides = {}) {
    this.inner = inner;
    this.log = log;
    this.overrides = overrides;
  }
  async head(key) {
    return this.inner ? this.inner.head(key) : null;
  }
  async getText(key) {
    if (key in this.overrides) return this.overrides[key];
    return this.inner ? this.inner.getText(key) : null;
  }
  async putFile(key, path, opts = {}) {
    this.log(`[dry-run] put   ${key}  <- ${path}  (${opts.contentType}; ${opts.cacheControl})`);
  }
  async putText(key, _text, opts = {}) {
    this.log(`[dry-run] put   ${key}  (${opts.contentType}; ${opts.cacheControl})`);
  }
  async copy(srcKey, dstKey, opts = {}) {
    this.log(`[dry-run] copy  ${srcKey} -> ${dstKey}  (${opts.contentType}; ${opts.cacheControl})`);
  }
}
