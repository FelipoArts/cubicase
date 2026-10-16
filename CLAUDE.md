@AGENTS.md

# CubeForge Dash — Project Context

## Overview
CubeForge Dash is a Tauri v2 desktop app that simplifies creating and sharing Minecraft servers. It connects friends peer-to-peer (WebRTC, with a TURN relay as fallback) to avoid port forwarding.

## Stack
- **Frontend**: Next.js (static export) + React 19 + TypeScript + Zustand + Tailwind v4 + Framer Motion
- **Desktop Shell**: Tauri v2 (Rust backend)
- **Sidecar**: Go binary (`cubicase-link`) for P2P networking (WebRTC via Pion); relay = coturn (`infra/relay`)
- **Build**: `npm run tauri dev` / `npm run tauri build`

## Key Architecture Decisions
- **Network provider abstraction**: the backend picks the sidecar from the session `launcher` (`ProviderManager`); currently `link-v1` (P2P) plus a dev-only Mock
- **Minecraft server process**: Managed via Rust `std::process::Command` with TCP polling for online detection (not log parsing)
- **JRE management**: Auto-downloaded from Adoptium API, stored in app local data dir
- **Server.jar download**: Done via Rust `reqwest` (not PowerShell), Mojang manifest API
- **Static export**: Next.js outputs to `out/`, served by Tauri's webview

## Important Files
- `src-tauri/src/lib.rs` — All Rust Tauri commands (network, MC server, properties, memory)
- `src-tauri/sidecars/cubicase-link/` — Go sidecar for P2P networking (host/guest, signaling, bridge)
- `src/app/page.tsx` — Main UI (host/guest flows, server management, console)
- `src/app/store.ts` — Zustand store with localStorage persistence
- `src/lib/server.ts` — Minecraft server installation (Mojang API, EULA, properties, importExistingServer, scanExternalServer)
- `src/lib/jre.ts` — Java runtime download/install from Adoptium
- `src-tauri/capabilities/default.json` — Permission scoping for shell, fs, http

## Common Commands
- `npm run tauri dev` — Run in development mode
- `npm run tauri build` — Build for production
- `npm run dev` — Run Next.js dev server only (for UI work without Tauri)

## Notes
- The Rust `read_server_properties` and `write_server_properties` commands expect `serverDir` (full path), not `serverName`
- Network session can use `network_session.json` file as fallback when API is unavailable
- Mock provider is available for offline development: set `"provider": "mock"` in network_session.json
