// =========================================================
// lib/ollama.js
//
// Reusable helpers for talking to a local Ollama server.
//
// This module deliberately contains application logic only —
// no CLI banners or formatting. Callers decide how to display
// results or errors.
// =========================================================


// ---------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------

// Shared model names used across the chatbot and RAG tools.
// Exporting them here avoids conflicting duplicate literals.
export const CHAT_MODEL = "qwen3:4b-instruct";
export const EMBEDDING_MODEL = "qwen3-embedding:0.6b";

// Base URL for the local Ollama HTTP API.
const OLLAMA_BASE_URL = "http://localhost:11434";

// /api/tags lists installed models and confirms the server is up.
const OLLAMA_TAGS_URL = `${OLLAMA_BASE_URL}/api/tags`;

// /api/embed turns text into numeric embedding vectors.
const OLLAMA_EMBED_URL = `${OLLAMA_BASE_URL}/api/embed`;

// /api/chat generates assistant replies from a message list.
const OLLAMA_CHAT_URL = `${OLLAMA_BASE_URL}/api/chat`;


// ---------------------------------------------------------
// REACHABILITY / MODEL CHECKS
// ---------------------------------------------------------

/**
 * Confirm Ollama is reachable and return the installed
 * model names from GET /api/tags.
 *
 * A successful response means:
 *   1. Ollama is running on localhost:11434
 *   2. We can see which models are installed
 *
 * @returns {Promise<string[]>}
 */
export async function getInstalledModelNames() {
    let response;

    try {
        // GET /api/tags — no request body.
        // Response shape (conceptually):
        // { "models": [ { "name": "qwen3:4b-instruct", ... }, ... ] }
        response = await fetch(OLLAMA_TAGS_URL);
    } catch (error) {
        throw new Error(
            "Could not reach Ollama at http://localhost:11434.\n" +
            "Make sure Ollama is running, then try again."
        );
    }

    if (!response.ok) {
        throw new Error(
            `Ollama responded with an error while listing models: ` +
            `${response.status} ${response.statusText}`
        );
    }

    const data = await response.json();
    const models = Array.isArray(data.models) ? data.models : [];

    return models.map((model) => model.name);
}


/**
 * Confirm Ollama is reachable (same /api/tags check).
 * Useful when a caller only needs connectivity, not the list.
 */
export async function checkOllamaReachable() {
    await getInstalledModelNames();
}


/**
 * Fail clearly if a required model is not installed.
 * Do not silently switch to a different model.
 *
 * @param {string} modelName
 */
export async function ensureModelAvailable(modelName) {
    const modelNames = await getInstalledModelNames();

    if (!modelNames.includes(modelName)) {
        throw new Error(
            `Model "${modelName}" is not installed.\n` +
            `Install it with:\n\n` +
            `  ollama pull ${modelName}\n`
        );
    }
}


// ---------------------------------------------------------
// EMBEDDINGS
// ---------------------------------------------------------

/**
 * Send one or more strings to Ollama's POST /api/embed
 * endpoint and return the resulting embedding vectors.
 *
 * Request body:
 *   { model, input }  — input may be a string or string[]
 *
 * Response:
 *   { model, embeddings: number[][] }
 *
 * @param {string[]} texts
 * @param {string} modelName
 * @returns {Promise<number[][]>}
 */
export async function createEmbeddings(texts, modelName) {
    const response = await fetch(OLLAMA_EMBED_URL, {
        method: "POST",

        headers: {
            "Content-Type": "application/json",
        },

        body: JSON.stringify({
            model: modelName,
            input: texts,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();

        throw new Error(
            `Embedding request failed: ${response.status} ${response.statusText}\n${errorText}`
        );
    }

    const data = await response.json();
    return data.embeddings;
}


// ---------------------------------------------------------
// CHAT
// ---------------------------------------------------------

/**
 * Strip accidental thinking-tag leakage from a model reply.
 *
 * Some models may wrap internal reasoning in <think>...</think>.
 * We keep only the visible answer after the closing tag.
 *
 * @param {string} text
 * @returns {string}
 */
function cleanAssistantText(text) {
    let answer = text ?? "";

    if (answer.includes("</think>")) {
        answer = answer.split("</think>").pop().trim();
    }

    return answer;
}


/**
 * Send a chat conversation to Ollama's POST /api/chat
 * endpoint and return the assistant's text reply.
 *
 * Request body:
 *   {
 *     model,
 *     messages: [ { role, content }, ... ],
 *     stream: false,
 *     options: { temperature, num_predict }
 *   }
 *
 * Response (non-streaming):
 *   { message: { role: "assistant", content: "..." }, ... }
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {{ model: string, temperature?: number, numPredict?: number }} options
 * @returns {Promise<string>} assistant text
 */
export async function chatWithOllama(messages, options) {
    const {
        model,
        temperature = 0.4,
        numPredict = 1000,
    } = options;

    const response = await fetch(OLLAMA_CHAT_URL, {
        method: "POST",

        headers: {
            "Content-Type": "application/json",
        },

        body: JSON.stringify({
            model,

            messages,

            stream: false,

            options: {
                temperature,
                num_predict: numPredict,
            },
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();

        throw new Error(
            `Chat request failed: ${response.status} ${response.statusText}\n${errorText}`
        );
    }

    const data = await response.json();
    const rawAnswer = data.message?.content ?? "";

    // Centralize </think> cleanup so every caller gets the
    // same visible-text behavior.
    return cleanAssistantText(rawAnswer);
}


function parseToolCallArguments(raw) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        return raw;
    }

    if (typeof raw === "string" && raw.trim()) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed;
            }
        } catch {
            return null;
        }
    }

    return null;
}


function extractToolCalls(message) {
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    const extracted = [];

    for (const call of calls) {
        const fn = call?.function ?? {};
        const name = typeof fn.name === "string" ? fn.name : "";

        extracted.push({
            id: typeof call.id === "string" ? call.id : null,
            name,
            arguments: parseToolCallArguments(fn.arguments),
        });
    }

    return extracted;
}


/**
 * Chat with native Ollama tools / tool_calls.
 *
 * Does not parse tool calls out of ordinary assistant prose.
 * chatWithOllama() remains unchanged for normal chat and RAG.
 *
 * @param {{
 *   messages: object[],
 *   tools: object[],
 *   model: string,
 *   temperature?: number,
 *   numPredict?: number,
 * }} options
 * @returns {Promise<{
 *   content: string,
 *   toolCalls: Array<{ id: string|null, name: string, arguments: object|null }>,
 *   message: object,
 * }>}
 */
export async function chatWithOllamaTools(options) {
    const {
        messages,
        tools,
        model,
        temperature = 0.2,
        numPredict = 1000,
    } = options;

    const response = await fetch(OLLAMA_CHAT_URL, {
        method: "POST",

        headers: {
            "Content-Type": "application/json",
        },

        body: JSON.stringify({
            model,
            messages,
            tools,
            stream: false,
            options: {
                temperature,
                num_predict: numPredict,
            },
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();

        throw new Error(
            `Chat request failed: ${response.status} ${response.statusText}\n${errorText}`
        );
    }

    const data = await response.json();
    const message = data.message ?? { role: "assistant", content: "" };

    return {
        content: cleanAssistantText(message.content ?? ""),
        toolCalls: extractToolCalls(message),
        message,
    };
}
