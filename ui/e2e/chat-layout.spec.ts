import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const shotDir = path.join(__dirname, "screenshots");

const LONG_MARKDOWN = `## Layout verification

This is a long assistant reply used to prove the conversation area can grow.

1. First item
2. Second item
3. Third item

- Bullet one
- Bullet two

\`\`\`ts
function hello(name: string) {
  return \`Hello, \${name}\`;
}
\`\`\`

| Column | Value |
| --- | --- |
| Alpha | 1 |
| Beta | 2 |

**Bold** and *italic* text should wrap naturally across multiple lines without clipping. `.repeat(1) +
    "\n\n" +
    "Paragraph after the table. ".repeat(40);

async function mockApis(page: Page) {
    await page.route("**/api/health", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                ok: true,
                backend: "connected",
                ollama: "connected",
                ready: true,
                chatModel: { name: "qwen3:4b-instruct", available: true },
                embeddingModel: {
                    name: "qwen3-embedding:0.6b",
                    available: true,
                },
            }),
        });
    });

    await page.route("**/api/transcript", async (route) => {
        if (route.request().method() !== "GET") {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ ok: true }),
            });
            return;
        }

        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                conversationId: "fixture-conversation",
                messages: [
                    {
                        id: "u1",
                        role: "user",
                        content: "Short question about the layout.",
                        createdAt: new Date().toISOString(),
                        contextMode: "chat",
                    },
                    {
                        id: "a1",
                        role: "assistant",
                        content: "Short assistant reply.",
                        createdAt: new Date().toISOString(),
                        contextMode: "chat",
                    },
                    {
                        id: "u2",
                        role: "user",
                        content: "Show me a long markdown answer.",
                        createdAt: new Date().toISOString(),
                        contextMode: "chat",
                    },
                    {
                        id: "a2",
                        role: "assistant",
                        content: LONG_MARKDOWN,
                        createdAt: new Date().toISOString(),
                        contextMode: "chat",
                    },
                    {
                        id: "a3",
                        role: "assistant",
                        content: "",
                        createdAt: new Date().toISOString(),
                        contextMode: "computer",
                        approvalStatus: "pending",
                        approval: {
                            id: "approval-1",
                            tool: "write_file",
                            permission: "write",
                            reason: "Update a local note",
                            arguments: {
                                path: "notes/todo.md",
                                content: "demo",
                            },
                        },
                    },
                ],
            }),
        });
    });

    await page.route("**/api/approvals", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                approvals: [
                    {
                        id: "approval-1",
                        tool: "write_file",
                        permission: "write",
                        reason: "Update a local note",
                        arguments: {
                            path: "notes/todo.md",
                            content: "demo",
                        },
                    },
                ],
            }),
        });
    });

    await page.route("**/api/storage/**", async (route) => {
        const url = route.request().url();
        if (url.includes("/session")) {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    grants: [],
                    scanning: false,
                    discovery: null,
                }),
            });
            return;
        }
        if (url.includes("/drives")) {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ volumes: [] }),
            });
            return;
        }
        if (url.includes("/plans")) {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ plans: [] }),
            });
            return;
        }
        if (url.includes("/transfers")) {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    transfers: [
                        {
                            transferId: "transfer-1",
                            status: "running",
                            completedFiles: 1,
                            entryCount: 3,
                            failedFiles: 0,
                            skippedFiles: 0,
                            bytesTransferred: 1024,
                            bytesTotal: 4096,
                            verifiedBytes: 1024,
                            currentFile: "demo.txt",
                            destination: { offloadRoot: "E:\\\\LocalAI-Offload\\\\Offload" },
                        },
                    ],
                }),
            });
            return;
        }
        if (url.includes("/reclaim-jobs")) {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ jobs: [] }),
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
        });
    });

    await page.route("**/api/troubleshooting/**", async (route) => {
        const url = route.request().url();
        if (url.endsWith("/presets")) {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    presets: [
                        {
                            id: "notepad",
                            label: "Notepad",
                            processName: "notepad",
                        },
                    ],
                }),
            });
            return;
        }
        if (url.endsWith("/sessions") && route.request().method() === "GET") {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    sessions: [
                        {
                            troubleshootingSessionId: "watch-1",
                            status: "watching",
                            processName: "notepad",
                            targetAppLabel: "Notepad",
                            problemDescription: "demo",
                            startedAt: new Date().toISOString(),
                            endedAt: null,
                            durationMs: 120000,
                            elapsedMs: 15000,
                            cancelRequested: false,
                            reproductionAttemptAt: null,
                            tryingNowAt: null,
                            markersAreUserReported: true,
                            processSummary: null,
                            latestSample: {
                                at: new Date().toISOString(),
                                processCount: 1,
                                anyNotResponding: false,
                                totalWorkingSetBytes: 2048000,
                            },
                            sampleCount: 3,
                            samplingGaps: [],
                            systemPressure: null,
                            eventQuery: null,
                            correlatedEvents: [],
                            report: null,
                            confidence: null,
                            limitations: [],
                            endReason: null,
                            message: "Watching Notepad",
                        },
                    ],
                }),
            });
            return;
        }
        if (url.includes("/sessions/watch-1")) {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    session: {
                        troubleshootingSessionId: "watch-1",
                        status: "watching",
                        processName: "notepad",
                        targetAppLabel: "Notepad",
                        problemDescription: "demo",
                        startedAt: new Date().toISOString(),
                        endedAt: null,
                        durationMs: 120000,
                        elapsedMs: 15000,
                        cancelRequested: false,
                        reproductionAttemptAt: null,
                        tryingNowAt: null,
                        markersAreUserReported: true,
                        processSummary: null,
                        latestSample: {
                            at: new Date().toISOString(),
                            processCount: 1,
                            anyNotResponding: false,
                            totalWorkingSetBytes: 2048000,
                        },
                        sampleCount: 3,
                        samplingGaps: [],
                        systemPressure: null,
                        eventQuery: null,
                        correlatedEvents: [],
                        report: null,
                        confidence: null,
                        limitations: [],
                        endReason: null,
                        message: "Watching Notepad",
                    },
                }),
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
        });
    });

    await page.route("**/api/tools", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                allowedRoots: [],
                tools: [
                    {
                        name: "inspect_system_health",
                        description: "Summarize basic system health",
                        permission: "read",
                    },
                ],
            }),
        });
    });
}

async function openComputerTools(page: Page) {
    await page.locator("#chat-context-mode").selectOption("computer");
    await page.getByRole("button", { name: "Computer Tools" }).click();
    await expect(page.getByRole("heading", { name: "Computer Tools" })).toBeVisible();
}

test.describe("UI-1 chat layout", () => {
    test.beforeEach(async ({ page }) => {
        await mockApis(page);
        await page.goto("/");
        await expect(page.getByRole("heading", { name: "Chat" })).toBeVisible();
    });

    for (const viewport of [
        { name: "desktop-1440", width: 1440, height: 900 },
        { name: "laptop-1280", width: 1280, height: 800 },
        { name: "tablet-768", width: 768, height: 1024 },
        { name: "mobile-390", width: 390, height: 844 },
    ]) {
        test(`layout at ${viewport.name}`, async ({ page }) => {
            await page.setViewportSize({
                width: viewport.width,
                height: viewport.height,
            });

            const log = page.locator(".chat-log");
            await expect(log).toBeVisible();
            const box = await log.boundingBox();
            expect(box?.height ?? 0).toBeGreaterThan(180);

            await expect(page.getByText("Short assistant reply.")).toBeVisible();
            await expect(page.getByRole("heading", { name: "Layout verification" })).toBeVisible();
            await expect(page.locator(".md-pre")).toBeVisible();
            await expect(page.getByText("This action will not run until you approve it.")).toBeVisible();
            await expect(page.getByLabel("Send a message")).toBeVisible();

            await page.screenshot({
                path: path.join(shotDir, `${viewport.name}-chat.png`),
                fullPage: true,
            });

            await openComputerTools(page);
            await expect(page.locator(".chat-log")).toBeVisible();
            const withTools = await page.locator(".chat-log").boundingBox();
            expect(withTools?.height ?? 0).toBeGreaterThan(120);

            await page.getByRole("tab", { name: "Watch Me Try" }).click();
            await expect(page.getByRole("heading", { name: "Watch Me Try" })).toBeVisible();
            await expect(page.getByText("Elapsed")).toBeVisible();

            await page.screenshot({
                path: path.join(shotDir, `${viewport.name}-tools-watch.png`),
                fullPage: true,
            });

            // On narrow viewports the drawer covers the toolbar toggle; close from the panel.
            await page
                .locator(".computer-tools-panel")
                .getByRole("button", { name: "Close" })
                .click();
            await expect(
                page.locator(".computer-tools-panel"),
            ).toBeHidden();
            await page.getByRole("button", { name: "Computer Tools" }).click();
            await expect(page.getByText("Elapsed")).toBeVisible();

            await page.getByRole("tab", { name: "Offload Planning" }).click();
            await expect(
                page.getByRole("heading", { name: "Offload planning" }),
            ).toBeVisible();
            await page.getByRole("tab", { name: "Transfers & Reclamation" }).click();
            await expect(page.getByText("Transfer running")).toBeVisible();
        });
    }

    test("auto-scroll respects reading position", async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        const log = page.locator(".chat-log");
        await log.evaluate((el) => {
            el.scrollTop = 0;
        });

        await page.evaluate(() => {
            const event = new Event("scroll");
            document.querySelector(".chat-log")?.dispatchEvent(event);
        });

        await page.waitForTimeout(200);
        const before = await log.evaluate((el) => el.scrollTop);
        expect(before).toBeLessThan(40);

        await page.evaluate(() => {
            const root = document.querySelector(".chat-log");
            if (!root) {
                return;
            }
            const article = document.createElement("article");
            article.className = "chat-message chat-message-assistant";
            article.textContent = "Late-arriving message while reading older content.";
            root.appendChild(article);
            root.dispatchEvent(new Event("scroll"));
        });

        await page.waitForTimeout(300);
        const after = await log.evaluate((el) => el.scrollTop);
        expect(after).toBeLessThan(80);
    });
});
