import { useEffect, useState } from "react";

import { fetchHealth, type HealthSnapshot } from "../services/statusService";
import { fetchTools } from "../services/toolsService";
import type { ToolDefinition } from "../types";

function isInspectTool(tool: ToolDefinition): boolean {
    return tool.name.startsWith("inspect_");
}

export function SystemDiagnosticsPanel() {
    const [health, setHealth] = useState<HealthSnapshot | null>(null);
    const [tools, setTools] = useState<ToolDefinition[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            setLoading(true);
            try {
                const [snapshot, catalog] = await Promise.all([
                    fetchHealth(),
                    fetchTools().catch(() => ({ allowedRoots: [], tools: [] })),
                ]);
                if (cancelled) {
                    return;
                }
                setHealth(snapshot);
                setTools(catalog.tools.filter(isInspectTool));
                setError(null);
            } catch (caught) {
                if (!cancelled) {
                    setError(
                        caught instanceof Error
                            ? caught.message
                            : "Could not load system diagnostics.",
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
    }, []);

    return (
        <article className="computer-tool-section" aria-label="System diagnostics">
            <header className="computer-tool-section-header">
                <div>
                    <h2>System Diagnostics</h2>
                    <p>
                        Read-only status for the local API and Ollama. Deeper
                        Windows inspections run through Computer chat tools with
                        the normal approval flow.
                    </p>
                </div>
            </header>

            {error ? (
                <div className="banner banner-error" role="alert">
                    <strong>Diagnostics unavailable</strong>
                    <p>{error}</p>
                </div>
            ) : null}

            {loading ? <p className="computer-tool-muted">Checking health…</p> : null}

            {health ? (
                <dl className="status-grid">
                    <div>
                        <dt>API</dt>
                        <dd>{health.label}</dd>
                    </div>
                    <div>
                        <dt>Ready</dt>
                        <dd>{health.ready ? "Yes" : "No"}</dd>
                    </div>
                    <div>
                        <dt>Model</dt>
                        <dd>{health.modelName}</dd>
                    </div>
                    <div>
                        <dt>Detail</dt>
                        <dd>{health.detail ?? "—"}</dd>
                    </div>
                </dl>
            ) : null}

            <div className="computer-tool-subsection">
                <h3>Available inspect tools</h3>
                {tools.length === 0 ? (
                    <p className="computer-tool-muted">
                        No inspect tools were returned by the API.
                    </p>
                ) : (
                    <ul className="plain-list">
                        {tools.map((tool) => (
                            <li key={tool.name}>
                                <code>{tool.name}</code>
                                {tool.description ? ` — ${tool.description}` : ""}
                            </li>
                        ))}
                    </ul>
                )}
                <p className="computer-tool-muted">
                    Ask in Computer mode to run an inspection. This panel does not
                    execute tools on its own.
                </p>
            </div>
        </article>
    );
}
