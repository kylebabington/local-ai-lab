// =========================================================
// lib/activity.js
//
// Append-only JSONL audit log for tool activity.
// =========================================================


import fs from "node:fs/promises";
import path from "node:path";


const ACTIVITY_PATH = path.join(process.cwd(), "data", "tool-activity.jsonl");
const MAX_RECORDS = 200;


async function ensureActivityFile() {
    await fs.mkdir(path.dirname(ACTIVITY_PATH), { recursive: true });

    try {
        await fs.access(ACTIVITY_PATH);
    } catch {
        await fs.writeFile(ACTIVITY_PATH, "", "utf8");
    }
}


/**
 * @param {object} record
 */
export async function appendActivity(record) {
    await ensureActivityFile();

    const line = JSON.stringify({
        id: record.id,
        timestamp: record.timestamp ?? new Date().toISOString(),
        type: record.type,
        tool: record.tool ?? null,
        status: record.status,
        summary: record.summary,
        details: record.details ?? null,
    });

    await fs.appendFile(ACTIVITY_PATH, `${line}\n`, "utf8");
}


export async function readActivity(limit = 100) {
    await ensureActivityFile();

    const raw = await fs.readFile(ACTIVITY_PATH, "utf8");
    const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
    const records = [];

    for (const line of lines.slice(-MAX_RECORDS)) {
        try {
            records.push(JSON.parse(line));
        } catch {
            // skip malformed lines
        }
    }

    const capped = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_RECORDS) : 100;
    return records.slice(-capped).reverse();
}
