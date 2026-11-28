// A client that stops reading must not make the server hoard its messages: past this much unsent data
// it is dropped (the app and overlays reconnect by themselves and get recent history again).
export const MAX_BUFFERED = 8 * 1024 * 1024;

export interface Sink {
  readyState: number;
  OPEN: number;
  bufferedAmount: number;
  send(data: string): void;
  terminate(): void;
}

export function deliver(ws: Sink, data: string) {
  if (ws.readyState !== ws.OPEN) return;
  if (ws.bufferedAmount > MAX_BUFFERED) ws.terminate();
  else ws.send(data);
}
