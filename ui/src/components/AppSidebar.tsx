import type { AppSection } from "../types";

interface AppSidebarProps {
    active: AppSection;
    open: boolean;
    onNavigate: (section: AppSection) => void;
}

const ITEMS: { id: AppSection; label: string; icon: string }[] = [
    { id: "chat", label: "Chat", icon: "M4 6h16v10H8l-4 4V6z" },
    { id: "projects", label: "Projects", icon: "M4 8h16v12H4zM4 8l3-4h6l3 4" },
    { id: "files", label: "Files", icon: "M7 4h7l6 6v10H7zM14 4v6h6" },
    { id: "memory", label: "Memory", icon: "M12 5a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM12 9v3l2 2" },
    { id: "tools", label: "Tools", icon: "M14 4l6 6-8 8H6v-6zM4 20l3-1" },
    { id: "activity", label: "Activity", icon: "M5 19V9M12 19V5M19 19v-7" },
    { id: "settings", label: "Settings", icon: "M5 7h14M5 12h14M5 17h14" },
];

export function AppSidebar({
    active,
    open,
    onNavigate,
}: AppSidebarProps) {
    return (
        <nav
            id="app-sidebar"
            className={`app-sidebar${open ? " is-open" : ""}`}
            aria-label="Main"
        >
                <ul className="sidebar-list">
                    {ITEMS.map((item) => {
                        const isActive = item.id === active;

                        return (
                            <li key={item.id}>
                                <button
                                    type="button"
                                    className={`sidebar-item${isActive ? " is-active" : ""}`}
                                    aria-current={isActive ? "page" : undefined}
                                    title={item.label}
                                    onClick={() => onNavigate(item.id)}
                                >
                                    <svg
                                        className="sidebar-icon"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="1.7"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        aria-hidden="true"
                                    >
                                        <path d={item.icon} />
                                    </svg>
                                    <span className="sidebar-label">{item.label}</span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            </nav>
    );
}
