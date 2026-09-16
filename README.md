# Local AI Lab

A beginner-friendly local experiment with Ollama.

This project includes:

1. A terminal chatbot (`app.js`) with normal chat, single-file `/load`, and project `/rag`
2. An embeddings / cosine-similarity demo (`embedding-test.js`)
3. A local RAG / code-search CLI (`project-rag.js`)
4. A local HTTP API (`server.js`) for the React UI
5. A React UI (`ui/`) that talks only to that API — never to Ollama directly

Everything runs locally through Ollama. There is no cloud AI service and no vector database.

---

## Architecture

Reusable logic lives in shared modules. The terminal and the HTTP API are two interfaces over the same engine.

```text
interfaces
├── app.js          terminal
└── server.js       local HTTP API (127.0.0.1:3001)

shared logic
├── lib/chat.js     normal chat + chat-history.json
├── lib/rag.js      project retrieval
├── lib/agent.js    Computer-mode tools + approvals
├── lib/activity.js tool audit log
├── lib/tools/      filesystem tools + path safety
└── lib/ollama.js   Ollama HTTP helpers
        ↓
     Ollama
```

```text
React UI  →  Vite /api proxy  →  server.js  →  lib/chat.js, lib/rag.js, or lib/agent.js  →  Ollama
```

The browser never calls `localhost:11434`.

* `lib/chat.js` — persistent normal conversation
* `lib/rag.js` — scan, chunk, index, search, and ask about the project
* `lib/agent.js` — Computer-mode tool loop and pending approvals
* `lib/tools/` — root-scoped filesystem tools and path checks
* `lib/activity.js` — append-only tool activity log
* `lib/ollama.js` — talk to Ollama (`/api/tags`, `/api/embed`, `/api/chat`)
* `app.js` — interactive terminal chatbot
* `server.js` — local API used by the React UI
* `project-rag.js` — standalone RAG CLI (same engine as `/rag`)
* `ui/` — React interface

Normal chat persists to `chat-history.json`. Project/RAG questions and Computer-mode turns do not.

File context in the UI is still future work. The terminal `/load` command continues to work and is not exposed over HTTP.

Use **either** the terminal **or** the HTTP server as the active normal-chat interface — not both at the same time. Each process keeps its own in-memory copy of the conversation while writing the same history file. The React UI uses `server.js`. Pending Computer-mode approvals live only in that `server.js` process and disappear on restart.

```powershell
node app.js
```

or:

```powershell
npm run server
```

---

## Requirements

* Node.js
* [Ollama](https://ollama.com/)
* Chat model: `qwen3:4b-instruct`
* Embedding model: `qwen3-embedding:0.6b`

Install the models:

```powershell
ollama pull qwen3:4b-instruct
ollama pull qwen3-embedding:0.6b
```

Make sure Ollama is running before you use any of the scripts.

---

## React UI

The frontend lives in `ui/` and talks to `server.js` through a Vite proxy (`/api` → `http://127.0.0.1:3001`).

Terminal 1:

```powershell
npm run server
```

Terminal 2:

```powershell
cd ui
npm install
npm run dev
```

Then open `http://localhost:5173`.

* **Chat** context uses `POST /api/chat` and persists to `chat-history.json`
* **Project** context uses `POST /api/rag` and does not persist those turns
* **Computer** context uses `POST /api/agent` for filesystem tools. Those turns are session-only
* **File** context remains disabled
* The header is green / “Local AI connected” only when Ollama is reachable and both required models are installed

You can also start the terminal chatbot with `npm run chat` (same as `node app.js`). Do not run that at the same time as `npm run server` if you care about a single in-memory conversation.

---

## Computer mode and tools

Computer mode can inspect files inside allowed roots and propose a few filesystem changes. The browser never talks to the filesystem or to Ollama.

### Permission classes

* **Read (auto):** `list_directory`, `get_file_info`, `search_files`, `read_text_file`
* **Approval required:** `create_directory`, `copy_file`, `move_file`, `rename_file` — shown in the UI until you approve or reject. Approve/reject send only the stored approval id, not a new path from the browser
* **High risk (not enabled):** delete, overwrite, shell, and install. They appear on the Tools page as blocked labels only

Destinations that already exist are refused. Symbolic links are refused, including a symlink in the middle of a path.

### Allowed roots

By default, tools may only touch `process.cwd()` (the folder where you started `npm run server`).

To allow additional folders, set `LOCAL_AI_ALLOWED_ROOTS` using the platform path delimiter (`;` on Windows):

```powershell
$env:LOCAL_AI_ALLOWED_ROOTS = "C:\dev\Personal\local-ai-lab;D:\notes"
npm run server
```

Do not point this at your entire user profile or `C:\` unless you intend that.

### Activity

Tool events are appended to `data/tool-activity.jsonl`. That file persists across restarts. It stores short summaries and path metadata, not file contents, prompts, or full tool payloads.

Pending approvals are in-memory only. Restarting `server.js` drops them.

---

## Chatbot

Start the interactive local chatbot:

```powershell
node app.js
```

Useful commands inside the chat:

* `/load <file>` — load one local file into memory for the conversation
* `/unload` — remove the loaded file
* `/file` — show which file is currently loaded
* `/rag <question>` — ask a question about the indexed project
* `exit` — quit

### Three ways to talk to the model

| Mode | What it does |
|---|---|
| Normal chat | Uses persistent conversation history in `chat-history.json` |
| `/load` | Gives the model the **entire** explicitly selected file (transient; not saved to history) |
| `/rag` | Searches the project index, retrieves relevant chunks, and answers from those chunks only |

`/load` and `/rag` are separate:

* `/load` never feeds into `/rag`
* `/rag` never injects the currently loaded file
* A loaded file may still appear in RAG sources if semantic search retrieves chunks from that file through the index

### History behavior

* Normal chat messages are saved to `chat-history.json`
* Loaded file contents are **not** written into history
* `/rag` questions, answers, and retrieved chunks are **not** written into history

---

## Embedding demo

Learn what embeddings and cosine similarity look like:

```powershell
node embedding-test.js
```

This script:

1. Sends three short sentences to the local embedding model
2. Prints how many numbers are in one embedding vector
3. Compares semantic similarity between the sentences

You should usually see that the two file-related sentences are more similar to each other than either is to the CSS sentence.

---

## Project RAG

`project-rag.js` is the standalone CLI for the same RAG engine used by `/rag` in the chatbot.

### 1. Build an index

```powershell
node project-rag.js index
```

This will:

* scan the current project directory
* split useful files into overlapping line chunks
* create embeddings for those chunks
* save them to `.local-ai-index.json`

Rebuild the index after you change project source files. Indexing is intentional and manual — nothing watches the filesystem yet.

The index is tied to the embedding model that created it. If you switch embedding models, rebuild with `node project-rag.js index` before searching or asking. Vectors from different embedding models cannot be compared.

### 2. Semantic search

```powershell
node project-rag.js search "Where is file loading implemented?"
```

This embeds your question, compares it against every stored chunk, and prints the top matches with similarity scores, file paths, and line ranges.

### 3. Ask one RAG question

```powershell
node project-rag.js ask "How does persistent memory work?"
```

This retrieves the most relevant chunks and sends **only those chunks** plus your question to `qwen3:4b-instruct`.

### 4. Interactive project chat

```powershell
node project-rag.js chat
```

Ask multiple questions about the project. Type `exit` to quit.

This mode does not write retrieved source code into `chat-history.json`.

### Example chatbot RAG usage

Inside `node app.js`:

```text
/rag Where does this application load local files?
```

You should see an answer grounded in retrieved project context, plus a short Sources list with file paths and line ranges.

If no index exists yet:

```text
No project index found.

Run:

  node project-rag.js index
```

---

## Beginner concepts

### Embeddings

An embedding turns text into a list of numbers (a vector).

Texts with similar meaning tend to produce vectors that point in similar directions.

### Cosine similarity

Cosine similarity measures how similar two vectors are by comparing their direction.

* Closer to `1` → more similar meaning
* Closer to `0` → less related

This project calculates cosine similarity with plain JavaScript math — no library.

### Chunking

Large files are split into smaller pieces before embedding.

Why? If you embed an entire file as one giant string, search becomes less precise. Smaller chunks make it easier to find the exact section that matches a question.

This project uses overlapping groups of lines so important context near chunk boundaries is less likely to be lost.

### Semantic search

Semantic search finds text by meaning, not just exact keyword matches.

Example: a question about “loading a file from disk” can match code that says `fs.readFile`, even if the wording is different.

### Retrieval

Retrieval means:

1. Embed the question
2. Compare it to stored chunk embeddings
3. Keep the best matches

### RAG

RAG stands for Retrieval-Augmented Generation.

Instead of sending an entire project to the chat model, we:

1. Retrieve only the most relevant chunks
2. Give those chunks to the model as context
3. Ask the model to answer based on that context

That keeps answers more grounded in the real project files and avoids stuffing the whole codebase into every prompt.

---

## Notes

* `.local-ai-index.json`, `chat-history.json`, and `data/tool-activity.jsonl` are ignored by git.
* Sensitive files named `.env` or `.env.*` are never indexed.
* Retrieved project text is treated as data, not instructions.
* Lock files and common generated folders are skipped during scanning.
* Rebuild the index after you change project files, or after switching embedding models:

```powershell
node project-rag.js index
```
