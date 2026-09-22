import type { ServerResponse } from 'node:http';

export interface LoopSseClient {
  res: ServerResponse;
  convId: number;
}

const loopClients = new Map<string, Set<LoopSseClient>>();

export function registerLoopSse(loopId: string, res: ServerResponse, convId: number): void {
  let set = loopClients.get(loopId);
  if (!set) {
    set = new Set();
    loopClients.set(loopId, set);
  }
  const client: LoopSseClient = { res, convId };
  set.add(client);
  const cleanup = () => {
    set?.delete(client);
    if (set && set.size === 0) {
      loopClients.delete(loopId);
    }
  };
  res.on('close', cleanup);
  res.on('finish', cleanup);
}

export function sseWrite(res: ServerResponse, event: string | null, data: unknown): boolean {
  if (res.writableEnded || res.destroyed) return false;
  try {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch {
    return false;
  }
}

export function broadcastLoopEvent(loopId: string, event: string | null, data: unknown): void {
  const set = loopClients.get(loopId);
  if (!set) return;
  for (const client of set) {
    sseWrite(client.res, event, data);
  }
}

export function endLoopSse(loopId: string, finalData?: unknown): void {
  const set = loopClients.get(loopId);
  if (!set) return;
  for (const client of set) {
    if (!client.res.writableEnded && !client.res.destroyed) {
      if (finalData) sseWrite(client.res, 'done', finalData);
      client.res.end();
    }
  }
  loopClients.delete(loopId);
}
