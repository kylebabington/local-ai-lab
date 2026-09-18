import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";

import { EmptyState } from "../components/EmptyState";
import {
    addFileRoot,
    fetchFileStatus,
    removeFileRoot,
    scanFileInventory,
    searchFiles,
} from "../services/filesService";
import type {
    FileInventoryEntry,
    FileInventoryStatus,
    FileRoot,
    FileSearchDirection,
    FileSearchSort,
} from "../types";

const PAGE_SIZE = 50;

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return "—";
    }

    if (bytes < 1024) {
        return `${bytes} B`;
    }

    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }

    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatModified(iso: string): string {
    const date = new Date(iso);

    if (Number.isNaN(date.getTime())) {
        return iso;
    }

    return date.toLocaleString([], {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}

function rootLabel(roots: FileRoot[], rootId: string): string {
    const match = roots.find((root) => root.id === rootId);
    return match?.path ?? rootId;
}

export function FilesPage() {
    const [status, setStatus] = useState<FileInventoryStatus | null>(null);
    const [pathInput, setPathInput] = useState("");
    const [query, setQuery] = useState("");
    const [extension, setExtension] = useState("");
    const [rootFilter, setRootFilter] = useState("");
    const [sort, setSort] = useState<FileSearchSort>("name");
    const [direction, setDirection] = useState<FileSearchDirection>("asc");
    const [offset, setOffset] = useState(0);
    const [results, setResults] = useState<FileInventoryEntry[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [searching, setSearching] = useState(false);
    const [scanning, setScanning] = useState(false);
    const [mutating, setMutating] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refreshStatus = useCallback(async () => {
        const next = await fetchFileStatus();
        setStatus(next);
        return next;
    }, []);

    const runSearch = useCallback(
        async (nextOffset = 0, nextStatus?: FileInventoryStatus | null) => {
            const current = nextStatus ?? status;

            if (!current?.inventoryExists) {
                setResults([]);
                setTotal(0);
                setOffset(0);
                return;
            }

            setSearching(true);

            try {
                const data = await searchFiles({
                    query,
                    extension,
                    rootId: rootFilter || undefined,
                    sort,
                    direction,
                    limit: PAGE_SIZE,
                    offset: nextOffset,
                });
                setResults(data.files);
                setTotal(data.total);
                setOffset(data.offset);
                setError(null);
            } catch (caught) {
                setError(
                    caught instanceof Error
                        ? caught.message
                        : "Could not search files.",
                );
            } finally {
                setSearching(false);
            }
        },
        [status, query, extension, rootFilter, sort, direction],
    );

    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                const next = await refreshStatus();

                if (cancelled) {
                    return;
                }

                setError(null);

                if (next.inventoryExists) {
                    const data = await searchFiles({
                        limit: PAGE_SIZE,
                        offset: 0,
                        sort: "name",
                        direction: "asc",
                    });

                    if (!cancelled) {
                        setResults(data.files);
                        setTotal(data.total);
                        setOffset(0);
                    }
                }
            } catch (caught) {
                if (!cancelled) {
                    setError(
                        caught instanceof Error
                            ? caught.message
                            : "Could not load file inventory.",
                    );
                }
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        }

        void load();

        return () => {
            cancelled = true;
        };
    }, [refreshStatus]);

    async function handleAddRoot(event: FormEvent) {
        event.preventDefault();
        setMutating(true);
        setError(null);

        try {
            await addFileRoot(pathInput);
            setPathInput("");
            const next = await refreshStatus();
            await runSearch(0, next);
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Could not add folder.",
            );
        } finally {
            setMutating(false);
        }
    }

    async function handleRemoveRoot(id: string) {
        setMutating(true);
        setError(null);

        try {
            await removeFileRoot(id);

            if (rootFilter === id) {
                setRootFilter("");
            }

            const next = await refreshStatus();
            await runSearch(0, next);
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Could not remove folder.",
            );
        } finally {
            setMutating(false);
        }
    }

    async function handleScan() {
        setScanning(true);
        setError(null);

        try {
            await scanFileInventory();
            const next = await refreshStatus();
            await runSearch(0, next);
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Scan failed.",
            );
        } finally {
            setScanning(false);
        }
    }

    async function handleSearchSubmit(event: FormEvent) {
        event.preventDefault();
        await runSearch(0);
    }

    const roots = status?.roots ?? [];
    const hasRoots = roots.length > 0;
    const hasInventory = Boolean(status?.inventoryExists);
    const busy = loading || mutating || scanning;

    return (
        <section className="page" aria-labelledby="files-heading">
            <header className="page-toolbar">
                <div>
                    <h1 id="files-heading">Files</h1>
                    <p className="page-kicker">Metadata inventory</p>
                </div>
            </header>

            <div className="page-stack">
                <p className="lede">
                    Explicitly choose local folders for read-only metadata
                    scanning. Local AI does not modify files in these folders,
                    and File chat context stays unavailable until a later phase.
                </p>

                {error ? (
                    <div className="banner banner-error" role="alert">
                        <strong>File Intelligence</strong>
                        <p>{error}</p>
                    </div>
                ) : null}

                {status?.truncated ? (
                    <div className="banner banner-info" role="status">
                        <strong>Inventory truncated</strong>
                        <p>
                            {status.truncationReason ??
                                "A scan guardrail was reached, so this inventory is incomplete."}
                        </p>
                    </div>
                ) : null}

                <article className="info-card files-section">
                    <h2>Folders</h2>
                    <p className="files-section-copy">
                        Adding a folder permits read-only metadata scanning
                        (names, paths, sizes, dates). It does not grant write
                        access or Computer-mode mutation rights.
                    </p>

                    <form className="files-root-form" onSubmit={handleAddRoot}>
                        <label className="files-field">
                            <span>Absolute folder path</span>
                            <input
                                type="text"
                                value={pathInput}
                                onChange={(event) =>
                                    setPathInput(event.target.value)
                                }
                                placeholder="C:\Users\...\Documents"
                                spellCheck={false}
                                autoComplete="off"
                                disabled={busy}
                            />
                        </label>
                        <button
                            type="submit"
                            className="btn btn-primary"
                            disabled={busy || !pathInput.trim()}
                        >
                            Add folder
                        </button>
                    </form>

                    {!hasRoots ? (
                        <EmptyState
                            title="No folders yet"
                            body="Add an absolute path to a local folder before Local AI can inspect file metadata."
                            hint="Start with a small test folder — not an entire drive."
                        />
                    ) : (
                        <ul className="files-root-list">
                            {roots.map((root) => (
                                <li key={root.id} className="files-root-item">
                                    <div>
                                        <p className="files-root-path">
                                            {root.path}
                                        </p>
                                        <p className="activity-detail">
                                            Read-only metadata root
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        className="btn btn-ghost"
                                        disabled={busy}
                                        onClick={() =>
                                            void handleRemoveRoot(root.id)
                                        }
                                    >
                                        Remove
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </article>

                <article className="info-card files-section">
                    <h2>Scan</h2>

                    {!hasRoots ? (
                        <p className="files-section-copy">
                            Configure at least one folder to enable scanning.
                        </p>
                    ) : !hasInventory ? (
                        <EmptyState
                            title="Ready to scan"
                            body="Folders are configured. Run a scan to build the metadata inventory."
                        />
                    ) : (
                        <dl className="files-summary">
                            <div>
                                <dt>Last scan</dt>
                                <dd>
                                    {status?.scannedAt
                                        ? formatModified(status.scannedAt)
                                        : "—"}
                                </dd>
                            </div>
                            <div>
                                <dt>Files</dt>
                                <dd>{status?.fileCount ?? 0}</dd>
                            </div>
                            <div>
                                <dt>Total size</dt>
                                <dd>{formatBytes(status?.totalBytes ?? 0)}</dd>
                            </div>
                            <div>
                                <dt>Skipped / errors</dt>
                                <dd>
                                    {status?.skippedCount ?? 0} /{" "}
                                    {status?.errorCount ?? 0}
                                </dd>
                            </div>
                        </dl>
                    )}

                    <button
                        type="button"
                        className="btn btn-primary"
                        disabled={!hasRoots || busy}
                        onClick={() => void handleScan()}
                    >
                        {scanning ? "Scanning…" : "Scan folders"}
                    </button>
                </article>

                {hasInventory ? (
                    <article className="info-card files-section">
                        <h2>Search</h2>

                        <form
                            className="files-search-form"
                            onSubmit={(event) => void handleSearchSubmit(event)}
                        >
                            <label className="files-field">
                                <span>Filename or path</span>
                                <input
                                    type="search"
                                    value={query}
                                    onChange={(event) =>
                                        setQuery(event.target.value)
                                    }
                                    placeholder="resume, notes…"
                                    disabled={busy || searching}
                                />
                            </label>
                            <label className="files-field">
                                <span>Extension</span>
                                <input
                                    type="text"
                                    value={extension}
                                    onChange={(event) =>
                                        setExtension(event.target.value)
                                    }
                                    placeholder="pdf"
                                    spellCheck={false}
                                    disabled={busy || searching}
                                />
                            </label>
                            <label className="files-field">
                                <span>Folder</span>
                                <select
                                    value={rootFilter}
                                    onChange={(event) =>
                                        setRootFilter(event.target.value)
                                    }
                                    disabled={busy || searching}
                                >
                                    <option value="">All folders</option>
                                    {roots.map((root) => (
                                        <option key={root.id} value={root.id}>
                                            {root.path}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label className="files-field">
                                <span>Sort</span>
                                <select
                                    value={sort}
                                    onChange={(event) =>
                                        setSort(
                                            event.target
                                                .value as FileSearchSort,
                                        )
                                    }
                                    disabled={busy || searching}
                                >
                                    <option value="name">Name</option>
                                    <option value="modified">Modified</option>
                                    <option value="size">Size</option>
                                </select>
                            </label>
                            <label className="files-field">
                                <span>Direction</span>
                                <select
                                    value={direction}
                                    onChange={(event) =>
                                        setDirection(
                                            event.target
                                                .value as FileSearchDirection,
                                        )
                                    }
                                    disabled={busy || searching}
                                >
                                    <option value="asc">Ascending</option>
                                    <option value="desc">Descending</option>
                                </select>
                            </label>
                            <button
                                type="submit"
                                className="btn btn-primary"
                                disabled={busy || searching}
                            >
                                Search
                            </button>
                        </form>

                        {searching ? <p>Searching…</p> : null}

                        {!searching && total === 0 ? (
                            <EmptyState
                                title="No matching files"
                                body="No files in the inventory match this search. Try a different name, extension, or folder filter."
                            />
                        ) : null}

                        {results.length > 0 ? (
                            <>
                                <div className="files-table-wrap">
                                    <table className="files-table">
                                        <thead>
                                            <tr>
                                                <th scope="col">Name</th>
                                                <th scope="col">Path</th>
                                                <th scope="col">Folder</th>
                                                <th scope="col">Type</th>
                                                <th scope="col">Size</th>
                                                <th scope="col">Modified</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {results.map((file) => (
                                                <tr
                                                    key={`${file.rootId}:${file.absolutePath}`}
                                                >
                                                    <td data-label="Name">
                                                        {file.name}
                                                    </td>
                                                    <td data-label="Path">
                                                        <code>
                                                            {file.relativePath}
                                                        </code>
                                                    </td>
                                                    <td data-label="Folder">
                                                        {rootLabel(
                                                            roots,
                                                            file.rootId,
                                                        )}
                                                    </td>
                                                    <td data-label="Type">
                                                        {file.extension || "—"}
                                                    </td>
                                                    <td data-label="Size">
                                                        {formatBytes(file.size)}
                                                    </td>
                                                    <td data-label="Modified">
                                                        {formatModified(
                                                            file.modifiedAt,
                                                        )}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>

                                <div className="files-pager">
                                    <p className="activity-detail">
                                        Showing {offset + 1}–
                                        {offset + results.length} of {total}
                                    </p>
                                    <div className="files-pager-actions">
                                        <button
                                            type="button"
                                            className="btn btn-ghost"
                                            disabled={
                                                offset <= 0 ||
                                                searching ||
                                                busy
                                            }
                                            onClick={() =>
                                                void runSearch(
                                                    Math.max(
                                                        0,
                                                        offset - PAGE_SIZE,
                                                    ),
                                                )
                                            }
                                        >
                                            Previous
                                        </button>
                                        <button
                                            type="button"
                                            className="btn btn-ghost"
                                            disabled={
                                                offset + results.length >=
                                                    total ||
                                                searching ||
                                                busy
                                            }
                                            onClick={() =>
                                                void runSearch(
                                                    offset + PAGE_SIZE,
                                                )
                                            }
                                        >
                                            Next
                                        </button>
                                    </div>
                                </div>
                            </>
                        ) : null}
                    </article>
                ) : null}
            </div>
        </section>
    );
}
