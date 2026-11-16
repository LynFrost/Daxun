// ntfy transport for optional, per-device cross-computer notifications.
// Configuration stays in chrome.storage.local (never storage.sync).
export const SYNC_KEYS = {
  send: 'replynotice_sync_send',
  receive: 'replynotice_sync_receive',
  sharePreview: 'replynotice_sync_share_preview',
  topic: 'replynotice_sync_topic',
  deviceName: 'replynotice_sync_device_name',
  deviceId: 'replynotice_sync_device_id',
} as const;

export const SYNC_TITLE = '答讯 · ReplyNotice';
export const GENERIC_MESSAGE = 'ChatGPT has finished responding.';

const MAX_MESSAGE_LENGTH = 1500;
const MAX_EVENT_AGE_MS = 2 * 60 * 1000;
const MAX_SEEN_EVENTS = 300;
const SEEN_TTL_MS = 5 * 60 * 1000;

export type SyncSettings = {
  send: boolean;
  receive: boolean;
  sharePreview: boolean;
  topic: string;
  deviceName: string;
};

export type SyncEvent = {
  protocol: 'replynotice-sync';
  schemaVersion: 1;
  type: 'reply_done' | 'test';
  eventId: string;
  deviceId: string;
  deviceName: string;
  timestamp: number;
  title: typeof SYNC_TITLE;
  message: string;
};

type SyncState = 'disabled' | 'invalid-config' | 'connecting' | 'connected' | 'reconnecting';
type SyncStatus = { state: SyncState; detail?: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function validTopic(value: unknown): value is string {
  // 22 random base64url characters have at least 128 bits of entropy when
  // generated uniformly; this also excludes the short public test topic.
  return typeof value === 'string' && /^[A-Za-z0-9_-]{22,128}$/.test(value);
}

export function validDeviceName(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value &&
    value.length > 0 && Array.from(value).length <= 40 && !CONTROL_CHARS.test(value);
}

export function newRandomTopic(): string {
  return 'daxun-' + crypto.randomUUID().replace(/-/g, '');
}

export function readSyncSettings(stored: Record<string, unknown>): SyncSettings {
  return {
    send: stored[SYNC_KEYS.send] === true,
    receive: stored[SYNC_KEYS.receive] === true,
    sharePreview: stored[SYNC_KEYS.sharePreview] === true,
    topic: typeof stored[SYNC_KEYS.topic] === 'string' ? stored[SYNC_KEYS.topic] as string : '',
    deviceName: typeof stored[SYNC_KEYS.deviceName] === 'string' ? stored[SYNC_KEYS.deviceName] as string : '',
  };
}

export async function ensureDeviceId(): Promise<string> {
  const stored = await chrome.storage.local.get(SYNC_KEYS.deviceId);
  const existing = stored[SYNC_KEYS.deviceId];
  if (typeof existing === 'string' && UUID_PATTERN.test(existing)) return existing;
  const deviceId = crypto.randomUUID();
  await chrome.storage.local.set({ [SYNC_KEYS.deviceId]: deviceId });
  return deviceId;
}

export async function publishSyncEvent(
  settings: SyncSettings,
  deviceId: string,
  message: string,
  type: SyncEvent['type'] = 'reply_done',
): Promise<void> {
  if (!settings.send || !validTopic(settings.topic) || !validDeviceName(settings.deviceName)) {
    throw new Error('invalid-config');
  }
  if (!UUID_PATTERN.test(deviceId) || !message || CONTROL_CHARS.test(message.replace(/[\n\t]/g, ''))) {
    throw new Error('invalid-message');
  }

  const event: SyncEvent = {
    protocol: 'replynotice-sync',
    schemaVersion: 1,
    type,
    eventId: crypto.randomUUID(),
    deviceId,
    deviceName: settings.deviceName,
    timestamp: Date.now(),
    title: SYNC_TITLE,
    message: Array.from(message).slice(0, MAX_MESSAGE_LENGTH).join(''),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    // POST to the topic URL means plain-text content, NOT ntfy's root JSON API.
    const response = await fetch('https://ntfy.sh/' + encodeURIComponent(settings.topic), {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Cache': 'no',
        'X-Firebase': 'no',
      },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('http-' + response.status);
  } catch (error) {
    if (controller.signal.aborted) throw new Error('timeout');
    if (error instanceof Error && /^http-\d+$/.test(error.message)) throw error;
    throw new Error('network-error');
  } finally {
    clearTimeout(timeout);
  }
}

function parseNtfyMessage(raw: unknown): SyncEvent | null {
  if (typeof raw !== 'string' || raw.length > 6000) return null;
  try {
    const outer: unknown = JSON.parse(raw);
    if (!outer || typeof outer !== 'object') return null;
    const envelope = outer as Record<string, unknown>;
    if (envelope.event !== 'message' || typeof envelope.message !== 'string' ||
        envelope.message.length > 5000) return null;

    const inner: unknown = JSON.parse(envelope.message);
    if (!inner || typeof inner !== 'object') return null;
    const value = inner as Record<string, unknown>;
    if (value.protocol !== 'replynotice-sync' || value.schemaVersion !== 1 ||
        (value.type !== 'reply_done' && value.type !== 'test') ||
        typeof value.eventId !== 'string' || !UUID_PATTERN.test(value.eventId) ||
        typeof value.deviceId !== 'string' || !UUID_PATTERN.test(value.deviceId) ||
        !validDeviceName(value.deviceName) ||
        value.title !== SYNC_TITLE ||
        typeof value.message !== 'string' || !value.message ||
        Array.from(value.message).length > MAX_MESSAGE_LENGTH ||
        CONTROL_CHARS.test(value.message.replace(/[\n\t]/g, '')) ||
        typeof value.timestamp !== 'number' || !Number.isSafeInteger(value.timestamp)) return null;
    const age = Date.now() - value.timestamp;
    if (age < -30000 || age > MAX_EVENT_AGE_MS) return null;
    return value as unknown as SyncEvent;
  } catch {
    return null;
  }
}

export class NtfySubscription {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private attempts = 0;
  private state: SyncState = 'disabled';
  private detail = '';
  private topic = '';
  private deviceId = '';
  private seen = new Map<string, number>();

  constructor(private readonly onEvent: (event: SyncEvent) => void) {}

  start(): void {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (SYNC_KEYS.receive in changes || SYNC_KEYS.topic in changes ||
          SYNC_KEYS.deviceId in changes) {
        void this.refresh();
      }
    });
    chrome.runtime.onStartup.addListener(() => { void this.refresh(); });
    void this.refresh();
  }

  status(): SyncStatus {
    return this.detail ? { state: this.state, detail: this.detail } : { state: this.state };
  }

  private stop(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
    if (this.socket) {
      const previous = this.socket;
      this.socket = null;
      previous.onclose = null;
      previous.onerror = null;
      previous.onmessage = null;
      previous.onopen = null;
      previous.close();
    }
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    this.stop();
    this.attempts = 0;
    this.state = 'disabled';
    this.detail = '';
    this.topic = '';
    this.deviceId = '';
    try {
      const stored = await chrome.storage.local.get([
        SYNC_KEYS.receive, SYNC_KEYS.topic, SYNC_KEYS.deviceName,
      ]);
      if (generation !== this.generation) return;
      const settings = readSyncSettings(stored);
      if (!settings.receive) return;
      if (!validTopic(settings.topic) || !validDeviceName(settings.deviceName)) {
        this.state = 'invalid-config';
        this.detail = '请填写有效的随机主题（至少22位）和设备名称';
        return;
      }
      const deviceId = await ensureDeviceId();
      if (generation !== this.generation) return;
      this.topic = settings.topic;
      this.deviceId = deviceId;
      this.connect(generation);
    } catch {
      if (generation !== this.generation) return;
      this.state = 'invalid-config';
      this.detail = '读取本机配置失败';
    }
  }

  private connect(generation: number): void {
    if (generation !== this.generation || !this.topic) return;
    this.state = this.attempts ? 'reconnecting' : 'connecting';
    this.detail = '';
    try {
      // Without since= or poll= ntfy subscribes to live events only.
      const socket = new WebSocket('wss://ntfy.sh/' + encodeURIComponent(this.topic) + '/ws');
      this.socket = socket;
      socket.onopen = () => {
        if (generation !== this.generation || this.socket !== socket) return;
        this.state = 'connected';
        this.attempts = 0;
        this.detail = '';
        // Chrome 116+ resets the SW idle timer on extension API calls.
        // Do NOT send undocumented text heartbeats to ntfy.
        this.keepaliveTimer = setInterval(() => {
          if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return;
          chrome.runtime.getPlatformInfo(() => { void chrome.runtime.lastError; });
        }, 20000);
      };
      socket.onmessage = (event) => {
        if (generation !== this.generation || this.socket !== socket) return;
        const item = parseNtfyMessage(event.data);
        if (!item || item.deviceId === this.deviceId || this.alreadySeen(item.eventId)) return;
        this.onEvent(item);
      };
      socket.onerror = () => {
        if (generation !== this.generation || this.socket !== socket) return;
        this.detail = '连接异常，将重试';
        socket.close();
      };
      socket.onclose = () => {
        if (generation !== this.generation || this.socket !== socket) return;
        this.socket = null;
        if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = null;
        this.retry(generation);
      };
    } catch {
      this.retry(generation);
    }
  }

  private retry(generation: number): void {
    if (generation !== this.generation) return;
    this.state = 'reconnecting';
    this.detail = '连接中断，正在重试';
    const delays = [1000, 2000, 5000, 10000, 30000];
    const delay = delays[Math.min(this.attempts, delays.length - 1)];
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(generation);
    }, delay + Math.floor(Math.random() * 1000));
  }

  private alreadySeen(eventId: string): boolean {
    const now = Date.now();
    for (const [id, at] of this.seen) {
      if (now - at > SEEN_TTL_MS) this.seen.delete(id);
    }
    if (this.seen.has(eventId)) return true;
    this.seen.set(eventId, now);
    while (this.seen.size > MAX_SEEN_EVENTS) {
      this.seen.delete(this.seen.keys().next().value!);
    }
    return false;
  }
}
