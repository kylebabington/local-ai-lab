# Local AI frontend

React + Vite + TypeScript UI for the local assistant.

This directory is the browser interface only. It talks to `server.js` through `/api` (proxied to `http://127.0.0.1:3001` in development). It does **not** call Ollama.

From the repo root:

```powershell
npm run server
```

Then here:

```powershell
npm install
npm run dev
```

See the root README for architecture, Computer-mode tools, and terminal commands.
