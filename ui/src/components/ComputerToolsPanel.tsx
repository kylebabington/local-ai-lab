import { useId, useState } from "react";

import { StorageOffloadPanel } from "./StorageOffloadPanel";
import { StorageScanPanel } from "./StorageScanPanel";
import { SystemDiagnosticsPanel } from "./SystemDiagnosticsPanel";
import { TroubleshootingPanel } from "./TroubleshootingPanel";

export type ComputerToolsTab =
    | "diagnostics"
    | "watch"
    | "scan"
    | "planning"
    | "reclaim";

interface ComputerToolsPanelProps {
    open: boolean;
    computerBusy?: boolean;
    scanRefresh: number;
    hasScanGrants: boolean;
    onGrantsChanged: () => void;
    onClose: () => void;
}

const TABS: Array<{ id: ComputerToolsTab; label: string }> = [
    { id: "diagnostics", label: "System Diagnostics" },
    { id: "watch", label: "Watch Me Try" },
    { id: "scan", label: "Scan Folders" },
    { id: "planning", label: "Offload Planning" },
    { id: "reclaim", label: "Transfers & Reclamation" },
];

export function ComputerToolsPanel({
    open,
    computerBusy = false,
    scanRefresh,
    hasScanGrants,
    onGrantsChanged,
    onClose,
}: ComputerToolsPanelProps) {
    const titleId = useId();
    const [tab, setTab] = useState<ComputerToolsTab>("diagnostics");
    const offloadSection = tab === "reclaim" ? "reclaim" : "planning";

    return (
        <aside
            className={`computer-tools-panel${open ? " is-open" : ""}`}
            aria-labelledby={titleId}
            aria-hidden={!open}
            inert={!open ? true : undefined}
        >
            <header className="computer-tools-header">
                <div>
                    <h2 id={titleId}>Computer Tools</h2>
                    <p>One workflow at a time. Closing this panel does not cancel jobs.</p>
                </div>
                <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={onClose}
                    disabled={!open}
                >
                    Close
                </button>
            </header>

            <div
                className="computer-tools-tabs"
                role="tablist"
                aria-label="Computer tool workflows"
            >
                {TABS.map((item) => {
                    const selected = tab === item.id;
                    return (
                        <button
                            key={item.id}
                            type="button"
                            role="tab"
                            id={`computer-tab-${item.id}`}
                            aria-selected={selected}
                            aria-controls={`computer-panel-${item.id}`}
                            tabIndex={open && selected ? 0 : -1}
                            className={`computer-tools-tab${selected ? " is-active" : ""}`}
                            disabled={!open}
                            onClick={() => setTab(item.id)}
                        >
                            {item.label}
                        </button>
                    );
                })}
            </div>

            <div className="computer-tools-body">
                <div
                    id="computer-panel-diagnostics"
                    role="tabpanel"
                    aria-labelledby="computer-tab-diagnostics"
                    hidden={tab !== "diagnostics"}
                    inert={tab !== "diagnostics" ? true : undefined}
                >
                    <SystemDiagnosticsPanel />
                </div>

                <div
                    id="computer-panel-watch"
                    role="tabpanel"
                    aria-labelledby="computer-tab-watch"
                    hidden={tab !== "watch"}
                    inert={tab !== "watch" ? true : undefined}
                >
                    <TroubleshootingPanel computerBusy={computerBusy} />
                </div>

                <div
                    id="computer-panel-scan"
                    role="tabpanel"
                    aria-labelledby="computer-tab-scan"
                    hidden={tab !== "scan"}
                    inert={tab !== "scan" ? true : undefined}
                >
                    <StorageScanPanel
                        refreshKey={scanRefresh}
                        computerBusy={computerBusy}
                        onGrantsChanged={onGrantsChanged}
                    />
                </div>

                <div
                    id="computer-panel-offload"
                    role="tabpanel"
                    aria-labelledby={
                        tab === "reclaim"
                            ? "computer-tab-reclaim"
                            : "computer-tab-planning"
                    }
                    hidden={tab !== "planning" && tab !== "reclaim"}
                    inert={
                        tab !== "planning" && tab !== "reclaim" ? true : undefined
                    }
                >
                    <StorageOffloadPanel
                        refreshKey={scanRefresh}
                        hasGrants={hasScanGrants}
                        section={offloadSection}
                    />
                </div>
            </div>
        </aside>
    );
}
