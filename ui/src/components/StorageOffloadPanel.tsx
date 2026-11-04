import { useEffect, useMemo, useState } from "react";

import { approveAction, rejectAction } from "../services/agentService";
import {
    cancelStorageReclaimJob,
    cancelStorageRemoval,
    cancelStorageTransfer,
    createStoragePlan,
    fetchStorageDrives,
    fetchStoragePlan,
    fetchStoragePlans,
    fetchStorageReclaimJob,
    fetchStorageRemoval,
    fetchStorageTransfer,
    lockReclaimSelection,
    lockStorageSelection,
    refreshStorageDrives,
    requestStorageRemoval,
    requestStorageTransfer,
    startStorageReclaimReview,
} from "../services/storageService";
import type {
    LockedManifest,
    OffloadPlan,
    OffloadPlanEntry,
    PendingApproval,
    ReclaimCandidate,
    ReclaimJob,
    ReclaimManifest,
    RemovalJob,
    StorageTransfer,
    StorageVolume,
} from "../types";

function formatBytes(bytes: number | null | undefined): string {
    if (!Number.isFinite(bytes ?? NaN) || (bytes ?? 0) < 0) {
        return "—";
    }

    const value = bytes as number;
    if (value < 1024) {
        return `${value} B`;
    }

    const units = ["KB", "MB", "GB", "TB"];
    let scaled = value / 1024;
    let unit = 0;

    while (scaled >= 1024 && unit < units.length - 1) {
        scaled /= 1024;
        unit += 1;
    }

    return `${scaled.toFixed(scaled >= 10 ? 0 : 1)} ${units[unit]}`;
}

function safetyLabel(safety: OffloadPlanEntry["safety"]): string {
    if (safety === "likely_portable") {
        return "Likely portable";
    }
    if (safety === "review_required") {
        return "Review required";
    }
    return "Excluded";
}

function eligibilityLabel(eligibility: ReclaimCandidate["eligibility"]): string {
    if (eligibility === "eligible_for_review") {
        return "Eligible for review";
    }
    if (eligibility === "requires_manual_review") {
        return "Requires manual review";
    }
    if (eligibility === "excluded") {
        return "Excluded";
    }
    return "Verification failed";
}

interface StorageOffloadPanelProps {
    refreshKey?: number;
    hasGrants: boolean;
}

export function StorageOffloadPanel({
    refreshKey = 0,
    hasGrants,
}: StorageOffloadPanelProps) {
    const [volumes, setVolumes] = useState<StorageVolume[]>([]);
    const [destinationVolumeId, setDestinationVolumeId] = useState("");
    const [folderName, setFolderName] = useState("Offload");
    const [plan, setPlan] = useState<OffloadPlan | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [manifest, setManifest] = useState<LockedManifest | null>(null);
    const [approval, setApproval] = useState<PendingApproval | null>(null);
    const [incompleteAck, setIncompleteAck] = useState(false);
    const [authorizeHydrate, setAuthorizeHydrate] = useState(false);
    const [transfer, setTransfer] = useState<StorageTransfer | null>(null);
    const [reclaimJob, setReclaimJob] = useState<ReclaimJob | null>(null);
    const [reclaimSelected, setReclaimSelected] = useState<Set<string>>(
        new Set(),
    );
    const [reclaimManifest, setReclaimManifest] =
        useState<ReclaimManifest | null>(null);
    const [removalApproval, setRemovalApproval] =
        useState<PendingApproval | null>(null);
    const [removalAck, setRemovalAck] = useState(false);
    const [removalJob, setRemovalJob] = useState<RemovalJob | null>(null);
    const [expandedEntryId, setExpandedEntryId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function loadDrives(forceRefresh = false) {
        const data = forceRefresh
            ? await refreshStorageDrives()
            : await fetchStorageDrives();
        setVolumes(data.volumes ?? []);
    }

    async function loadLatestPlan() {
        const plans = await fetchStoragePlans();
        const latest = plans[plans.length - 1] ?? null;
        if (latest) {
            setPlan(latest);
            setSelected(
                new Set(
                    latest.entries
                        .filter((entry) => entry.selectable)
                        .map((entry) => entry.id),
                ),
            );
        }
    }

    useEffect(() => {
        let cancelled = false;

        Promise.all([loadDrives(false), loadLatestPlan()])
            .then(() => {
                if (!cancelled) {
                    setError(null);
                }
            })
            .catch((caught: unknown) => {
                if (!cancelled) {
                    setError(
                        caught instanceof Error
                            ? caught.message
                            : "Could not load offload tools.",
                    );
                }
            });

        return () => {
            cancelled = true;
        };
    }, [refreshKey]);

    const eligibleDestinations = useMemo(
        () =>
            volumes.filter(
                (volume) =>
                    (volume.classification === "external" ||
                        volume.classification === "removable") &&
                    volume.volumeId &&
                    volume.identityConfidence !== "low",
            ),
        [volumes],
    );

    const selectedEntries = useMemo(() => {
        if (!plan) {
            return [];
        }
        return plan.entries.filter((entry) => selected.has(entry.id));
    }, [plan, selected]);

    const estimatedTotal = selectedEntries.reduce(
        (sum, entry) => sum + (entry.sizeBytes ?? 0),
        0,
    );

    async function handlePlan() {
        if (!destinationVolumeId) {
            setError("Select an external or removable destination first.");
            return;
        }

        setBusy(true);
        setError(null);
        setManifest(null);

        try {
            const created = await createStoragePlan({
                destinationVolumeId,
                destinationFolderName: folderName.trim() || "Offload",
            });
            const full = await fetchStoragePlan(String(created.planId));
            setPlan(full);
            setSelected(
                new Set(
                    full.entries
                        .filter((entry) => entry.selectable && entry.safety === "likely_portable")
                        .map((entry) => entry.id),
                ),
            );
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Could not create an offload plan.",
            );
        } finally {
            setBusy(false);
        }
    }

    function toggleEntry(id: string, selectable: boolean) {
        if (!selectable) {
            return;
        }

        setSelected((current) => {
            const next = new Set(current);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }

    function selectAllSelectable() {
        if (!plan) {
            return;
        }
        setSelected(
            new Set(
                plan.entries
                    .filter((entry) => entry.selectable)
                    .map((entry) => entry.id),
            ),
        );
    }

    function selectNone() {
        setSelected(new Set());
    }

    async function handleLock() {
        if (!plan) {
            return;
        }

        setBusy(true);
        setError(null);

        try {
            const locked = await lockStorageSelection(plan.id, [...selected]);
            setManifest(locked);
            setApproval(null);
            setTransfer(null);
            setIncompleteAck(false);
            const refreshed = await fetchStoragePlan(plan.id);
            setPlan(refreshed);
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Could not lock that selection.",
            );
        } finally {
            setBusy(false);
        }
    }

    async function handleRequestTransfer() {
        if (!manifest) {
            return;
        }

        setBusy(true);
        setError(null);

        try {
            const result = await requestStorageTransfer({
                manifestId: manifest.manifestId,
                reason: "Copy selected files to the external drive.",
                authorizeHydrateCloudFiles: authorizeHydrate,
            });
            setApproval(result.approval);
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Could not request that transfer.",
            );
        } finally {
            setBusy(false);
        }
    }

    async function handleApproveTransfer() {
        if (!approval) {
            return;
        }

        setBusy(true);
        setError(null);

        try {
            const result = await approveAction(approval.id, {
                acknowledgeIncompleteScan: incompleteAck,
                authorizeHydrateCloudFiles: authorizeHydrate,
            });
            const transferId =
                (result as { transfer?: { transferId?: string } }).transfer
                    ?.transferId ?? null;
            setApproval(null);
            if (transferId) {
                const live = await fetchStorageTransfer(transferId);
                setTransfer(live);
            }
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Could not approve that transfer.",
            );
        } finally {
            setBusy(false);
        }
    }

    async function handleRejectTransfer() {
        if (!approval) {
            return;
        }

        setBusy(true);
        setError(null);

        try {
            await rejectAction(approval.id);
            setApproval(null);
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Could not reject that transfer.",
            );
        } finally {
            setBusy(false);
        }
    }

    async function handleCancelTransfer() {
        if (!transfer) {
            return;
        }

        setBusy(true);
        setError(null);

        try {
            const updated = await cancelStorageTransfer(transfer.transferId);
            setTransfer(updated);
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Could not cancel that transfer.",
            );
        } finally {
            setBusy(false);
        }
    }

    async function handleStartReclaimReview() {
        if (!transfer) {
            return;
        }

        setBusy(true);
        setError(null);
        setExpandedEntryId(null);
        setReclaimSelected(new Set());
        setReclaimManifest(null);
        setRemovalApproval(null);
        setRemovalAck(false);
        setRemovalJob(null);

        try {
            const job = await startStorageReclaimReview(transfer.transferId);
            setReclaimJob(job);
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Could not start reclaim review.",
            );
        } finally {
            setBusy(false);
        }
    }

    function toggleReclaimEntry(entryId: string, eligible: boolean) {
        if (!eligible) {
            return;
        }
        setReclaimSelected((current) => {
            const next = new Set(current);
            if (next.has(entryId)) {
                next.delete(entryId);
            } else {
                next.add(entryId);
            }
            return next;
        });
    }

    async function handleLockReclaimSelection() {
        if (!reclaimJob) {
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const locked = await lockReclaimSelection(reclaimJob.jobId, [
                ...reclaimSelected,
            ]);
            setReclaimManifest(locked);
            setRemovalApproval(null);
            setRemovalAck(false);
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Could not lock reclaim selection.",
            );
        } finally {
            setBusy(false);
        }
    }

    async function handleRequestRemoval() {
        if (!reclaimManifest) {
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const result = await requestStorageRemoval({
                reclaimManifestId: reclaimManifest.reclaimManifestId,
                reason: "Move selected synthetic verified originals to the Recycle Bin.",
            });
            setRemovalApproval(result.approval);
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Could not request removal approval.",
            );
        } finally {
            setBusy(false);
        }
    }

    async function handleApproveRemoval() {
        if (!removalApproval) {
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const result = await approveAction(removalApproval.id, {
                acknowledgeRemovalRisk: removalAck,
            });
            setRemovalApproval(null);
            const removalId =
                (result as { removal?: { removalId?: string } }).removal
                    ?.removalId ?? null;
            if (removalId) {
                const live = await fetchStorageRemoval(removalId);
                setRemovalJob(live);
            }
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Could not approve removal.",
            );
        } finally {
            setBusy(false);
        }
    }

    async function handleRejectRemoval() {
        if (!removalApproval) {
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await rejectAction(removalApproval.id);
            setRemovalApproval(null);
            setRemovalAck(false);
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Could not reject removal.",
            );
        } finally {
            setBusy(false);
        }
    }

    async function handleCancelReclaimReview() {
        if (!reclaimJob) {
            return;
        }

        setBusy(true);
        setError(null);

        try {
            const job = await cancelStorageReclaimJob(reclaimJob.jobId);
            setReclaimJob(job);
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Could not cancel reclaim review.",
            );
        } finally {
            setBusy(false);
        }
    }

    useEffect(() => {
        if (
            !transfer ||
            transfer.status === "completed" ||
            transfer.status === "failed" ||
            transfer.status === "cancelled" ||
            transfer.status === "interrupted"
        ) {
            return;
        }

        const timer = window.setInterval(() => {
            void fetchStorageTransfer(transfer.transferId)
                .then((live) => setTransfer(live))
                .catch(() => {
                    // keep last known state
                });
        }, 1000);

        return () => window.clearInterval(timer);
    }, [transfer]);

    useEffect(() => {
        if (
            !reclaimJob ||
            reclaimJob.status === "completed" ||
            reclaimJob.status === "failed" ||
            reclaimJob.status === "cancelled" ||
            reclaimJob.status === "incomplete"
        ) {
            return;
        }

        const timer = window.setInterval(() => {
            void fetchStorageReclaimJob(reclaimJob.jobId)
                .then((live) => setReclaimJob(live))
                .catch(() => {
                    // keep last known state
                });
        }, 1000);

        return () => window.clearInterval(timer);
    }, [reclaimJob]);

    useEffect(() => {
        if (
            !removalJob ||
            removalJob.status === "completed" ||
            removalJob.status === "failed" ||
            removalJob.status === "cancelled"
        ) {
            return;
        }

        const timer = window.setInterval(() => {
            void fetchStorageRemoval(removalJob.removalId)
                .then((live) => setRemovalJob(live))
                .catch(() => {
                    // keep last known state
                });
        }, 1000);

        return () => window.clearInterval(timer);
    }, [removalJob]);

    const reclaimSelectedBytes = useMemo(() => {
        if (!reclaimJob) {
            return 0;
        }
        return reclaimJob.candidates
            .filter(
                (candidate) =>
                    reclaimSelected.has(candidate.entryId) &&
                    candidate.syntheticRemovalAuthorized === true,
            )
            .reduce((sum, candidate) => sum + (candidate.sizeBytes ?? 0), 0);
    }, [reclaimJob, reclaimSelected]);

    const hasSyntheticRemovalCandidates = useMemo(() => {
        if (!reclaimJob) {
            return false;
        }
        return reclaimJob.candidates.some(
            (candidate) =>
                candidate.eligibility === "eligible_for_review" &&
                candidate.syntheticRemovalAuthorized === true,
        );
    }, [reclaimJob]);

    return (
        <article className="storage-scan-panel" aria-label="Storage offload planning">
            <div className="storage-scan-header">
                <div>
                    <h2>Offload planning</h2>
                    <p>
                        Review candidates, lock an exact file selection, then
                        approve a verified copy. Originals are never deleted.
                    </p>
                </div>
                <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => {
                        setBusy(true);
                        void loadDrives(true)
                            .catch((caught: unknown) => {
                                setError(
                                    caught instanceof Error
                                        ? caught.message
                                        : "Could not refresh drives.",
                                );
                            })
                            .finally(() => setBusy(false));
                    }}
                >
                    Refresh drives
                </button>
            </div>

            {error ? (
                <div className="banner banner-error" role="alert">
                    <strong>Offload planning</strong>
                    <p>{error}</p>
                </div>
            ) : null}

            {!hasGrants ? (
                <p className="storage-scan-empty">
                    Grant at least one scan folder above before planning an
                    offload.
                </p>
            ) : null}

            <div className="storage-offload-dest">
                <label className="files-field">
                    <span>Destination volume</span>
                    <select
                        value={destinationVolumeId}
                        disabled={busy || eligibleDestinations.length === 0}
                        onChange={(event) =>
                            setDestinationVolumeId(event.target.value)
                        }
                    >
                        <option value="">
                            {eligibleDestinations.length === 0
                                ? "No eligible external/removable volume"
                                : "Select a destination"}
                        </option>
                        {eligibleDestinations.map((volume) => (
                            <option
                                key={volume.volumeId ?? volume.mount}
                                value={volume.volumeId ?? ""}
                            >
                                {volume.mount}{" "}
                                {volume.label ? `(${volume.label})` : ""} ·{" "}
                                {volume.classification} ·{" "}
                                {formatBytes(volume.freeBytes)} free
                            </option>
                        ))}
                    </select>
                </label>
                <label className="files-field">
                    <span>Destination folder name</span>
                    <input
                        type="text"
                        value={folderName}
                        disabled={busy}
                        onChange={(event) => setFolderName(event.target.value)}
                        spellCheck={false}
                    />
                </label>
                <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy || !hasGrants || !destinationVolumeId}
                    onClick={() => void handlePlan()}
                >
                    Plan offload
                </button>
            </div>

            {volumes.length > 0 ? (
                <p className="storage-scan-scope">
                    {volumes.length} volume{volumes.length === 1 ? "" : "s"}{" "}
                    discovered · {eligibleDestinations.length} eligible
                    destination{eligibleDestinations.length === 1 ? "" : "s"}
                </p>
            ) : null}

            {plan ? (
                <div className="storage-offload-plan">
                    <p className="storage-scan-discovery">
                        Plan {plan.complete ? "complete" : "partial"} ·{" "}
                        {plan.candidateCount} candidates ·{" "}
                        {plan.selectableCount} selectable
                        {plan.incomplete?.timedOut ? " · timed out" : ""}
                        {plan.incomplete?.cancelled ? " · cancelled" : ""}
                        {plan.incomplete?.truncated ? " · truncated" : ""}
                        {plan.invalidated ? " · invalidated" : ""}
                    </p>
                    <p className="storage-scan-scope">
                        Estimated transfer size (current selection):{" "}
                        {formatBytes(estimatedTotal)}
                    </p>
                    <p className="storage-scan-scope">
                        Potential space recoverable after future verified source
                        removal: {formatBytes(estimatedTotal)} — not freed by
                        planning or copying alone.
                    </p>
                    {plan.destinationCapacityWarning ? (
                        <div className="banner banner-info" role="status">
                            <p>{plan.destinationCapacityWarning}</p>
                        </div>
                    ) : null}

                    <div className="storage-offload-actions">
                        <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={busy || plan.invalidated}
                            onClick={selectAllSelectable}
                        >
                            Select all selectable
                        </button>
                        <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={busy}
                            onClick={selectNone}
                        >
                            Select none
                        </button>
                        <button
                            type="button"
                            className="btn btn-primary"
                            disabled={
                                busy ||
                                plan.invalidated ||
                                selected.size === 0
                            }
                            onClick={() => void handleLock()}
                        >
                            Lock selection
                        </button>
                    </div>

                    <div className="storage-offload-table-wrap">
                        <table className="files-table storage-offload-table">
                            <thead>
                                <tr>
                                    <th scope="col">Select</th>
                                    <th scope="col">Source</th>
                                    <th scope="col">Destination</th>
                                    <th scope="col">Size</th>
                                    <th scope="col">Safety</th>
                                    <th scope="col">Concerns</th>
                                </tr>
                            </thead>
                            <tbody>
                                {plan.entries.map((entry) => (
                                    <tr key={entry.id}>
                                        <td>
                                            <input
                                                type="checkbox"
                                                checked={selected.has(entry.id)}
                                                disabled={
                                                    busy ||
                                                    !entry.selectable ||
                                                    plan.invalidated
                                                }
                                                onChange={() =>
                                                    toggleEntry(
                                                        entry.id,
                                                        entry.selectable,
                                                    )
                                                }
                                                aria-label={`Select ${entry.sourcePath}`}
                                            />
                                        </td>
                                        <td>
                                            <code>{entry.sourcePath}</code>
                                        </td>
                                        <td>
                                            <code>{entry.destinationPath}</code>
                                        </td>
                                        <td>{formatBytes(entry.sizeBytes)}</td>
                                        <td>{safetyLabel(entry.safety)}</td>
                                        <td>
                                            {[
                                                ...entry.dependencyConcerns,
                                                ...entry.concerns,
                                                entry.destinationConflict,
                                            ]
                                                .filter(Boolean)
                                                .join(" · ") || "—"}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            ) : null}

            {manifest ? (
                <div className="banner banner-info" role="status">
                    <strong>Selection locked</strong>
                    <p>
                        Manifest {manifest.manifestId.slice(0, 8)}… ·{" "}
                        {manifest.entryCount} files · estimated transfer{" "}
                        {formatBytes(manifest.estimatedTransferBytes)} · scan{" "}
                        {manifest.complete ? "complete" : "partial"}.
                    </p>
                    <p>
                        Destination{" "}
                        {`${manifest.destination.mount}LocalAI-Offload\\${manifest.destination.folderName}`}
                        . Originals will remain untouched. Copying does not free
                        internal storage.
                    </p>

                    <label>
                        <input
                            type="checkbox"
                            checked={authorizeHydrate}
                            disabled={busy || Boolean(transfer)}
                            onChange={(event) =>
                                setAuthorizeHydrate(event.target.checked)
                            }
                        />{" "}
                        Authorize hydrating cloud-only placeholders if
                        encountered (optional; skipped by default).
                    </label>

                    {!approval && !transfer ? (
                        <button
                            type="button"
                            className="btn btn-primary"
                            disabled={busy}
                            onClick={() => void handleRequestTransfer()}
                        >
                            Request transfer approval
                        </button>
                    ) : null}

                    {approval ? (
                        <div className="storage-offload-actions">
                            {approval.requiresIncompleteAck ? (
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={incompleteAck}
                                        disabled={busy}
                                        onChange={(event) =>
                                            setIncompleteAck(event.target.checked)
                                        }
                                    />{" "}
                                    I understand this plan came from an incomplete
                                    scan and is not exhaustive.
                                </label>
                            ) : null}
                            <button
                                type="button"
                                className="btn btn-primary"
                                disabled={
                                    busy ||
                                    (Boolean(approval.requiresIncompleteAck) &&
                                        !incompleteAck)
                                }
                                onClick={() => void handleApproveTransfer()}
                            >
                                Approve transfer
                            </button>
                            <button
                                type="button"
                                className="btn btn-ghost"
                                disabled={busy}
                                onClick={() => void handleRejectTransfer()}
                            >
                                Reject
                            </button>
                        </div>
                    ) : null}
                </div>
            ) : null}

            {transfer ? (
                <div className="banner banner-info" role="status">
                    <strong>Transfer {transfer.status}</strong>
                    <p>
                        {transfer.completedFiles}/{transfer.entryCount} verified ·{" "}
                        {transfer.failedFiles} failed · {transfer.skippedFiles}{" "}
                        skipped · {formatBytes(transfer.bytesTransferred)} /{" "}
                        {formatBytes(transfer.bytesTotal)}
                        {transfer.currentFile
                            ? ` · current ${transfer.currentFile}`
                            : ""}
                    </p>
                    {transfer.status === "running" ||
                    transfer.status === "cancelling" ||
                    transfer.status === "starting" ? (
                        <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={busy || transfer.status === "cancelling"}
                            onClick={() => void handleCancelTransfer()}
                        >
                            Cancel transfer
                        </button>
                    ) : null}
                    {transfer.status === "completed" ? (
                        <p>
                            Files copied and verified. Originals remain on your
                            computer. No internal storage has been freed. Verified{" "}
                            {formatBytes(transfer.verifiedBytes)} to{" "}
                            {transfer.destination.offloadRoot}.
                        </p>
                    ) : null}
                    {transfer.status === "failed" ||
                    transfer.status === "cancelled" ||
                    transfer.status === "interrupted" ? (
                        <p>
                            Partial transfer warning: some files were not
                            verified. Originals remain untouched. Temporary
                            `.partial` files may remain on the destination for
                            manual review. Individually verified files can still
                            be reviewed below.
                        </p>
                    ) : null}
                    {transfer.status === "completed" ||
                    transfer.status === "failed" ||
                    transfer.status === "cancelled" ||
                    transfer.status === "interrupted" ? (
                        <button
                            type="button"
                            className="btn btn-primary"
                            disabled={busy}
                            onClick={() => void handleStartReclaimReview()}
                        >
                            Review verified originals
                        </button>
                    ) : null}
                </div>
            ) : null}

            {reclaimJob ? (
                <div
                    className="banner banner-info"
                    role="region"
                    aria-label="Review verified originals"
                >
                    <strong>Review Verified Originals</strong>
                    <p>
                        These files have been evaluated for potential removal. No
                        original files have been deleted or modified.
                    </p>
                    <p>
                        Transfer status remains{" "}
                        <code>{reclaimJob.transferStatus}</code>
                        {reclaimJob.transferComplete
                            ? " (complete)."
                            : " (not entirely successful)."}{" "}
                        Review job {reclaimJob.status}
                        {reclaimJob.currentFile
                            ? ` · hashing ${reclaimJob.currentFile}`
                            : ""}{" "}
                        · {reclaimJob.progress.completed}/
                        {reclaimJob.progress.total} checked · trust{" "}
                        {reclaimJob.manifestTrust}.
                    </p>
                    <p>
                        Copied/verified in journal:{" "}
                        {formatBytes(
                            reclaimJob.estimates
                                .logicalBytesCopiedAndVerifiedInJournal,
                        )}{" "}
                        · Independently reverified:{" "}
                        {formatBytes(
                            reclaimJob.estimates
                                .logicalBytesIndependentlyReverified,
                        )}{" "}
                        · Potentially removable (logical):{" "}
                        {formatBytes(
                            reclaimJob.estimates.potentiallyRemovableLogicalBytes,
                        )}{" "}
                        · Estimated physical:{" "}
                        {reclaimJob.estimates
                            .estimatedPhysicallyRecoverableBytes == null
                            ? "uncertain"
                            : formatBytes(
                                  reclaimJob.estimates
                                      .estimatedPhysicallyRecoverableBytes,
                              )}{" "}
                        · Actually reclaimed:{" "}
                        {formatBytes(reclaimJob.bytesActuallyReclaimed)} (always
                        zero in this milestone).
                    </p>
                    <p>
                        Eligible for review: {reclaimJob.counts.eligible_for_review}{" "}
                        · Manual review:{" "}
                        {reclaimJob.counts.requires_manual_review} · Excluded:{" "}
                        {reclaimJob.counts.excluded} · Verification failed:{" "}
                        {reclaimJob.counts.verification_failed} · Reverified:{" "}
                        {reclaimJob.counts.reverified}
                    </p>

                    {reclaimJob.status === "starting" ||
                    reclaimJob.status === "running" ||
                    reclaimJob.status === "cancelling" ? (
                        <button
                            type="button"
                            className="btn btn-ghost"
                            disabled={
                                busy || reclaimJob.status === "cancelling"
                            }
                            onClick={() => void handleCancelReclaimReview()}
                        >
                            Cancel verification
                        </button>
                    ) : null}

                    {reclaimJob.candidates.length > 0 ? (
                        <div className="storage-offload-table-wrap">
                            <p>
                                Automated Recycle Bin removal is available only for
                                files inside explicitly registered synthetic test
                                roots. Real user files are never auto-removed —
                                use guided manual reclamation instead.
                            </p>
                            <p>
                                Selected synthetic logical bytes:{" "}
                                {formatBytes(reclaimSelectedBytes)}
                            </p>
                            {hasSyntheticRemovalCandidates ? (
                                <div className="storage-offload-actions">
                                    <button
                                        type="button"
                                        className="btn btn-ghost"
                                        disabled={busy}
                                        onClick={() =>
                                            setReclaimSelected(new Set())
                                        }
                                    >
                                        Clear selection
                                    </button>
                                    <button
                                        type="button"
                                        className="btn btn-primary"
                                        disabled={
                                            busy || reclaimSelected.size === 0
                                        }
                                        onClick={() =>
                                            void handleLockReclaimSelection()
                                        }
                                    >
                                        Lock synthetic reclaim selection
                                    </button>
                                </div>
                            ) : (
                                <p>
                                    No synthetic-authorized files in this review.
                                    Automated Recycle Bin removal is unavailable.
                                </p>
                            )}
                            <table className="storage-offload-table">
                                <thead>
                                    <tr>
                                        <th scope="col">Select</th>
                                        <th scope="col">Original</th>
                                        <th scope="col">External backup</th>
                                        <th scope="col">Size</th>
                                        <th scope="col">Eligibility</th>
                                        <th scope="col">Verification</th>
                                        <th scope="col">Details</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {reclaimJob.candidates.map((candidate) => {
                                        const eligible =
                                            candidate.eligibility ===
                                                "eligible_for_review" &&
                                            candidate.syntheticRemovalAuthorized ===
                                                true;
                                        return (
                                        <tr key={candidate.entryId}>
                                            <td>
                                                <input
                                                    type="checkbox"
                                                    checked={reclaimSelected.has(
                                                        candidate.entryId,
                                                    )}
                                                    disabled={!eligible || busy}
                                                    onChange={() =>
                                                        toggleReclaimEntry(
                                                            candidate.entryId,
                                                            eligible,
                                                        )
                                                    }
                                                    aria-label={`Select ${candidate.sourcePath}`}
                                                />
                                            </td>
                                            <td>
                                                <code>{candidate.sourcePath}</code>
                                            </td>
                                            <td>
                                                <code>
                                                    {candidate.destinationPath}
                                                </code>
                                            </td>
                                            <td>
                                                {formatBytes(candidate.sizeBytes)}
                                            </td>
                                            <td>
                                                {eligibilityLabel(
                                                    candidate.eligibility,
                                                )}
                                            </td>
                                            <td>
                                                src{" "}
                                                {candidate.sourceHashVerified
                                                    ? "ok"
                                                    : candidate.sourceIntegrity
                                                          .status}{" "}
                                                · dest{" "}
                                                {candidate.destinationHashVerified
                                                    ? "ok"
                                                    : candidate.destinationIntegrity
                                                          .status}
                                            </td>
                                            <td>
                                                <button
                                                    type="button"
                                                    className="btn btn-ghost"
                                                    onClick={() =>
                                                        setExpandedEntryId(
                                                            expandedEntryId ===
                                                                candidate.entryId
                                                                ? null
                                                                : candidate.entryId,
                                                        )
                                                    }
                                                >
                                                    {expandedEntryId ===
                                                    candidate.entryId
                                                        ? "Hide"
                                                        : "Inspect"}
                                                </button>
                                                {expandedEntryId ===
                                                candidate.entryId ? (
                                                    <div>
                                                        <p>
                                                            Copy:{" "}
                                                            {
                                                                candidate
                                                                    .copyIntegrity
                                                                    .status
                                                            }
                                                            {candidate
                                                                .copyIntegrity
                                                                .reason
                                                                ? ` — ${candidate.copyIntegrity.reason}`
                                                                : ""}
                                                        </p>
                                                        <p>
                                                            Auth:{" "}
                                                            {
                                                                candidate
                                                                    .sourceAuthorization
                                                                    .status
                                                            }
                                                            {candidate
                                                                .sourceAuthorization
                                                                .reason
                                                                ? ` — ${candidate.sourceAuthorization.reason}`
                                                                : ""}
                                                        </p>
                                                        <p>
                                                            Dependencies:{" "}
                                                            {
                                                                candidate
                                                                    .dependencyConfidence
                                                                    .status
                                                            }
                                                            {candidate
                                                                .dependencyConfidence
                                                                .reason
                                                                ? ` — ${candidate.dependencyConfidence.reason}`
                                                                : ""}
                                                        </p>
                                                        <p>
                                                            Cloud/reparse:{" "}
                                                            {
                                                                candidate
                                                                    .cloudReparseSafety
                                                                    .status
                                                            }
                                                        </p>
                                                        {[
                                                            ...candidate.reasons,
                                                            ...candidate.warnings,
                                                            ...candidate.manualReviewNeeds,
                                                        ].length > 0 ? (
                                                            <ul>
                                                                {[
                                                                    ...candidate.reasons,
                                                                    ...candidate.warnings,
                                                                    ...candidate.manualReviewNeeds,
                                                                ].map(
                                                                    (line) => (
                                                                        <li
                                                                            key={
                                                                                line
                                                                            }
                                                                        >
                                                                            {
                                                                                line
                                                                            }
                                                                        </li>
                                                                    ),
                                                                )}
                                                            </ul>
                                                        ) : (
                                                            <p>No warnings.</p>
                                                        )}
                                                    </div>
                                                ) : null}
                                            </td>
                                        </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    ) : null}

                    {reclaimManifest ? (
                        <div className="banner banner-info" role="status">
                            <strong>Reclaim selection locked</strong>
                            <p>
                                {reclaimManifest.entryCount} file(s) ·{" "}
                                {formatBytes(reclaimManifest.logicalBytesSelected)}{" "}
                                · disposal Recycle Bin · scope{" "}
                                {reclaimManifest.scope}. External copies remain.
                                Permanent deletion is unavailable.
                            </p>
                            {!removalApproval && !removalJob ? (
                                <button
                                    type="button"
                                    className="btn btn-primary"
                                    disabled={busy || reclaimManifest.consumed}
                                    onClick={() => void handleRequestRemoval()}
                                >
                                    Request removal approval
                                </button>
                            ) : null}
                            {removalApproval ? (
                                <div className="storage-offload-actions">
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={removalAck}
                                            disabled={busy}
                                            onChange={(event) =>
                                                setRemovalAck(
                                                    event.target.checked,
                                                )
                                            }
                                        />{" "}
                                        I understand selected originals will leave
                                        their paths and move to the Recycle Bin if
                                        recycling can be proven. This does not
                                        permanently delete files and does not empty
                                        the Recycle Bin.
                                    </label>
                                    <button
                                        type="button"
                                        className="btn btn-primary"
                                        disabled={busy || !removalAck}
                                        onClick={() => void handleApproveRemoval()}
                                    >
                                        Approve Recycle Bin removal
                                    </button>
                                    <button
                                        type="button"
                                        className="btn btn-ghost"
                                        disabled={busy}
                                        onClick={() => void handleRejectRemoval()}
                                    >
                                        Reject
                                    </button>
                                </div>
                            ) : null}
                        </div>
                    ) : null}

                    {removalJob ? (
                        <div className="banner banner-info" role="status">
                            <strong>Removal {removalJob.status}</strong>
                            <p>
                                Selected {removalJob.metrics.filesSelected} ·
                                recycled {removalJob.metrics.filesRecycled} ·
                                failed {removalJob.metrics.filesFailed} ·
                                indeterminate{" "}
                                {removalJob.metrics.filesIndeterminate} ·
                                permanently removed{" "}
                                {removalJob.metrics.filesPermanentlyRemoved} ·
                                free-space delta{" "}
                                {removalJob.metrics.freeBytesDelta == null
                                    ? "unknown"
                                    : formatBytes(
                                          removalJob.metrics.freeBytesDelta,
                                      )}{" "}
                                (observed snapshot only).
                            </p>
                            {removalJob.criticalFailure ? (
                                <p>
                                    Critical failure: permanent-deletion evidence
                                    disabled further removals.{" "}
                                    {removalJob.failureMessage}
                                </p>
                            ) : null}
                            <p>
                                Restore recycled synthetic items from File Explorer
                                Recycle Bin if needed. Unrelated recycled items are
                                never touched.
                            </p>
                            {removalJob.status === "running" ||
                            removalJob.status === "cancelling" ||
                            removalJob.status === "starting" ? (
                                <button
                                    type="button"
                                    className="btn btn-ghost"
                                    disabled={
                                        busy ||
                                        removalJob.status === "cancelling"
                                    }
                                    onClick={() =>
                                        void cancelStorageRemoval(
                                            removalJob.removalId,
                                        ).then(setRemovalJob)
                                    }
                                >
                                    Cancel removal
                                </button>
                            ) : null}
                            <ul>
                                {removalJob.files.map((file) => (
                                    <li key={file.entryId}>
                                        <code>{file.sourcePath}</code> —{" "}
                                        {file.outcome}
                                        {file.detail ? ` (${file.detail})` : ""}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </article>
    );
}
