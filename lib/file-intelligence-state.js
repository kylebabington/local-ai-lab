// =========================================================
// lib/file-intelligence-state.js
//
// Single shared coordinator for mutating File Intelligence
// operations (Phase 4A metadata + Phase 4B content index).
//
// Prevents check-then-start races between independent modules.
// Read-only paths (search, status, File RAG retrieval) do not
// acquire this lock.
// =========================================================


/** @typedef {"addRoot" | "removeRoot" | "scan" | "contentIndex"} FileIntelligenceOperation */

/** @type {FileIntelligenceOperation | null} */
let activeOperation = null;


/**
 * @param {FileIntelligenceOperation} active
 * @param {FileIntelligenceOperation} requested
 */
function busyMessage(active, requested) {
    const labels = {
        addRoot: "a root is being added",
        removeRoot: "a root is being removed",
        scan: "a metadata scan is running",
        contentIndex: "a content-index build is running",
    };

    return (
        `File Intelligence is busy (${labels[active] ?? active}). ` +
        `Cannot start ${requested} until it finishes.`
    );
}


/**
 * @returns {FileIntelligenceOperation | null}
 */
export function getActiveFileIntelligenceOperation() {
    return activeOperation;
}


/**
 * @returns {boolean}
 */
export function isFileIntelligenceBusy() {
    return activeOperation !== null;
}


/**
 * @returns {boolean}
 */
export function isFileContentIndexing() {
    return activeOperation === "contentIndex";
}


/**
 * @returns {boolean}
 */
export function isFileInventoryScanning() {
    return activeOperation === "scan";
}


/**
 * Atomically claim the File Intelligence mutation lock, run work,
 * and release in finally. Concurrent callers receive 409.
 *
 * Do not call this again from inside `work` (no nested acquisition).
 *
 * @template T
 * @param {FileIntelligenceOperation} operation
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function runFileIntelligenceMutation(operation, work) {
    if (activeOperation !== null) {
        const error = new Error(busyMessage(activeOperation, operation));
        error.status = 409;
        throw error;
    }

    activeOperation = operation;

    try {
        return await work();
    } finally {
        activeOperation = null;
    }
}


/** Test helpers — not for production routes. */
export const _test = {
    reset() {
        activeOperation = null;
    },
};
