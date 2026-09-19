import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, SettingsManager, getAgentDir, } from "@earendil-works/pi-coding-agent";
import { CHILD_TOOLS } from "./config.js";
function expandHome(value) {
    if (value === "~" || value.startsWith("~/") || value.startsWith("~\\"))
        return os.homedir() + value.slice(1);
    return value;
}
function real(value) {
    try {
        return fs.realpathSync(value);
    }
    catch {
        return path.resolve(value);
    }
}
function readManifest(root) {
    const manifestPath = path.join(root, "package.json");
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    }
    catch (error) {
        throw new Error(`Child extension package manifest is unreadable at ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        throw new Error(`Child extension package manifest is invalid at ${manifestPath}`);
    return parsed;
}
function owningPackage(entry) {
    let directory = fs.statSync(entry).isDirectory() ? entry : path.dirname(entry);
    for (;;) {
        const manifestPath = path.join(directory, "package.json");
        if (fs.existsSync(manifestPath))
            return { root: directory, manifest: readManifest(directory) };
        const parent = path.dirname(directory);
        if (parent === directory || path.basename(directory) === "node_modules")
            break;
        directory = parent;
    }
    throw new Error(`Child extension path is not owned by a package manifest: ${entry}`);
}
function assertExtensionManifest(root, manifest) {
    const declared = manifest.pi?.extensions;
    if (!Array.isArray(declared) || declared.length === 0) {
        throw new Error(`Child extension package ${String(manifest.name ?? root)} has no pi.extensions entry`);
    }
    if (declared.some((item) => typeof item !== "string" || item.length === 0)) {
        throw new Error(`Child extension package ${String(manifest.name ?? root)} has an invalid pi.extensions entry`);
    }
}
function packageAliases(resource) {
    const aliases = new Set();
    const owner = owningPackage(resource.path);
    if (typeof owner.manifest.name === "string") {
        aliases.add(owner.manifest.name.toLowerCase());
        aliases.add(owner.manifest.name.replace(/^@[^/]+\//, "").toLowerCase());
    }
    const filename = path.basename(resource.path).replace(/\.(?:ts|js)$/, "");
    aliases.add((filename === "index" ? path.basename(path.dirname(resource.path)) : filename).toLowerCase());
    return [...aliases];
}
function rejectRecursive(root, manifest) {
    const packageName = typeof manifest.name === "string" ? manifest.name.toLowerCase() : "";
    const thisRoot = real(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
    if (packageName === "pi-delegateau" || packageName.endsWith("/pi-delegateau") || real(root) === thisRoot) {
        throw new Error("pi-delegateau cannot be loaded into a delegated child");
    }
}
async function resolveExplicit(selector, configured, manager) {
    const expanded = expandHome(selector);
    if (!path.isAbsolute(expanded))
        throw new Error(`Child extension paths must be absolute or start with ~: ${selector}`);
    const selectedPath = real(expanded);
    if (!fs.existsSync(selectedPath))
        throw new Error(`Child extension path does not exist: ${selector}`);
    const owner = owningPackage(selectedPath);
    rejectRecursive(owner.root, owner.manifest);
    assertExtensionManifest(owner.root, owner.manifest);
    // Ask Pi's package manager to expand directories, globs and exact manifest
    // entries so this path follows the same package rules as normal loading.
    const packageResolved = await manager.resolveExtensionSources([owner.root], { temporary: true });
    const declared = packageResolved.extensions.filter((resource) => resource.enabled).map((resource) => real(resource.path));
    const candidates = fs.statSync(selectedPath).isDirectory()
        ? declared.filter((entry) => entry === selectedPath || entry.startsWith(`${selectedPath}${path.sep}`))
        : declared.filter((entry) => entry === selectedPath);
    if (candidates.length === 0)
        throw new Error(`Child extension path is not declared by its package pi.extensions manifest: ${selector}`);
    // An explicit path may name a package outside settings. If the same package
    // is configured, however, its enabled/disabled filter remains authoritative.
    const ownerConfigured = configured.filter((resource) => real(resource.metadata.baseDir ?? "") === real(owner.root));
    const configuredEnabled = new Set(ownerConfigured.filter((resource) => resource.enabled).map((resource) => real(resource.path)));
    if (ownerConfigured.length > 0 && candidates.some((entry) => !configuredEnabled.has(entry))) {
        throw new Error(`Child extension path is disabled by Pi package settings: ${selector}`);
    }
    return candidates;
}
export async function resolveChildExtensions(selectors, cwd, agentDir = getAgentDir()) {
    if (selectors.length === 0)
        return { paths: [], packageNames: [] };
    const settings = SettingsManager.create(cwd, agentDir);
    const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
    const resolved = await manager.resolve(async () => "error");
    const configured = resolved.extensions.filter((resource) => resource.metadata.origin === "package");
    const available = configured.filter((resource) => resource.enabled);
    const paths = [];
    const packageNames = new Set();
    for (const selector of selectors) {
        const isPath = path.isAbsolute(expandHome(selector)) || selector.startsWith("~");
        const matchingResources = isPath
            ? []
            : available.filter((resource) => packageAliases(resource).includes(selector.toLowerCase()));
        if (!isPath) {
            const roots = new Set(matchingResources.map((resource) => real(owningPackage(resource.path).root)));
            if (roots.size > 1)
                throw new Error(`Child extension name "${selector}" is ambiguous across Pi packages`);
        }
        const matches = isPath
            ? await resolveExplicit(selector, configured, manager)
            : matchingResources.map((resource) => real(resource.path));
        if (matches.length === 0)
            throw new Error(`Child extension "${selector}" could not be resolved from Pi package settings`);
        for (const entry of matches) {
            if (!fs.existsSync(entry) || !fs.statSync(entry).isFile())
                throw new Error(`Resolved child extension entry is missing: ${entry}`);
            const owner = owningPackage(entry);
            rejectRecursive(owner.root, owner.manifest);
            assertExtensionManifest(owner.root, owner.manifest);
            if (typeof owner.manifest.name === "string")
                packageNames.add(owner.manifest.name);
            paths.push(real(entry));
        }
    }
    return { paths: [...new Set(paths)], packageNames: [...packageNames] };
}
export function validateProbedChildTools(requestedTools, extensionPaths, probed) {
    const allowedEntries = new Set(extensionPaths.map(real));
    const byName = new Map(probed.map((tool) => [tool.name, tool]));
    const invalid = [];
    for (const name of requestedTools) {
        if (name === "delegate_task") {
            invalid.push(name);
            continue;
        }
        if (CHILD_TOOLS.has(name))
            continue;
        const tool = byName.get(name);
        const sourcePath = tool?.source?.path ? real(tool.source.path) : undefined;
        if (!tool || tool.source?.source === "builtin" || !sourcePath || !allowedEntries.has(sourcePath))
            invalid.push(name);
    }
    if (invalid.length > 0)
        throw new Error(`Child tools are not provided by approved built-ins or allowlisted extensions: ${invalid.join(", ")}`);
    return [...new Set(requestedTools)];
}
