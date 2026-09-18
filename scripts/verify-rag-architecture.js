// =========================================================
// scripts/verify-rag-architecture.js
//
// Architecture retrieval benchmark for Project RAG.
// Uses the real project index and retrieveForAsk().
// Expected filenames and content probes live only here.
// Does not rewrite answers or change production retrieval.
// =========================================================


import {
    CHAT_MODEL,
    EMBEDDING_MODEL,
    createEmbeddings,
    getInstalledModelNames,
} from "../lib/ollama.js";
import {
    RAG_TOP_K,
    TOP_K,
    askProject,
    classifySymbolEvidence,
    cosineSimilarity,
    extractUsefulSymbols,
    loadIndex,
    retrieveForAsk,
    searchIndex,
} from "../lib/rag.js";


const COMPUTER_APPROVAL_QUESTION =
    "How does a Computer-mode mutation move from the model requesting a tool, through argument validation and pending approval, to execution after the user approves it?";

const UI_API_RAG_QUESTION =
    "How does a Project-mode question travel from the React UI to the backend, through RAG retrieval, and back to the UI with source metadata?";

const HEALTH_QUESTION =
    "How does the application determine whether Ollama and the required models are available, and how does that status reach the frontend?";

const CHAT_PERSISTENCE_QUESTION =
    "How does normal Chat load conversation history, send a new message to Ollama, and persist the updated conversation back to disk?";

const COSINE_EPS = 1e-4;

const CITATION_PATTERNS = [
    /`?([\w./\\-]+\.(?:js|jsx|ts|tsx|py))`?\s*(?:—|--|,|:)?\s*\(?(?:lines?|line)\s+(\d+)\s*[–—-]\s*(\d+)\)?/gi,
    /`?([\w./\\-]+\.(?:js|jsx|ts|tsx|py))`?\s*:\s*(\d+)\s*[–—-]\s*(\d+)/gi,
];


const results = [];
const timings = [];
const noiseWarnings = [];


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


function warnNoise(name, detail) {
    noiseWarnings.push({ name, detail });
    console.log(`WARN  ${name} — ${detail}`);
}


function normalizePath(filePath) {
    return String(filePath).replaceAll("\\", "/").toLowerCase();
}


function chunkIdentity(chunk) {
    return `${chunk.filePath}:${chunk.startLine}:${chunk.endLine}`;
}


function matchHasFile(matches, expected) {
    const want = normalizePath(expected);
    return matches.some((item) => normalizePath(item.filePath).includes(want));
}


function matchesForFile(matches, expected) {
    const want = normalizePath(expected);
    return matches.filter((item) => normalizePath(item.filePath).includes(want));
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


function printRetrievalSet(title, matches) {
    console.log(`\n${title}:\n${formatMatches(matches)}\n`);
}


function fileContent(matches, expected) {
    return matchesForFile(matches, expected)
        .map((item) => item.content ?? "")
        .join("\n");
}


function requiredFilesPresent(matches, requiredFiles) {
    return requiredFiles.filter((filePath) => !matchHasFile(matches, filePath));
}


function assertSharedRetrievalInvariants(name, matches, expectedByIdentity) {
    const listing = formatMatches(matches);

    if (matches.length > RAG_TOP_K) {
        fail(
            name,
            `evidence budget exceeded: ${matches.length} > ${RAG_TOP_K}\n${listing}`,
        );
        return false;
    }

    const identities = matches.map(chunkIdentity);
    const unique = new Set(identities);

    if (unique.size !== identities.length) {
        fail(name, `duplicate chunk identities\n${listing}`);
        return false;
    }

    for (const match of matches) {
        const key = chunkIdentity(match);
        const expected = expectedByIdentity.get(key);

        if (expected === undefined) {
            fail(
                name,
                `returned chunk ${key} was not in the scored index\n${listing}`,
            );
            return false;
        }

        if (!Number.isFinite(match.similarity) || !Number.isFinite(expected)) {
            fail(
                name,
                `non-finite similarity for ${key} ` +
                `(got ${match.similarity}, expected ${expected})\n${listing}`,
            );
            return false;
        }

        if (Math.abs(match.similarity - expected) > COSINE_EPS) {
            fail(
                name,
                `cosine similarity rewritten for ${key}: ` +
                `got ${match.similarity}, original ${expected}\n${listing}`,
            );
            return false;
        }
    }

    return true;
}


function reportArchitectureNoise(name, matches, requiredFiles, semanticMatches) {
    const useful = matches.filter((item) => {
        return requiredFiles.some((filePath) => {
            return normalizePath(item.filePath).includes(normalizePath(filePath));
        });
    });

    const usefulSymbols = [];
    const seenSymbols = new Set();

    for (const chunk of useful) {
        for (const symbol of extractUsefulSymbols(chunk.content ?? "")) {
            if (!seenSymbols.has(symbol)) {
                seenSymbols.add(symbol);
                usefulSymbols.push(symbol);
            }
        }
    }

    let unrelated = 0;

    for (const chunk of matches) {
        const isRequired = requiredFiles.some((filePath) => {
            return normalizePath(chunk.filePath).includes(normalizePath(filePath));
        });

        if (isRequired) {
            continue;
        }

        const content = chunk.content ?? "";
        const related = usefulSymbols.some((symbol) => {
            return classifySymbolEvidence(content, symbol) !== null;
        });

        if (!related) {
            unrelated += 1;
        }
    }

    if (unrelated > 2) {
        warnNoise(
            name,
            `${unrelated} final chunks have no symbol relationship ` +
            "to the required architecture evidence",
        );
    }

    const hasMarkdown = matches.some((item) => {
        return normalizePath(item.filePath).endsWith(".md");
    });

    if (hasMarkdown && useful.length > 0) {
        warnNoise(
            name,
            "Markdown is in the final set while implementation evidence is present",
        );
    }

    printRetrievalSet(`${name} semantic searchIndex top ${TOP_K}`, semanticMatches);
}


async function scoreIndex(question, index) {
    const questionEmbeddings = await createEmbeddings(
        [question],
        EMBEDDING_MODEL,
    );
    const questionEmbedding = questionEmbeddings[0];
    const expectedByIdentity = new Map();

    for (const chunk of index.chunks) {
        expectedByIdentity.set(
            chunkIdentity(chunk),
            cosineSimilarity(questionEmbedding, chunk.embedding),
        );
    }

    return expectedByIdentity;
}


async function retrieveArchitectureCase(name, question, index) {
    const started = Date.now();
    const matches = await retrieveForAsk(question);
    const elapsedMs = Date.now() - started;
    timings.push({ name: `${name} retrieveForAsk`, elapsedMs });

    const semanticMatches = await searchIndex(question);
    const expectedByIdentity = await scoreIndex(question, index);

    printRetrievalSet(`${name} retrieveForAsk`, matches);

    if (!assertSharedRetrievalInvariants(name, matches, expectedByIdentity)) {
        return null;
    }

    return { matches, semanticMatches, elapsedMs };
}


function assertComputerApproval(matches) {
    const listing = formatMatches(matches);
    const missing = requiredFilesPresent(matches, [
        "lib/agent.js",
        "lib/tools/registry.js",
    ]);

    if (missing.length > 0) {
        fail(
            "architecture A computer approval retrieval",
            `missing ${missing.join(", ")}\n${listing}`,
        );
        return false;
    }

    const agentText = fileContent(matches, "lib/agent.js");
    const registryText = fileContent(matches, "lib/tools/registry.js");

    const agentPipeline =
        /dispatchToolCall/.test(agentText) ||
        /pendingApprovals/.test(agentText) ||
        /approveById/.test(agentText);

    const registryPipeline =
        /validateToolArguments/.test(registryText) ||
        /executeTool/.test(registryText) ||
        /PERMISSION_APPROVAL/.test(registryText);

    if (!agentPipeline) {
        fail(
            "architecture A computer approval retrieval",
            "lib/agent.js chunks lack dispatchToolCall / pendingApprovals / approveById\n" +
            listing,
        );
        return false;
    }

    if (!registryPipeline) {
        fail(
            "architecture A computer approval retrieval",
            "lib/tools/registry.js chunks lack validateToolArguments / executeTool / PERMISSION_APPROVAL\n" +
            listing,
        );
        return false;
    }

    pass(
        "architecture A computer approval retrieval",
        `${matches.length} chunks`,
    );
    return true;
}


function assertUiApiRag(matches) {
    const listing = formatMatches(matches);
    const required = [
        "ui/src/services/chatService.ts",
        "server.js",
        "lib/rag.js",
    ];
    const missing = requiredFilesPresent(matches, required);

    if (missing.length > 0) {
        fail(
            "architecture B UI API RAG retrieval",
            `missing ${missing.join(", ")}\n${listing}`,
        );
        return false;
    }

    const uiText = fileContent(matches, "ui/src/services/chatService.ts");
    const serverText = fileContent(matches, "server.js");
    const ragText = fileContent(matches, "lib/rag.js");

    const missingFacts = [];

    if (!(/contextMode\s*===\s*["']project["']/.test(uiText) && /\/api\/rag/.test(uiText))) {
        missingFacts.push("chatService.ts Project mode /api/rag");
    }

    const serverHandlesRag =
        /\/api\/rag/.test(serverText) || /handleRagPost/.test(serverText);
    const serverStripsContent =
        /filePath/.test(serverText) &&
        /startLine/.test(serverText) &&
        /endLine/.test(serverText) &&
        /similarity/.test(serverText) &&
        !/\bcontent:/.test(serverText);

    if (!serverHandlesRag) {
        missingFacts.push("server.js /api/rag handler");
    }

    if (!serverStripsContent) {
        missingFacts.push("server.js strips chunk content from returned matches");
    }

    if (!/askProject\s*\(/.test(ragText)) {
        missingFacts.push("lib/rag.js askProject()");
    }

    if (missingFacts.length > 0) {
        fail(
            "architecture B UI API RAG retrieval",
            `missing ${missingFacts.join("; ")}\n${listing}`,
        );
        return false;
    }

    pass(
        "architecture B UI API RAG retrieval",
        `${matches.length} chunks`,
    );
    return true;
}


function assertHealthPipeline(matches) {
    const listing = formatMatches(matches);
    const required = [
        "lib/ollama.js",
        "server.js",
        "ui/src/services/statusService.ts",
    ];
    const missing = requiredFilesPresent(matches, required);

    if (missing.length > 0) {
        fail(
            "architecture C health status retrieval",
            `missing ${missing.join(", ")}\n${listing}`,
        );
        return false;
    }

    const ollamaText = fileContent(matches, "lib/ollama.js");
    const serverText = fileContent(matches, "server.js");
    const statusText = fileContent(matches, "ui/src/services/statusService.ts");
    const missingFacts = [];

    if (!/getInstalledModelNames/.test(ollamaText)) {
        missingFacts.push("lib/ollama.js getInstalledModelNames");
    }

    if (!(/\/api\/health/.test(serverText) || /handleHealth/.test(serverText))) {
        missingFacts.push("server.js /api/health handler");
    }

    if (!(/fetchHealth/.test(statusText) && /\/api\/health/.test(statusText))) {
        missingFacts.push("statusService.ts fetchHealth /api/health");
    }

    if (missingFacts.length > 0) {
        fail(
            "architecture C health status retrieval",
            `missing ${missingFacts.join("; ")}\n${listing}`,
        );
        return false;
    }

    pass(
        "architecture C health status retrieval",
        `${matches.length} chunks`,
    );
    return true;
}


function assertChatPersistence(matches) {
    const listing = formatMatches(matches);

    if (!matchHasFile(matches, "lib/chat.js")) {
        fail(
            "architecture D chat persistence retrieval",
            `missing lib/chat.js\n${listing}`,
        );
        return false;
    }

    const chatText = fileContent(matches, "lib/chat.js");
    const missingFacts = [];

    if (
        !/loadHistoryFromDisk/.test(chatText) &&
        !/chat-history\.json/.test(chatText) &&
        !/initializeChat/.test(chatText)
    ) {
        missingFacts.push("load history from disk");
    }

    if (!/chatWithOllama/.test(chatText)) {
        missingFacts.push("chatWithOllama send path");
    }

    if (!/saveHistory/.test(chatText) && !/chat-history\.json/.test(chatText)) {
        missingFacts.push("persist history to disk");
    }

    if (missingFacts.length > 0) {
        fail(
            "architecture D chat persistence retrieval",
            `lib/chat.js chunks missing ${missingFacts.join("; ")}\n${listing}`,
        );
        return false;
    }

    pass(
        "architecture D chat persistence retrieval",
        `${matches.length} chunks`,
    );
    return true;
}


function parseImplementationCitations(answer) {
    const found = [];
    const seen = new Set();

    for (const pattern of CITATION_PATTERNS) {
        pattern.lastIndex = 0;
        let match;

        while ((match = pattern.exec(answer)) !== null) {
            const filePath = match[1];
            const startLine = Number(match[2]);
            const endLine = Number(match[3]);
            const key = `${normalizePath(filePath)}:${startLine}-${endLine}`;

            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            found.push({ filePath, startLine, endLine, text: match[0] });
        }
    }

    return found;
}


function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart <= bEnd && bStart <= aEnd;
}


function citationOverlapsRetrieved(citation, matches) {
    const citedStart = Math.min(citation.startLine, citation.endLine);
    const citedEnd = Math.max(citation.startLine, citation.endLine);

    return matchesForFile(matches, citation.filePath).some((item) => {
        return rangesOverlap(
            citedStart,
            citedEnd,
            Number(item.startLine),
            Number(item.endLine),
        );
    });
}


function citedFileInMatches(citation, matches) {
    return matchHasFile(matches, citation.filePath);
}


function extractApiPaths(answer) {
    const found = new Set();
    const pattern = /\/api\/[A-Za-z0-9_./-]+/g;
    let match;

    while ((match = pattern.exec(answer)) !== null) {
        found.add(match[0].replace(/[.,;:)]+$/, ""));
    }

    return [...found];
}


function extractMentionedSourceFiles(answer) {
    const found = new Set();
    const pattern = /[\w./\\-]+\.(?:js|jsx|ts|tsx|py)\b/gi;
    let match;

    while ((match = pattern.exec(answer)) !== null) {
        found.add(match[0].replaceAll("\\", "/"));
    }

    return [...found];
}


function mentionedFileInMatches(filePath, matches) {
    return matchHasFile(matches, filePath);
}


function assertGroundedArchitectureAnswer(name, result, requiredHints) {
    const listing = formatMatches(result.matches);
    const problems = [];

    if (result.matches.length > RAG_TOP_K) {
        problems.push(
            `sources exceeded budget: ${result.matches.length} > ${RAG_TOP_K}`,
        );
    }

    const citations = parseImplementationCitations(result.answer);

    if (citations.length === 0) {
        problems.push("no parseable file + line citations");
    }

    for (const citation of citations) {
        if (!citedFileInMatches(citation, result.matches)) {
            problems.push(
                `cited file not in retrieved matches: ${citation.text}`,
            );
            continue;
        }

        if (!citationOverlapsRetrieved(citation, result.matches)) {
            problems.push(
                `cited range does not overlap retrieved evidence: ${citation.text}`,
            );
        }
    }

    const retrievedText = result.matches
        .map((item) => item.content ?? "")
        .join("\n");

    for (const apiPath of extractApiPaths(result.answer)) {
        if (!retrievedText.includes(apiPath)) {
            problems.push(`invented route ${apiPath} is not in retrieved evidence`);
        }
    }

    for (const filePath of extractMentionedSourceFiles(result.answer)) {
        if (!mentionedFileInMatches(filePath, result.matches)) {
            problems.push(
                `mentioned file ${filePath} is not in retrieved sources`,
            );
        }
    }

    for (const hint of requiredHints) {
        if (hint.test && !hint.test.test(result.answer)) {
            problems.push(hint.missing);
        }
    }

    if (problems.length > 0) {
        fail(name, `${problems.join("; ")}\n${listing}\n\n${result.answer}`);
        return false;
    }

    pass(name, result.answer.slice(0, 180));
    return true;
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


async function runAnswerCase(name, question, requiredHints) {
    const started = Date.now();
    const result = await askProjectWithRetry(question);
    const elapsedMs = Date.now() - started;
    timings.push({ name: `${name} askProject`, elapsedMs });

    console.log(`\n${name} answer (${elapsedMs} ms):\n`);
    console.log(result.answer);
    console.log("");
    console.log("Answer sources:\n" + formatMatches(result.matches) + "\n");

    assertGroundedArchitectureAnswer(name, result, requiredHints);
    return result;
}


async function main() {
    let index;

    try {
        index = await loadIndex();

        if (!Array.isArray(index.chunks) || index.chunks.length === 0) {
            throw new Error("The index file exists but contains no chunks.");
        }

        pass("project index loaded", `${index.chunks.length} chunks`);
    } catch (error) {
        fail("project index loaded", error.message);
        console.log("");
        console.log(
            "Rebuild the index before architecture tests:\n\n  node project-rag.js index\n",
        );
        summarize();
        process.exitCode = 1;
        return;
    }

    let names;

    try {
        names = await getInstalledModelNames();
    } catch (error) {
        skip("architecture A computer approval retrieval", `Ollama unreachable (${error.message})`);
        skip("architecture B UI API RAG retrieval", "Ollama unreachable");
        skip("architecture C health status retrieval", "Ollama unreachable");
        skip("architecture D chat persistence retrieval", "Ollama unreachable");
        skip("architecture B UI API RAG answer", "Ollama unreachable");
        skip("architecture C health status answer", "Ollama unreachable");
        summarize();
        return;
    }

    if (!names.includes(EMBEDDING_MODEL)) {
        const detail = `${EMBEDDING_MODEL} is not installed`;
        skip("architecture A computer approval retrieval", detail);
        skip("architecture B UI API RAG retrieval", detail);
        skip("architecture C health status retrieval", detail);
        skip("architecture D chat persistence retrieval", detail);
        skip("architecture B UI API RAG answer", detail);
        skip("architecture C health status answer", detail);
        summarize();
        return;
    }

    const cases = [
        {
            name: "architecture A computer approval retrieval",
            question: COMPUTER_APPROVAL_QUESTION,
            requiredFiles: ["lib/agent.js", "lib/tools/registry.js"],
            assert: assertComputerApproval,
        },
        {
            name: "architecture B UI API RAG retrieval",
            question: UI_API_RAG_QUESTION,
            requiredFiles: [
                "ui/src/services/chatService.ts",
                "server.js",
                "lib/rag.js",
            ],
            assert: assertUiApiRag,
        },
        {
            name: "architecture C health status retrieval",
            question: HEALTH_QUESTION,
            requiredFiles: [
                "lib/ollama.js",
                "server.js",
                "ui/src/services/statusService.ts",
            ],
            assert: assertHealthPipeline,
        },
        {
            name: "architecture D chat persistence retrieval",
            question: CHAT_PERSISTENCE_QUESTION,
            requiredFiles: ["lib/chat.js"],
            assert: assertChatPersistence,
        },
    ];

    let retrievalFailed = false;

    for (const testCase of cases) {
        try {
            const retrieved = await retrieveArchitectureCase(
                testCase.name,
                testCase.question,
                index,
            );

            if (!retrieved) {
                retrievalFailed = true;
                continue;
            }

            const ok = testCase.assert(retrieved.matches);

            if (!ok) {
                retrievalFailed = true;
            }

            reportArchitectureNoise(
                testCase.name,
                retrieved.matches,
                testCase.requiredFiles,
                retrieved.semanticMatches,
            );
        } catch (error) {
            fail(testCase.name, error.message);
            retrievalFailed = true;
        }
    }

    if (retrievalFailed) {
        skip("architecture B UI API RAG answer", "retrieval failed");
        skip("architecture C health status answer", "retrieval failed");
        summarize();
        return;
    }

    if (!names.includes(CHAT_MODEL)) {
        const detail = `${CHAT_MODEL} is not installed`;
        skip("architecture B UI API RAG answer", detail);
        skip("architecture C health status answer", detail);
        summarize();
        return;
    }

    try {
        await runAnswerCase(
            "architecture B UI API RAG answer",
            UI_API_RAG_QUESTION,
            [
                {
                    test: /\/api\/rag/,
                    missing: "answer did not mention /api/rag",
                },
            ],
        );
    } catch (error) {
        fail("architecture B UI API RAG answer", error.message);
    }

    try {
        await runAnswerCase(
            "architecture C health status answer",
            HEALTH_QUESTION,
            [
                {
                    test: /\/api\/health/,
                    missing: "answer did not mention /api/health",
                },
            ],
        );
    } catch (error) {
        fail("architecture C health status answer", error.message);
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

    if (timings.length > 0) {
        console.log("");
        console.log("Timing:");
        for (const item of timings) {
            console.log(`  ${item.name}: ${item.elapsedMs} ms`);
        }
    }

    if (noiseWarnings.length > 0) {
        console.log("");
        console.log("Noise warnings:");
        for (const item of noiseWarnings) {
            console.log(`  ${item.name}: ${item.detail}`);
        }
    }

    if (failed.length > 0) {
        process.exitCode = 1;
    }
}


main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
