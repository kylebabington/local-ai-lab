// =========================================================
// scripts/verify-rag-grounding.js
//
// RAG grounding verification. Uses the real project index.
// Reports only tests that actually run. Does not rewrite answers.
// =========================================================


import {
    CHAT_MODEL,
    EMBEDDING_MODEL,
    buildOllamaGenerationOptions,
    formatOllamaUnreachableError,
    getInstalledModelNames,
} from "../lib/ollama.js";
import {
    RAG_NUM_CTX,
    RAG_TOP_K,
    TOP_K,
    askProject,
    classifySymbolEvidence,
    diversifyMatches,
    expandWithCrossReferences,
    extractUsefulSymbols,
    getAskProjectChatOptions,
    loadIndex,
    preferImplementationOnNearTie,
    retrieveForAsk,
    searchIndex,
    wholeIdentifierOccurs,
} from "../lib/rag.js";


const MOVE_QUESTION =
    "Walk me through every validation step that occurs when Computer mode tries to move a file, including path normalization, allowed-root checking, symlink or junction handling, destination validation, overwrite protection, and user approval. Cite the files responsible for each step.";

const OVERWRITE_QUESTION =
    "Can Computer mode overwrite an existing destination if I approve it? Is there a force or overwrite flag?";

const ROLLBACK_QUESTION =
    "How does the rollback system restore a file after a failed move?";

const CONTEXT_QUESTION =
    "What context size does Project mode request from Ollama, and how is that different from Chat and Computer mode?";

const EXPECTED_MOVE_FILES = [
    "lib/tools/path-safety.js",
    "lib/tools/filesystem.js",
    "lib/tools/registry.js",
    "lib/agent.js",
];


const results = [];


function record(name, status, detail = "") {
    results.push({ name, status, detail });
    const suffix = detail ? ` — ${detail}` : "";
    console.log(`${status.toUpperCase()}  ${name}${suffix}`);
}


function pass(name, detail) {
    record(name, "pass", detail);
}


function fail(name, detail) {
    record(name, "fail", detail);
}


function skip(name, detail) {
    record(name, "skip", detail);
}


function chunk(filePath, startLine, similarity) {
    return {
        filePath,
        startLine,
        endLine: startLine + 10,
        similarity,
        content: "",
    };
}


function normalizePath(filePath) {
    return String(filePath).replaceAll("\\", "/").toLowerCase();
}


function matchHasFile(matches, expected) {
    const want = normalizePath(expected);
    return matches.some((item) => normalizePath(item.filePath).includes(want));
}


function formatMatches(matches) {
    return matches.map((item, index) => {
        const sim = Number(item.similarity);
        const simText = Number.isFinite(sim) ? sim.toFixed(4) : String(item.similarity);
        return (
            `${index + 1}. ${item.filePath} lines ` +
            `${item.startLine}-${item.endLine} similarity=${simText}`
        );
    }).join("\n");
}


function nearbyNegation(text, index, radius = 100) {
    const start = Math.max(0, index - radius);
    const end = Math.min(text.length, index + radius);
    const window = text.slice(start, end).toLowerCase();

    return (
        /\b(no|not|never|without|doesn't|does not|do not|don't|cannot|can't|isn't|is not|aren't|are not|didn't|did not|won't|will not|neither|nor|false)\b/.test(window) ||
        /does not (show|define|include|have|support|exist|mention|provide)/.test(window) ||
        /not (shown|defined|present|supported|available|exist|mentioned)/.test(window)
    );
}


function claimsUnsupportedFlag(answer, flagName) {
    const pattern = new RegExp(
        `${flagName}\\s+(flag|parameter|option|mode|argument)`,
        "gi",
    );
    const enabling =
        /\b(there is|has a|with a|with the|supports?|allow|enable|exists?|available|provided|optional|you can|can be|could be|pass(?:ing)?|using)\b/;
    let match;

    while ((match = pattern.exec(answer)) !== null) {
        if (nearbyNegation(answer, match.index)) {
            continue;
        }

        const start = Math.max(0, match.index - 100);
        const end = Math.min(answer.length, match.index + 100);
        const window = answer.slice(start, end).toLowerCase();

        if (enabling.test(window)) {
            return true;
        }
    }

    return false;
}


function claimsOverwriteAfterApproval(answer) {
    const lower = answer.toLowerCase();
    const patterns = [
        /overwrite.{0,80}(after|if|when|once).{0,40}approv/,
        /approv.{0,80}(can|could|will|would|allow).{0,40}overwrite/,
        /if you approv.{0,60}overwrite/,
        /overwrite.{0,50}(is allowed|can be allowed|permitted)/,
    ];

    return patterns.some((pattern) => {
        const match = pattern.exec(lower);
        return match && !nearbyNegation(lower, match.index);
    });
}


function claimsGetFileInfoMoveSecurity(answer) {
    const lower = answer.toLowerCase();
    const index = lower.indexOf("get_file_info");

    if (index === -1) {
        return false;
    }

    const window = lower.slice(index, index + 220);
    const talksSecurity = /validat|path.?safety|move.?path|allowed.?root|destination/.test(
        window,
    );

    if (!talksSecurity) {
        return false;
    }

    return !nearbyNegation(lower, index);
}


function showsNoOverwrite(answer) {
    const lower = answer.toLowerCase();

    return (
        /already exists/.test(lower) ||
        /does not overwrite/.test(lower) ||
        /do not overwrite/.test(lower) ||
        /refuses overwrite/.test(lower) ||
        /refuse.{0,24}overwrite/.test(lower) ||
        /reject.{0,48}(exist|destin|overwrite)/.test(lower) ||
        /destination.{0,48}(already exist|must not exist|cannot exist)/.test(lower) ||
        /cannot overwrite/.test(lower) ||
        /will not overwrite/.test(lower) ||
        /no overwrite/.test(lower)
    );
}


function hasImplementationCitation(answer) {
    const hasPath =
        /[\w./\\-]+\.(js|jsx|ts|tsx|py)\b/i.test(answer) ||
        /(?:path-safety|filesystem|registry|agent)\.js/i.test(answer);
    const hasLines =
        /lines?\s+\d+/i.test(answer) ||
        /\b\d+\s*[–-]\s*\d+\b/.test(answer);

    return hasPath && hasLines;
}


function citesOverwriteEvidence(answer) {
    if (hasImplementationCitation(answer)) {
        return true;
    }

    return /moveFile|resolveNewPath|COPYFILE_EXCL|path-safety|filesystem\.js|registry\.js|does not overwrite/i.test(
        answer,
    );
}


function deniesMissingFeature(answer) {
    const lower = answer.toLowerCase();

    return (
        /does not show/.test(lower) ||
        /do not show/.test(lower) ||
        /not shown/.test(lower) ||
        /not (present|implemented|defined|available)/.test(lower) ||
        /there is no rollback/.test(lower) ||
        /no rollback/.test(lower) ||
        /retrieved context does not/.test(lower)
    );
}


function inventsRollbackSystem(answer) {
    const lower = answer.toLowerCase();

    if (deniesMissingFeature(answer)) {
        return false;
    }

    return (
        /rollback (system|layer|process|mechanism|tool)/.test(lower) &&
        /(restor|undo|revert|cop(?:y|ies)|backup|snapshot)/.test(lower)
    );
}


function testProjectNumCtxConfiguration() {
    const chatOptions = getAskProjectChatOptions();

    if (RAG_NUM_CTX !== 8192) {
        throw new Error(`RAG_NUM_CTX should be 8192, got ${RAG_NUM_CTX}`);
    }

    if (chatOptions.numCtx !== 8192) {
        throw new Error(
            `Project RAG chat options should request numCtx 8192, got ${chatOptions.numCtx}`,
        );
    }

    const withCtx = buildOllamaGenerationOptions({
        temperature: 0.2,
        numPredict: 1000,
        numCtx: chatOptions.numCtx,
    });

    if (withCtx.num_ctx !== 8192) {
        throw new Error(
            `Project numCtx should become num_ctx 8192, got ${withCtx.num_ctx}`,
        );
    }

    pass("Project RAG chat request uses numCtx 8192");
}


function testOmittedNumCtxRetainsDefault() {
    const omitted = buildOllamaGenerationOptions({
        temperature: 0.4,
        numPredict: 1000,
    });

    if (Object.hasOwn(omitted, "num_ctx")) {
        throw new Error("Omitting numCtx should not set num_ctx.");
    }

    const invalidValues = [0, -1, 12.5, "8192", null];

    for (const numCtx of invalidValues) {
        const options = buildOllamaGenerationOptions({
            temperature: 0.2,
            numPredict: 1000,
            numCtx,
        });

        if (Object.hasOwn(options, "num_ctx")) {
            throw new Error(
                `Invalid numCtx (${numCtx}) should not set num_ctx.`,
            );
        }
    }

    pass("omitting numCtx retains default Ollama context");
}


function testOllamaUnreachableErrorFormatting() {
    const operation = "Could not reach Ollama while generating a chat response.";

    if (formatOllamaUnreachableError(operation, {}) !== operation) {
        throw new Error("Missing cause should keep the operation message.");
    }

    const withBoth = formatOllamaUnreachableError(operation, {
        cause: {
            code: "UND_ERR_SOCKET",
            message: "other side closed",
        },
    });

    if (withBoth !== `${operation} UND_ERR_SOCKET: other side closed`) {
        throw new Error(`Unexpected diagnostic suffix: ${withBoth}`);
    }

    const codeOnly = formatOllamaUnreachableError(operation, {
        cause: { code: "ECONNREFUSED" },
    });

    if (codeOnly !== `${operation} ECONNREFUSED`) {
        throw new Error(`Unexpected code-only suffix: ${codeOnly}`);
    }

    pass("Ollama network errors include operation-specific diagnostics");
}


function testDiversifyMatches() {
    const sameFile = [
        chunk("README.md", 1, 0.9),
        chunk("README.md", 40, 0.8),
        chunk("README.md", 80, 0.7),
        chunk("README.md", 120, 0.6),
        chunk("lib/a.js", 1, 0.5),
    ];

    const first = diversifyMatches(sameFile, 5);

    if (
        first.length !== 5 ||
        first[0].startLine !== 1 ||
        first[1].startLine !== 40 ||
        first[2].filePath !== "lib/a.js"
    ) {
        throw new Error(
            "First pass should take two README chunks then other files.",
        );
    }

    if (first.filter((item) => item.filePath === "README.md").length !== 4) {
        throw new Error(
            "Second pass should fill remaining slots from the same file.",
        );
    }

    if (first.some((item, index) => item.similarity !== sameFile.find(
        (original) => original.startLine === item.startLine &&
            original.filePath === item.filePath,
    )?.similarity)) {
        throw new Error("diversifyMatches changed similarity values.");
    }

    const mixed = [
        chunk("a.js", 1, 0.99),
        chunk("a.js", 40, 0.98),
        chunk("a.js", 80, 0.97),
        chunk("b.js", 1, 0.96),
        chunk("b.js", 40, 0.95),
        chunk("c.js", 1, 0.94),
        chunk("c.js", 40, 0.93),
        chunk("d.js", 1, 0.92),
        chunk("e.js", 1, 0.91),
    ];
    const diversified = diversifyMatches(mixed, 8);
    const files = diversified.map((item) => item.filePath);

    if (diversified.length !== 8) {
        throw new Error(`Expected 8 diversified matches, got ${diversified.length}`);
    }

    if (files.filter((name) => name === "a.js").length !== 2) {
        throw new Error("First pass should cap a.js at 2 before fill.");
    }

    if (!files.includes("d.js") || !files.includes("e.js")) {
        throw new Error("Diversity should include later files before a third a.js.");
    }

    pass("diversifyMatches two-pass selection");
}


function makeSynthChunk(filePath, startLine, similarity, content) {
    return {
        filePath,
        startLine,
        endLine: startLine + 20,
        similarity,
        content,
    };
}


function sameMatchList(a, b) {
    return JSON.stringify(
        a.map((item) => ({
            filePath: item.filePath,
            startLine: item.startLine,
            endLine: item.endLine,
            similarity: item.similarity,
        })),
    ) === JSON.stringify(
        b.map((item) => ({
            filePath: item.filePath,
            startLine: item.startLine,
            endLine: item.endLine,
            similarity: item.similarity,
        })),
    );
}


function testExtractUsefulSymbols() {
    const js = `
export function calculateWidgetBudget(limit) {
    return calculateWidgetBudget(limit);
}

import { calculateWidgetBudget } from "./alpha.js";
const leftover = 1;
    `.trim();

    const symbols = extractUsefulSymbols(js);

    if (!symbols.includes("calculateWidgetBudget")) {
        throw new Error("Should extract calculateWidgetBudget.");
    }

    if (symbols.includes("limit") || symbols.includes("return") || symbols.includes("const")) {
        throw new Error("Should not extract keywords or trivial parameter names.");
    }

    const prose = "The retrieved context talks about ordinary English budgets and sizes.";
    const proseSymbols = extractUsefulSymbols(prose);

    if (proseSymbols.includes("retrieved") || proseSymbols.includes("ordinary")) {
        throw new Error("Should not extract ordinary English prose tokens.");
    }

    const constantText = "export const WIDGET_LIMIT = 10;\nuseCap(WIDGET_LIMIT);";
    const constantSymbols = extractUsefulSymbols(constantText);

    if (!constantSymbols.includes("WIDGET_LIMIT")) {
        throw new Error("Should extract uppercase constants such as WIDGET_LIMIT.");
    }

    if (!constantSymbols.includes("useCap")) {
        throw new Error("Should extract mixed-case call identifiers.");
    }

    pass("extractUsefulSymbols finds meaningful identifiers");
}


function testClassifySymbolEvidence() {
    const definition = classifySymbolEvidence(
        "export function calculateWidgetBudget(limit) {\n  return 1;\n}",
        "calculateWidgetBudget",
    );
    const call = classifySymbolEvidence(
        "const total = calculateWidgetBudget(5);",
        "calculateWidgetBudget",
    );
    const imported = classifySymbolEvidence(
        'import { calculateWidgetBudget } from "./alpha.js";',
        "calculateWidgetBudget",
    );
    const reference = classifySymbolEvidence(
        "See calculateWidgetBudget for details about budgets.",
        "calculateWidgetBudget",
    );
    const constantDef = classifySymbolEvidence(
        "export const WIDGET_LIMIT = 10;",
        "WIDGET_LIMIT",
    );
    const pythonDef = classifySymbolEvidence(
        "def hydrate_sprocket(count):\n    return count",
        "hydrate_sprocket",
    );
    const pythonCall = classifySymbolEvidence(
        "value = hydrate_sprocket(3)",
        "hydrate_sprocket",
    );
    const missing = classifySymbolEvidence(
        "calculateWidgetBudgeting(1)",
        "calculateWidgetBudget",
    );

    if (definition !== "definition") {
        throw new Error(`Expected definition, got ${definition}`);
    }

    if (call !== "call") {
        throw new Error(`Expected call, got ${call}`);
    }

    if (imported !== "import") {
        throw new Error(`Expected import, got ${imported}`);
    }

    if (reference !== "reference") {
        throw new Error(`Expected reference, got ${reference}`);
    }

    if (constantDef !== "definition") {
        throw new Error(`Expected constant definition, got ${constantDef}`);
    }

    if (pythonDef !== "definition" || pythonCall !== "call") {
        throw new Error("Python definition/call detection failed.");
    }

    if (missing !== null) {
        throw new Error("Whole-identifier match should reject prefixed names.");
    }

    if (!wholeIdentifierOccurs("calculateWidgetBudget(1)", "calculateWidgetBudget")) {
        throw new Error("wholeIdentifierOccurs should match exact identifiers.");
    }

    pass("definition/call-site detection");
}


function testExpandWithCrossReferences() {
    const alpha = makeSynthChunk(
        "alpha.js",
        1,
        0.91,
        "export function calculateWidgetBudget(limit) {\n  return limit * 2;\n}",
    );
    const beta = makeSynthChunk(
        "beta.js",
        10,
        0.41,
        "const total = calculateWidgetBudget(4);\nexport function runBudget() {\n  return total;\n}",
    );
    const gamma = makeSynthChunk(
        "gamma.js",
        1,
        0.58,
        "export function unrelatedHelper() {\n  return 2;\n}",
    );
    const docs = makeSynthChunk(
        "docs.md",
        1,
        0.84,
        "See calculateWidgetBudget for details about how budgets are computed.",
    );
    const alphaDup = makeSynthChunk(
        "alpha.js",
        1,
        0.91,
        alpha.content,
    );

    const selected = [alpha, docs, gamma];
    const allChunks = [alpha, docs, gamma, beta];
    const expanded = expandWithCrossReferences(selected, allChunks, 3);

    if (expanded.length > 3) {
        throw new Error(`Final evidence exceeded budget: ${expanded.length}`);
    }

    if (expanded.length !== 3) {
        throw new Error(`Expected 3 chunks, got ${expanded.length}`);
    }

    const files = expanded.map((item) => item.filePath);

    if (!files.includes("alpha.js")) {
        throw new Error("Should preserve the defining implementation chunk.");
    }

    if (!files.includes("beta.js")) {
        throw new Error("Should promote the cross-file call site.");
    }

    if (files.includes("docs.md")) {
        throw new Error("Source call-site evidence should outrank incidental Markdown.");
    }

    const betaHit = expanded.find((item) => item.filePath === "beta.js");

    if (betaHit.similarity !== 0.41) {
        throw new Error("Cross-reference merge rewrote cosine similarity.");
    }

    const withDuplicatePool = expandWithCrossReferences(
        [alpha, docs, gamma],
        [alpha, alphaDup, docs, gamma, beta],
        3,
    );
    const alphaCount = withDuplicatePool.filter((item) => {
        return item.filePath === "alpha.js" && item.startLine === 1;
    }).length;

    if (alphaCount !== 1) {
        throw new Error("Should not insert duplicate chunk identities.");
    }

    const again = expandWithCrossReferences(selected, allChunks, 3);

    if (!sameMatchList(expanded, again)) {
        throw new Error("Cross-reference expansion must be deterministic.");
    }

    const widgetDef = makeSynthChunk(
        "limits.js",
        1,
        0.88,
        "export const WIDGET_LIMIT = 10;",
    );
    const widgetUse = makeSynthChunk(
        "consumer.js",
        8,
        0.36,
        "const cap = WIDGET_LIMIT;\nexport function applyCap(value) {\n  return Math.min(value, cap);\n}",
    );
    const widgetDocs = makeSynthChunk(
        "notes.md",
        1,
        0.8,
        "The WIDGET_LIMIT should stay at ten for this lab.",
    );
    const widgetOther = makeSynthChunk(
        "unrelated.js",
        1,
        0.52,
        "export function paintCanvas() {\n  return true;\n}",
    );

    const widgetExpanded = expandWithCrossReferences(
        [widgetDef, widgetDocs, widgetOther],
        [widgetDef, widgetDocs, widgetOther, widgetUse],
        3,
    );
    const widgetFiles = widgetExpanded.map((item) => item.filePath);

    if (!widgetFiles.includes("consumer.js")) {
        throw new Error("Uppercase constant cross-file use should be promoted.");
    }

    if (widgetFiles.includes("notes.md")) {
        throw new Error("Constant source evidence should outrank Markdown mentions.");
    }

    if (widgetExpanded.some((item) => item.filePath === "consumer.js" && item.similarity !== 0.36)) {
        throw new Error("Uppercase-constant expansion rewrote similarity.");
    }

    const bounded = expandWithCrossReferences(
        [alpha, docs],
        [alpha, docs, gamma, beta],
        2,
    );

    if (bounded.length !== 2) {
        throw new Error(`Budget 2 should stay 2, got ${bounded.length}`);
    }

    const healthDef = makeSynthChunk(
        "ollama.js",
        1,
        0.9,
        "export async function getInstalledModelNames() {\n  return [];\n}",
    );
    const healthMid = makeSynthChunk(
        "mid.js",
        1,
        0.55,
        "export function formatBanner() {\n  return 1;\n}",
    );
    const healthDocs = makeSynthChunk(
        "notes.md",
        1,
        0.8,
        "Health checks confirm Ollama is running.",
    );
    const healthCall = makeSynthChunk(
        "server.js",
        10,
        0.34,
        "const names = await getInstalledModelNames();\nexport async function handleHealth() {\n  return names;\n}",
    );
    const healthExpanded = expandWithCrossReferences(
        [healthDef, healthMid, healthDocs],
        [healthDef, healthMid, healthDocs, healthCall],
        3,
    );
    const healthFiles = healthExpanded.map((item) => item.filePath);

    if (!healthFiles.includes("server.js")) {
        throw new Error("Cross-file helper call should replace incidental Markdown.");
    }

    if (healthFiles.includes("notes.md")) {
        throw new Error("Helper call site should outrank Markdown.");
    }

    const routeServer = makeSynthChunk(
        "server.js",
        40,
        0.88,
        'if (pathname === "/api/health") {\n  await handleHealth(response);\n}',
    );
    const routeDocs = makeSynthChunk(
        "notes.md",
        1,
        0.7,
        "The UI polls application health.",
    );
    const routeUi = makeSynthChunk(
        "statusService.ts",
        1,
        0.31,
        'export async function fetchHealth() {\n  return fetch("/api/health");\n}',
    );
    const routeExpanded = expandWithCrossReferences(
        [routeServer, routeDocs],
        [routeServer, routeDocs, routeUi],
        2,
    );
    const routeFiles = routeExpanded.map((item) => item.filePath);

    if (!routeFiles.includes("statusService.ts")) {
        throw new Error("Shared /api/ route literals should promote the HTTP client.");
    }

    pass("cross-reference expansion is generic and bounded");
}


function testPreferImplementationOnNearTie() {
    const farApart = preferImplementationOnNearTie([
        chunk("README.md", 1, 0.9),
        chunk("lib/code.js", 1, 0.87),
    ]);

    if (farApart[0].filePath !== "README.md" || farApart[1].filePath !== "lib/code.js") {
        throw new Error("Larger similarity gaps must keep cosine order.");
    }

    const nearTie = preferImplementationOnNearTie([
        chunk("README.md", 1, 0.5),
        chunk("lib/code.js", 1, 0.495),
        chunk("notes.md", 1, 0.494),
    ]);

    if (nearTie[0].filePath !== "lib/code.js") {
        throw new Error("Near-tied implementation file should precede Markdown.");
    }

    if (nearTie[1].filePath !== "README.md" || nearTie[2].filePath !== "notes.md") {
        throw new Error("Non-implementation files should keep relative order in a bucket.");
    }

    if (nearTie[0].similarity !== 0.495) {
        throw new Error("Tie-break must preserve original similarity values.");
    }

    const exact = preferImplementationOnNearTie([
        chunk("docs.md", 1, 0.4),
        chunk("app.py", 1, 0.4),
        chunk("ui.tsx", 20, 0.4),
    ]);

    if (exact[0].filePath !== "app.py" || exact[1].filePath !== "ui.tsx") {
        throw new Error("Equal scores should stably put implementation files first.");
    }

    const leaderGap = preferImplementationOnNearTie([
        chunk("README.md", 1, 0.5),
        chunk("lib/a.js", 1, 0.495),
        chunk("lib/b.js", 1, 0.48),
    ]);

    if (leaderGap[0].filePath !== "lib/a.js") {
        throw new Error("0.01 window from the leader should allow source to precede Markdown.");
    }

    if (leaderGap[2].filePath !== "lib/b.js") {
        throw new Error("Chunks more than 0.01 below the leader start a new bucket.");
    }

    pass("preferImplementationOnNearTie is deterministic");
}


async function testIndexPresent() {
    const index = await loadIndex();

    if (!Array.isArray(index.chunks) || index.chunks.length === 0) {
        throw new Error("The index file exists but contains no chunks.");
    }

    pass("project index loaded", `${index.chunks.length} chunks`);
}


async function testTopKSplit(question) {
    const searchMatches = await searchIndex(question);
    const ragMatches = await retrieveForAsk(question);

    if (searchMatches.length !== TOP_K) {
        throw new Error(
            `searchIndex returned ${searchMatches.length}, expected ${TOP_K}`,
        );
    }

    if (ragMatches.length !== RAG_TOP_K) {
        throw new Error(
            `retrieveForAsk returned ${ragMatches.length}, expected ${RAG_TOP_K}`,
        );
    }

    pass(
        "TOP_K vs RAG_TOP_K",
        `search=${searchMatches.length} rag=${ragMatches.length}`,
    );

    return ragMatches;
}


function assertExpectedMoveFiles(matches) {
    const missing = EXPECTED_MOVE_FILES.filter(
        (filePath) => !matchHasFile(matches, filePath),
    );
    const listing = formatMatches(matches.slice(0, RAG_TOP_K));

    console.log("\nRetrieved RAG matches:\n" + listing + "\n");

    if (missing.length > 0) {
        fail(
            "move-validation retrieved files",
            `missing ${missing.join(", ")}\n${listing}`,
        );
        return false;
    }

    pass(
        "move-validation retrieved files",
        EXPECTED_MOVE_FILES.join(", "),
    );
    return true;
}


function assertMoveAnswerGrounding(answer) {
    const problems = [];

    if (claimsUnsupportedFlag(answer, "force")) {
        problems.push("claimed a force flag");
    }

    if (claimsUnsupportedFlag(answer, "overwrite")) {
        problems.push("claimed an overwrite flag");
    }

    if (claimsOverwriteAfterApproval(answer)) {
        problems.push("claimed overwrite is allowed after approval");
    }

    if (claimsGetFileInfoMoveSecurity(answer)) {
        problems.push("claimed get_file_info performs move-path security");
    }

    if (!showsNoOverwrite(answer)) {
        problems.push("did not state existing destinations are rejected");
    }

    if (!hasImplementationCitation(answer)) {
        problems.push("missing file/line citation");
    }

    if (problems.length > 0) {
        fail(
            "move-validation answer grounding",
            `${problems.join("; ")}\n${answer}`,
        );
        return;
    }

    pass("move-validation answer grounding", answer.slice(0, 180));
}


function assertOverwriteAnswer(answer) {
    const problems = [];
    const lower = answer.toLowerCase();
    const denies =
        /\bno\b/.test(lower) ||
        /cannot overwrite/.test(lower) ||
        /does not overwrite/.test(lower) ||
        /reject/.test(lower);

    if (!denies) {
        problems.push("did not deny overwrite");
    }

    if (claimsOverwriteAfterApproval(answer)) {
        problems.push("claimed overwrite after approval");
    }

    if (claimsUnsupportedFlag(answer, "force")) {
        problems.push("claimed a force flag exists");
    }

    if (claimsUnsupportedFlag(answer, "overwrite")) {
        problems.push("claimed an overwrite flag exists");
    }

    if (!showsNoOverwrite(answer)) {
        problems.push("did not cite no-overwrite behavior");
    }

    if (!citesOverwriteEvidence(answer)) {
        problems.push("did not point at retrieved implementation evidence");
    }

    if (problems.length > 0) {
        fail("no-overwrite question", `${problems.join("; ")}\n${answer}`);
        return;
    }

    pass("no-overwrite question", answer.slice(0, 180));
}


async function askProjectWithRetry(question) {
    let lastError;

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            return await askProject(question);
        } catch (error) {
            lastError = error;
            console.warn(
                `askProject attempt ${attempt} failed: ${error.message}`,
            );
        }
    }

    throw lastError;
}


function assertRollbackAnswer(answer) {
    if (inventsRollbackSystem(answer)) {
        fail("missing-feature rollback", `invented a rollback system\n${answer}`);
        return;
    }

    if (!deniesMissingFeature(answer)) {
        fail(
            "missing-feature rollback",
            `did not say the retrieved context lacks a rollback system\n${answer}`,
        );
        return;
    }

    pass("missing-feature rollback", answer.slice(0, 180));
}


function hasProjectNumCtxDefinition(matches) {
    return matches.some((item) => {
        return (
            normalizePath(item.filePath).includes("lib/rag.js") &&
            /RAG_NUM_CTX\s*=\s*8192/.test(item.content)
        );
    });
}


function hasChatOllamaCallSite(matches) {
    return matches.some((item) => {
        if (!normalizePath(item.filePath).includes("lib/chat.js")) {
            return false;
        }

        return /chatWithOllama\s*\(/.test(item.content) && !/\bnumCtx\s*:/.test(item.content);
    });
}


function hasComputerOllamaCallSite(matches) {
    return matches.some((item) => {
        if (!normalizePath(item.filePath).includes("lib/agent.js")) {
            return false;
        }

        const called =
            /chatWithTools\s*\(/.test(item.content) ||
            /chatWithOllamaTools\s*\(/.test(item.content);

        return called && !/\bnumCtx\s*:/.test(item.content);
    });
}


function hasOptionalNumCtxHelper(matches) {
    return matches.some((item) => {
        if (!normalizePath(item.filePath).includes("lib/ollama.js")) {
            return false;
        }

        const mentionsBoth = /\bnum_ctx\b/.test(item.content) && /\bnumCtx\b/.test(item.content);
        const optional =
            /positive integer/i.test(item.content) ||
            /Number\.isInteger\s*\(\s*numCtx/.test(item.content) ||
            /num_ctx\s*=\s*numCtx/.test(item.content);

        return mentionsBoth && optional;
    });
}


function assertContextSizeRetrieval(matches) {
    const listing = formatMatches(matches);

    console.log("\nContext-size RAG matches:\n" + listing + "\n");

    if (matches.length > RAG_TOP_K) {
        fail(
            "context-size comparison retrieval",
            `evidence budget exceeded: ${matches.length} > ${RAG_TOP_K}\n${listing}`,
        );
        return;
    }

    const missing = [];

    if (!hasProjectNumCtxDefinition(matches)) {
        missing.push("Project RAG_NUM_CTX = 8192 definition");
    }

    if (!hasChatOllamaCallSite(matches)) {
        missing.push("Chat chatWithOllama() call site omitting numCtx");
    }

    if (!hasComputerOllamaCallSite(matches)) {
        missing.push("Computer chatWithTools()/chatWithOllamaTools() call site omitting numCtx");
    }

    if (!hasOptionalNumCtxHelper(matches)) {
        missing.push("shared Ollama helper optional num_ctx behavior");
    }

    if (missing.length > 0) {
        fail(
            "context-size comparison retrieval",
            `missing ${missing.join("; ")}\n${listing}`,
        );
        return;
    }

    pass("context-size comparison retrieval", listing.replaceAll("\n", " | "));
}


async function main() {
    try {
        testProjectNumCtxConfiguration();
    } catch (error) {
        fail("Project RAG chat request uses numCtx 8192", error.message);
    }

    try {
        testOmittedNumCtxRetainsDefault();
    } catch (error) {
        fail("omitting numCtx retains default Ollama context", error.message);
    }

    try {
        testOllamaUnreachableErrorFormatting();
    } catch (error) {
        fail(
            "Ollama network errors include operation-specific diagnostics",
            error.message,
        );
    }

    try {
        testDiversifyMatches();
    } catch (error) {
        fail("diversifyMatches two-pass selection", error.message);
    }

    try {
        testPreferImplementationOnNearTie();
    } catch (error) {
        fail("preferImplementationOnNearTie is deterministic", error.message);
    }

    try {
        testExtractUsefulSymbols();
    } catch (error) {
        fail("extractUsefulSymbols finds meaningful identifiers", error.message);
    }

    try {
        testClassifySymbolEvidence();
    } catch (error) {
        fail("definition/call-site detection", error.message);
    }

    try {
        testExpandWithCrossReferences();
    } catch (error) {
        fail("cross-reference expansion is generic and bounded", error.message);
    }

    try {
        await testIndexPresent();
    } catch (error) {
        fail("project index loaded", error.message);
        console.log("");
        console.log(
            "Rebuild the index before RAG tests:\n\n  node project-rag.js index\n",
        );
        summarize();
        process.exitCode = 1;
        return;
    }

    let names;

    try {
        names = await getInstalledModelNames();
    } catch (error) {
        skip("TOP_K vs RAG_TOP_K", `Ollama unreachable (${error.message})`);
        skip("context-size comparison retrieval", "Ollama unreachable");
        skip("move-validation retrieved files", "Ollama unreachable");
        skip("move-validation answer grounding", "Ollama unreachable");
        skip("no-overwrite question", "Ollama unreachable");
        skip("missing-feature rollback", "Ollama unreachable");
        summarize();
        return;
    }

    if (!names.includes(EMBEDDING_MODEL)) {
        const detail = `${EMBEDDING_MODEL} is not installed`;
        skip("TOP_K vs RAG_TOP_K", detail);
        skip("context-size comparison retrieval", detail);
        skip("move-validation retrieved files", detail);
        skip("move-validation answer grounding", detail);
        skip("no-overwrite question", detail);
        skip("missing-feature rollback", detail);
        summarize();
        return;
    }

    let ragMatches;

    try {
        ragMatches = await testTopKSplit(MOVE_QUESTION);
        assertExpectedMoveFiles(ragMatches);
    } catch (error) {
        fail("TOP_K vs RAG_TOP_K", error.message);
        skip("move-validation retrieved files", "retrieval failed");
    }

    try {
        const contextMatches = await retrieveForAsk(CONTEXT_QUESTION);
        assertContextSizeRetrieval(contextMatches);
    } catch (error) {
        fail("context-size comparison retrieval", error.message);
    }

    if (!names.includes(CHAT_MODEL)) {
        const detail = `${CHAT_MODEL} is not installed`;
        skip("move-validation answer grounding", detail);
        skip("no-overwrite question", detail);
        skip("missing-feature rollback", detail);
        summarize();
        return;
    }

    try {
        console.log("\nAsking move-validation question...\n");
        const result = await askProjectWithRetry(MOVE_QUESTION);
        console.log(result.answer);
        console.log("");
        console.log("Answer sources:\n" + formatMatches(result.matches) + "\n");
        assertMoveAnswerGrounding(result.answer);
    } catch (error) {
        fail("move-validation answer grounding", error.message);
    }

    try {
        console.log("\nAsking no-overwrite question...\n");
        const result = await askProjectWithRetry(OVERWRITE_QUESTION);
        console.log(result.answer);
        console.log("");
        assertOverwriteAnswer(result.answer);
    } catch (error) {
        fail("no-overwrite question", error.message);
    }

    try {
        console.log("\nAsking rollback question...\n");
        const result = await askProjectWithRetry(ROLLBACK_QUESTION);
        console.log(result.answer);
        console.log("");
        assertRollbackAnswer(result.answer);
    } catch (error) {
        fail("missing-feature rollback", error.message);
    }

    summarize();
}


function summarize() {
    const failed = results.filter((item) => item.status === "fail");
    console.log("");
    console.log(
        `Results: ${results.filter((item) => item.status === "pass").length} passed, ` +
        `${failed.length} failed, ` +
        `${results.filter((item) => item.status === "skip").length} skipped`,
    );

    if (failed.length > 0) {
        process.exitCode = 1;
    }
}


main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
