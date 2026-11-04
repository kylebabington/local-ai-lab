// =========================================================
// lib/tools/windows-recycle.js
//
// Node wrapper for the pinned windows-recycle.exe helper.
// Verifies provenance hash before every launch. shell:false.
// Never uses fs.unlink or PowerShell Remove-Item.
// =========================================================


import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const HELPER_DIR = path.join(ROOT, "native", "windows-recycle");
export const HELPER_EXE = path.join(HELPER_DIR, "windows-recycle.exe");
export const HELPER_MANIFEST = path.join(HELPER_DIR, "windows-recycle.provenance.json");
export const HELPER_SOURCE = path.join(HELPER_DIR, "windows-recycle.c");
export const EXPECTED_HELPER_VERSION = "local-ai-lab-windows-recycle/1.0.0";

export const HELPER_TIMEOUT_MS = 30_000;
export const HELPER_MAX_STDOUT_BYTES = 16_384;

/** Global kill-switch after permanent-deletion evidence. */
let removalDisabledReason = null;

/** @type {Map<string, { provenAt: string, recyclePath: string }>} */
const recycleCapabilityByRoot = new Map();


export function getRemovalDisabledReason() {
    return removalDisabledReason;
}


export function disableFurtherRemovals(reason) {
    removalDisabledReason = reason || "Removal disabled after critical failure.";
}


function resetRemovalDisabledForTests() {
    removalDisabledReason = null;
}


function looksLikePermanentDeletionEvidence(parsed, result) {
    if (result?.permanentlyRemoved === true) {
        return true;
    }
    if (parsed?.permanentlyRemoved === true) {
        return true;
    }
    if (String(parsed?.outcome || result?.outcome || "") === "permanently_removed") {
        return true;
    }
    const detail = String(parsed?.detail || result?.detail || "").toLowerCase();
    if (
        detail.includes("psinewlycreated") &&
        (detail.includes("null") || detail.includes("fully deleted"))
    ) {
        return true;
    }
    return false;
}


async function sha256File(filePath) {
    const buf = await fs.readFile(filePath);
    return createHash("sha256").update(buf).digest("hex");
}


export async function loadHelperProvenance() {
    const raw = await fs.readFile(HELPER_MANIFEST, "utf8");
    return JSON.parse(raw);
}


/**
 * Verify helper exists and matches pinned provenance.
 */
export async function assertHelperProvenance() {
    if (process.platform !== "win32") {
        throw Object.assign(new Error("Recycle helper is Windows-only."), {
            code: "UNSUPPORTED_PLATFORM",
            status: 400,
        });
    }

    let manifest;
    try {
        manifest = await loadHelperProvenance();
    } catch {
        throw Object.assign(
            new Error(
                "Recycle helper provenance manifest missing. Run scripts/build-windows-recycle.js.",
            ),
            { code: "HELPER_NOT_BUILT", status: 503 },
        );
    }

    if (manifest.helperVersion !== EXPECTED_HELPER_VERSION) {
        throw Object.assign(
            new Error("Recycle helper version mismatch."),
            { code: "HELPER_VERSION_MISMATCH", status: 503 },
        );
    }

    const exeHash = await sha256File(HELPER_EXE);
    if (exeHash !== manifest.exeSha256) {
        throw Object.assign(
            new Error("Recycle helper executable hash does not match provenance."),
            { code: "HELPER_HASH_MISMATCH", status: 503 },
        );
    }

    if (manifest.sourceSha256) {
        const sourceHash = await sha256File(HELPER_SOURCE);
        if (sourceHash !== manifest.sourceSha256) {
            throw Object.assign(
                new Error(
                    "Recycle helper source hash does not match provenance. Rebuild with scripts/build-windows-recycle.js.",
                ),
                { code: "HELPER_SOURCE_MISMATCH", status: 503 },
            );
        }
    }

    // Ensure we only launch the application-controlled path.
    const realExe = await fs.realpath(HELPER_EXE);
    const expectedDir = await fs.realpath(HELPER_DIR);
    if (!realExe.toLowerCase().startsWith(expectedDir.toLowerCase() + path.sep) &&
        realExe.toLowerCase() !== expectedDir.toLowerCase()) {
        // file inside dir
        if (!realExe.toLowerCase().startsWith(expectedDir.toLowerCase())) {
            throw Object.assign(
                new Error("Recycle helper escaped the controlled native directory."),
                { code: "HELPER_PATH_ESCAPE", status: 503 },
            );
        }
    }

    return { manifest, exeHash, exePath: realExe };
}


function parseHelperJson(stdout) {
    const text = String(stdout || "").trim();
    if (!text) {
        return null;
    }
    // Take last JSON line.
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    try {
        return JSON.parse(last);
    } catch {
        return null;
    }
}


function runHelper(envExtra, timeoutMs = HELPER_TIMEOUT_MS) {
    return new Promise(async (resolve) => {
        let provenance;
        try {
            provenance = await assertHelperProvenance();
        } catch (error) {
            resolve({
                outcome: "indeterminate",
                recycled: false,
                permanentlyRemoved: false,
                aborted: false,
                detail: error.message,
                code: error.code ?? "HELPER_PROVENANCE",
                raw: null,
            });
            return;
        }

        const child = spawn(provenance.exePath, [], {
            env: {
                ...process.env,
                ...envExtra,
            },
            windowsHide: true,
            shell: false,
            cwd: HELPER_DIR,
        });

        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let settled = false;
        let stdoutOverflow = false;

        const timer = setTimeout(() => {
            if (!settled) {
                child.kill();
            }
        }, timeoutMs);

        child.stdout.on("data", (chunk) => {
            if (stdout.length + chunk.length > HELPER_MAX_STDOUT_BYTES) {
                stdoutOverflow = true;
                child.kill();
                return;
            }
            stdout = Buffer.concat([stdout, chunk]);
        });
        child.stderr.on("data", (chunk) => {
            if (stderr.length < HELPER_MAX_STDOUT_BYTES) {
                stderr = Buffer.concat([stderr, chunk]);
            }
        });

        child.on("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
                outcome: "indeterminate",
                recycled: false,
                permanentlyRemoved: false,
                aborted: false,
                detail: error.message,
                code: "HELPER_SPAWN_ERROR",
                raw: null,
            });
        });

        child.on("close", (exitCode, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);

            if (stdoutOverflow) {
                resolve({
                    outcome: "indeterminate",
                    recycled: false,
                    permanentlyRemoved: false,
                    aborted: false,
                    detail: "Helper stdout exceeded bound.",
                    code: "HELPER_STDOUT_OVERFLOW",
                    raw: null,
                });
                return;
            }

            const parsed = parseHelperJson(stdout.toString("utf8"));
            if (!parsed || typeof parsed !== "object") {
                resolve({
                    outcome: "indeterminate",
                    recycled: false,
                    permanentlyRemoved: false,
                    aborted: Boolean(signal),
                    detail: signal
                        ? `Helper killed (${signal}).`
                        : `Unreadable helper output (exit=${exitCode}).`,
                    code: "HELPER_BAD_OUTPUT",
                    raw: stdout.toString("utf8").slice(0, 500),
                    exitCode,
                });
                return;
            }

            const outcome = String(parsed.outcome || "indeterminate");
            const recycled = parsed.recycled === true && outcome === "recycled";
            // Never trust recycled without positive evidence fields.
            const proven =
                recycled &&
                typeof parsed.recyclePath === "string" &&
                parsed.recyclePath.length > 0 &&
                parsed.permanentlyRemoved !== true;

            const result = {
                outcome: proven ? "recycled" : outcome === "recycled" ? "indeterminate" : outcome,
                recycled: proven,
                permanentlyRemoved: parsed.permanentlyRemoved === true,
                aborted: parsed.aborted === true || outcome === "aborted",
                detail: parsed.detail || null,
                recyclePath: parsed.recyclePath || null,
                path: parsed.path || null,
                hr: parsed.hr ?? null,
                helperVersion: parsed.helperVersion || null,
                exitCode,
                raw: parsed,
            };

            // Defense in depth: never treat recycled as proven without path,
            // and never miss permanent-deletion evidence masked as aborted.
            if (looksLikePermanentDeletionEvidence(parsed, result)) {
                result.permanentlyRemoved = true;
                result.recycled = false;
                if (result.outcome === "recycled" || result.outcome === "aborted") {
                    result.outcome = "permanently_removed";
                }
                disableFurtherRemovals(
                    "Permanent deletion evidence from Recycle Bin helper; further removals disabled.",
                );
            }

            if (result.outcome === "recycled" && !result.recycled) {
                result.outcome = "indeterminate";
            }

            resolve(result);
        });
    });
}


export async function probeRecyclePath(filePath) {
    return runHelper({
        LOCAL_AI_RECYCLE_MODE: "probe",
        LOCAL_AI_RECYCLE_PATH: path.resolve(filePath),
    });
}


export async function recycleFile(filePath, identity = {}) {
    if (removalDisabledReason) {
        return {
            outcome: "failed",
            recycled: false,
            permanentlyRemoved: false,
            aborted: false,
            detail: removalDisabledReason,
            code: "REMOVAL_DISABLED",
        };
    }

    const env = {
        LOCAL_AI_RECYCLE_MODE: "recycle",
        LOCAL_AI_RECYCLE_PATH: path.resolve(filePath),
    };
    if (identity.sizeBytes != null) {
        env.LOCAL_AI_RECYCLE_EXPECT_SIZE = String(identity.sizeBytes);
    }
    if (identity.mtimeMs != null) {
        env.LOCAL_AI_RECYCLE_EXPECT_MTIME_MS = String(Math.trunc(identity.mtimeMs));
    }
    return runHelper(env);
}


/**
 * Prove recycle-only behavior on a root by recycling a sacrificial file.
 * Must succeed with PostDeleteItem evidence before any real removal job.
 */
export async function proveRecycleOnlyForRoot(rootPath) {
    const root = path.resolve(rootPath);
    if (recycleCapabilityByRoot.has(root.toLowerCase())) {
        return { ok: true, cached: true, ...recycleCapabilityByRoot.get(root.toLowerCase()) };
    }

    await assertRecycleCapableVolume(root);
    await assertHelperProvenance();

    const probePath = path.join(
        root,
        `.localai-recycle-probe-${Date.now()}-${process.pid}.bin`,
    );
    const payload = `recycle-probe-${Date.now()}`;
    await fs.writeFile(probePath, payload);
    const stat = await fs.lstat(probePath);
    const result = await recycleFile(probePath, {
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
    });

    if (result.permanentlyRemoved) {
        disableFurtherRemovals(
            "Recycle capability probe was permanently deleted; further removals disabled.",
        );
        return {
            ok: false,
            detail: result.detail,
            result,
        };
    }

    if (!(result.recycled && result.recyclePath)) {
        // Leave any leftover probe file in place — never fs.unlink as a
        // removal fallback (hard boundary). Harness/temp roots clean up later.
        return {
            ok: false,
            detail: result.detail || `Probe outcome=${result.outcome}`,
            result,
            leftoverProbePath: probePath,
        };
    }

    const record = {
        provenAt: new Date().toISOString(),
        recyclePath: result.recyclePath,
    };
    recycleCapabilityByRoot.set(root.toLowerCase(), record);
    return { ok: true, cached: false, result, ...record };
}


export async function restoreRecycledFile(recyclePath, destinationPath) {
    if (removalDisabledReason) {
        return {
            outcome: "failed",
            recycled: false,
            permanentlyRemoved: false,
            aborted: false,
            detail: removalDisabledReason,
            code: "REMOVAL_DISABLED",
        };
    }

    return runHelper({
        LOCAL_AI_RECYCLE_MODE: "restore",
        LOCAL_AI_RECYCLE_PATH: path.resolve(recyclePath),
        LOCAL_AI_RECYCLE_RESTORE_DEST: path.resolve(destinationPath),
    });
}


/**
 * Refuse volumes that cannot guarantee recycle-only behavior.
 * subst drives and UNC paths are rejected.
 */
export async function assertRecycleCapableVolume(absolutePath) {
    const resolved = path.resolve(absolutePath);
    if (resolved.startsWith("\\\\")) {
        throw Object.assign(
            new Error("Network/UNC paths cannot use recycle-only removal."),
            { code: "RECYCLE_UNSUPPORTED", status: 409 },
        );
    }

    // Detect subst: QueryDosDevice on the drive letter.
    const match = /^([A-Za-z]):\\/.exec(resolved);
    if (!match) {
        throw Object.assign(
            new Error("Path is not on a local drive letter."),
            { code: "RECYCLE_UNSUPPORTED", status: 409 },
        );
    }

    const { spawnSync } = await import("node:child_process");
    const letter = `${match[1].toUpperCase()}:`;
    const q = spawnSync("cmd.exe", ["/d", "/s", "/c", "subst"], {
        encoding: "utf8",
        windowsHide: true,
        shell: false,
    });
    const substOut = `${q.stdout || ""}\n${q.stderr || ""}`.toUpperCase();
    // subst lists like `R:\: => C:\path`
    if (substOut.includes(`${letter}\\:`)) {
        throw Object.assign(
            new Error(
                "subst/mapped drives do not provide a trustworthy Recycle Bin; refusing removal.",
            ),
            { code: "RECYCLE_UNSUPPORTED", status: 409 },
        );
    }

    return { drive: letter, path: resolved };
}


export const _test = {
    parseHelperJson,
    HELPER_EXE,
    HELPER_MANIFEST,
    HELPER_SOURCE,
    runHelper,
    resetRemovalDisabledForTests,
    looksLikePermanentDeletionEvidence,
};
