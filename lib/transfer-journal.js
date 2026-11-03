// =========================================================
// lib/transfer-journal.js
//
// Private, durable transfer journals. Not exposed over HTTP.
// Crash-consistent updates via temp + rename.
// =========================================================


import fs from "node:fs/promises";
import path from "node:path";
import { constants as fsConstants } from "node:fs";


const JOURNAL_DIR = path.join(process.cwd(), "data", "transfer-journal");

export const FILE_STATES = Object.freeze([
    "pending",
    "copying",
    "copied",
    "verifying",
    "verified",
    "failed",
    "interrupted",
    "skipped",
]);


async function ensureJournalDir() {
    await fs.mkdir(JOURNAL_DIR, { recursive: true });

    if (process.platform === "win32") {
        try {
            // Best-effort: hide the directory from casual browsing.
            await fs.rename(JOURNAL_DIR, JOURNAL_DIR);
        } catch {
            // ignore
        }
    }
}


function journalPath(transferId) {
    if (
        typeof transferId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(transferId)
    ) {
        throw new Error("Invalid transfer id.");
    }

    return path.join(JOURNAL_DIR, `${transferId}.json`);
}


/**
 * Crash-consistent write: write temp exclusively, fsync, rename.
 *
 * @param {string} transferId
 * @param {object} record
 */
export async function writeTransferJournal(transferId, record) {
    await ensureJournalDir();
    const target = journalPath(transferId);
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    const payload = `${JSON.stringify(record, null, 2)}\n`;

    let handle;
    try {
        handle = await fs.open(temp, "wx");
        await handle.writeFile(payload, "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temp, target);
    } catch (error) {
        if (handle) {
            try {
                await handle.close();
            } catch {
                // ignore
            }
        }
        try {
            await fs.unlink(temp);
        } catch {
            // ignore
        }
        throw error;
    }

    return record;
}


export async function readTransferJournal(transferId) {
    const target = journalPath(transferId);

    try {
        const raw = await fs.readFile(target, "utf8");
        return JSON.parse(raw);
    } catch (error) {
        if (error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}


export async function listTransferJournalIds() {
    await ensureJournalDir();
    const names = await fs.readdir(JOURNAL_DIR);
    return names
        .filter((name) => name.endsWith(".json") && !name.includes(".tmp"))
        .map((name) => name.slice(0, -".json".length));
}


/**
 * Mark any journals still "running"/"starting"/"cancelling" as interrupted.
 * Never auto-resumes. Called once at process boot.
 */
export async function markUnfinishedJournalsInterrupted() {
    const ids = await listTransferJournalIds();
    const updated = [];

    for (const id of ids) {
        const record = await readTransferJournal(id);
        if (!record) {
            continue;
        }

        if (
            record.status === "running" ||
            record.status === "starting" ||
            record.status === "cancelling"
        ) {
            record.status = "interrupted";
            record.interruptedAt = new Date().toISOString();
            record.interruptReason = "server_restart";
            for (const file of record.files ?? []) {
                if (
                    file.state === "pending" ||
                    file.state === "copying" ||
                    file.state === "copied" ||
                    file.state === "verifying"
                ) {
                    file.state = "interrupted";
                    file.failureCode = file.failureCode ?? "INTERRUPTED";
                }
            }
            await writeTransferJournal(id, record);
            updated.push(id);
        }
    }

    return updated;
}


export function getJournalDirectory() {
    return JOURNAL_DIR;
}


/** Test helpers */
export const _test = {
    journalPath,
    JOURNAL_DIR,
    fsConstants,
};
