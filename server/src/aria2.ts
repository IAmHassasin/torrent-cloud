/** Minimal aria2 JSON-RPC client (https://aria2.github.io/manual/en/html/aria2c.html#rpc-interface). */

export interface Aria2File {
  index: string;
  path: string;
  length: string;
  completedLength: string;
  selected: 'true' | 'false';
}

export interface Aria2Status {
  gid: string;
  status: 'active' | 'waiting' | 'paused' | 'error' | 'complete' | 'removed';
  totalLength: string;
  completedLength: string;
  downloadSpeed: string;
  connections: string;
  numSeeders?: string;
  infoHash?: string;
  dir: string;
  files: Aria2File[];
  followedBy?: string[];
  errorCode?: string;
  errorMessage?: string;
  bittorrent?: { info?: { name?: string } };
}

export class Aria2Error extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'Aria2Error';
  }
}

export class Aria2Client {
  private seq = 0;

  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly timeoutMs = 15000,
  ) {}

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `tc-${++this.seq}`,
        method: `aria2.${method}`,
        params: [`token:${this.secret}`, ...params],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = (await response.json()) as { result?: T; error?: { code: number; message: string } };
    if (payload.error) throw new Aria2Error(payload.error.message, payload.error.code);
    if (!response.ok) throw new Aria2Error(`HTTP ${response.status}`, response.status);
    return payload.result as T;
  }

  addUri(uris: string[], options: Record<string, string>): Promise<string> {
    return this.call<string>('addUri', [uris, options]);
  }

  addTorrent(torrentBase64: string, options: Record<string, string>): Promise<string> {
    return this.call<string>('addTorrent', [torrentBase64, [], options]);
  }

  tellStatus(gid: string): Promise<Aria2Status> {
    return this.call<Aria2Status>('tellStatus', [gid]);
  }

  async remove(gid: string): Promise<void> {
    await this.call('forceRemove', [gid]).catch(() => undefined);
    await this.call('removeDownloadResult', [gid]).catch(() => undefined);
  }

  removeDownloadResult(gid: string): Promise<string> {
    return this.call<string>('removeDownloadResult', [gid]);
  }

  getVersion(): Promise<{ version: string }> {
    return this.call<{ version: string }>('getVersion');
  }
}
