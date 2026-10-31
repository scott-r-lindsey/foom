import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assets, buildIdentity, checksums, identity, macBundleVersion } from "./nightly.mjs";

const prefix = "updates/nightly/";
const digest = (data) => createHash("sha256").update(data).digest("hex");

/** Input is exclusively this run's tested packages, including the notarized macOS ZIP. */
export function generateFeed(packages, info) {
  const checked = identity(info.sha, info.date, info.version.split("-nightly.")[0]);
  if (checked.version !== info.version) throw new Error("Invalid nightly feed identity");
  const names = new Set();
  const archives = packages.filter(({ name }) => !name.endsWith("-RELEASES"));
  for (const { name, data } of archives) {
    if (
      !/^[A-Za-z0-9._+-]+$/.test(name) ||
      names.has(name) ||
      !Buffer.isBuffer(data) ||
      !data.length
    )
      throw new Error("Invalid or duplicate nightly artifact");
    names.add(name);
  }
  const immutable = archives.map(({ name, data }) => ({
    key: `${prefix}artifacts/${info.sha}/${name}`,
    data,
    sha256: digest(data),
    immutable: true,
  }));
  const feeds = ["darwin-arm64", "linux-x64", "win32-x64"].map((target) => {
    const name = `Foom-nightly-${info.day}-${info.short}-${target}.zip`;
    const archive = immutable.find(({ key }) => key.endsWith(`/${name}`));
    if (!archive || archive.data.length < 4 || archive.data.readUInt32LE(0) !== 0x04034b50)
      throw new Error(`Missing or invalid ${target} nightly ZIP`);
    const url = `https://foom-term.com/${archive.key}`;
    const metadata = {
      version: info.version,
      commit: info.sha,
      commitDate: info.date,
      sha256: archive.sha256,
      url,
      ...(target.startsWith("darwin-")
        ? {
            currentRelease: macBundleVersion({ version: info.version, foomNightlyDate: info.date }),
            releases: [
              {
                version: macBundleVersion({ version: info.version, foomNightlyDate: info.date }),
                updateTo: { url },
              },
            ],
          }
        : {}),
    };
    const data = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
    return {
      key: `${prefix}${target}/${target.startsWith("darwin-") ? "latest-mac.json" : "latest.json"}`,
      data,
      sha256: digest(data),
      immutable: false,
    };
  });
  const downloads = [
    ["darwin-arm64.dmg", /\.dmg$/],
    ["darwin-arm64.zip", /-darwin-arm64\.zip$/],
    ["linux-x64.deb", /\.deb$/],
    ["linux-x64.rpm", /\.rpm$/],
    ["linux-x64.zip", /-linux-x64\.zip$/],
    ["win32-x64-setup.exe", /\.exe$/],
    ["win32-x64.zip", /-win32-x64\.zip$/],
  ].map(([suffix, pattern]) => {
    const matches = immutable.filter(({ key }) => pattern.test(key));
    if (matches.length !== 1) throw new Error(`Missing or duplicate nightly download: ${suffix}`);
    const archive = matches[0];
    return {
      ...archive,
      key: `${prefix}download/Foom-nightly-${suffix}`,
      filename: archive.key.split("/").at(-1),
      immutable: false,
    };
  });
  const metadata = (name, data) => ({
    key: `${prefix}download/${name}`,
    data,
    sha256: digest(data),
    immutable: false,
  });
  const sums = metadata(
    "SHA256SUMS",
    Buffer.from(
      checksums(downloads.map(({ key, data }) => ({ name: key.split("/").at(-1), data }))),
    ),
  );
  const manifest = metadata(
    "latest.json",
    Buffer.from(
      `${JSON.stringify(
        {
          version: info.version,
          commit: info.sha,
          commitDate: info.date,
          files: downloads.map(({ key, filename, sha256 }) => ({
            name: key.split("/").at(-1),
            sha256,
            url: `https://foom-term.com/${prefix}artifacts/${info.sha}/${filename}`,
          })),
        },
        null,
        2,
      )}\n`,
    ),
  );
  return [
    ...immutable,
    ...[...downloads, sums, manifest, ...feeds].map((object) => ({
      ...object,
      commit: info.sha,
      commitDate: info.date,
    })),
  ];
}

/** Argument arrays only; tests inject the entire AWS boundary and never contact AWS. */
export function uploadFeed(objects, { bucket, distribution, region }, aws = runAws) {
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? "") ||
    !/^[A-Z0-9]+$/.test(distribution ?? "") ||
    !/^[a-z]{2}-[a-z]+-\d+$/.test(region ?? "")
  )
    throw new Error(
      "Configure NIGHTLY_FEED_BUCKET, NIGHTLY_FEED_DISTRIBUTION_ID and NIGHTLY_FEED_REGION",
    );
  const directory = mkdtempSync(join(tmpdir(), "foom-nightly-feed-"));
  const call = (args) => aws([...args, "--region", region, "--no-cli-pager"]);
  try {
    // Preflight every existing object before writing anything. A re-sign of the
    // same commit can differ byte-for-byte and must never replace a published ZIP.
    // S3 returns 403 for missing HEADs without unrestricted ListBucket. List only
    // this prefix, then HEAD known keys; never interpret access denial as absence.
    const keys = new Set(
      JSON.parse(
        call([
          "s3api",
          "list-objects-v2",
          "--bucket",
          bucket,
          "--prefix",
          prefix,
          "--query",
          "Contents[].Key",
          "--output",
          "json",
        ]),
      ) ?? [],
    );
    const pending = [];
    for (const object of objects) {
      const head = keys.has(object.key)
        ? JSON.parse(call(["s3api", "head-object", "--bucket", bucket, "--key", object.key]))
        : undefined;
      if (head && object.immutable) {
        if (head.Metadata?.sha256 !== object.sha256 || head.ContentLength !== object.data.length)
          throw new Error(`Immutable nightly artifact differs: ${object.key}`);
        continue;
      }
      if (head && !object.immutable) {
        // Fixed bytes may already belong to a newer, interrupted publication
        // whose JSON pointers still describe the previous night. HEAD metadata
        // protects every overwritten download/checksum before any writes occur.
        let previous = { commit: head.Metadata?.commit, commitDate: head.Metadata?.commitdate };
        if (object.key.endsWith(".json")) {
          const file = join(directory, "previous.json");
          call(["s3api", "get-object", "--bucket", bucket, "--key", object.key, file]);
          previous = JSON.parse(readFileSync(file, "utf8"));
        }
        if (
          !/^[a-f0-9]{40}$/.test(previous.commit ?? "") ||
          !Number.isFinite(Date.parse(previous.commitDate))
        )
          throw new Error("Invalid existing nightly publication identity");
        if (
          previous.commit !== object.commit &&
          Date.parse(previous.commitDate) >= Date.parse(object.commitDate)
        )
          throw new Error("Refusing to move nightly feed backwards");
      }
      pending.push(object);
    }
    // Immutable bytes, fixed downloads/checksums, manifest, then update feeds.
    // Metadata always references complete immutable objects, even on partial failure.
    for (const [index, object] of pending.entries()) {
      const file = join(directory, String(index));
      writeFileSync(file, object.data);
      call([
        "s3api",
        "put-object",
        "--bucket",
        bucket,
        "--key",
        object.key,
        "--body",
        file,
        "--metadata",
        JSON.stringify({
          sha256: object.sha256,
          ...(!object.immutable ? { commit: object.commit, commitdate: object.commitDate } : {}),
        }),
        "--checksum-algorithm",
        "SHA256",
        "--checksum-sha256",
        Buffer.from(object.sha256, "hex").toString("base64"),
        "--cache-control",
        object.immutable
          ? "public,max-age=31536000,immutable"
          : "no-cache,max-age=0,must-revalidate",
        "--content-type",
        object.key.endsWith(".json")
          ? "application/json"
          : object.key.endsWith("/SHA256SUMS")
            ? "text/plain"
            : "application/octet-stream",
        ...(object.filename
          ? ["--content-disposition", `attachment; filename="${object.filename}"`]
          : []),
        ...(object.immutable ? ["--if-none-match", "*"] : []),
      ]);
    }
    call([
      "cloudfront",
      "create-invalidation",
      "--distribution-id",
      distribution,
      "--paths",
      ...objects.filter(({ immutable }) => !immutable).map(({ key }) => `/${key}`),
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runAws(args) {
  return execFileSync("aws", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const info = buildIdentity();
  if (
    process.env.GITHUB_REF !== "refs/heads/main" ||
    process.env.GITHUB_SHA !== info.sha ||
    !(
      process.env.GITHUB_EVENT_NAME === "schedule" ||
      (process.env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
        process.env.PUBLISH_NIGHTLY === "true")
    )
  )
    throw new Error("Nightly feed upload requires the tested main schedule/opt-in commit");
  uploadFeed(generateFeed(assets("nightly-packages", info), info), {
    bucket: process.env.NIGHTLY_FEED_BUCKET,
    distribution: process.env.NIGHTLY_FEED_DISTRIBUTION_ID,
    region: process.env.NIGHTLY_FEED_REGION,
  });
}
