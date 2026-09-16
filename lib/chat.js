// =========================================================
// lib/chat.js
//
// Reusable normal-chat conversation logic.
//
// This module owns:
//   - the normal-chat system prompt
//   - persistent messages
//   - chat-history.json load / save
//   - sending a turn to Ollama
//
// It does NOT:
//   - talk to the terminal
//   - serve HTTP
//   - run RAG (that stays in lib/rag.js)
//   - persist /load file contents
//
// Both app.js (terminal) and server.js (HTTP) call this module.
// They should not be used as the active normal-chat interface
// at the same time: each process has its own in-memory copy.
// =========================================================


import fs from "node:fs/promises";

import {
    CHAT_MODEL,
    chatWithOllama,
} from "./ollama.js";


// ---------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------

const HISTORY_FILE = "./chat-history.json";

const SYSTEM_PROMPT = `
You are a helpful local AI assistant.

Rules:
- Answer questions directly.
- Be concise unless the user asks for detail.
- Do not use emojis.
- Do not excessively praise the user.
- Do not pretend to have feelings, preferences, or personal experiences.
- Explain technical concepts clearly for a beginner.
- When reviewing code, identify concrete issues instead of inventing problems.
- When writing code, explain the important parts clearly.
`;


// ---------------------------------------------------------
// PRIVATE STATE
// ---------------------------------------------------------

let messages = createFreshMessages();
let initialized = false;
let initializeResult = { loaded: false };

// One-at-a-time queue so overlapping HTTP chat requests cannot
// interleave push / generate / save on the shared messages array.
let mutationQueue = Promise.resolve();


function createFreshMessages() {
    return [
        {
            role: "system",
            content: SYSTEM_PROMPT,
        },
    ];
}


function applyCurrentSystemPrompt() {
    if (messages[0]?.role === "system") {
        messages[0].content = SYSTEM_PROMPT;
        return;
    }

    messages.unshift({
        role: "system",
        content: SYSTEM_PROMPT,
    });
}


/**
 * Run mutating chat work one operation at a time.
 *
 * A failed operation still releases the queue so the next
 * request is not stuck.
 *
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
function enqueueMutation(work) {
    const run = mutationQueue.then(work);

    mutationQueue = run.then(
        () => undefined,
        () => undefined,
    );

    return run;
}


async function saveHistory() {
    const json = JSON.stringify(messages, null, 2);
    await fs.writeFile(HISTORY_FILE, json, "utf8");
}


async function loadHistoryFromDisk() {
    try {
        const json = await fs.readFile(HISTORY_FILE, "utf8");
        const savedMessages = JSON.parse(json);

        if (Array.isArray(savedMessages)) {
            messages = savedMessages;
        }

        applyCurrentSystemPrompt();
        return { loaded: true };

    } catch (error) {
        if (error.code === "ENOENT") {
            messages = createFreshMessages();
            return { loaded: false };
        }

        throw error;
    }
}


async function sendChatMessageUnlocked(userMessage, options = {}) {
    const trimmed = typeof userMessage === "string" ? userMessage.trim() : "";

    if (!trimmed) {
        throw new Error("Message cannot be empty.");
    }

    const temporarySystemMessages = Array.isArray(
        options.temporarySystemMessages,
    )
        ? options.temporarySystemMessages
        : [];

    messages.push({
        role: "user",
        content: trimmed,
    });

    // Copy so a loaded file (or other request-only context) is
    // never written into chat-history.json.
    const requestMessages = [...messages];

    // Request-only context sits immediately before the current user
    // turn so a long saved history cannot bury /load file contents.
    if (temporarySystemMessages.length > 0) {
        requestMessages.splice(
            requestMessages.length - 1,
            0,
            ...temporarySystemMessages,
        );
    }

    requestMessages.splice(requestMessages.length - 1, 0, {
        role: "system",
        content: `
CURRENT REQUEST PRIORITY

Answer the user's latest message.

Earlier user instructions are historical conversation context. Do not continue following an older instruction when the latest user request clearly replaces it.

Do not repeat an earlier fixed-response instruction unless the current user request asks for it again.
`.trim(),
    });

    const answer = await chatWithOllama(requestMessages, {
        model: CHAT_MODEL,
        temperature: 0.4,
        numPredict: 1000,
    });

    messages.push({
        role: "assistant",
        content: answer,
    });

    await saveHistory();

    return { answer };
}


async function clearChatHistoryUnlocked() {
    messages = createFreshMessages();
    await saveHistory();
}


// ---------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------

/**
 * Load chat-history.json into memory.
 *
 * Safe to call more than once in the same process: later calls
 * return the first result and do not reload or duplicate the
 * system prompt.
 *
 * @returns {Promise<{ loaded: boolean }>}
 */
export async function initializeChat() {
    if (initialized) {
        return initializeResult;
    }

    initializeResult = await loadHistoryFromDisk();
    initialized = true;
    return initializeResult;
}


/**
 * Send a normal-chat turn. Persists user + assistant messages.
 *
 * options.temporarySystemMessages are added only to the Ollama
 * request, after the real system prompt. They are not saved.
 *
 * @param {string} userMessage
 * @param {{ temporarySystemMessages?: Array<{ role: string, content: string }> }} [options]
 * @returns {Promise<{ answer: string }>}
 */
export function sendChatMessage(userMessage, options = {}) {
    return enqueueMutation(() => sendChatMessageUnlocked(userMessage, options));
}


/**
 * User-visible history only (no system prompt).
 * Existing stored messages have no timestamps.
 *
 * @returns {Array<{ role: string, content: string, createdAt: null }>}
 */
export function getVisibleChatHistory() {
    return messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
            role: message.role,
            content: message.content,
            createdAt: null,
        }));
}


/**
 * Reset to the current system prompt and persist the empty chat.
 *
 * @returns {Promise<void>}
 */
export function clearChatHistory() {
    return enqueueMutation(() => clearChatHistoryUnlocked());
}
