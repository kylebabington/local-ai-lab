import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from "react";

import { loadSettings, saveSettings } from "../services/settingsStorage";
import type { AppSettings } from "../types";

interface SettingsContextValue {
    settings: AppSettings;
    updateSettings: (patch: Partial<AppSettings>) => void;
    reducedMotion: boolean;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

function prefersReducedMotion(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
    const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
    const [systemReduce, setSystemReduce] = useState(prefersReducedMotion);

    useEffect(() => {
        const media = window.matchMedia("(prefers-reduced-motion: reduce)");
        const onChange = () => setSystemReduce(media.matches);

        media.addEventListener("change", onChange);
        return () => media.removeEventListener("change", onChange);
    }, []);

    const reducedMotion =
        settings.motion === "reduce" ||
        (settings.motion === "system" && systemReduce);

    useEffect(() => {
        document.documentElement.dataset.theme = settings.theme;
        document.documentElement.dataset.reducedMotion = reducedMotion
            ? "true"
            : "false";
        document.documentElement.style.colorScheme = settings.theme;
    }, [settings.theme, reducedMotion]);

    const updateSettings = useCallback((patch: Partial<AppSettings>) => {
        setSettings((current) => {
            const next = { ...current, ...patch };
            saveSettings(next);
            return next;
        });
    }, []);

    const value = useMemo(
        () => ({ settings, updateSettings, reducedMotion }),
        [settings, updateSettings, reducedMotion],
    );

    return (
        <SettingsContext.Provider value={value}>
            {children}
        </SettingsContext.Provider>
    );
}

export function useSettings(): SettingsContextValue {
    const value = useContext(SettingsContext);

    if (!value) {
        throw new Error("useSettings must be used within SettingsProvider.");
    }

    return value;
}
