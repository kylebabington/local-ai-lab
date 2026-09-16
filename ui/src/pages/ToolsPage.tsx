import { useEffect, useState } from "react";

import { fetchTools } from "../services/toolsService";
import type { ToolDefinition, ToolPermission } from "../types";

const LEVELS: {
    id: ToolPermission;
    title: string;
    body: string;
}[] = [
    {
        id: "read",
        title: "Read",
        body: "Inspect without changing the machine. These run without asking.",
    },
    {
        id: "approval",
        title: "Approval required",
        body: "Propose a change, then wait for you. Approve and Reject use a stored id.",
    },
    {
        id: "high-risk",
        title: "High risk",
        body: "Destructive or unbounded actions are listed here only. They are not callable.",
    },
];

function groupTools(tools: ToolDefinition[], permission: ToolPermission) {
    return tools.filter((tool) => tool.permission === permission);
}

export function ToolsPage() {
    const [tools, setTools] = useState<ToolDefinition[]>([]);
    const [roots, setRoots] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                const data = await fetchTools();

                if (!cancelled) {
                    setTools(data.tools);
                    setRoots(data.allowedRoots);
                    setError(null);
                }
            } catch (caught) {
                if (!cancelled) {
                    setError(
                        caught instanceof Error
                            ? caught.message
                            : "Could not load tools.",
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
        <section className="page" aria-labelledby="tools-heading">
            <header className="page-toolbar">
                <div>
                    <h1 id="tools-heading">Tools</h1>
                    <p className="page-kicker">Permissions before actions</p>
                </div>
            </header>

            <div className="page-stack">
                <p className="lede">
                    Tools run on the Node backend, never in the browser. Read
                    tools execute immediately. Create, copy, move, and rename
                    wait for approval. Delete, overwrite, shell, and install are
                    not enabled.
                </p>

                {loading ? <p>Loading tools…</p> : null}

                {error ? (
                    <div className="banner banner-error" role="alert">
                        <strong>Could not load tools</strong>
                        <p>{error}</p>
                    </div>
                ) : null}

                {roots.length > 0 ? (
                    <article className="info-card">
                        <h2>Allowed roots</h2>
                        <ul className="plain-list">
                            {roots.map((root) => (
                                <li key={root}>{root}</li>
                            ))}
                        </ul>
                    </article>
                ) : null}

                <div className="permission-grid" aria-label="Permission levels">
                    {LEVELS.map((level) => {
                        const grouped = groupTools(tools, level.id);

                        return (
                            <article
                                key={level.id}
                                className={`permission-card permission-${level.id}`}
                            >
                                <h2>{level.title}</h2>
                                <p>{level.body}</p>
                                <ul className="plain-list">
                                    {grouped.map((tool) => (
                                        <li key={tool.name}>
                                            <strong>{tool.name}</strong>
                                            {tool.available ? "" : " — not enabled"}
                                            <div>{tool.summary}</div>
                                        </li>
                                    ))}
                                </ul>
                            </article>
                        );
                    })}
                </div>
            </div>
        </section>
    );
}
