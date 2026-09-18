// =========================================================
// scripts/verify-file-inventory.js
//
// Phase 4A File Intelligence verification against a synthetic
// sandbox. Never scans personal folders.
// =========================================================


import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
    MAX_INVENTORY_FILES,
    MAX_SCAN_DEPTH,
    _test,
    addRoot,
    getStatus,
    listRoots,
    removeRoot,
    scanInventory,
    searchInventory,
    validateFileRoot,
} from "../lib/file-inventory.js";


const ROOT = process.cwd();
const SANDBOX = path.join(ROOT, ".file-test-sandbox");
const CONFIG_DIR = path.join(SANDBOX, "_config");
const TREE = path.join(SANDBOX, "tree");
const DOCS = path.join(TREE, "documents");
const NESTED = path.join(DOCS, "nested");
const IGNORED_NODE = path.join(TREE, "node_modules");
const IGNORED_GIT = path.join(TREE, ".git");
const SENSITIVE = path.join(TREE, "sensitive");

const results = [];
const perf = {};


function record(name, status, detail = "") {
    results.push({ name, status, detail });
    const suffix = detail ? ` — ${detail}` : "";
    console.log(`${status.toUpperCase()}  ${name}${suffix}`);
}


function pass(name, detail) {
    record(name, "pass", detail);
}


function fail(name, detail) {
    record(name, "fail", detail);
}


function skip(name, detail) {
    record(name, "skip", detail);
}


async function expectThrow(work, match) {
    try {
        await work();
        throw new Error("Expected an error.");
    } catch (error) {
        if (error.message === "Expected an error.") {
            throw error;
        }

        const text = String(error.message ?? "");
        if (!text.toLowerCase().includes(String(match).toLowerCase())) {
            throw new Error(
                `Expected error containing "${match}", got: ${text}`,
            );
        }
    }
}


async function exists(filePath) {
    try {
        await fs.lstat(filePath);
        return true;
    } catch {
        return false;
    }
}


async function writeFile(filePath, contents) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents, "utf8");
}


async function setupSandbox() {
    await fs.rm(SANDBOX, { recursive: true, force: true });
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.mkdir(NESTED, { recursive: true });
    await fs.mkdir(path.join(IGNORED_NODE, "pkg"), { recursive: true });
    await fs.mkdir(IGNORED_GIT, { recursive: true });
    await fs.mkdir(SENSITIVE, { recursive: true });

    await writeFile(path.join(DOCS, "Resume 2026.pdf"), "%PDF-1.4 fake\n");
    await writeFile(path.join(DOCS, "notes.txt"), "hello notes\n");
    await writeFile(path.join(NESTED, "application.docx"), "PK fake docx\n");
    await writeFile(path.join(IGNORED_NODE, "pkg", "index.js"), "secret junk\n");
    await writeFile(path.join(IGNORED_GIT, "config"), "[core]\n");
    await writeFile(path.join(SENSITIVE, ".env"), "SECRET=1\n");
    await writeFile(path.join(SENSITIVE, ".env.local"), "SECRET=2\n");
    await writeFile(path.join(SENSITIVE, "private.pem"), "-----BEGIN-----\n");
    await writeFile(path.join(SENSITIVE, "id_rsa"), "fake-key\n");
    await writeFile(path.join(SENSITIVE, "id_ed25519"), "fake-ed\n");
    await writeFile(path.join(SENSITIVE, "safe-readme.txt"), "ok\n");

    process.env.LOCAL_AI_FILE_ROOTS_PATH = path.join(CONFIG_DIR, "file-roots.json");
    process.env.LOCAL_AI_FILE_INVENTORY_PATH = path.join(
        CONFIG_DIR,
        "file-inventory.json",
    );
}


async function resetConfig() {
    await fs.rm(process.env.LOCAL_AI_FILE_ROOTS_PATH, { force: true });
    await fs.rm(process.env.LOCAL_AI_FILE_INVENTORY_PATH, { force: true });
}


async function testRootValidation() {
    await resetConfig();

    const root = await validateFileRoot(DOCS);
    if (!root.id || root.realPath !== (await fs.realpath(DOCS))) {
        throw new Error("Valid directory was not accepted cleanly.");
    }
    pass("valid directory accepted");

    await expectThrow(
        () => validateFileRoot("Documents"),
        "absolute path",
    );
    await expectThrow(
        () => validateFileRoot("./Documents"),
        "absolute path",
    );
    await expectThrow(
        () => validateFileRoot("..\\Documents"),
        "absolute path",
    );
    pass("relative paths rejected");

    await expectThrow(
        () => validateFileRoot(path.join(DOCS, "missing-folder")),
        "does not exist",
    );
    pass("nonexistent root rejected");

    await expectThrow(
        () => validateFileRoot(path.join(DOCS, "notes.txt")),
        "directory",
    );
    pass("file-as-root rejected");

    const volumeRoot = path.parse(DOCS).root;
    await expectThrow(
        () => validateFileRoot(volumeRoot),
        "filesystem or volume root",
    );
    pass("filesystem root rejected");

    await addRoot(DOCS);
    await expectThrow(() => addRoot(DOCS), "already configured");
    pass("duplicate canonical root rejected");

    await expectThrow(() => addRoot(NESTED), "inside an existing");
    pass("nested/overlapping child root rejected");

    await resetConfig();
    await addRoot(NESTED);
    await expectThrow(() => addRoot(DOCS), "inside this folder");
    pass("overlapping parent root rejected");
}


async function testScanning() {
    await resetConfig();
    await addRoot(TREE);

    const started = Date.now();
    const summary = await scanInventory();
    perf.scanDurationMs = Date.now() - started;
    perf.filesDiscovered = summary.fileCount;

    const inventoryRaw = await fs.readFile(
        process.env.LOCAL_AI_FILE_INVENTORY_PATH,
        "utf8",
    );
    perf.inventoryJsonBytes = Buffer.byteLength(inventoryRaw);
    const inventory = JSON.parse(inventoryRaw);

    const names = inventory.files.map((file) => file.name);
    const relatives = inventory.files.map((file) =>
        file.relativePath.replace(/\\/g, "/"),
    );

    if (!names.includes("Resume 2026.pdf") || !names.includes("notes.txt")) {
        throw new Error("Expected top-level documents missing from inventory.");
    }
    if (!names.includes("application.docx")) {
        throw new Error("Nested regular file missing from inventory.");
    }
    pass("regular and nested files inventoried");

    if (names.includes("index.js") || relatives.some((r) => r.includes("node_modules"))) {
        throw new Error("Ignored node_modules contents were inventoried.");
    }
    if (relatives.some((r) => r.includes(".git"))) {
        throw new Error("Ignored .git contents were inventoried.");
    }
    pass("ignored directories excluded");

    for (const bad of [".env", ".env.local", "private.pem", "id_rsa", "id_ed25519"]) {
        if (names.includes(bad)) {
            throw new Error(`Sensitive file ${bad} appeared in inventory.`);
        }
    }
    if (!names.includes("safe-readme.txt")) {
        throw new Error("Non-sensitive file in sensitive/ was excluded.");
    }
    pass("sensitive files excluded");

    const notes = inventory.files.find((file) => file.name === "notes.txt");
    if (!notes) {
        throw new Error("notes.txt missing.");
    }
    if (notes.relativePath.replace(/\\/g, "/") !== "documents/notes.txt") {
        throw new Error(`Unexpected relative path: ${notes.relativePath}`);
    }
    if (!(notes.size > 0) || !(notes.mtimeMs > 0) || !notes.fingerprint) {
        throw new Error("Missing size/mtime/fingerprint metadata.");
    }
    if (notes.fingerprint !== `${notes.size}:${notes.mtimeMs}`) {
        throw new Error("Fingerprint is not size:mtimeMs.");
    }
    pass("relative paths and metadata present");

    if (summary.fileCount < 4) {
        throw new Error(`Expected at least 4 files, got ${summary.fileCount}`);
    }
}


async function testSymlinkEscape() {
    await resetConfig();

    const outside = path.join(
        os.tmpdir(),
        `local-ai-file-outside-${Date.now()}`,
    );
    const linkPath = path.join(TREE, "escape-link");
    const secret = path.join(outside, "outside-secret.txt");

    await fs.mkdir(outside, { recursive: true });
    await writeFile(secret, "OUTSIDE_SHOULD_NOT_INDEX\n");

    try {
        const type = process.platform === "win32" ? "junction" : "dir";
        await fs.symlink(outside, linkPath, type);
    } catch (error) {
        skip(
            "symlink/junction escape",
            `could not create link (${error.message})`,
        );
        await fs.rm(outside, { recursive: true, force: true });
        return;
    }

    try {
        await addRoot(TREE);
        const summary = await scanInventory();
        const inventory = JSON.parse(
            await fs.readFile(process.env.LOCAL_AI_FILE_INVENTORY_PATH, "utf8"),
        );
        const names = inventory.files.map((file) => file.name);
        const abs = inventory.files.map((file) => file.absolutePath);

        if (names.includes("outside-secret.txt")) {
            throw new Error("Symlink escape target was inventoried.");
        }

        const outsideNorm = process.platform === "win32"
            ? outside.toLowerCase()
            : outside;
        if (
            abs.some((entry) => {
                const value = process.platform === "win32"
                    ? entry.toLowerCase()
                    : entry;
                return value.startsWith(outsideNorm);
            })
        ) {
            throw new Error("Inventory contains paths outside the root via link.");
        }

        if (!(summary.skippedCount > 0)) {
            throw new Error("Expected skippedCount to increase for the link.");
        }

        pass("symlink/junction escape not followed");
    } finally {
        await fs.rm(linkPath, { recursive: true, force: true }).catch(() => {});
        await fs.rm(outside, { recursive: true, force: true });
    }
}


async function testPersistence() {
    await resetConfig();
    await addRoot(DOCS);
    await scanInventory();

    const rootsBefore = await listRoots();
    const statusBefore = await getStatus();

    // Re-import would share module state; instead re-read via public API after
    // confirming files exist on disk, then load fresh by reading JSON ourselves
    // and comparing through listRoots/getStatus (same process persistence).
    const rootsDisk = JSON.parse(
        await fs.readFile(process.env.LOCAL_AI_FILE_ROOTS_PATH, "utf8"),
    );
    const inventoryDisk = JSON.parse(
        await fs.readFile(process.env.LOCAL_AI_FILE_INVENTORY_PATH, "utf8"),
    );

    if (rootsDisk.roots.length !== 1) {
        throw new Error("Roots did not persist to disk.");
    }
    if (!inventoryDisk.scannedAt || inventoryDisk.files.length < 1) {
        throw new Error("Inventory did not persist to disk.");
    }

    const rootsAgain = await listRoots();
    const statusAgain = await getStatus();

    if (rootsAgain[0].id !== rootsBefore[0].id) {
        throw new Error("Root id changed after reload-from-disk path.");
    }
    if (statusAgain.fileCount !== statusBefore.fileCount) {
        throw new Error("Inventory status changed unexpectedly.");
    }
    pass("roots and inventory survive reload");

    await fs.writeFile(
        process.env.LOCAL_AI_FILE_ROOTS_PATH,
        "{ not json",
        "utf8",
    );
    await expectThrow(() => listRoots(), "Malformed file-roots.json");
    pass("malformed roots JSON produces clear failure");

    await resetConfig();
    await addRoot(DOCS);
    await addRoot(SENSITIVE);
    await scanInventory();

    const beforeRemove = await searchInventory({ limit: 200 });
    const docsRoot = (await listRoots()).find((root) => root.path === DOCS);
    await removeRoot(docsRoot.id);

    const afterRoots = await listRoots();
    if (afterRoots.some((root) => root.id === docsRoot.id)) {
        throw new Error("Removed root still listed.");
    }

    const afterSearch = await searchInventory({ limit: 200 });
    if (afterSearch.files.some((file) => file.rootId === docsRoot.id)) {
        throw new Error("Inventory still contains removed root entries.");
    }
    if (afterSearch.total >= beforeRemove.total) {
        throw new Error("Removing a root did not shrink inventory.");
    }

    if (await exists(path.join(DOCS, "notes.txt")) === false) {
        throw new Error("Remove root deleted a real user file.");
    }
    pass("removing a root prunes inventory without mutating files");
}


async function testSearch() {
    await resetConfig();
    await addRoot(TREE);
    await scanInventory();

    const started = Date.now();
    const byName = await searchInventory({ query: "RESUME" });
    perf.searchLatencyMs = Date.now() - started;

    if (!byName.files.some((file) => file.name === "Resume 2026.pdf")) {
        throw new Error("Case-insensitive filename search failed.");
    }
    pass("case-insensitive filename search");

    const byPath = await searchInventory({ query: "nested" });
    if (!byPath.files.some((file) => file.name === "application.docx")) {
        throw new Error("Relative-path search failed.");
    }
    pass("relative-path search");

    const byExt = await searchInventory({ extension: "txt" });
    if (
        byExt.files.length === 0 ||
        byExt.files.some((file) => file.extension !== "txt")
    ) {
        throw new Error("Extension filter failed.");
    }
    pass("extension filter");

    const roots = await listRoots();
    const byRoot = await searchInventory({ rootId: roots[0].id });
    if (byRoot.total !== byRoot.files.length && byRoot.total > byRoot.limit) {
        // ok — pagination
    }
    if (byRoot.files.some((file) => file.rootId !== roots[0].id)) {
        throw new Error("Root filter leaked other roots.");
    }
    pass("root filter");

    const bySizeDesc = await searchInventory({
        sort: "size",
        direction: "desc",
        limit: 50,
    });
    for (let i = 1; i < bySizeDesc.files.length; i += 1) {
        if (bySizeDesc.files[i - 1].size < bySizeDesc.files[i].size) {
            throw new Error("Size descending sort incorrect.");
        }
    }
    pass("sorting");

    const page1 = await searchInventory({ limit: 2, offset: 0, sort: "name" });
    const page2 = await searchInventory({ limit: 2, offset: 2, sort: "name" });
    if (page1.files.length !== 2) {
        throw new Error("Pagination page size incorrect.");
    }
    if (page1.files[0].absolutePath === page2.files[0]?.absolutePath) {
        throw new Error("Pagination offset did not advance.");
    }
    pass("pagination");

    const clamped = await searchInventory({ limit: 9999 });
    if (clamped.limit !== _test.MAX_LIMIT) {
        throw new Error(
            `Expected max limit ${_test.MAX_LIMIT}, got ${clamped.limit}`,
        );
    }
    pass("max limit clamping");
}


async function testLimits() {
    await resetConfig();
    await addRoot(TREE);

    const summary = await scanInventory({ maxInventoryFiles: 2 });
    if (!summary.truncated) {
        throw new Error("Expected truncated=true with small file limit.");
    }
    if (summary.fileCount !== 2) {
        throw new Error(`Expected 2 inventoried files, got ${summary.fileCount}`);
    }
    if (!String(summary.truncationReason ?? "").includes("file limit")) {
        throw new Error("Missing truncation reason for file limit.");
    }
    pass("scan truncates at injectable file limit", `files=${summary.fileCount}`);

    await resetConfig();
    await addRoot(TREE);
    // Depth 1 enters documents/ and sensitive/, but not documents/nested/.
    const depthSummary = await scanInventory({ maxScanDepth: 1 });
    const inventory = JSON.parse(
        await fs.readFile(process.env.LOCAL_AI_FILE_INVENTORY_PATH, "utf8"),
    );
    const names = inventory.files.map((file) => file.name);

    if (names.includes("application.docx")) {
        throw new Error("Depth-1 scan should not enter nested/.");
    }
    if (!names.includes("notes.txt") || !names.includes("Resume 2026.pdf")) {
        throw new Error("Depth-1 scan should still inventory documents/* files.");
    }
    if (!depthSummary.truncated) {
        throw new Error("Expected truncated when depth limit blocks descent.");
    }
    if (!String(depthSummary.truncationReason ?? "").includes("depth limit")) {
        throw new Error("Missing truncation reason for depth limit.");
    }
    pass("scan truncates at injectable depth limit");
}


async function jsonRequest(port, method, urlPath, body) {
    const payload = body === undefined ? null : JSON.stringify(body);

    return new Promise((resolve, reject) => {
        const request = http.request(
            {
                host: "127.0.0.1",
                port,
                path: urlPath,
                method,
                headers: payload
                    ? {
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(payload),
                    }
                    : {},
            },
            (response) => {
                const chunks = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    let data = null;
                    try {
                        data = text ? JSON.parse(text) : null;
                    } catch {
                        reject(new Error(`Invalid JSON from ${urlPath}`));
                        return;
                    }
                    resolve({ status: response.statusCode, data });
                });
            },
        );

        request.on("error", reject);
        if (payload) {
            request.write(payload);
        }
        request.end();
    });
}


async function startApiHarness() {
    // Mirrors server.js /api/files* contract against sandbox env paths.
    const {
        addRoot: add,
        getStatus: status,
        listRoots: roots,
        removeRoot: remove,
        scanInventory: scan,
        searchInventory: search,
    } = await import("../lib/file-inventory.js");

    function send(response, code, body) {
        const json = JSON.stringify(body);
        response.writeHead(code, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(json),
        });
        response.end(json);
    }

    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");

        try {
            if (url.pathname === "/api/files/status" && request.method === "GET") {
                send(response, 200, await status());
                return;
            }

            if (url.pathname === "/api/files/roots" && request.method === "GET") {
                send(response, 200, { roots: await roots() });
                return;
            }

            if (url.pathname === "/api/files/roots" && request.method === "POST") {
                const chunks = [];
                for await (const chunk of request) {
                    chunks.push(chunk);
                }
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
                const root = await add(body.path);
                send(response, 200, { root });
                return;
            }

            if (url.pathname === "/api/files/roots/remove" && request.method === "POST") {
                const chunks = [];
                for await (const chunk of request) {
                    chunks.push(chunk);
                }
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
                const root = await remove(body.id);
                send(response, 200, { root });
                return;
            }

            if (url.pathname === "/api/files/scan" && request.method === "POST") {
                send(response, 200, { summary: await scan() });
                return;
            }

            if (url.pathname === "/api/files" && request.method === "GET") {
                send(
                    response,
                    200,
                    await search({
                        query: url.searchParams.get("query") ?? "",
                        rootId: url.searchParams.get("rootId") ?? "",
                        extension: url.searchParams.get("extension") ?? "",
                        limit: Number(url.searchParams.get("limit")),
                        offset: Number(url.searchParams.get("offset")),
                        sort: url.searchParams.get("sort") ?? "name",
                        direction: url.searchParams.get("direction") ?? "asc",
                    }),
                );
                return;
            }

            send(response, 404, { error: { message: "Route not found." } });
        } catch (error) {
            send(response, error.status ?? 400, {
                error: { message: error.message },
            });
        }
    });

    await new Promise((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    return { server, port: address.port };
}


async function testApiRoutes() {
    await resetConfig();
    const { server, port } = await startApiHarness();

    try {
        const statusEmpty = await jsonRequest(port, "GET", "/api/files/status");
        if (statusEmpty.status !== 200 || statusEmpty.data.rootCount !== 0) {
            throw new Error("GET /api/files/status failed for empty config.");
        }
        pass("GET /api/files/status");

        const rootsEmpty = await jsonRequest(port, "GET", "/api/files/roots");
        if (rootsEmpty.status !== 200 || rootsEmpty.data.roots.length !== 0) {
            throw new Error("GET /api/files/roots failed.");
        }
        pass("GET /api/files/roots");

        const added = await jsonRequest(port, "POST", "/api/files/roots", {
            path: DOCS,
        });
        if (added.status !== 200 || !added.data.root?.id) {
            throw new Error(`POST /api/files/roots failed: ${JSON.stringify(added.data)}`);
        }
        pass("POST /api/files/roots");

        const relative = await jsonRequest(port, "POST", "/api/files/roots", {
            path: "Documents",
        });
        if (
            relative.status === 200 ||
            !String(relative.data?.error?.message ?? "").includes("absolute")
        ) {
            throw new Error("Relative path was accepted by API.");
        }
        pass("POST /api/files/roots rejects relative paths");

        const scanned = await jsonRequest(port, "POST", "/api/files/scan");
        if (scanned.status !== 200 || !(scanned.data.summary.fileCount > 0)) {
            throw new Error("POST /api/files/scan failed.");
        }
        pass("POST /api/files/scan");

        const listed = await jsonRequest(
            port,
            "GET",
            "/api/files?query=notes&limit=10",
        );
        if (
            listed.status !== 200 ||
            !listed.data.files.some((file) => file.name === "notes.txt")
        ) {
            throw new Error("GET /api/files search failed.");
        }
        pass("GET /api/files");

        const removed = await jsonRequest(port, "POST", "/api/files/roots/remove", {
            id: added.data.root.id,
        });
        if (removed.status !== 200) {
            throw new Error("POST /api/files/roots/remove failed.");
        }

        const after = await jsonRequest(port, "GET", "/api/files");
        if (after.data.files.some((file) => file.rootId === added.data.root.id)) {
            throw new Error("Remove did not prune via API.");
        }
        pass("POST /api/files/roots/remove");
    } finally {
        await new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
    }
}


async function main() {
    console.log("Phase 4A File Intelligence verification");
    console.log(`Sandbox: ${SANDBOX}`);
    console.log(`Defaults: MAX_SCAN_DEPTH=${MAX_SCAN_DEPTH} MAX_INVENTORY_FILES=${MAX_INVENTORY_FILES}`);
    console.log("");

    await setupSandbox();

    const suites = [
        ["root validation", testRootValidation],
        ["scanning", testScanning],
        ["symlink/junction escape", testSymlinkEscape],
        ["persistence", testPersistence],
        ["search", testSearch],
        ["limits", testLimits],
        ["API routes", testApiRoutes],
    ];

    for (const [name, fn] of suites) {
        try {
            await fn();
        } catch (error) {
            fail(name, error.message);
        }
    }

    console.log("");
    console.log("Performance");
    console.log(`  files discovered: ${perf.filesDiscovered ?? "n/a"}`);
    console.log(`  scan duration: ${perf.scanDurationMs ?? "n/a"} ms`);
    console.log(`  inventory JSON size: ${perf.inventoryJsonBytes ?? "n/a"} bytes`);
    console.log(`  search latency: ${perf.searchLatencyMs ?? "n/a"} ms`);
    console.log("");

    const passed = results.filter((item) => item.status === "pass").length;
    const failed = results.filter((item) => item.status === "fail");
    const skipped = results.filter((item) => item.status === "skip").length;

    console.log(
        `Results: ${passed} passed, ${failed.length} failed, ${skipped} skipped`,
    );

    if (failed.length) {
        process.exitCode = 1;
    }
}


main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            await fs.rm(SANDBOX, { recursive: true, force: true });
        } catch {
            // leave sandbox if cleanup fails
        }
    });
