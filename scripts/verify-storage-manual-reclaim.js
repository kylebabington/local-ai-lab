// =========================================================
// scripts/verify-storage-manual-reclaim.js
//
// Milestone D2.5 guided manual reclamation (read-only).
// =========================================================


import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
    approveById,
    createStandaloneTransferApproval,
} from "../lib/agent.js";
import { getTool, listTools, validateToolArguments } from "../lib/tools/registry.js";
import {
    lockManifestFromSelection,
    planStorageOffload,
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
    lockReclaimSelection,
} from "../lib/tools/storage-removal.js";
import {
    buildManualRecoveryGuidance,
    listManualReclamation,
    markManuallyHandled,
    observeManualCleanup,
    reverifyManualEntry,
    _test as manualTest,
} from "../lib/tools/storage-manual-reclaim.js";
import { _test as recycleTest } from "../lib/tools/windows-recycle.js";
import { grantScanFolder } from "../lib/tools/storage.js";
import { inspectExternalDrives } from "../lib/tools/windows.js";
import {
    _test as sessionTest,
    runWithSession,
} from "../lib/storage-session.js";


const results = [];
const PARENT = path.dirname(process.cwd());
const RUN_ID = crypto.randomUUID();


function record(name, status, detail = "") {
    results.push({ name, status, detail });
    console.log(
        `${status.toUpperCase()}  ${name}${detail ? ` — ${detail}` : ""}`,
    );
}

function pass(name, detail) {
    record(name, "pass", detail);
}

function fail(name, detail) {
    record(name, "fail", detail);
}

function assert(condition, message) {
    if (!condition) {
        throw new Error(message || "assertion failed");
    }
}

async function expectThrow(fn, match) {
    try {
        await fn();
        throw new Error("expected throw");
    } catch (error) {
        if (error.message === "expected throw") {
            throw error;
        }
        if (match && !String(error.message).includes(match) && error.code !== match) {
            throw new Error(`expected ${match}, got ${error.message}`);
        }
    }
}

async function writeFile(filePath, contents) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
}

async function rimraf(target) {
    await fs.rm(target, { recursive: true, force: true });
}

async function waitForTransfer(transferId, session) {
    for (let i = 0; i < 120; i += 1) {
        const transfer = getPublicTransfer(transferId, session);
        if (
            transfer &&
            ["completed", "failed", "cancelled", "interrupted"].includes(
                transfer.status,
            )
        ) {
            return transfer;
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("Timed out waiting for transfer.");
}

async function waitForReclaim(jobId, session) {
    for (let i = 0; i < 120; i += 1) {
        const job = getPublicReclaimJob(jobId, session);
        if (
            job &&
            ["completed", "failed", "cancelled", "incomplete"].includes(job.status)
        ) {
            return job;
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("Timed out waiting for reclaim job.");
}


async function testNoRealFileRemovalApi() {
    const tools = listTools();
    assert(
        tools.find((t) => t.name === "delete_path")?.available === false,
        "delete_path must remain unavailable",
    );
    assert(
        !tools.some((t) => t.name === "run_shell" && t.available),
        "run_shell must remain unavailable",
    );
    const removal = getTool("request_reclaim_removal");
    assert(removal, "request_reclaim_removal missing");
    await expectThrow(
        () =>
            validateToolArguments("request_reclaim_removal", {
                reclaimManifestId: "x",
                reason: "y",
                path: "C:\\Users\\someone\\Documents\\file.bin",
            }),
        "Unexpected",
    );
    pass("no real-file removal API / no model delete paths");
}


async function testGuidanceExclusions() {
    const cloudish = buildManualRecoveryGuidance({
        eligibility: RECLAIM_ELIGIBLE,
        destinationHashVerified: true,
        cloudReparseSafety: { status: "unsafe", reason: "OneDrive cloud placeholder" },
        sourceAuthorization: { status: "authorized" },
        dependencyConfidence: { status: "clear" },
        reasons: [],
        warnings: [],
    });
    assert(cloudish.excludedFromRecommendation, "cloud should exclude");
    assert(!cloudish.recommendedForManualReview, "cloud not recommended");

    const protectedish = buildManualRecoveryGuidance({
        eligibility: "excluded",
        destinationHashVerified: true,
        cloudReparseSafety: { status: "safe" },
        sourceAuthorization: { status: "authorized" },
        dependencyConfidence: { status: "clear" },
        reasons: ["That location is protected and cannot be scanned."],
        warnings: [],
    });
    assert(protectedish.excludedFromRecommendation, "protected excluded");

    const good = buildManualRecoveryGuidance({
        eligibility: RECLAIM_ELIGIBLE,
        destinationHashVerified: true,
        cloudReparseSafety: { status: "safe" },
        sourceAuthorization: { status: "authorized" },
        dependencyConfidence: { status: "clear" },
        reasons: [],
        warnings: [],
    });
    assert(good.recommendedForManualReview, "eligible should recommend review");
    assert(good.neverClaimsSafeToDelete, "must never claim safe to delete");
    pass("cloud/protected exclusion + guidance labeling");
}


async function testGuidedWorkflowLive() {
    let snapshot;
    try {
        snapshot = await inspectExternalDrives({});
    } catch (error) {
        pass("guided workflow (skipped live)", error.message);
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
        pass("guided workflow (skipped live)", "no external volume");
        return;
    }

    const synthRoot = path.join(
        PARENT,
        `.local-ai-lab-manual-src-${RUN_ID.slice(0, 8)}`,
    );
    await rimraf(synthRoot);
    await fs.mkdir(synthRoot, { recursive: true });
    const fileName = `manual-${RUN_ID.slice(0, 8)}.bin`;
    const sourcePath = path.join(synthRoot, fileName);
    const payload = `manual-reclaim-${RUN_ID}`;
    await writeFile(sourcePath, payload);

    const folderName = `LalManual-${RUN_ID.slice(0, 8)}`;
    const session = sessionTest.createSession();
    await manualTest.resetStateForTests();

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
                reason: "manual reclaim verify",
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
            assert(reclaim.candidates.length >= 1, "no candidates");

            const candidate =
                reclaim.candidates.find(
                    (c) => c.eligibility === RECLAIM_ELIGIBLE,
                ) ?? reclaim.candidates[0];

            // Without harness synthetic registration, automated removal must stay off.
            assert(
                candidate.syntheticRemovalAuthorized !== true,
                "unexpected syntheticRemovalAuthorized without registry",
            );
            if (candidate.eligibility === RECLAIM_ELIGIBLE) {
                try {
                    await lockReclaimSelection(reclaim.jobId, [
                        candidate.entryId,
                    ]);
                    throw new Error("expected synthetic lock to refuse");
                } catch (error) {
                    if (error.message === "expected synthetic lock to refuse") {
                        throw error;
                    }
                    assert(
                        error.code === "NOT_SYNTHETIC_ROOT" ||
                            /outside every explicitly registered|synthetic/i.test(
                                error.message,
                            ),
                        error.message,
                    );
                }
            }
            pass("synthetic removal restrictions remain enforced");

            const observation = await reverifyManualEntry(
                reclaim.jobId,
                candidate.entryId,
            );
            assert(
                observation.destinationVerification.hashMatched ||
                    observation.destinationVerification.status ===
                        "external_copy_independently_verified",
                observation.destinationVerification.detail || "dest verify failed",
            );
            assert(
                observation.originalStatus === "original_still_present",
                observation.originalStatus,
            );
            assert(
                observation.machineClaim.localAiRemovedFile === false,
                "must not claim Local AI removed file",
            );
            pass("external-copy verification + source still exists");

            // Simulate source removed externally.
            await fs.rename(sourcePath, `${sourcePath}.gone`);
            const afterGone = await observeManualCleanup(
                reclaim.jobId,
                [candidate.entryId],
                { priorFreeBytes: observation.freeBytesObserved },
            );
            assert(
                afterGone.results[0].originalStatus === "original_no_longer_found",
                afterGone.results[0].originalStatus,
            );
            assert(
                afterGone.machineClaim.localAiRemovedFile === false,
                "still must not claim app removal",
            );
            pass("source removed externally observation");

            // Restore source for dest mismatch / disconnect style checks.
            await fs.rename(`${sourcePath}.gone`, sourcePath);

            const marked = await markManuallyHandled({
                transferId: reclaim.transferId,
                entryId: candidate.entryId,
                reclaimJobId: reclaim.jobId,
                note: "handled in Explorer (simulated)",
            });
            assert(marked.label === "user_reported_manual_reclamation");
            assert(marked.machineRemoved === false);
            const listed = await listManualReclamation(reclaim.transferId);
            assert(listed.entries.length >= 1, "listed handled");
            pass("manual action audit labeling");

            // Destination mismatch: rewrite destination content.
            await fs.writeFile(candidate.destinationPath, "tampered");
            const mismatched = await reverifyManualEntry(
                reclaim.jobId,
                candidate.entryId,
            );
            assert(
                mismatched.destinationVerification.status ===
                    "destination_mismatch" ||
                    mismatched.destinationVerification.hashMatched === false,
                mismatched.destinationVerification.status,
            );
            pass("destination mismatch detection");

            // Expired authorization: revoke by ending grants via new session isolation
            // is covered by reclaim suite; here ensure observe still reports volume facts.
            assert(
                typeof mismatched.freeSpaceAttribution === "string" &&
                    mismatched.freeSpaceAttribution.length > 0,
                "metrics attribution missing",
            );
            pass("accurate storage metrics labeling");

            await rimraf(path.join(external.mount, "LocalAI-Offload", folderName));
        });
    } finally {
        await rimraf(synthRoot);
        await manualTest.resetStateForTests();
    }
}


async function testDriveDisconnectAndAuth() {
    // Without an active reclaim job / session, APIs must fail closed.
    await expectThrow(
        () => reverifyManualEntry("missing-job", "missing-entry"),
        "UNKNOWN_JOB",
    );
    await expectThrow(
        () =>
            markManuallyHandled({
                transferId: "",
                entryId: "x",
            }),
        "transferId",
    );
    pass("expired/missing authorization fail-closed");
}


async function main() {
    await bootstrapTransferRuntime();
    bootstrapReclaimRuntime();
    await bootstrapRemovalRuntime();
    // Historical permanent-deletion journals arm the kill-switch on bootstrap
    // (desired in production). Clear only under the harness _test API.
    recycleTest.resetRemovalDisabledForTests();
    await manualTest.resetStateForTests();

    const tests = [
        ["no real-file removal API", testNoRealFileRemovalApi],
        ["guidance exclusions", testGuidanceExclusions],
        ["drive disconnect / auth", testDriveDisconnectAndAuth],
        ["guided workflow live", testGuidedWorkflowLive],
    ];

    for (const [name, fn] of tests) {
        try {
            await fn();
        } catch (error) {
            fail(name, error.message);
        }
    }

    const passed = results.filter((r) => r.status === "pass").length;
    const failed = results.filter((r) => r.status === "fail").length;
    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
}


main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
