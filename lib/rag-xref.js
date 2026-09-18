// =========================================================
// lib/rag-xref.js
//
// Lightweight cross-reference expansion for Project RAG.
//
// After semantic retrieval, inspect selected implementation
// chunks, extract useful code symbols and /api/... route
// literals, and scan the already loaded index for
// definitions / imports / call sites / shared routes.
//
// Strong cross-file evidence can replace weaker leftover
// semantic slots without growing the Project RAG budget.
//
// Used only by the Project answering path. CLI searchIndex()
// stays ordinary top-K cosine retrieval.
//
// Does not create embeddings, call a second model, or rewrite
// cosine similarity values.
// =========================================================


import path from "node:path";


const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const MIN_SYMBOL_LENGTH = 3;
const MAX_SYMBOLS = 40;
const MAX_SYMBOLS_PER_CHUNK = 16;
const MAX_HOPS = 2;
const MAX_HOP_SEED_CHUNKS = 12;
const MAX_CHUNKS_PER_FILE = 2;
const MAX_ROUTES_PER_CHUNK = 8;

const IMPLEMENTATION_EXTENSIONS = new Set([
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".py",
]);

const KEYWORDS = new Set([
    "abstract", "and", "any", "as", "assert", "async", "await",
    "bigint", "boolean", "break", "case", "catch", "class", "const",
    "continue", "debugger", "declare", "def", "default", "del",
    "delete", "do", "elif", "else", "enum", "except", "export",
    "extends", "false", "finally", "for", "from", "function",
    "global", "if", "implements", "import", "in", "infer",
    "instanceof", "interface", "is", "keyof", "lambda", "let",
    "module", "namespace", "never", "new", "none", "nonlocal",
    "not", "null", "number", "object", "of", "or", "override",
    "pass", "private", "protected", "public", "raise", "readonly",
    "return", "satisfies", "static", "string", "super", "switch",
    "symbol", "this", "throw", "true", "try", "type", "typeof",
    "undefined", "unknown", "var", "void", "while", "with", "yield",
]);

const COMMON_WORDS = new Set([
    "add", "api", "app", "arg", "args", "array", "async", "await", "answer",
    "base", "body", "bool", "bottom", "build", "call", "callback",
    "catch", "child", "chunk", "chunks", "code", "config", "console",
    "const", "content", "context", "count", "create", "css", "ctx",
    "current", "data", "debug", "default", "delete", "dest", "dict",
    "dist", "done", "each", "end", "entry", "err", "error", "event",
    "export", "false", "file", "files", "filter", "find", "first",
    "fn", "forEach", "from", "function", "get", "handler", "height",
    "helper", "helpers", "html", "http", "id", "include", "includes",
    "index", "info", "init", "input", "item", "items", "join", "json",
    "key", "keys", "last", "left", "length", "lib", "line", "lines",
    "list", "log", "main", "map", "match", "matches", "max", "message",
    "messages", "method", "min", "mod", "model", "name", "names", "next",
    "node", "null", "number", "obj", "object", "ok", "opt", "opts",
    "option", "options", "output", "param", "parameter", "parameters", "params",
    "parent", "path", "payload", "pkg", "pop", "prev", "promise", "property",
    "prompt", "push", "read", "reduce", "remove", "replace", "replaceAll",
    "request", "response", "result", "results", "return", "right",
    "root", "run", "self", "set", "setup", "size", "slice", "source",
    "split", "src", "start", "status", "string", "sum", "target",
    "temp", "test", "tests", "text", "then", "throw", "tmp", "toFixed",
    "toString", "top", "total", "trim", "true", "type", "undefined",
    "update", "uri", "url", "user", "users", "util", "utils", "value",
    "values", "warn", "width", "window", "write", "inventory", "bodies",
    "filename", "filepath", "startline", "endline", "modelname", "modelnames",
    "preview", "record", "statustext",
]);

const CATEGORY_BONUS = {
    definition: 120,
    call: 110,
    route: 110,
    import: 70,
    reference: 8,
};

const CATEGORY_RANK = {
    definition: 0,
    call: 1,
    route: 1,
    import: 2,
    reference: 3,
};

const QUOTED_API_ROUTE_RE = /(['"`])(\/api\/[A-Za-z0-9][A-Za-z0-9_/-]*)\1/g;
const LOGGED_API_ROUTE_RE =
    /(['"`])(?:GET|POST|PUT|PATCH|DELETE)\s+(\/api\/[A-Za-z0-9][A-Za-z0-9_/-]*)/gi;


function chunkIdentity(chunk) {
    return `${chunk.filePath}:${chunk.startLine}:${chunk.endLine}`;
}


function normalizePath(filePath) {
    return String(filePath).replaceAll("\\", "/");
}


function isImplementationFile(filePath) {
    return IMPLEMENTATION_EXTENSIONS.has(
        path.extname(filePath).toLowerCase()
    );
}


function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


/**
 * True when `symbol` appears as a whole identifier in text.
 *
 * @param {string} text
 * @param {string} symbol
 * @returns {boolean}
 */
export function wholeIdentifierOccurs(text, symbol) {
    if (typeof text !== "string" || typeof symbol !== "string" || symbol.length === 0) {
        return false;
    }

    const pattern = new RegExp(
        `(^|[^A-Za-z0-9_$])${escapeRegExp(symbol)}([^A-Za-z0-9_$]|$)`
    );

    return pattern.test(text);
}


function hasCodeShape(name) {
    if (name.includes("$")) {
        return true;
    }

    if (name.includes("_") && /[A-Za-z]/.test(name)) {
        return true;
    }

    // camelCase or PascalCase with an internal capital.
    // Rejects Title Case comment words such as "Ollama" or "Confirm".
    return /[a-z][A-Z]/.test(name) || /[A-Z][a-z]+[A-Z]/.test(name);
}


function stripCommentsAndStrings(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/^\s*\*.*$/gm, " ")
        .replace(/(^|[^:])\/\/.*$/gm, "$1")
        .replace(/'(?:\\.|[^'\\])*'/g, "''")
        .replace(/"(?:\\.|[^"\\])*"/g, "\"\"")
        .replace(/`(?:\\.|[^`\\])*`/g, "``");
}


function looksLikeOptionsCall(content) {
    return (
        /[A-Za-z_$][A-Za-z0-9_$]*\s*\(\s*\{/.test(content) ||
        /[A-Za-z_$][A-Za-z0-9_$]*\s*\([^)]*,\s*\{/.test(content)
    );
}


/**
 * Extract /api/... path literals shared by HTTP handlers and clients.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractApiRoutes(text) {
    if (typeof text !== "string" || text.length === 0) {
        return [];
    }

    const found = [];
    const seen = new Set();

    function addRoute(route) {
        const normalized = String(route).replace(/\/+$/, "");

        if (normalized.length <= 4 || seen.has(normalized)) {
            return;
        }

        seen.add(normalized);
        found.push(normalized);
    }

    QUOTED_API_ROUTE_RE.lastIndex = 0;
    let match;

    while ((match = QUOTED_API_ROUTE_RE.exec(text)) !== null) {
        addRoute(match[2]);
    }

    LOGGED_API_ROUTE_RE.lastIndex = 0;

    while ((match = LOGGED_API_ROUTE_RE.exec(text)) !== null) {
        addRoute(match[2]);
    }

    return found;
}


function routeOccurs(text, route) {
    if (typeof text !== "string" || typeof route !== "string" || route.length === 0) {
        return false;
    }

    const pattern = new RegExp(`${escapeRegExp(route)}(?![A-Za-z0-9_/-])`);
    return pattern.test(text);
}


function isWeakLocalName(symbol) {
    return /^[a-z][a-z0-9]*$/.test(symbol);
}


function effectiveCategoryRank(category, symbol) {
    if (category === "definition" && isWeakLocalName(symbol)) {
        return CATEGORY_RANK.reference;
    }

    return CATEGORY_RANK[category];
}


function isUsefulSymbolName(name) {
    if (typeof name !== "string" || name.length < MIN_SYMBOL_LENGTH) {
        return false;
    }

    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
        return false;
    }

    if (KEYWORDS.has(name) || KEYWORDS.has(name.toLowerCase())) {
        return false;
    }

    if (COMMON_WORDS.has(name) || COMMON_WORDS.has(name.toLowerCase())) {
        return false;
    }

    return true;
}


function addSymbol(target, seen, name) {
    if (!isUsefulSymbolName(name) || seen.has(name)) {
        return;
    }

    seen.add(name);
    target.push(name);
}


function collectGroupIdentifiers(group, add) {
    if (typeof group !== "string") {
        return;
    }

    const parts = group.split(",");

    for (const part of parts) {
        const names = part
            .replace(/\btype\s+/g, "")
            .split(/\bas\b/)
            .map((piece) => piece.trim())
            .filter(Boolean);

        for (const name of names) {
            const ident = name.match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
            if (ident) {
                add(ident[0]);
            }
        }
    }
}


/**
 * Extract a conservative list of useful code symbols.
 *
 * Prefers declarations, imports, exports, calls, and
 * mixed-case / underscored identifiers over English prose.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractUsefulSymbols(text) {
    if (typeof text !== "string" || text.length === 0) {
        return [];
    }

    const seen = new Set();
    const declared = [];
    const imported = [];
    const called = [];
    const shaped = [];

    const addDeclared = (name) => addSymbol(declared, seen, name);
    const addImported = (name) => addSymbol(imported, seen, name);
    const addCalled = (name) => addSymbol(called, seen, name);
    const addShaped = (name) => addSymbol(shaped, seen, name);

    const declarationPatterns = [
        /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/g,
        /\b(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
        /\b(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
        /\bdef\s+([A-Za-z_][A-Za-z0-9_]*)/g,
        /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:(]/g,
    ];

    for (const pattern of declarationPatterns) {
        for (const match of text.matchAll(pattern)) {
            addDeclared(match[1]);
        }
    }

    for (const match of text.matchAll(/\bimport\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\b/g)) {
        addImported(match[1]);
    }

    for (const match of text.matchAll(/\bimport\s*(?:type\s*)?\{([^}]+)\}/g)) {
        collectGroupIdentifiers(match[1], addImported);
    }

    for (const match of text.matchAll(/\bexport\s*(?:type\s*)?\{([^}]+)\}/g)) {
        collectGroupIdentifiers(match[1], addDeclared);
    }

    for (const match of text.matchAll(
        /\bfrom\s+['"][^'"]+['"]\s+import\s+([^\n]+)/g
    )) {
        collectGroupIdentifiers(match[1], addImported);
    }

    for (const match of text.matchAll(
        /\b(?:import|from)\s+([A-Za-z_][A-Za-z0-9_]*)\s+import\b/g
    )) {
        addImported(match[1]);
    }

    const codeText = stripCommentsAndStrings(text);

    for (const match of codeText.matchAll(
        /(?:^|[^A-Za-z0-9_$.])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g
    )) {
        addCalled(match[1]);
    }

    for (const match of codeText.matchAll(IDENTIFIER_RE)) {
        const name = match[0];
        if (hasCodeShape(name)) {
            addShaped(name);
        }
    }

    return [...declared, ...imported, ...called, ...shaped];
}


function isTypeOnlyChunk(chunk) {
    const extension = path.extname(chunk.filePath).toLowerCase();

    if (extension !== ".ts" && extension !== ".tsx") {
        return false;
    }

    const content = chunk.content ?? "";
    const hasTypeDecl = /(?:^|\n)\s*(?:export\s+)?(?:interface|type)\s+/.test(content);
    const hasRuntime =
        /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\b/.test(content) ||
        /(?:^|\n)\s*def\s+/.test(content);

    return hasTypeDecl && !hasRuntime;
}


/**
 * Classify how a symbol appears in a chunk.
 *
 * @param {string} text
 * @param {string} symbol
 * @returns {"definition"|"import"|"call"|"reference"|null}
 */
export function classifySymbolEvidence(text, symbol) {
    if (!wholeIdentifierOccurs(text, symbol)) {
        return null;
    }

    const escaped = escapeRegExp(symbol);

    const definitionPatterns = [
        new RegExp(
            `(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${escaped}\\b`
        ),
        new RegExp(`(?:export\\s+)?(?:default\\s+)?class\\s+${escaped}\\b`),
        new RegExp(`(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\b`),
        new RegExp(`\\bdef\\s+${escaped}\\b`),
        new RegExp(`\\bclass\\s+${escaped}\\s*[:({]`),
    ];

    if (definitionPatterns.some((pattern) => pattern.test(text))) {
        return "definition";
    }

    const importPatterns = [
        new RegExp(`\\bimport\\s+(?:type\\s+)?${escaped}\\s+from\\b`),
        new RegExp(`\\bimport\\s*(?:type\\s*)?\\{[^}]*\\b${escaped}\\b[^}]*\\}`),
        new RegExp(`\\bexport\\s*(?:type\\s*)?\\{[^}]*\\b${escaped}\\b[^}]*\\}`),
        new RegExp(`\\bfrom\\s+\\S+\\s+import\\s+[^\\n]*\\b${escaped}\\b`),
    ];

    if (importPatterns.some((pattern) => pattern.test(text))) {
        return "import";
    }

    const callPattern = new RegExp(
        `(?:^|[^A-Za-z0-9_$.])${escaped}\\s*\\(`
    );
    const declarationCall = new RegExp(
        `(?:function\\s*\\*?|def|class)\\s+${escaped}\\s*\\(`
    );

    if (callPattern.test(text) && !declarationCall.test(text)) {
        return "call";
    }

    return "reference";
}


function bestCategory(current, next) {
    if (!current) {
        return next;
    }

    if (!next) {
        return current;
    }

    return CATEGORY_RANK[next] < CATEGORY_RANK[current] ? next : current;
}


function similarityOf(chunk) {
    const value = Number(chunk.similarity);
    return Number.isFinite(value) ? value : 0;
}


function collectSymbolsFromChunks(chunks, limit = MAX_SYMBOLS) {
    const perChunk = [];

    for (const chunk of chunks) {
        if (!isImplementationFile(chunk.filePath) || isTypeOnlyChunk(chunk)) {
            continue;
        }

        perChunk.push(extractUsefulSymbols(chunk.content ?? "").slice(0, MAX_SYMBOLS_PER_CHUNK));
    }

    const seen = new Set();
    const ordered = [];
    let added = true;

    for (let round = 0; added && ordered.length < limit; round += 1) {
        added = false;

        for (const symbols of perChunk) {
            if (round >= symbols.length) {
                continue;
            }

            const symbol = symbols[round];

            if (seen.has(symbol)) {
                continue;
            }

            seen.add(symbol);
            ordered.push(symbol);
            added = true;

            if (ordered.length >= limit) {
                break;
            }
        }
    }

    return ordered;
}


function collectRoutesFromChunks(chunks, limit = MAX_SYMBOLS) {
    const seen = new Set();
    const ordered = [];

    for (const chunk of chunks) {
        if (!isImplementationFile(chunk.filePath) || isTypeOnlyChunk(chunk)) {
            continue;
        }

        let addedFromChunk = 0;

        for (const route of extractApiRoutes(chunk.content ?? "")) {
            if (seen.has(route)) {
                continue;
            }

            seen.add(route);
            ordered.push(route);
            addedFromChunk += 1;

            if (ordered.length >= limit || addedFromChunk >= MAX_ROUTES_PER_CHUNK) {
                break;
            }
        }

        if (ordered.length >= limit) {
            break;
        }
    }

    return ordered;
}


function topImplementationChunks(chunks, limit = 3) {
    return chunks
        .filter((chunk) => {
            return isImplementationFile(chunk.filePath) && !isTypeOnlyChunk(chunk);
        })
        .map((chunk, index) => ({
            chunk,
            index,
            sim: similarityOf(chunk),
        }))
        .sort((a, b) => {
            if (b.sim !== a.sim) {
                return b.sim - a.sim;
            }

            return a.index - b.index;
        })
        .slice(0, limit)
        .map((item) => item.chunk);
}


function findMatchesForSymbols(allChunks, symbols, excludedKeys, seedFiles) {
    const found = new Map();

    for (const chunk of allChunks) {
        const key = chunkIdentity(chunk);

        if (excludedKeys.has(key)) {
            continue;
        }

        const content = chunk.content ?? "";
        let rawCategory = null;
        let matchedSymbol = null;
        let matchedFromSeedFile = false;

        for (const symbol of symbols) {
            const nextRaw = classifySymbolEvidence(content, symbol);

            if (!nextRaw) {
                continue;
            }

            const better =
                !rawCategory ||
                effectiveCategoryRank(nextRaw, symbol) <
                    effectiveCategoryRank(rawCategory, matchedSymbol);

            if (better) {
                rawCategory = nextRaw;
                matchedSymbol = symbol;
                matchedFromSeedFile = seedFiles.has(normalizePath(chunk.filePath));
            }
        }

        if (!rawCategory) {
            continue;
        }

        const category = rawCategory;

        const impl = isImplementationFile(chunk.filePath);
        const existing = found.get(key);

        if (
            existing &&
            CATEGORY_RANK[existing.rawCategory] <= CATEGORY_RANK[rawCategory]
        ) {
            continue;
        }

        found.set(key, {
            chunk,
            category,
            rawCategory,
            symbol: matchedSymbol,
            impl,
            crossFile: !matchedFromSeedFile,
        });
    }

    return [...found.values()];
}


function findMatchesForRoutes(allChunks, routes, excludedKeys, seedFiles) {
    const found = new Map();

    if (!Array.isArray(routes) || routes.length === 0) {
        return [];
    }

    for (const chunk of allChunks) {
        const key = chunkIdentity(chunk);

        if (excludedKeys.has(key)) {
            continue;
        }

        const content = chunk.content ?? "";
        let matchedRoute = null;

        for (const route of routes) {
            if (routeOccurs(content, route)) {
                matchedRoute = route;
                break;
            }
        }

        if (!matchedRoute) {
            continue;
        }

        found.set(key, {
            chunk,
            category: "route",
            rawCategory: "route",
            symbol: matchedRoute,
            impl: isImplementationFile(chunk.filePath),
            crossFile: !seedFiles.has(normalizePath(chunk.filePath)),
        });
    }

    return [...found.values()];
}


function collectXrefCandidates(selected, allChunks) {
    const selectedKeys = new Set(selected.map(chunkIdentity));
    const candidateMap = new Map();

    let seedChunks = topImplementationChunks(selected, selected.length);

    if (seedChunks.length === 0) {
        seedChunks = selected.filter((chunk) => {
            return isImplementationFile(chunk.filePath) && !isTypeOnlyChunk(chunk);
        });
    }

    const seenSymbols = new Set();
    const seenRoutes = new Set();

    for (let hop = 0; hop < MAX_HOPS && seedChunks.length > 0; hop += 1) {
        const symbols = collectSymbolsFromChunks(seedChunks).filter((symbol) => {
            if (seenSymbols.has(symbol)) {
                return false;
            }

            seenSymbols.add(symbol);
            return true;
        });
        const routes = collectRoutesFromChunks(seedChunks).filter((route) => {
            if (seenRoutes.has(route)) {
                return false;
            }

            seenRoutes.add(route);
            return true;
        });

        if (symbols.length === 0 && routes.length === 0) {
            break;
        }

        const seedFiles = new Set(
            seedChunks.map((chunk) => normalizePath(chunk.filePath))
        );

        const matches = [
            ...findMatchesForSymbols(
                allChunks,
                symbols,
                selectedKeys,
                seedFiles
            ),
            ...findMatchesForRoutes(
                allChunks,
                routes,
                selectedKeys,
                seedFiles
            ),
        ];

        const nextSeeds = [];
        const nextSeedKeys = new Set();

        for (const match of matches) {
            const key = chunkIdentity(match.chunk);
            const record = {
                ...match,
                hop,
            };
            const existing = candidateMap.get(key);

            if (!existing) {
                candidateMap.set(key, record);
            } else {
                const earlierHop = record.hop < existing.hop;
                const sameHopBetterCategory =
                    record.hop === existing.hop &&
                    CATEGORY_RANK[record.category] < CATEGORY_RANK[existing.category];

                if (earlierHop || sameHopBetterCategory) {
                    candidateMap.set(key, record);
                }
            }

            const usefulSeed =
                match.impl &&
                (
                    match.rawCategory === "definition" ||
                    match.rawCategory === "call" ||
                    match.rawCategory === "route"
                );

            if (usefulSeed && nextSeeds.length < MAX_HOP_SEED_CHUNKS && !nextSeedKeys.has(key)) {
                nextSeeds.push(match.chunk);
                nextSeedKeys.add(key);
            }
        }

        seedChunks = nextSeeds;
    }

    return [...candidateMap.values()];
}


function xrefInternalScore(match, context = {}) {
    const definedInSelected = context.definedInSelected ?? new Set();
    const selectedFilePaths = context.selectedFilePaths ?? new Set();
    const selectedRoutes = context.selectedRoutes ?? new Set();
    const cat = CATEGORY_BONUS[match.category] ?? 0;
    const catScaled = match.hop ? cat * 0.5 : cat;
    const loc = match.crossFile ? 40 : 0;
    const impl = match.impl ? 0 : -80;
    const hopBonus = match.hop ? 0 : 50;
    const neededDefinition =
        !match.hop &&
        match.rawCategory === "definition" &&
        match.symbol &&
        !definedInSelected.has(match.symbol)
            ? 60
            : 0;
    const extraDefinitionPenalty =
        match.rawCategory === "definition" &&
        match.symbol &&
        definedInSelected.has(match.symbol)
            ? -55
            : 0;
    const redundantImportPenalty =
        match.rawCategory === "import" &&
        match.symbol &&
        definedInSelected.has(match.symbol)
            ? -60
            : 0;
    const hop2CallBoost =
        match.hop &&
        match.rawCategory === "call" &&
        !isWeakLocalName(match.symbol)
            ? 110
            : 0;
    const neededCallBoost =
        !match.hop &&
        match.rawCategory === "call" &&
        match.crossFile &&
        match.symbol &&
        definedInSelected.has(match.symbol) &&
        !isWeakLocalName(match.symbol)
            ? 110
            : 0;
    const neededRouteBoost =
        match.category === "route" &&
        match.crossFile &&
        match.symbol &&
        selectedRoutes.has(match.symbol)
            ? 110
            : 0;
    const extraSameFilePenalty =
        selectedFilePaths.has(normalizePath(match.chunk.filePath)) &&
        match.rawCategory !== "definition"
            ? -80
            : 0;
    const optionsCallBoost =
        !match.hop &&
        (match.category === "call" || match.category === "reference") &&
        looksLikeOptionsCall(match.chunk.content ?? "")
            ? 110
            : 0;

    return (
        catScaled +
        loc +
        impl +
        hopBonus +
        neededDefinition +
        extraDefinitionPenalty +
        redundantImportPenalty +
        hop2CallBoost +
        neededCallBoost +
        neededRouteBoost +
        extraSameFilePenalty +
        optionsCallBoost
    );
}


function selectionScore(item, context) {
    const sim = similarityOf(item.chunk);
    const impl = isImplementationFile(item.chunk.filePath);

    if (item.origin === "semantic") {
        if (isTypeOnlyChunk(item.chunk)) {
            return 250 + sim;
        }

        if (!impl) {
            return 200 + sim;
        }

        return 800 + sim;
    }

    if (!impl) {
        return 120 + sim;
    }

    return Math.min(790, 520 + xrefInternalScore(item, context) + sim);
}


function comparePoolItems(a, b) {
    if (b.score !== a.score) {
        return b.score - a.score;
    }

    const simDiff = similarityOf(b.chunk) - similarityOf(a.chunk);

    if (simDiff !== 0) {
        return simDiff;
    }

    const pathCmp = normalizePath(a.chunk.filePath).localeCompare(
        normalizePath(b.chunk.filePath)
    );

    if (pathCmp !== 0) {
        return pathCmp;
    }

    if (a.chunk.startLine !== b.chunk.startLine) {
        return a.chunk.startLine - b.chunk.startLine;
    }

    return a.chunk.endLine - b.chunk.endLine;
}


function greedySelect(pool, topK, protectedChunks = []) {
    const selected = [];
    const keys = new Set();
    const perFile = new Map();

    function tryAdd(chunk) {
        if (selected.length >= topK) {
            return false;
        }

        const key = chunkIdentity(chunk);

        if (keys.has(key)) {
            return false;
        }

        const fileKey = normalizePath(chunk.filePath);
        const count = perFile.get(fileKey) ?? 0;

        if (count >= MAX_CHUNKS_PER_FILE) {
            return false;
        }

        selected.push(chunk);
        keys.add(key);
        perFile.set(fileKey, count + 1);
        return true;
    }

    for (const chunk of protectedChunks) {
        tryAdd(chunk);
    }

    for (const item of pool) {
        if (selected.length >= topK) {
            break;
        }

        tryAdd(item.chunk);
    }

    return selected;
}


/**
 * Merge cross-file definition / call-site evidence into the
 * Project RAG budget without growing it.
 *
 * Cosine similarity values on returned chunks are unchanged.
 *
 * @param {Array<object>} selected
 * @param {Array<object>} allChunks
 * @param {number} topK
 * @returns {Array<object>}
 */
export function expandWithCrossReferences(selected, allChunks, topK) {
    if (!Array.isArray(selected) || selected.length === 0 || topK <= 0) {
        return [];
    }

    if (!Array.isArray(allChunks) || allChunks.length === 0) {
        return selected.slice(0, topK);
    }

    const seedChunks = topImplementationChunks(selected, selected.length);
    const seedSymbols = collectSymbolsFromChunks(
        seedChunks.length > 0 ? seedChunks : selected
    );
    const seedRoutes = collectRoutesFromChunks(
        seedChunks.length > 0 ? seedChunks : selected
    );

    if (seedSymbols.length === 0 && seedRoutes.length === 0) {
        return selected.slice(0, topK);
    }

    const definedInSelected = new Set();

    for (const chunk of selected) {
        const content = chunk.content ?? "";

        for (const symbol of seedSymbols) {
            if (classifySymbolEvidence(content, symbol) === "definition") {
                definedInSelected.add(symbol);
            }
        }
    }

    const protectedChunks = selected.filter((chunk) => {
        return isImplementationFile(chunk.filePath) && !isTypeOnlyChunk(chunk);
    });
    const protectedKeys = new Set(protectedChunks.map(chunkIdentity));

    const candidates = collectXrefCandidates(selected, allChunks);

    const pool = [];

    for (const chunk of selected) {
        pool.push({
            chunk,
            origin: "semantic",
            category: null,
            crossFile: false,
            impl: isImplementationFile(chunk.filePath),
            protected: protectedKeys.has(chunkIdentity(chunk)),
            score: 0,
        });
    }

    const selectedKeys = new Set(selected.map(chunkIdentity));

    for (const match of candidates) {
        if (selectedKeys.has(chunkIdentity(match.chunk))) {
            continue;
        }

        pool.push({
            ...match,
            origin: "xref",
            protected: false,
            score: 0,
        });
    }

    const selectedFilePaths = new Set(
        selected.map((chunk) => normalizePath(chunk.filePath))
    );
    const selectedRoutes = new Set(collectRoutesFromChunks(selected));
    const scoreContext = {
        definedInSelected,
        selectedFilePaths,
        selectedRoutes,
    };

    for (const item of pool) {
        item.score = selectionScore(item, scoreContext);
    }

    pool.sort(comparePoolItems);

    const merged = greedySelect(pool, topK, protectedChunks);

    if (merged.length < Math.min(topK, selected.length)) {
        const keys = new Set(merged.map(chunkIdentity));

        for (const chunk of selected) {
            if (merged.length >= topK) {
                break;
            }

            const key = chunkIdentity(chunk);

            if (keys.has(key)) {
                continue;
            }

            merged.push(chunk);
            keys.add(key);
        }
    }

    if (merged.length > 0) {
        return merged;
    }

    return selected.slice(0, topK);
}
