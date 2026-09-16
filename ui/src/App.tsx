import { useEffect, useState } from "react";

import { AppHeader } from "./components/AppHeader";
import { AppSidebar } from "./components/AppSidebar";
import { SettingsProvider } from "./context/SettingsContext";
import { ActivityPage } from "./pages/ActivityPage";
import { ChatPage } from "./pages/ChatPage";
import { FilesPage } from "./pages/FilesPage";
import { MemoryPage } from "./pages/MemoryPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ToolsPage } from "./pages/ToolsPage";
import { loadSection, saveSection } from "./services/settingsStorage";
import type { AppSection } from "./types";

function MainView({ section }: { section: AppSection }) {
    switch (section) {
        case "projects":
            return <ProjectsPage />;
        case "files":
            return <FilesPage />;
        case "memory":
            return <MemoryPage />;
        case "tools":
            return <ToolsPage />;
        case "activity":
            return <ActivityPage />;
        case "settings":
            return <SettingsPage />;
        default:
            return <ChatPage />;
    }
}

const SECTION_TITLES: Record<AppSection, string> = {
    chat: "Chat",
    projects: "Projects",
    files: "Files",
    memory: "Memory",
    tools: "Tools",
    activity: "Activity",
    settings: "Settings",
};

function Shell() {
    const [section, setSection] = useState<AppSection>(() => loadSection());
    const [sidebarOpen, setSidebarOpen] = useState(false);

    useEffect(() => {
        saveSection(section);
        document.title = `${SECTION_TITLES[section]} · Local AI`;
    }, [section]);

    useEffect(() => {
        function onKeyDown(event: KeyboardEvent) {
            if (event.key === "Escape") {
                setSidebarOpen(false);
            }
        }

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    function navigate(next: AppSection) {
        setSection(next);
        setSidebarOpen(false);
    }

    return (
        <div className="app-shell">
            <a className="skip-link" href="#main-content">
                Skip to content
            </a>
            <AppHeader
                sidebarOpen={sidebarOpen}
                onToggleSidebar={() => setSidebarOpen((open) => !open)}
            />
            <div
                className={`sidebar-backdrop${sidebarOpen ? " is-visible" : ""}`}
                hidden={!sidebarOpen}
                onClick={() => setSidebarOpen(false)}
            />
            <div className="app-body">
                <AppSidebar
                    active={section}
                    open={sidebarOpen}
                    onNavigate={navigate}
                />
                <main id="main-content" className="app-main">
                    <MainView section={section} />
                </main>
            </div>
        </div>
    );
}

export default function App() {
    return (
        <SettingsProvider>
            <Shell />
        </SettingsProvider>
    );
}
