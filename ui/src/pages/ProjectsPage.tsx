import { EmptyState } from "../components/EmptyState";

export function ProjectsPage() {
    return (
        <section className="page" aria-labelledby="projects-heading">
            <header className="page-toolbar">
                <div>
                    <h1 id="projects-heading">Projects</h1>
                    <p className="page-kicker">Project knowledge and RAG</p>
                </div>
            </header>

            <div className="page-stack">
                <EmptyState
                    title="Project memory will live here"
                    body="The terminal already indexes a project, retrieves relevant chunks, and answers from that context. This screen will become the place to choose a project, see index status, and ask grounded questions — without typing /rag."
                    hint="Project questions already work from Chat using the Project context. This screen will later show index status and project selection."
                />

                <article className="info-card">
                    <h2>What will appear</h2>
                    <ul className="plain-list">
                        <li>Indexed project path and last index time</li>
                        <li>Semantic search over project files</li>
                        <li>Answers with source files and line ranges</li>
                        <li>Manual re-index, not a silent file watcher</li>
                    </ul>
                </article>
            </div>
        </section>
    );
}
