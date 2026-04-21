import { WebSocket } from "ws";

// Single active WebSocket connection for the user. Server is single-user, so we hold
// exactly one connection at a time — when a new client connects the old one is told
// "taken" and closed (handled in ws-handler).
let connectedWs: WebSocket | null = null;

export function getConnectedWs(): WebSocket | null {
  return connectedWs;
}

export function setConnectedWs(ws: WebSocket | null) {
  connectedWs = ws;
}

export function isConnected(): boolean {
  return !!connectedWs && connectedWs.readyState === WebSocket.OPEN;
}

// Send a JSON payload to the connected client. Silently drops if no client is connected.
export function sendJson(payload: unknown): void {
  if (isConnected()) {
    connectedWs!.send(JSON.stringify(payload));
  }
}

// Send a binary frame (e.g. PCM audio) to the connected client.
export function sendBinary(data: Buffer): void {
  if (isConnected()) {
    connectedWs!.send(data, { binary: true });
  }
}

// Broadcast a typed event `{ type, ...data }` to the connected client. Used by voice,
// task queue, and file-watcher code to push state changes to the frontend.
export function broadcast(type: string, data: Record<string, unknown> = {}): void {
  sendJson({ type, ...data });
}
