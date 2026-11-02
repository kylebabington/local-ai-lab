// =========================================================
// scripts/verify-storage-scan.js
//
// Milestone A storage-scan grants and inspect_disk_usage.
// Uses a dedicated temp sandbox — never personal user files.
// =========================================================


import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
    PERMISSION_READ,
    executeTool,
    getTool,
    validateToolArguments,
} from "../lib/tools/registry.js";
import {
    NO_SCAN_GRANT_MESSAGE,
    PROFILE_ROOT_MESSAGE,
    PROTECTED_LOCATION_MESSAGE,
    VOLUME_ROOT_MESSAGE,
    assertGrantablePath,
    grantScanFolder,
    inspectDiskUsage,
} from "../lib/tools/storage.js";
import {
    _test as sessionTest,
    forbiddenCrossOriginMessage,
    runWithSession,
    revokeAllSessionGrants,
    revokeSessionGrant,
} from "../lib/storage-session.js";
import { dispatchToolCall, listPendingApprovals, rejectById } from "../lib/agent.js";


const results = [];
const SANDBOX = path.join(process.cwd(), ".storage-scan-test-sandbox");
const OUTSIDE = path.join(path.dirname(process.cwd()), ".local-ai-lab-scan-test");


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


function assert(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}


async function expectThrow(work, needle) {
    try {
        await work();
    } catch (error) {
        if (needle && !String(error.message).includes(needle)) {
            throw new Error(
                `Expected error containing ${JSON.stringify(needle)}, got: ${error.message}`,
            );
        }
        return error;
    }
    throw new Error("Expected an error.");
}


async function rimraf(target) {
    await fs.rm(target, { recursive: true, force: true });
}


async function writeFile(filePath, contents) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
}


async function setupSandbox() {
    await rimraf(SANDBOX);
    await rimraf(OUTSIDE);
    await fs.mkdir(path.join(SANDBOX, "videos"), { recursive: true });
    await fs.mkdir(path.join(SANDBOX, "cache"), { recursive: true });
    await writeFile(path.join(SANDBOX, "videos", "clip.bin"), "x".repeat(4096));
    await writeFile(path.join(SANDBOX, "notes.txt"), "hello");
    await writeFile(path.join(SANDBOX, "cache", "tmp.dat"), "y".repeat(2048));
    await fs.mkdir(path.join(OUTSIDE, "dataset"), { recursive: true });
    await writeFile(path.join(OUTSIDE, "dataset", "big.bin"), "z".repeat(8192));
}


async function withSession(work) {
    const session = sessionTest.createSession();
    return runWithSession(session, () => work(session));
}


async function testNoGrantFails() {
    await withSession(async () => {
        const error = await expectThrow(
            () => executeTool("inspect_disk_usage", { path: SANDBOX }),
            NO_SCAN_GRANT_MESSAGE,
        );
        assert(error.code === "NO_GRANT", "NO_GRANT code");
    });

    pass("no grant", "inspect_disk_usage refuses until a folder is granted");
}


async function testGrantAndScan() {
    await withSession(async () => {
        const grant = await grantScanFolder(SANDBOX);
        assert(grant.path, "grant path");

        const { result } = await executeTool("inspect_disk_usage", {
            path: SANDBOX,
        });

        assert(result.complete === true, "small sandbox should complete");
        assert(result.incomplete === null, "complete scan reported incomplete");
        assert(result.filesVisited >= 3, "expected files");
        assert(result.totalBytes >= 4096 + 2048, "sizes undercounted");
        assert(
            result.possibleCaches.some((item) => item.name === "cache"),
            "cache heuristic",
        );
        assert(Array.isArray(result.interpretationLimits), "limits");
        assert(result.grantId === grant.id, "grantId");
    });

    pass("grant and scan", "bounded disk usage inside a granted folder");
}


async function testOutsideComputerRoots() {
    await withSession(async () => {
        await grantScanFolder(OUTSIDE);
        const { result } = await executeTool("inspect_disk_usage", {
            path: OUTSIDE,
        });
        assert(result.filesVisited >= 1, "outside scan missed files");

        await expectThrow(
            () => executeTool("list_directory", { path: OUTSIDE }),
            "outside the allowed filesystem roots",
        );
    });

    pass(
        "scan grants vs Computer roots",
        "granted outside-root folder is readable by inspect_disk_usage only",
    );
}


async function testProtectedAndVolumeRoots() {
    await expectThrow(() => assertGrantablePath("C:\\"), VOLUME_ROOT_MESSAGE);
    await expectThrow(() => assertGrantablePath("C:"), VOLUME_ROOT_MESSAGE);
    await expectThrow(
        () => assertGrantablePath(os.homedir()),
        PROFILE_ROOT_MESSAGE,
    );

    const windowsDir = path.join(path.parse(process.cwd()).root, "Windows");
    try {
        await fs.lstat(windowsDir);
        await expectThrow(
            () => assertGrantablePath(windowsDir),
            PROTECTED_LOCATION_MESSAGE,
        );
    } catch (error) {
        if (error?.code !== "ENOENT") {
            throw error;
        }
    }

    pass("protected grants", "volume root, profile, and Windows refused");
}


async function testRevokeStopsScan() {
    await withSession(async (session) => {
        const grant = await grantScanFolder(SANDBOX);
        revokeSessionGrant(grant.id, session);
        await expectThrow(
            () => executeTool("inspect_disk_usage", { path: SANDBOX }),
            NO_SCAN_GRANT_MESSAGE,
        );

        const keep = await grantScanFolder(SANDBOX);
        await grantScanFolder(OUTSIDE);
        revokeSessionGrant(keep.id, session);
        await expectThrow(
            () => executeTool("inspect_disk_usage", { path: SANDBOX }),
            "not in the current scan session",
        );
        const { result } = await executeTool("inspect_disk_usage", { path: OUTSIDE });
        assert(result.filesVisited >= 1, "remaining grant should still scan");
    });

    pass("revoke", "revoked grants immediately block inspect_disk_usage");
}


async function testIncompleteLimits() {
    await withSession(async () => {
        await grantScanFolder(SANDBOX);
        const { result } = await executeTool("inspect_disk_usage", {
            path: SANDBOX,
            maxEntries: 1,
            maxDepth: 0,
        });
        assert(result.complete === false, "limit must be incomplete");
        assert(result.incomplete, "incomplete object missing");
        assert(
            result.incomplete.truncated === true || result.incomplete.limit,
            "limit not reported",
        );
    });

    pass("scan limits", "truncated walks are complete=false");
}


async function testSymlinkEscape() {
    const linkPath = path.join(SANDBOX, "escape-link");
    const secret = path.join(OUTSIDE, "secret.txt");
    await writeFile(secret, "SECRET");

    try {
        const type = process.platform === "win32" ? "junction" : "dir";
        await fs.symlink(OUTSIDE, linkPath, type);
    } catch (error) {
        skip("symlink/junction escape", `could not create link (${error.message})`);
        return;
    }

    await withSession(async () => {
        await grantScanFolder(SANDBOX);
        const { result } = await executeTool("inspect_disk_usage", {
            path: SANDBOX,
        });
        const blob = JSON.stringify(result);
        assert(!blob.includes("SECRET"), "followed a junction/symlink to secret.txt");
        assert(
            !result.largestFiles.some((item) => item.name === "secret.txt"),
            "secret file listed",
        );
    });

    pass("symlink/junction escape", "walker does not follow links out of the grant");
}


async function testOriginGuard() {
    const forbidden = forbiddenCrossOriginMessage({
        headers: { origin: "https://evil.example" },
        socket: { remoteAddress: "127.0.0.1" },
    });
    assert(forbidden, "evil origin allowed");

    const local = forbiddenCrossOriginMessage({
        headers: { origin: "http://localhost:5173" },
        socket: { remoteAddress: "127.0.0.1" },
    });
    assert(local === null, "localhost origin blocked");

    const script = forbiddenCrossOriginMessage({
        headers: {},
        socket: { remoteAddress: "127.0.0.1" },
    });
    assert(script === null, "loopback scripts should be allowed without Origin");

    const remote = forbiddenCrossOriginMessage({
        headers: {},
        socket: { remoteAddress: "8.8.8.8" },
    });
    assert(remote, "non-loopback missing Origin allowed");

    pass("origin guard", "cross-origin mutating requests rejected");
}


async function testSessionIsolation() {
    const sessionA = sessionTest.createSession();
    const sessionB = sessionTest.createSession();

    await runWithSession(sessionA, async () => {
        await grantScanFolder(SANDBOX);
        const { result } = await executeTool("inspect_disk_usage", { path: SANDBOX });
        assert(result.filesVisited >= 1, "session A scan failed");
    });

    await runWithSession(sessionB, async () => {
        await expectThrow(
            () => executeTool("inspect_disk_usage", { path: SANDBOX }),
            NO_SCAN_GRANT_MESSAGE,
        );
    });

    pass("session isolation", "grants are bound to the server-managed session");
}


async function testRequestStorageScanApproval() {
    await withSession(async () => {
        const pendingBefore = listPendingApprovals().length;
        const continuation = {
            messages: [],
            steps: 0,
            activity: [],
            evidenceLedger: [],
            chatWithTools: async () => ({
                content: "",
                toolCalls: [],
                message: { role: "assistant", content: "" },
            }),
        };

        const blocked = await dispatchToolCall(
            "request_storage_scan",
            { path: "C:\\", reason: "scan the drive" },
            continuation,
        );
        assert(blocked.kind === "result", "C:\\ grant should not pause for approval");
        assert(blocked.payload.ok === false, "C:\\ grant must fail");

        const asked = await dispatchToolCall(
            "request_storage_scan",
            { path: SANDBOX, reason: "measure folder size" },
            continuation,
        );
        assert(asked.kind === "approval", "valid folder should request approval");
        assert(
            listPendingApprovals().length === pendingBefore + 1,
            "pending approval missing",
        );

        const rejected = await rejectById(asked.approval.id);
        assert(rejected.status === "complete", "reject did not resume");

        await expectThrow(
            () => executeTool("inspect_disk_usage", { path: SANDBOX }),
            NO_SCAN_GRANT_MESSAGE,
        );
    });

    pass(
        "request_storage_scan",
        "model-proposed folders need approval; C:\\ is refused before the card",
    );
}


async function testDiskToolIsReadOnly() {
    const tool = getTool("inspect_disk_usage");
    assert(tool.permission === PERMISSION_READ, "disk usage permission");
    validateToolArguments("inspect_disk_usage", { path: SANDBOX, maxDepth: 2 });
    pass("inspect_disk_usage registry", "read-only with bounded args");
}


async function testLiveDiskUsage() {
    if (process.platform !== "win32") {
        skip("live inspect_disk_usage", "not running on Windows");
        return;
    }

    await withSession(async () => {
        await grantScanFolder(SANDBOX);
        const { result } = await executeTool("inspect_disk_usage", {
            path: SANDBOX,
        });
        assert(result.filesVisited >= 1, "live filesVisited");
        pass(
            "live inspect_disk_usage",
            `complete=${result.complete} files=${result.filesVisited}`,
        );
    });
}


async function testHttpOriginOnStoragePost() {
    // Direct module coverage is in testOriginGuard. This checks the
    // helper still rejects a typical browser CSRF Origin.
    const message = forbiddenCrossOriginMessage({
        headers: { origin: "http://example.com", referer: "http://example.com/" },
        socket: { remoteAddress: "127.0.0.1" },
    });
    assert(message, "example.com origin allowed");
    pass("HTTP origin helper", "storage POSTs share the loopback origin check");
}


async function main() {
    const tests = [
        ["inspect_disk_usage registry", testDiskToolIsReadOnly],
        ["no grant", testNoGrantFails],
        ["grant and scan", testGrantAndScan],
        ["scan grants vs Computer roots", testOutsideComputerRoots],
        ["protected grants", testProtectedAndVolumeRoots],
        ["revoke", testRevokeStopsScan],
        ["scan limits", testIncompleteLimits],
        ["symlink/junction escape", testSymlinkEscape],
        ["origin guard", testOriginGuard],
        ["session isolation", testSessionIsolation],
        ["request_storage_scan", testRequestStorageScanApproval],
        ["HTTP origin helper", testHttpOriginOnStoragePost],
        ["live inspect_disk_usage", testLiveDiskUsage],
    ];

    try {
        await setupSandbox();

        for (const [name, run] of tests) {
            try {
                sessionTest.reset();
                revokeAllSessionGrants();
                await run();
            } catch (error) {
                fail(name, error.message);
            } finally {
                sessionTest.reset();
                for (const item of listPendingApprovals()) {
                    try {
                        await rejectById(item.id);
                    } catch {
                        // leftover
                    }
                }
            }
        }
    } finally {
        await rimraf(SANDBOX);
        await rimraf(OUTSIDE);
        sessionTest.reset();
    }

    const passed = results.filter((item) => item.status === "pass").length;
    const failed = results.filter((item) => item.status === "fail").length;
    const skipped = results.filter((item) => item.status === "skip").length;
    console.log("");
    console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);

    if (failed > 0) {
        process.exitCode = 1;
    }
}


main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
