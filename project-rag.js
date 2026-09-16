// =========================================================
// project-rag.js
//
// CLI entry point for the local RAG experiment.
//
// All reusable Ollama / RAG logic lives in:
//   lib/ollama.js
//   lib/rag.js
//
// This file is responsible for:
//   - reading command-line arguments
//   - calling reusable functions
//   - formatting terminal output
//   - the interactive RAG chat loop
// =========================================================


import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { ensureModelAvailable } from "./lib/ollama.js";

import {
    CHAT_MODEL,
    EMBEDDING_MODEL,
    TOP_K,
    buildIndex,
    saveIndex,
    loadIndex,
    searchIndex,
    askProject,
} from "./lib/rag.js";


// ---------------------------------------------------------
// SEARCH RESULT FORMATTING
// ---------------------------------------------------------

/**
 * Print search results in a readable format.
 */
function printSearchResults(results) {
    if (results.length === 0) {
        console.log("No matching chunks found.");
        return;
    }

    results.forEach((result, index) => {
        const previewLines = result.content
            .split(/\r?\n/)
            .slice(0, 6)
            .join("\n");

        console.log(
            `${index + 1}. ${result.filePath} — lines ` +
            `${result.startLine}-${result.endLine}`
        );
        console.log(`Similarity: ${result.similarity.toFixed(4)}`);
        console.log();
        console.log(previewLines);

        if (result.content.split(/\r?\n/).length > 6) {
            console.log("...");
        }

        console.log();
    });
}


// ---------------------------------------------------------
// INTERACTIVE CHAT MODE
// ---------------------------------------------------------

async function runChatMode() {
    console.log("\nLOCAL PROJECT AI");
    console.log(`Project: ${process.cwd()}`);
    console.log(`Chat model: ${CHAT_MODEL}`);
    console.log(`Embedding model: ${EMBEDDING_MODEL}`);
    console.log(`
Ask a question about the project.
Type "exit" to quit.
`);

    // Confirm the index exists before entering the loop.
    await loadIndex();

    const rl = readline.createInterface({
        input,
        output,
    });

    try {
        while (true) {
            const userMessage = await rl.question("You: ");
            const trimmedMessage = userMessage.trim();

            if (trimmedMessage.toLowerCase() === "exit") {
                break;
            }

            if (!trimmedMessage) {
                continue;
            }

            try {
                console.log("\nSearching project and generating answer...\n");

                const { answer } = await askProject(trimmedMessage);

                console.log(`Qwen: ${answer}\n`);
            } catch (error) {
                console.error("\nSomething went wrong:");
                console.error(error.message);
                console.error();
            }
        }
    } finally {
        rl.close();
    }

    console.log("\nGoodbye!");
}


// ---------------------------------------------------------
// CLI HELPERS
// ---------------------------------------------------------

function printUsage() {
    console.log(`
Usage:
  node project-rag.js index
  node project-rag.js search "your question"
  node project-rag.js ask "your question"
  node project-rag.js chat
`);
}


// ---------------------------------------------------------
// MAIN
// ---------------------------------------------------------

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    if (!command) {
        printUsage();
        process.exitCode = 1;
        return;
    }

    try {
        if (command === "index") {
            await ensureModelAvailable(EMBEDDING_MODEL);

            const index = await buildIndex();
            await saveIndex(index);

            console.log("\nIndex summary:");
            console.log(`  Project: ${index.projectDir}`);
            console.log(`  Chunks: ${index.chunks.length}`);
            console.log(`  Created: ${index.createdAt}`);
            return;
        }

        if (command === "search") {
            const question = args.slice(1).join(" ").trim();

            if (!question) {
                console.error('Please provide a search question in quotes.');
                printUsage();
                process.exitCode = 1;
                return;
            }

            console.log(`\nSearching for: ${question}\n`);

            // searchIndex verifies the embedding model itself.
            const results = await searchIndex(question, TOP_K);
            printSearchResults(results);
            return;
        }

        if (command === "ask") {
            const question = args.slice(1).join(" ").trim();

            if (!question) {
                console.error('Please provide a question in quotes.');
                printUsage();
                process.exitCode = 1;
                return;
            }

            console.log(`\nQuestion: ${question}\n`);
            console.log("Retrieving relevant project chunks...\n");

            // askProject verifies both models itself.
            const { answer } = await askProject(question);

            console.log("Answer:\n");
            console.log(answer);
            console.log();
            return;
        }

        if (command === "chat") {
            // Pre-check models so failures appear before the loop.
            // askProject also checks on each turn.
            await ensureModelAvailable(EMBEDDING_MODEL);
            await ensureModelAvailable(CHAT_MODEL);
            await runChatMode();
            return;
        }

        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exitCode = 1;

    } catch (error) {
        console.error("\nSomething went wrong:");
        console.error(error.message);
        console.error();
        process.exitCode = 1;
    }
}


main();
