// =========================================================
// embedding-test.js
//
// A small standalone experiment that shows how embeddings
// and cosine similarity work with a local Ollama model.
//
// This file is intentionally separate from the chatbot so we
// can learn the underlying mechanics without extra frameworks.
// =========================================================


// ---------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------

// The local embedding model we will use.
//
// An embedding model turns text into a list of numbers
// (a "vector") that represents the meaning of that text.
const EMBEDDING_MODEL = "qwen3-embedding:0.6b";


// Ollama's embedding endpoint.
//
// Unlike /api/chat (which generates replies), /api/embed
// returns numeric vectors for the texts we send.
const OLLAMA_EMBED_URL = "http://localhost:11434/api/embed";


// Used only for reachability / model-availability checks.
// Listing tags confirms both that Ollama is running and
// which models are currently installed.
const OLLAMA_TAGS_URL = "http://localhost:11434/api/tags";


// ---------------------------------------------------------
// CREATE EMBEDDINGS
// ---------------------------------------------------------

/**
 * Send one or more text strings to Ollama and receive
 * one embedding vector for each string.
 *
 * @param {string[]} texts - The strings to embed.
 * @returns {Promise<number[][]>} - An array of embedding vectors.
 */
async function createEmbeddings(texts) {
    // Step 1:
    // Ask Ollama to turn each string into a vector.
    //
    // We send:
    //   - model: which embedding model to use
    //   - input: one string OR an array of strings
    const response = await fetch(OLLAMA_EMBED_URL, {
        method: "POST",

        headers: {
            "Content-Type": "application/json",
        },

        body: JSON.stringify({
            model: EMBEDDING_MODEL,
            input: texts,
        }),
    });


    // Step 2:
    // If the HTTP status is not OK (for example 404 or 500),
    // stop and explain what went wrong.
    if (!response.ok) {
        const errorText = await response.text();

        throw new Error(
            `Embedding request failed: ${response.status} ${response.statusText}\n${errorText}`
        );
    }


    // Step 3:
    // Parse the JSON body from Ollama.
    //
    // A successful response looks conceptually like:
    // {
    //   "model": "qwen3-embedding:0.6b",
    //   "embeddings": [ [0.12, -0.04, ...], [0.08, 0.01, ...] ]
    // }
    const data = await response.json();


    // Step 4:
    // Return only the embeddings array.
    //
    // Each inner array is one embedding vector for one input string.
    return data.embeddings;
}


// ---------------------------------------------------------
// COSINE SIMILARITY
// ---------------------------------------------------------

/**
 * Compare two embedding vectors and return a score that
 * describes how similar their meanings are.
 *
 * Cosine similarity answers:
 * "Do these two vectors point in a similar direction?"
 *
 * - Values closer to 1 mean "very similar meaning"
 * - Values closer to 0 mean "less related"
 * - Values closer to -1 would mean "opposite directions"
 *   (less common with many embedding models)
 *
 * We do this with simple arithmetic — no library needed.
 *
 * @param {number[]} vectorA
 * @param {number[]} vectorB
 * @returns {number}
 */
function cosineSimilarity(vectorA, vectorB) {
    // Safety check: both vectors must have the same length.
    if (vectorA.length !== vectorB.length) {
        throw new Error(
            "Cannot compare embeddings of different lengths."
        );
    }


    // -----------------------------------------------------
    // DOT PRODUCT
    // -----------------------------------------------------
    //
    // Multiply matching pairs of numbers, then add them up.
    //
    // Example with tiny vectors [1, 2] and [3, 4]:
    //   (1 * 3) + (2 * 4) = 3 + 8 = 11
    //
    // A larger positive dot product usually means the vectors
    // are pointing in more similar directions (before we
    // account for their lengths).
    let dotProduct = 0;

    for (let i = 0; i < vectorA.length; i++) {
        dotProduct += vectorA[i] * vectorB[i];
    }


    // -----------------------------------------------------
    // MAGNITUDE (LENGTH) OF EACH VECTOR
    // -----------------------------------------------------
    //
    // Magnitude is like the length of an arrow.
    //
    // For vector [3, 4]:
    //   sqrt(3*3 + 4*4) = sqrt(9 + 16) = sqrt(25) = 5
    //
    // We need both lengths so we can remove the effect of
    // "how long" each vector is and focus on direction.
    let magnitudeA = 0;
    let magnitudeB = 0;

    for (let i = 0; i < vectorA.length; i++) {
        magnitudeA += vectorA[i] * vectorA[i];
        magnitudeB += vectorB[i] * vectorB[i];
    }

    magnitudeA = Math.sqrt(magnitudeA);
    magnitudeB = Math.sqrt(magnitudeB);


    // -----------------------------------------------------
    // PROTECT AGAINST DIVISION BY ZERO
    // -----------------------------------------------------
    //
    // If either vector has length 0, dividing would crash
    // or produce NaN. Treat that as "no similarity".
    if (magnitudeA === 0 || magnitudeB === 0) {
        return 0;
    }


    // -----------------------------------------------------
    // FINAL COSINE SIMILARITY
    // -----------------------------------------------------
    //
    // similarity = (A · B) / (|A| * |B|)
    //
    // This is the standard formula. Dividing by both lengths
    // normalizes the result so only the angle between the
    // vectors matters.
    return dotProduct / (magnitudeA * magnitudeB);
}


// ---------------------------------------------------------
// OLLAMA AVAILABILITY CHECKS
// ---------------------------------------------------------

/**
 * Confirm Ollama is reachable and the embedding model exists.
 *
 * We use /api/tags because it both proves the server is up
 * and tells us which models are installed.
 */
async function ensureEmbeddingModelAvailable() {
    let response;

    try {
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

    // Ollama may report names like "qwen3-embedding:0.6b"
    // or occasionally with a digest suffix. Exact name match
    // is what we want for this educational project.
    const modelNames = models.map((model) => model.name);

    if (!modelNames.includes(EMBEDDING_MODEL)) {
        throw new Error(
            `Embedding model "${EMBEDDING_MODEL}" is not installed.\n` +
            `Install it with:\n\n` +
            `  ollama pull ${EMBEDDING_MODEL}\n`
        );
    }
}


// ---------------------------------------------------------
// DEMONSTRATION
// ---------------------------------------------------------

async function main() {
    console.log("\nEMBEDDING SIMILARITY DEMO");
    console.log(`Model: ${EMBEDDING_MODEL}\n`);


    // These three sentences let us see semantic similarity.
    //
    // Sentence 1 and sentence 2 both talk about reading a
    // local file, so their embeddings should usually be
    // closer together.
    //
    // Sentence 3 is about CSS layout, so it should usually
    // be less similar to sentence 1.
    const sentence1 = "Load a local file from the user's computer.";
    const sentence2 = "Read a file from disk and store its contents in memory.";
    const sentence3 = "Use CSS Grid to center a card on the page.";


    try {
        await ensureEmbeddingModelAvailable();


        console.log("Creating embeddings for three sentences...\n");


        // Ask Ollama for all three embeddings in one request.
        const embeddings = await createEmbeddings([
            sentence1,
            sentence2,
            sentence3,
        ]);


        if (!embeddings || embeddings.length !== 3) {
            throw new Error(
                "Unexpected embedding response: expected 3 vectors."
            );
        }


        const embedding1 = embeddings[0];
        const embedding2 = embeddings[1];
        const embedding3 = embeddings[2];


        // An embedding's "dimensions" are simply how many
        // numbers are in the vector. More dimensions can
        // capture more nuance, but also use more memory.
        console.log(`Embedding dimensions: ${embedding1.length}`);


        const similarity12 = cosineSimilarity(embedding1, embedding2);
        const similarity13 = cosineSimilarity(embedding1, embedding3);


        console.log(
            `Similarity (sentence 1 vs 2): ${similarity12.toFixed(4)}`
        );
        console.log(
            `Similarity (sentence 1 vs 3): ${similarity13.toFixed(4)}`
        );


        console.log(`
Interpretation tip:
  The two file-related sentences should generally score higher
  than the CSS sentence. Exact numbers can vary between runs.
`);

    } catch (error) {
        console.error("\nSomething went wrong:");
        console.error(error.message);
        console.error();
        process.exitCode = 1;
    }
}


main();
