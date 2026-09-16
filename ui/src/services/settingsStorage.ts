import { DEFAULT_SETTINGS, type AppSection, type AppSettings } from "../types";

const SETTINGS_KEY = "local-ai-lab.ui.settings";
const SECTION_KEY = "local-ai-lab.ui.section";

const SECTIONS: AppSection[] = [
    "chat",
    "projects",
    "files",
    "memory",
    "tools",
    "activity",
    "settings",
];

function isAppSection(value: string): value is AppSection {
    return SECTIONS.includes(value as AppSection);
}

export function loadSettings(): AppSettings {
    try {
        const raw = window.localStorage.getItem(SETTINGS_KEY);

        if (!raw) {
            return { ...DEFAULT_SETTINGS };
        }

        const parsed = JSON.parse(raw) as Partial<AppSettings>;

        return {
            selectedModel:
                typeof parsed.selectedModel === "string"
                    ? parsed.selectedModel
                    : DEFAULT_SETTINGS.selectedModel,
            theme: parsed.theme === "light" ? "light" : "dark",
            responseDetail:
                parsed.responseDetail === "concise" ||
                parsed.responseDetail === "detailed"
                    ? parsed.responseDetail
                    : "balanced",
            motion:
                parsed.motion === "reduce" || parsed.motion === "allow"
                    ? parsed.motion
                    : "system",
        };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

export function saveSettings(settings: AppSettings): void {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadSection(): AppSection {
    try {
        const raw = window.localStorage.getItem(SECTION_KEY);

        if (raw && isAppSection(raw)) {
            return raw;
        }
    } catch {
        // Ignore unavailable storage.
    }

    return "chat";
}

export function saveSection(section: AppSection): void {
    window.localStorage.setItem(SECTION_KEY, section);
}
