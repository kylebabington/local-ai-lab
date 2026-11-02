import { useEffect, useMemo, useState } from "react";

import {
    createStoragePlan,
    fetchStorageDrives,
    fetchStoragePlan,
    fetchStoragePlans,
    lockStorageSelection,
    refreshStorageDrives,
} from "../services/storageService";
import type {
    LockedManifest,
    OffloadPlan,
    OffloadPlanEntry,
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

    return (
        <article className="storage-scan-panel" aria-label="Storage offload planning">
            <div className="storage-scan-header">
                <div>
                    <h2>Offload planning</h2>
                    <p>
                        Read-only. Review candidates, then lock an exact file
                        selection. Copying is not enabled yet.
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
                        {manifest.complete ? "complete" : "partial"}. Copy is
                        not available in this milestone.
                    </p>
                </div>
            ) : null}
        </article>
    );
}
