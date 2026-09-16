import { useEffect, useState } from "react";

import { DISPLAY_MODEL } from "../types";
import { fetchHealth, type HealthSnapshot } from "../services/statusService";

interface AppHeaderProps {
    sidebarOpen: boolean;
    onToggleSidebar: () => void;
}

const POLL_MS = 8000;

const INITIAL_HEALTH: HealthSnapshot = {
    status: "disconnected",
    label: "Checking backend",
    detail: null,
    modelName: DISPLAY_MODEL,
    ready: false,
};

export function AppHeader({ sidebarOpen, onToggleSidebar }: AppHeaderProps) {
    const [health, setHealth] = useState<HealthSnapshot>(INITIAL_HEALTH);

    useEffect(() => {
        let cancelled = false;

        async function refresh() {
            const snapshot = await fetchHealth();

            if (!cancelled) {
                setHealth(snapshot);
            }
        }

        void refresh();
        const timer = window.setInterval(() => {
            void refresh();
        }, POLL_MS);

        return () => {
            cancelled = true;
            window.clearInterval(timer);
        };
    }, []);

    return (
        <header className="app-header">
            <div className="app-header-brand">
                <button
                    type="button"
                    className="sidebar-toggle"
                    aria-controls="app-sidebar"
                    aria-expanded={sidebarOpen}
                    onClick={onToggleSidebar}
                >
                    <span className="visually-hidden">
                        {sidebarOpen ? "Close navigation" : "Open navigation"}
                    </span>
                    <span className="sidebar-toggle-bars" aria-hidden="true" />
                </button>
                <p className="app-wordmark">Local AI</p>
            </div>

            <div className="app-header-status">
                <span className="app-model" title="Configured chat model">
                    {health.modelName}
                </span>
                <span
                    className={`status-pill status-${health.status}`}
                    title={health.detail ?? health.label}
                >
                    <span className="status-dot" aria-hidden="true" />
                    <span>{health.label}</span>
                    {health.detail ? (
                        <span className="status-sub">{health.detail}</span>
                    ) : null}
                </span>
            </div>
        </header>
    );
}
