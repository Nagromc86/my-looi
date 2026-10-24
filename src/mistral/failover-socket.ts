/**
 * FailoverRealtimeSocket — French fork addition.
 *
 * Wraps a primary realtime socket (Gemini) and, when it closes because a
 * quota/rate limit was reached, continues the same conversation on a
 * secondary socket (Mistral) without the conversation service noticing:
 * the latest session configuration is replayed and capture keeps running.
 */

type Json = Record<string, any>;
export type RealtimeSocketLike = {
  readyState: number;
  onopen: ((event: any) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: any) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(): void;
  markSessionAnnounced?: () => void;
};

export function isQuotaClose(code: number, reason: string): boolean {
  return /quota|resource.?exhausted|rate.?limit|too many requests|\b429\b/i.test(reason) || code === 4029;
}

export type FailoverOptions = {
  primary: () => RealtimeSocketLike;
  secondary: () => RealtimeSocketLike;
  shouldFailover?: (code: number, reason: string) => boolean;
  onFailover?: (details: { code: number; reason: string; beforeSessionReady: boolean }) => void;
};

export class FailoverRealtimeSocket {
  readyState = 0;
  onopen: ((event: any) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  private current: RealtimeSocketLike;
  private usingSecondary = false;
  private opened = false;
  private sessionReady = false;
  private lastSessionUpdate: string | null = null;
  private readonly options: FailoverOptions;

  constructor(options: FailoverOptions) {
    this.options = options;
    this.current = this.attach(options.primary(), false);
  }

  get isUsingSecondary(): boolean {
    return this.usingSecondary;
  }

  private attach(socket: RealtimeSocketLike, secondary: boolean): RealtimeSocketLike {
    socket.onopen = (event) => {
      if (this.current !== socket) return;
      if (secondary && this.lastSessionUpdate) {
        if (this.sessionReady) socket.markSessionAnnounced?.();
        socket.send(this.lastSessionUpdate);
      }
      if (!this.opened) {
        this.opened = true;
        this.readyState = 1;
        this.onopen?.(event);
      }
    };
    socket.onmessage = (event) => {
      if (this.current !== socket) return;
      let parsed: Json | null = null;
      try { parsed = JSON.parse(event.data); } catch {}
      const type = parsed?.type;
      if (type === "session.created" || type === "session.updated") {
        // Capture must start only once, whichever engine answers first.
        if (this.sessionReady) return;
        if (type === "session.updated") this.sessionReady = true;
      }
      this.onmessage?.(event);
    };
    socket.onerror = (event) => {
      if (this.current !== socket) return;
      this.onerror?.(event);
    };
    socket.onclose = (event) => {
      if (this.current !== socket) return;
      const code = event?.code ?? 1006;
      const reason = String(event?.reason ?? "");
      const shouldFailover = this.options.shouldFailover ?? isQuotaClose;
      if (!this.usingSecondary && shouldFailover(code, reason)) {
        this.usingSecondary = true;
        this.options.onFailover?.({ code, reason, beforeSessionReady: !this.sessionReady });
        this.current = this.attach(this.options.secondary(), true);
        return;
      }
      this.readyState = 3;
      this.onclose?.(event);
    };
    return socket;
  }

  send(data: string): void {
    try {
      const parsed = JSON.parse(data);
      if (parsed?.type === "session.update") this.lastSessionUpdate = data;
    } catch {}
    this.current.send(data);
  }

  close(): void {
    this.readyState = 3;
    const socket = this.current;
    socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null;
    try { socket.close(); } catch {}
  }
}
