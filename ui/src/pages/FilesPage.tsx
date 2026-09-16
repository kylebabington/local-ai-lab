import { EmptyState } from "../components/EmptyState";

export function FilesPage() {
    return (
        <section className="page" aria-labelledby="files-heading">
            <header className="page-toolbar">
                <div>
                    <h1 id="files-heading">Files</h1>
                    <p className="page-kicker">Search and organize later</p>
                </div>
            </header>

            <div className="page-stack">
                <EmptyState
                    title="Local files, on purpose"
                    body="This is a placeholder for browsing, searching, and attaching files as context. The terminal already supports loading one explicit file. The UI will replace that command with a clear selection flow — still never calling the filesystem from the browser."
                    hint="No files are listed or opened from the browser. File context remains a later phase."
                />

                <article className="info-card">
                    <h2>Future surface</h2>
                    <ul className="plain-list">
                        <li>Find files by name or meaning</li>
                        <li>Attach a file as chat context</li>
                        <li>Keep secrets such as .env files out of reach</li>
                    </ul>
                </article>
            </div>
        </section>
    );
}
