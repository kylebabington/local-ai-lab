// =========================================================
// lib/storage-session.js
//
// Server-managed browser session for temporary storage-scan
// grants. Grants are in-memory only and never expand
// LOCAL_AI_ALLOWED_ROOTS.
// =========================================================


import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";


export const SESSION_COOKIE_NAME = "local_ai_lab_session";
export const GRANT_TTL_MS = 30 * 60 * 1000;
export const SESSION_IDLE_MS = 30 * 60 * 1000;

const COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60;

const sessions = new Map();
const sessionStore = new AsyncLocalStorage();


function isLoopbackHost(hostname) {
    const host = String(hostname ?? "").replace(/^\[|\]$/g, "").toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
}


export function isLoopbackOrigin(origin) {
    if (typeof origin !== "string" || !origin.trim()) {
        return false;
    }

    try {
        const url = new URL(origin);
        return (
            (url.protocol === "http:" || url.protocol === "https:") &&
            isLoopbackHost(url.hostname)
        );
    } catch {
        return false;
    }
}


/**
 * Explicitly trusted browser origins for mutating/local APIs.
 * Defaults cover the Vite UI (5173) and the API itself (3001).
 * Override / extend with LOCAL_AI_TRUSTED_ORIGINS (comma-separated).
 *
 * @returns {string[]}
 */
export function getTrustedAppOrigins() {
    const defaults = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
    ];
    const raw = process.env.LOCAL_AI_TRUSTED_ORIGINS;
    if (!raw || !raw.trim()) {
        return defaults;
    }

    const extra = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    return [...new Set([...defaults, ...extra])];
}


/**
 * True when origin is an explicitly trusted app origin.
 * Unlike isLoopbackOrigin, arbitrary localhost ports are not trusted.
 *
 * @param {string} origin
 * @returns {boolean}
 */
export function isTrustedAppOrigin(origin) {
    if (typeof origin !== "string" || !origin.trim()) {
        return false;
    }

    try {
        const url = new URL(origin);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return false;
        }
        if (!isLoopbackHost(url.hostname)) {
            return false;
        }

        const normalized = `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
        const withDefaultPort = url.port
            ? normalized
            : `${url.protocol}//${url.hostname}:${url.protocol === "https:" ? "443" : "80"}`;

        const trusted = getTrustedAppOrigins();
        return trusted.some((entry) => {
            try {
                const allowed = new URL(entry);
                const allowedNorm = `${allowed.protocol}//${allowed.hostname}${allowed.port ? `:${allowed.port}` : ""}`;
                return allowedNorm === normalized || allowedNorm === withDefaultPort;
            } catch {
                return false;
            }
        });
    } catch {
        return false;
    }
}


export function isLoopbackAddress(address) {
    const value = String(address ?? "");
    return (
        value === "127.0.0.1" ||
        value === "::1" ||
        value === ":ffff:127.0.0.1"
    );
}


/**
 * Reject untrusted mutating browser requests.
 * Browser Origin/Referer must be an explicitly trusted app origin.
 * Missing Origin is allowed only from a loopback TCP peer
 * (local verification scripts / same-machine tools).
 *
 * @param {import("node:http").IncomingMessage} request
 * @returns {string|null} error message when forbidden
 */
export function forbiddenCrossOriginMessage(request) {
    const origin = request.headers.origin;

    if (typeof origin === "string" && origin.trim()) {
        return isTrustedAppOrigin(origin)
            ? null
            : "Cross-origin requests are not allowed.";
    }

    const referer = request.headers.referer;

    if (typeof referer === "string" && referer.trim()) {
        return isTrustedAppOrigin(referer)
            ? null
            : "Cross-origin requests are not allowed.";
    }

    if (isLoopbackAddress(request.socket?.remoteAddress)) {
        return null;
    }

    return "Cross-origin requests are not allowed.";
}


export function parseCookies(header) {
    const cookies = {};

    if (typeof header !== "string" || !header.trim()) {
        return cookies;
    }

    for (const part of header.split(";")) {
        const index = part.indexOf("=");
        if (index <= 0) {
            continue;
        }

        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        cookies[key] = decodeURIComponent(value);
    }

    return cookies;
}


function createSessionRecord() {
    return {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        grants: new Map(),
        lastDiscovery: null,
        lastDriveSnapshot: null,
        plans: new Map(),
        manifests: new Map(),
        transfers: new Map(),
        reclaimJobs: new Map(),
        reclaimManifests: new Map(),
        removalJobs: new Map(),
        scanAbort: null,
        scanning: false,
        ended: false,
    };
}


function pruneSession(session) {
    const now = Date.now();

    if (now - session.lastSeen > SESSION_IDLE_MS) {
        session.grants.clear();
        session.lastDiscovery = null;
        session.lastDriveSnapshot = null;
        session.plans.clear();
        session.manifests.clear();
        abortScan(session);
        endSessionTransfers(session, "session_expired");
    }

    for (const [id, grant] of session.grants) {
        if (grant.expiresAt <= now) {
            session.grants.delete(id);
            invalidatePlansForGrant(session, grant);
        }
    }
}


function invalidatePlansForGrant(session, grant) {
    if (!session || !grant) {
        return;
    }

    const grantNorm = process.platform === "win32"
        ? String(grant.realPath).toLowerCase()
        : String(grant.realPath);

    for (const [planId, plan] of session.plans) {
        const usesGrant = (plan.entries ?? []).some((entry) => {
            const source = String(entry.sourcePath ?? "");
            const sourceNorm = process.platform === "win32"
                ? source.toLowerCase()
                : source;
            return (
                sourceNorm === grantNorm ||
                sourceNorm.startsWith(`${grantNorm}${path.sep}`) ||
                entry.grantId === grant.id
            );
        });

        if (usesGrant || (plan.grantIds ?? []).includes(grant.id)) {
            plan.invalidated = true;
            plan.invalidReason = "A scan grant used by this plan was revoked.";
            session.plans.set(planId, plan);

            for (const [manifestId, manifest] of session.manifests) {
                if (manifest.planId === planId) {
                    manifest.invalidated = true;
                    manifest.invalidReason = plan.invalidReason;
                    session.manifests.set(manifestId, manifest);
                    cancelTransfersForManifest(
                        session,
                        manifestId,
                        "grant_revoked",
                    );
                }
            }
        }
    }
}


/**
 * @type {((session: object, reason: string) => void) | null}
 */
let endSessionTransfersHook = null;

/**
 * @type {((session: object, manifestId: string, reason: string) => void) | null}
 */
let cancelTransfersForManifestHook = null;

/**
 * @type {((session: object, reason: string) => void) | null}
 */
let endSessionReclaimJobsHook = null;


export function setTransferSessionHooks({ endSessionTransfers, cancelTransfersForManifest }) {
    endSessionTransfersHook = endSessionTransfers;
    cancelTransfersForManifestHook = cancelTransfersForManifest;
}


export function setReclaimSessionHooks({ endSessionReclaimJobs }) {
    endSessionReclaimJobsHook = endSessionReclaimJobs;
}


function endSessionTransfers(session, reason) {
    if (typeof endSessionTransfersHook === "function") {
        endSessionTransfersHook(session, reason);
    }
    if (typeof endSessionReclaimJobsHook === "function") {
        endSessionReclaimJobsHook(session, reason);
    }
}


function cancelTransfersForManifest(session, manifestId, reason) {
    if (typeof cancelTransfersForManifestHook === "function") {
        cancelTransfersForManifestHook(session, manifestId, reason);
    }
}


function abortScan(session) {
    if (session.scanAbort) {
        session.scanAbort.abort();
        session.scanAbort = null;
    }
    session.scanning = false;
}


export function getActiveSession() {
    return sessionStore.getStore() ?? null;
}


export function runWithSession(session, work) {
    return sessionStore.run(session, work);
}


export function ensureSession(request, response) {
    pruneIdleSessions();

    const cookies = parseCookies(request.headers.cookie);
    const requestedId = cookies[SESSION_COOKIE_NAME];
    let session = typeof requestedId === "string"
        ? sessions.get(requestedId)
        : null;

    if (!session) {
        session = createSessionRecord();
        sessions.set(session.id, session);
        response.setHeader(
            "Set-Cookie",
            `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.id)}; ` +
                `Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
        );
    }

    session.lastSeen = Date.now();
    pruneSession(session);
    return session;
}


function pruneIdleSessions() {
    const now = Date.now();

    for (const [id, session] of sessions) {
        if (now - session.lastSeen > SESSION_IDLE_MS) {
            abortScan(session);
            endSessionTransfers(session, "session_expired");
            session.ended = true;
            sessions.delete(id);
        }
    }
}


export function getSessionById(sessionId) {
    if (typeof sessionId !== "string" || !sessionId) {
        return null;
    }

    const session = sessions.get(sessionId) ?? null;
    if (!session || session.ended) {
        return null;
    }

    pruneSession(session);
    if (Date.now() - session.lastSeen > SESSION_IDLE_MS) {
        return null;
    }

    return session;
}


export function storeSessionTransfer(transfer, session = getActiveSession()) {
    if (!session) {
        throw Object.assign(new Error("No storage scan session is active."), {
            code: "NO_SESSION",
            status: 401,
        });
    }

    if (!session.transfers) {
        session.transfers = new Map();
    }

    session.transfers.set(transfer.id, transfer);
    return transfer;
}


export function getSessionTransfer(transferId, session = getActiveSession()) {
    if (!session || typeof transferId !== "string" || !session.transfers) {
        return null;
    }

    return session.transfers.get(transferId) ?? null;
}


export function listSessionTransfers(session = getActiveSession()) {
    if (!session || !session.transfers) {
        return [];
    }

    return [...session.transfers.values()];
}


export function storeSessionReclaimJob(job, session = getActiveSession()) {
    if (!session) {
        throw Object.assign(new Error("No storage scan session is active."), {
            code: "NO_SESSION",
            status: 401,
        });
    }

    if (!session.reclaimJobs) {
        session.reclaimJobs = new Map();
    }

    session.reclaimJobs.set(job.id, job);
    return job;
}


export function getSessionReclaimJob(jobId, session = getActiveSession()) {
    if (!session || typeof jobId !== "string" || !session.reclaimJobs) {
        return null;
    }

    return session.reclaimJobs.get(jobId) ?? null;
}


export function listSessionReclaimJobs(session = getActiveSession()) {
    if (!session || !session.reclaimJobs) {
        return [];
    }

    return [...session.reclaimJobs.values()];
}


export function findActiveTransferForManifest(
    manifestId,
    session = getActiveSession(),
) {
    if (!session || !session.transfers || typeof manifestId !== "string") {
        return null;
    }

    for (const transfer of session.transfers.values()) {
        if (
            transfer.manifestId === manifestId &&
            (transfer.status === "running" ||
                transfer.status === "cancelling" ||
                transfer.status === "starting")
        ) {
            return transfer;
        }
    }

    return null;
}


export function publicGrant(grant) {
    return {
        id: grant.id,
        path: grant.path,
        addedAt: new Date(grant.addedAt).toISOString(),
        expiresAt: new Date(grant.expiresAt).toISOString(),
    };
}


export function listSessionGrants(session = getActiveSession()) {
    if (!session) {
        return [];
    }

    pruneSession(session);
    return [...session.grants.values()].map(publicGrant);
}


export function getGrantRoots(session = getActiveSession()) {
    if (!session) {
        return [];
    }

    pruneSession(session);
    return [...session.grants.values()].map((grant) => grant.realPath);
}


export function findGrantForPath(requestedPath, session = getActiveSession()) {
    if (!session) {
        return null;
    }

    pruneSession(session);
    const resolved = path.resolve(requestedPath);

    for (const grant of session.grants.values()) {
        const grantNorm = process.platform === "win32"
            ? grant.realPath.toLowerCase()
            : grant.realPath;
        const candidateNorm = process.platform === "win32"
            ? resolved.toLowerCase()
            : resolved;

        if (candidateNorm === grantNorm) {
            return grant;
        }

        const relative = path.relative(grantNorm, candidateNorm);
        if (
            relative &&
            !path.isAbsolute(relative) &&
            relative.split(/[\\/]/)[0] !== ".."
        ) {
            return grant;
        }
    }

    return null;
}


export function addSessionGrant(grant, session = getActiveSession()) {
    if (!session) {
        throw Object.assign(new Error("No storage scan session is active."), {
            code: "NO_SESSION",
            status: 401,
        });
    }

    pruneSession(session);

    for (const existing of session.grants.values()) {
        if (
            existing.realPath.toLowerCase() === grant.realPath.toLowerCase()
        ) {
            existing.expiresAt = Date.now() + GRANT_TTL_MS;
            existing.path = grant.path;
            return existing;
        }
    }

    const record = {
        id: crypto.randomUUID(),
        path: grant.path,
        realPath: grant.realPath,
        addedAt: Date.now(),
        expiresAt: Date.now() + GRANT_TTL_MS,
    };
    session.grants.set(record.id, record);
    return record;
}


export function revokeSessionGrant(grantId, session = getActiveSession()) {
    if (!session) {
        throw Object.assign(new Error("No storage scan session is active."), {
            code: "NO_SESSION",
            status: 401,
        });
    }

    pruneSession(session);

    if (!session.grants.has(grantId)) {
        throw Object.assign(new Error("Unknown scan folder grant."), {
            status: 404,
        });
    }

    const grant = session.grants.get(grantId);
    session.grants.delete(grantId);
    invalidatePlansForGrant(session, grant);

    if (session.lastDiscovery) {
        const still = findGrantForPath(session.lastDiscovery.path, session);
        if (!still) {
            session.lastDiscovery = null;
        }
    }

    abortScan(session);
    return true;
}


export function revokeAllSessionGrants(session = getActiveSession()) {
    if (!session) {
        return { revoked: 0 };
    }

    const count = session.grants.size;
    const grants = [...session.grants.values()];
    session.grants.clear();
    session.lastDiscovery = null;

    for (const grant of grants) {
        invalidatePlansForGrant(session, grant);
    }

    abortScan(session);
    return { revoked: count };
}


export function setLastDriveSnapshot(snapshot, session = getActiveSession()) {
    if (!session) {
        return;
    }

    session.lastDriveSnapshot = snapshot;
}


export function getLastDriveSnapshot(session = getActiveSession()) {
    return session?.lastDriveSnapshot ?? null;
}


export function storeSessionPlan(plan, session = getActiveSession()) {
    if (!session) {
        throw Object.assign(new Error("No storage scan session is active."), {
            code: "NO_SESSION",
            status: 401,
        });
    }

    session.plans.set(plan.id, plan);
    return plan;
}


export function getSessionPlan(planId, session = getActiveSession()) {
    if (!session || typeof planId !== "string") {
        return null;
    }

    return session.plans.get(planId) ?? null;
}


export function listSessionPlans(session = getActiveSession()) {
    if (!session) {
        return [];
    }

    return [...session.plans.values()];
}


export function storeSessionManifest(manifest, session = getActiveSession()) {
    if (!session) {
        throw Object.assign(new Error("No storage scan session is active."), {
            code: "NO_SESSION",
            status: 401,
        });
    }

    session.manifests.set(manifest.id, manifest);
    return manifest;
}


export function getSessionManifest(manifestId, session = getActiveSession()) {
    if (!session || typeof manifestId !== "string") {
        return null;
    }

    return session.manifests.get(manifestId) ?? null;
}


export function beginSessionScan(session = getActiveSession()) {
    if (!session) {
        throw Object.assign(new Error("No storage scan session is active."), {
            code: "NO_SESSION",
            status: 401,
        });
    }

    abortScan(session);
    const controller = new AbortController();
    session.scanAbort = controller;
    session.scanning = true;
    return controller.signal;
}


export function endSessionScan(session = getActiveSession()) {
    if (!session) {
        return;
    }

    session.scanAbort = null;
    session.scanning = false;
}


export function cancelSessionScan(session = getActiveSession()) {
    if (!session) {
        return { cancelled: false };
    }

    const wasScanning = session.scanning;
    abortScan(session);
    return { cancelled: wasScanning };
}


export function setLastDiscovery(summary, session = getActiveSession()) {
    if (!session) {
        return;
    }

    session.lastDiscovery = summary;
}


export function getLastDiscovery(session = getActiveSession()) {
    return session?.lastDiscovery ?? null;
}


export function isSessionScanning(session = getActiveSession()) {
    return session?.scanning === true;
}


export function listSuggestedScanFolders() {
    const home = os.homedir();
    const labels = [
        ["Downloads", "Downloads"],
        ["Documents", "Documents"],
        ["Pictures", "Pictures"],
        ["Videos", "Videos"],
        ["Desktop", "Desktop"],
    ];
    const suggestions = [];

    for (const [id, folder] of labels) {
        const folderPath = path.join(home, folder);
        suggestions.push({
            id,
            label: folder,
            path: folderPath,
            available: true,
        });
    }

    return suggestions;
}


/** Test helpers — not for production routes. */
export const _test = {
    reset() {
        for (const session of sessions.values()) {
            abortScan(session);
        }
        sessions.clear();
    },
    createSession() {
        const session = createSessionRecord();
        sessions.set(session.id, session);
        return session;
    },
    getSessions() {
        return sessions;
    },
};
