import { readFileSync, readdirSync } from "node:fs";

const manifestPaths = [
  "package.json",
  ...readdirSync("apps", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `apps/${entry.name}/package.json`),
  ...readdirSync("packages", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/package.json`)
];

const exactStableVersion = /^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/;
const failures = [];
const externalDependencies = new Set();

for (const manifestPath of manifestPaths) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (version === "workspace:*") continue;
      externalDependencies.add(name);
      if (version !== "catalog:") {
        failures.push(`${manifestPath}: ${section}.${name} must use the root catalog (found ${version})`);
      }
    }
  }
}

const rootManifest = JSON.parse(readFileSync("package.json", "utf8"));
if (!/^pnpm@11\.4\.0\+sha512\.[a-f0-9]{128}$/.test(rootManifest.packageManager ?? "")) {
  failures.push("package.json: packageManager must pin pnpm 11.4.0 and its full SHA-512 digest");
}

const workspace = readFileSync("pnpm-workspace.yaml", "utf8");
const catalogBlock = workspace.match(/(?:^|\n)catalog:\n(?<entries>(?: {2}[^\n]+\n?)*)/)?.groups?.entries ?? "";
const catalog = new Map();
for (const line of catalogBlock.split("\n")) {
  const entry = line.match(/^ {2}(?:"(?<quoted>[^"]+)"|(?<plain>[^:\s]+)):\s*(?<version>\S+)\s*$/)?.groups;
  if (!entry) continue;
  const name = entry.quoted ?? entry.plain;
  catalog.set(name, entry.version);
  if (!exactStableVersion.test(entry.version)) failures.push(`pnpm-workspace.yaml: catalog.${name} must be an exact stable version`);
}
for (const name of externalDependencies) {
  if (!catalog.has(name)) failures.push(`pnpm-workspace.yaml: catalog is missing ${name}`);
}

for (const required of [
  "minimumReleaseAge: 10080",
  "minimumReleaseAgeStrict: true",
  "minimumReleaseAgeIgnoreMissingTime: false",
  "trustPolicy: no-downgrade",
  "trustLockfile: false",
  "blockExoticSubdeps: true",
  "strictDepBuilds: true",
  "autoInstallPeers: false"
]) {
  if (!workspace.includes(required)) failures.push(`pnpm-workspace.yaml: missing ${required}`);
}

const lockfile = readFileSync("pnpm-lock.yaml", "utf8");
if (!/^settings:\n  autoInstallPeers: false$/m.test(lockfile)) {
  failures.push("pnpm-lock.yaml: autoInstallPeers must match the workspace policy");
}

const packagesBlock = lockfile.match(/\npackages:\n(?<packages>[\s\S]*?)\nsnapshots:\n/)?.groups?.packages ?? "";
for (const line of packagesBlock.split("\n")) {
  const key = line.match(/^  ['"]?(?<key>[^'"\n]+)['"]?:$/)?.groups?.key;
  if (key && /@\d+\.\d+\.\d+-[0-9A-Za-z]/.test(key)) {
    failures.push(`pnpm-lock.yaml: prerelease package is forbidden (${key})`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Dependency policy verified across ${manifestPaths.length} workspace manifests and ${catalog.size} catalog entries.`);
}
