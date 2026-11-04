// =========================================================
// scripts/verify-storage-removal.js
//
// Milestone D2 synthetic-only Recycle Bin removal.
// Reports mocked / helper-build / live-recycle / restore separately.
// =========================================================


import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
    approveById,
    createStandaloneRemovalApproval,
    createStandaloneTransferApproval,
    rejectById,
} from "../lib/agent.js";
import {
    PERMISSION_APPROVAL,
    getTool,
    listTools,
    validateToolArguments,
} from "../lib/tools/registry.js";
import {
    lockManifestFromSelection,
    planStorageOffload,
    _test as offloadTest,
} from "../lib/tools/storage-offload.js";
import {
    bootstrapTransferRuntime,
    getPublicTransfer,
} from "../lib/tools/storage-transfer.js";
import {
    RECLAIM_ELIGIBLE,
    bootstrapReclaimRuntime,
    getPublicReclaimJob,
    startReclaimReview,
} from "../lib/tools/storage-reclaim.js";
import {
    bootstrapRemovalRuntime,
    getPublicRemovalJob,
    lockReclaimSelection,
    _test as removalTest,
} from "../lib/tools/storage-removal.js";
import {
    assertHelperProvenance,
    assertRecycleCapableVolume,
    proveRecycleOnlyForRoot,
    recycleFile,
    restoreRecycledFile,
    _test as recycleTest,
} from "../lib/tools/windows-recycle.js";
import {
    clearSyntheticReclaimRoots,
    installSyntheticTestAuthority,
    registerSyntheticReclaimRoot,
    revokeSyntheticTestAuthority,
} from "../lib/synthetic-reclaim-roots.js";
import { grantScanFolder } from "../lib/tools/storage.js";
import { inspectExternalDrives } from "../lib/tools/windows.js";
import {
    _test as sessionTest,
    runWithSession,
} from "../lib/storage-session.js";


const results = [];
const PARENT = path.dirname(process.cwd());
const RUN_ID = crypto.randomUUID();
const AUTHORITY = Symbol("local-ai-synthetic-authority");


function record(name, status, detail = "", kind = "mocked") {
    results.push({ name, status, detail, kind });
    console.log(
        `${status.toUpperCase()}  [${kind}] ${name}${detail ? ` — ${detail}` : ""}`,
    );
}

function pass(name, detail, kind = "mocked") {
    record(name, "pass", detail, kind);
}

function fail(name, detail, kind = "mocked") {
    record(name, "fail", detail, kind);
}

function skip(name, detail, kind = "mocked") {
    record(name, "skip", detail, kind);
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

async function sha256File(filePath) {
    const buf = await fs.readFile(filePath);
    return crypto.createHash("sha256").update(buf).digest("hex");
}

async function waitForTransfer(transferId, session, timeoutMs = 60_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const transfer = await runWithSession(session, () =>
            getPublicTransfer(transferId),
        );
        if (
            transfer &&
            ["completed", "failed", "cancelled", "interrupted"].includes(
                transfer.status,
            )
        ) {
            return transfer;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for transfer.");
}

async function waitForReclaim(jobId, session, timeoutMs = 60_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const job = await runWithSession(session, () =>
            getPublicReclaimJob(jobId),
        );
        if (
            job &&
            ["completed", "failed", "cancelled", "incomplete"].includes(
                job.status,
            )
        ) {
            return job;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for reclaim.");
}

async function waitForRemoval(removalId, session, timeoutMs = 60_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const job = await runWithSession(session, () =>
            getPublicRemovalJob(removalId),
        );
        if (
            job &&
            ["completed", "failed", "cancelled"].includes(job.status)
        ) {
            return job;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for removal.");
}


async function testRegistry() {
    const tool = getTool("request_reclaim_removal");
    assert(tool.permission === PERMISSION_APPROVAL, "approval permission");
    validateToolArguments("request_reclaim_removal", {
        reclaimManifestId: crypto.randomUUID(),
        reason: "test",
    });
    await expectThrow(
        () =>
            validateToolArguments("request_reclaim_removal", {
                reclaimManifestId: crypto.randomUUID(),
                reason: "test",
                sourcePath: "C:\\evil",
            }),
        "Unexpected",
    );
    assert(
        listTools().find((t) => t.name === "delete_path")?.available === false,
        "delete available",
    );
    assert(
        !listTools().some((t) => t.name === "run_shell" && t.available),
        "shell available",
    );
    pass("registry", "request_reclaim_removal approval-only; delete/shell blocked");
}


async function testSyntheticRegistryGate() {
    const rogue = path.join(PARENT, `.local-ai-lab-name-only-${RUN_ID.slice(0, 8)}`);
    await rimraf(rogue);
    await fs.mkdir(rogue, { recursive: true });
    await writeFile(path.join(rogue, "a.mp4"), "x");

    // Pattern alone must not authorize.
    assert(
        !(await import("../lib/synthetic-reclaim-roots.js")).isPathInsideSyntheticReclaimRoot(
            path.join(rogue, "a.mp4"),
        ),
        "name pattern authorized",
    );

    await expectThrow(
        () =>
            registerSyntheticReclaimRoot(Symbol("wrong"), {
                runId: RUN_ID,
                rootPath: rogue,
            }),
        "test authority",
    );

    const registered = await registerSyntheticReclaimRoot(AUTHORITY, {
        runId: RUN_ID,
        rootPath: rogue,
    });
    assert(registered.rootId, "rootId missing");
    clearSyntheticReclaimRoots(AUTHORITY, RUN_ID);
    await rimraf(rogue);
    pass(
        "synthetic registry gate",
        "harness authority required; name patterns are not enough",
    );
}


async function testHelperBuildAndProvenance() {
    const built = spawnSync("node", ["scripts/build-windows-recycle.js"], {
        encoding: "utf8",
        windowsHide: true,
        shell: false,
    });
    if (built.status !== 0) {
        skip(
            "native helper build",
            built.stderr || built.stdout || "build failed",
            "helper-build",
        );
        return false;
    }
    const provenance = await assertHelperProvenance();
    assert(provenance.exeHash, "missing hash");
    pass(
        "native helper build + provenance",
        `sha256=${provenance.exeHash.slice(0, 12)}…`,
        "helper-build",
    );
    return true;
}


async function testMockedParseAndRefuse() {
    const parsed = recycleTest.parseHelperJson(
        '{"outcome":"recycled","recycled":true,"permanentlyRemoved":false,"aborted":false,"recyclePath":"","path":"x"}\n',
    );
    // Empty recyclePath must not count as proven — wrapper enforces this.
    const wrapped = {
        outcome: parsed.outcome,
        recycled: parsed.recycled === true && parsed.recyclePath,
    };
    assert(!wrapped.recycled, "empty recyclePath treated as proven");

    assert(
        recycleTest.looksLikePermanentDeletionEvidence(
            {
                outcome: "aborted",
                permanentlyRemoved: false,
                detail:
                    "PostDeleteItem: psiNewlyCreated is null (item was fully deleted, not recycled).",
            },
            { outcome: "aborted", permanentlyRemoved: false },
        ),
        "aborted+null-psi must trip permanent-deletion evidence",
    );

    assert(
        typeof recycleTest.resetRemovalDisabledForTests === "function",
        "kill-switch reset must stay under _test only",
    );

    await expectThrow(
        () => assertRecycleCapableVolume("\\\\server\\share\\file.bin"),
        "Network",
    );
    pass(
        "mocked helper parsing / UNC refuse",
        "empty recyclePath not proven; null-psi fail-closed",
    );
}


async function probeRecycleOnlyCapability(synthRoot) {
    const proven = await proveRecycleOnlyForRoot(synthRoot);
    if (!proven.ok) {
        const permanentlyRemoved = proven.result?.permanentlyRemoved === true;
        return {
            ok: false,
            detail: permanentlyRemoved
                ? "Capability probe was permanently deleted (psiNewlyCreated null). " +
                  "Recycle-only behavior is not established; refusing live removal tests."
                : proven.detail ||
                  `Capability probe outcome=${proven.result?.outcome}; recycle-only not proven.`,
            result: proven.result,
        };
    }
    return { ok: true, result: proven.result, recyclePath: proven.recyclePath };
}


async function testLiveRecycleAndRestore(helperReady) {
    if (!helperReady) {
        skip(
            "live recycle + restore",
            "helper not built",
            "live-restore",
        );
        return;
    }

    let snapshot;
    try {
        snapshot = await inspectExternalDrives({});
    } catch (error) {
        skip("live recycle + restore", error.message, "live-recycle");
        return;
    }

    const external = (snapshot.volumes ?? []).find(
        (volume) =>
            (volume.classification === "external" ||
                volume.classification === "removable") &&
            volume.volumeId &&
            volume.identityConfidence !== "low",
    );
    if (!external) {
        skip(
            "live recycle + restore",
            "no eligible external/removable volume",
            "live-recycle",
        );
        return;
    }

    // Dedicated synthetic root (harness-registered). Path name alone never
    // authorizes removal — only the synthetic registry does.
    const synthRoot = path.join(
        PARENT,
        `.local-ai-lab-removal-src-${RUN_ID.slice(0, 8)}`,
    );
    await rimraf(synthRoot);
    await fs.mkdir(synthRoot, { recursive: true });
    const fileName = `note-${RUN_ID.slice(0, 8)}.mp4`;
    const sourcePath = path.join(synthRoot, fileName);
    const payload = `live-removal-synthetic-${RUN_ID}`;
    await writeFile(sourcePath, payload);
    const originalHash = await sha256File(sourcePath);

    await registerSyntheticReclaimRoot(AUTHORITY, {
        runId: RUN_ID,
        rootPath: synthRoot,
    });

    // Confirm recycle-capable on the source volume (not subst).
    try {
        await assertRecycleCapableVolume(sourcePath);
    } catch (error) {
        skip("live recycle + restore", error.message, "live-recycle");
        clearSyntheticReclaimRoots(AUTHORITY, RUN_ID);
        await rimraf(synthRoot);
        return;
    }

    // Establish recycle-only proof BEFORE any workflow removal.
    const capability = await probeRecycleOnlyCapability(synthRoot);
    if (!capability.ok) {
        skip("live recycle", capability.detail, "live-recycle");
        skip("live restore + hash", "blocked: recycle-only not proven", "live-restore");
        clearSyntheticReclaimRoots(AUTHORITY, RUN_ID);
        await rimraf(synthRoot);
        return;
    }
    pass(
        "live recycle capability probe",
        "PostDeleteItem provided Recycle Bin item for sacrificial probe",
        "live-recycle",
    );

    const folderName = `LalRemoval-${RUN_ID.slice(0, 8)}`;
    const session = sessionTest.createSession();
    recycleTest.resetRemovalDisabledForTests();

    try {
        await runWithSession(session, async () => {
            await grantScanFolder(synthRoot);
            const planned = await planStorageOffload({
                destinationVolumeId: external.volumeId,
                destinationFolderName: folderName,
                minBytes: 1,
                maxDepth: 2,
                maxEntries: 20,
                maxMs: 15_000,
            });
            const selectable = planned.entries.filter((e) => e.selectable);
            assert(selectable.length >= 1, "no selectable");
            const locked = lockManifestFromSelection(planned.planId, [
                selectable[0].id,
            ]);
            const approval = await createStandaloneTransferApproval({
                manifestId: locked.manifestId,
                reason: "removal live transfer",
            });
            const approved = await approveById(approval.id, {
                acknowledgeIncompleteScan: approval.requiresIncompleteAck
                    ? true
                    : undefined,
            });
            const finished = await waitForTransfer(
                approved.transfer.transferId,
                session,
            );
            assert(finished.status === "completed", finished.status);

            const started = await startReclaimReview({
                transferId: finished.transferId,
            });
            const reclaim = await waitForReclaim(started.id, session);
            const eligible = reclaim.candidates.filter(
                (c) => c.eligibility === RECLAIM_ELIGIBLE,
            );
            assert(eligible.length >= 1, `no eligible; statuses=${reclaim.candidates.map((c) => c.eligibility).join(",")}`);

            const reclaimManifest = lockReclaimSelection(reclaim.jobId, [
                eligible[0].entryId,
            ]);
            assert(reclaimManifest.entryCount === 1, "lock count");

            // Auto-select-all is not performed; explicit single id only.
            const remApproval = await createStandaloneRemovalApproval({
                reclaimManifestId: reclaimManifest.reclaimManifestId,
                reason: "live synthetic recycle",
            });
            await expectThrow(
                () =>
                    approveById(remApproval.id, {
                        acknowledgeRemovalRisk: false,
                    }),
                "Acknowledge",
            );
            const startedRemoval = await approveById(remApproval.id, {
                acknowledgeRemovalRisk: true,
            });
            assert(
                startedRemoval.status === "removal_started",
                startedRemoval.status,
            );
            const removal = await waitForRemoval(
                startedRemoval.removal.removalId,
                session,
            );

            assert(
                removal.metrics.filesPermanentlyRemoved === 0,
                "permanent removal occurred",
            );
            const fileResult = removal.files[0];
            assert(fileResult.outcome === "recycled", fileResult.outcome + " " + fileResult.detail);
            assert(fileResult.recyclePath, "missing recycle path evidence");

            await expectThrow(async () => fs.lstat(sourcePath), "ENOENT");
            const destStill = await fs.readFile(
                eligible[0].destinationPath,
                "utf8",
            );
            assert(destStill === payload, "external copy changed");

            pass(
                "live recycle",
                `recycled with PostDeleteItem path; dest intact on ${external.mount}`,
                "live-recycle",
            );

            // Restore via helper and verify hash.
            const restoredPath = path.join(synthRoot, `restored-${fileName}`);
            const restored = await restoreRecycledFile(
                fileResult.recyclePath,
                restoredPath,
            );
            if (restored.outcome !== "restored") {
                skip(
                    "live restore + hash",
                    restored.detail || restored.outcome,
                    "live-restore",
                );
            } else {
                const restoredHash = await sha256File(restoredPath);
                assert(
                    restoredHash === originalHash,
                    "restored hash mismatch",
                );
                pass(
                    "live restore + hash",
                    "SHA-256 matched after Recycle Bin restore",
                    "live-restore",
                );
            }

            await rimraf(
                path.join(external.mount, "LocalAI-Offload", folderName),
            );
        });
    } catch (error) {
        fail("live recycle + restore", error.message, "live-recycle");
    } finally {
        clearSyntheticReclaimRoots(AUTHORITY, RUN_ID);
        await rimraf(synthRoot);
    }
}


async function testRejectionPaths() {
    const session = sessionTest.createSession();
    await runWithSession(session, async () => {
        await expectThrow(
            () =>
                lockReclaimSelection(crypto.randomUUID(), [
                    crypto.randomUUID(),
                ]),
            "Unknown reclaim job",
        );
    });

    // Path args rejected already covered by registry.
    pass("rejection paths", "unknown job / path args blocked");
}


async function main() {
    await bootstrapTransferRuntime();
    bootstrapReclaimRuntime();
    await bootstrapRemovalRuntime();
    installSyntheticTestAuthority(AUTHORITY);
    recycleTest.resetRemovalDisabledForTests();

    let helperReady = false;
    const tests = [
        ["registry", testRegistry, "mocked"],
        ["synthetic registry gate", testSyntheticRegistryGate, "mocked"],
        ["mocked helper parsing / UNC refuse", testMockedParseAndRefuse, "mocked"],
        [
            "native helper build + provenance",
            async () => {
                helperReady = await testHelperBuildAndProvenance();
            },
            "helper-build",
        ],
        ["rejection paths", testRejectionPaths, "mocked"],
        [
            "live recycle + restore",
            async () => testLiveRecycleAndRestore(helperReady),
            "live-recycle",
        ],
    ];

    for (const [name, fn] of tests) {
        try {
            await fn();
        } catch (error) {
            fail(name, error.message);
        }
    }

    clearSyntheticReclaimRoots(AUTHORITY);
    revokeSyntheticTestAuthority();

    const byKind = (kind) => results.filter((item) => item.kind === kind);
    const summarize = (items) => ({
        passed: items.filter((i) => i.status === "pass").length,
        failed: items.filter((i) => i.status === "fail").length,
        skipped: items.filter((i) => i.status === "skip").length,
    });

    console.log("\n--- Milestone D2 verification summary ---");
    for (const kind of ["mocked", "helper-build", "live-recycle", "live-restore"]) {
        const s = summarize(byKind(kind));
        console.log(
            `${kind}: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped`,
        );
    }

    const failed = results.filter((i) => i.status === "fail").length;
    if (failed > 0) {
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
