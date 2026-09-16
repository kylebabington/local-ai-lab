import { useSettings } from "../context/SettingsContext";
import type { MotionPreference, ResponseDetail, ThemePreference } from "../types";

export function SettingsPage() {
    const { settings, updateSettings } = useSettings();

    return (
        <section className="page" aria-labelledby="settings-heading">
            <header className="page-toolbar">
                <div>
                    <h1 id="settings-heading">Settings</h1>
                    <p className="page-kicker">Interface only · Ollama is not changed</p>
                </div>
            </header>

            <div className="settings-list">
                <div className="settings-row">
                    <div>
                        <h2>Model</h2>
                        <p>Shown in the header. This screen does not change Ollama.</p>
                    </div>
                    <p className="settings-value" aria-live="polite">
                        {settings.selectedModel}
                    </p>
                </div>

                <fieldset className="settings-row">
                    <legend>
                        <span>
                            <span className="settings-legend-title">Theme</span>
                            <span className="settings-legend-help">
                                Dark is the primary design. Light is available for contrast checks.
                            </span>
                        </span>
                    </legend>
                    <div className="segmented" role="group" aria-label="Theme">
                        {(["dark", "light"] as ThemePreference[]).map((theme) => (
                            <button
                                key={theme}
                                type="button"
                                className={settings.theme === theme ? "is-selected" : ""}
                                aria-pressed={settings.theme === theme}
                                onClick={() => updateSettings({ theme })}
                            >
                                {theme === "dark" ? "Dark" : "Light"}
                            </button>
                        ))}
                    </div>
                </fieldset>

                <fieldset className="settings-row">
                    <legend>
                        <span>
                            <span className="settings-legend-title">Response detail</span>
                            <span className="settings-legend-help">
                                Stored in this browser. Not sent to Ollama in this phase.
                            </span>
                        </span>
                    </legend>
                    <div className="segmented" role="group" aria-label="Response detail">
                        {(
                            [
                                ["concise", "Concise"],
                                ["balanced", "Balanced"],
                                ["detailed", "Detailed"],
                            ] as [ResponseDetail, string][]
                        ).map(([value, label]) => (
                            <button
                                key={value}
                                type="button"
                                className={
                                    settings.responseDetail === value ? "is-selected" : ""
                                }
                                aria-pressed={settings.responseDetail === value}
                                onClick={() => updateSettings({ responseDetail: value })}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </fieldset>

                <fieldset className="settings-row">
                    <legend>
                        <span>
                            <span className="settings-legend-title">Motion</span>
                            <span className="settings-legend-help">
                                Also respects the operating system “reduce motion” setting when set to System.
                            </span>
                        </span>
                    </legend>
                    <div className="segmented" role="group" aria-label="Motion preference">
                        {(
                            [
                                ["system", "System"],
                                ["reduce", "Reduce"],
                                ["allow", "Allow"],
                            ] as [MotionPreference, string][]
                        ).map(([value, label]) => (
                            <button
                                key={value}
                                type="button"
                                className={settings.motion === value ? "is-selected" : ""}
                                aria-pressed={settings.motion === value}
                                onClick={() => updateSettings({ motion: value })}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </fieldset>
            </div>
        </section>
    );
}
