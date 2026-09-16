import { EmptyState } from "../components/EmptyState";

export function MemoryPage() {
    return (
        <section className="page" aria-labelledby="memory-heading">
            <header className="page-toolbar">
                <div>
                    <h1 id="memory-heading">Memory</h1>
                    <p className="page-kicker">Long-term notes, later</p>
                </div>
            </header>

            <div className="page-stack">
                <EmptyState
                    title="Nothing is remembered here yet"
                    body="Normal chat history already lives in the Node backend as chat-history.json. This screen is reserved for longer-lived, inspectable memory — facts you choose to keep — not a hidden profile of you."
                    hint="Phase 1 does not store conversation text in the browser except while this tab is open."
                />

                <article className="info-card">
                    <h2>Intended later</h2>
                    <ul className="plain-list">
                        <li>Review stored memories</li>
                        <li>Pin or forget individual items</li>
                        <li>Keep memory separate from raw chat logs</li>
                    </ul>
                </article>
            </div>
        </section>
    );
}
