export default defineBackground(() => {
  const SYSTEM_NOTIFICATION_KEY = 'chatgpt_notifier_system_notification_enabled';
  const PREVIEW_KEY = 'chatgpt_notifier_qa_preview_enabled';
  const NOTIFICATION_ORIGIN_PREFIX = 'replynotice_origin_';
  const ORIGIN_TTL_MS = 24 * 60 * 60 * 1000;
  const MAX_ORIGINS = 100;
  const HOME_URL = 'https://chatgpt.com/';
  const notifiedCycles = new Set<string>();
  const pendingNotificationClicks = new Set<string>();
  const MAX_REMEMBERED_CYCLES = 200;

  type NotificationMessage = {
    type: 'CHATGPT_REPLY_DONE' | 'CHATGPT_TEST_NOTIFICATION';
    cycleId?: string;
    payload?: {
      title?: string;
      message?: string;
      questionPreview?: string;
      answerPreview?: string;
      conversationUrl?: string;
    };
  };

  type NotificationOrigin = { tabId: number; url: string; createdAt: number };

  function trustedConversationUrl(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      return url.origin === 'https://chatgpt.com' ? url.href : null;
    } catch {
      return null;
    }
  }

  function previewText(value: unknown, limit: number): string {
    if (typeof value !== 'string') return '';
    const normalized = value.replace(/\s+/g, ' ').trim();
    const characters = Array.from(normalized);
    return characters.length > limit ? characters.slice(0, limit).join('') + '……' : normalized;
  }

  function notificationText(payload: NotificationMessage['payload'], previewEnabled: boolean): string {
    const fallback = payload?.message || 'ChatGPT has finished responding.';
    if (!previewEnabled) return fallback;
    const question = previewText(payload?.questionPreview, 50);
    const answer = previewText(payload?.answerPreview, 100);
    if (!question && !answer) return fallback;
    return '问：' + (question || '提问内容不可预览') +
      '\n答：' + (answer || 'ChatGPT 回答已完成');
  }

  function rememberOrigin(notificationId: string, origin: NotificationOrigin, finish: () => void) {
    chrome.storage.session.set({ [NOTIFICATION_ORIGIN_PREFIX + notificationId]: origin }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        console.warn('[ReplyNotice/background] Could not save notification click target:', error.message);
      }
      finish();
    });
  }

  function pruneOrigins() {
    chrome.storage.session.get(null, (all) => {
      if (chrome.runtime.lastError) return;
      const now = Date.now();
      const items = Object.entries(all)
        .filter(([key]) => key.startsWith(NOTIFICATION_ORIGIN_PREFIX))
        .map(([key, value]) => ({ key, origin: value as NotificationOrigin }));
      const expired = items.filter(({ origin }) =>
        !origin || typeof origin.createdAt !== 'number' || now - origin.createdAt > ORIGIN_TTL_MS,
      ).map(({ key }) => key);
      const live = items.filter(({ key }) => !expired.includes(key))
        .sort((a, b) => a.origin.createdAt - b.origin.createdAt);
      const extra = live.slice(0, Math.max(0, live.length - MAX_ORIGINS)).map(({ key }) => key);
      const keys = [...expired, ...extra];
      if (keys.length) chrome.storage.session.remove(keys);
    });
  }

  function openChat(url: string) {
    chrome.tabs.create({ url }, () => {
      if (chrome.runtime.lastError) {
        console.error('[ReplyNotice/background] Could not open ChatGPT:', chrome.runtime.lastError.message);
      }
    });
  }

  chrome.notifications.onClicked.addListener((notificationId) => {
    const key = NOTIFICATION_ORIGIN_PREFIX + notificationId;
    // Read the origin before clearing: clear() may fire onClosed, and the
    // native banner may already have moved into Windows Notification Center.
    pendingNotificationClicks.add(notificationId);
    chrome.storage.session.get([key], (result) => {
      const error = chrome.runtime.lastError;
      const origin = result?.[key] as NotificationOrigin | undefined;
      pendingNotificationClicks.delete(notificationId);
      chrome.storage.session.remove(key);

      // Only clear the clicked notification. A missing/already-dismissed
      // notification must not block navigation to its original conversation.
      try {
        chrome.notifications.clear(notificationId, (wasCleared) => {
          const clearError = chrome.runtime.lastError;
          if (clearError) {
            console.warn('[ReplyNotice/background] Could not clear clicked notification:', clearError.message);
          } else {
            console.debug('[ReplyNotice/background] Clicked notification clear result:', {
              notificationId, wasCleared,
            });
          }
        });
      } catch (clearError) {
        console.warn('[ReplyNotice/background] Clearing clicked notification threw:', clearError);
      }

      const url = trustedConversationUrl(origin?.url) || HOME_URL;
      if (error || !origin || typeof origin.tabId !== 'number' ||
          typeof origin.createdAt !== 'number' || Date.now() - origin.createdAt > ORIGIN_TTL_MS) {
        openChat(url);
        return;
      }
      chrome.tabs.get(origin.tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          openChat(url);
          return;
        }
        // Do not focus an unrelated page if the original tab navigated away.
        const tabUrl = typeof tab.url === 'string' ? trustedConversationUrl(tab.url) : null;
        if (tab.url && (!tabUrl || new URL(tabUrl).pathname !== new URL(url).pathname)) {
          openChat(url);
          return;
        }
        chrome.tabs.update(origin.tabId, { active: true }, (updatedTab) => {
          if (chrome.runtime.lastError || !updatedTab) {
            openChat(url);
            return;
          }
          chrome.windows.update(updatedTab.windowId, { focused: true }, () => {
            if (chrome.runtime.lastError) {
              console.warn('[ReplyNotice/background] Could not focus ChatGPT window:', chrome.runtime.lastError.message);
            }
          });
        });
      });
    });
  });

  chrome.notifications.onClosed.addListener((notificationId, byUser) => {
    // Edge/Windows may retire the desktop banner while keeping a clickable
    // notification in Notification Center. The platform's automatic close
    // event must not erase the origin prematurely. TTL (24 h) and the
    // 100-entry cap in pruneOrigins() bound retained mappings.
    if (!byUser) {
      console.debug('[ReplyNotice/background] System-closed notification origin retained:', notificationId);
      return;
    }
    // A click can also generate onClosed. Keep the mapping until the
    // onClicked handler has obtained its snapshot.
    if (pendingNotificationClicks.has(notificationId)) return;
    // Explicit user dismissal (X) only cleans up; it never opens ChatGPT.
    chrome.storage.session.remove(NOTIFICATION_ORIGIN_PREFIX + notificationId);
  });

  pruneOrigins();

  function createSystemNotification(
    payload: NotificationMessage['payload'],
    sendResponse: (response: { status: string; detail?: string }) => void,
    origin?: NotificationOrigin,
  ) {
    chrome.notifications.getPermissionLevel((level) => {
      const permissionError = chrome.runtime.lastError;
      if (permissionError) {
        console.error('[ReplyNotice/background] Notification permission check failed:', permissionError.message);
        sendResponse({ status: 'error', detail: permissionError.message });
        return;
      }
      if (level !== 'granted') {
        console.warn('[ReplyNotice/background] Browser notification permission is not granted:', level);
        sendResponse({ status: 'permission-denied' });
        return;
      }

      try {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('logo.png'),
          title: payload?.title || '答讯 · ReplyNotice',
          message: payload?.message || 'ChatGPT has finished responding.',
          priority: 1,
          requireInteraction: true,
        }, (notificationId) => {
          const error = chrome.runtime.lastError;
          if (error || !notificationId) {
            console.error('[ReplyNotice/background] Notification creation failed:', error?.message || 'No notification ID returned');
            sendResponse({ status: 'error', detail: error?.message || 'No notification ID returned' });
            return;
          }
          // Successful creation does not guarantee a Windows banner (Focus Assist / DND / Edge settings).
          const finish = () => {
            console.info('[ReplyNotice/background] Notification created:', notificationId);
            sendResponse({ status: 'created' });
          };
          if (origin) {
            rememberOrigin(notificationId, origin, () => {
              pruneOrigins();
              finish();
            });
          } else {
            finish();
          }
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error('[ReplyNotice/background] Notification API threw:', detail);
        sendResponse({ status: 'error', detail });
      }
    });
  }

  chrome.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
    const message = rawMessage as NotificationMessage | null;
    if (message?.type !== 'CHATGPT_REPLY_DONE' && message?.type !== 'CHATGPT_TEST_NOTIFICATION') {
      return;
    }

    if (message.type === 'CHATGPT_TEST_NOTIFICATION') {
      // From an extension page's DevTools console:
      // chrome.runtime.sendMessage({ type: 'CHATGPT_TEST_NOTIFICATION' }, console.log)
      // This bypasses the content-script detector and the user-facing toggle.
      console.info('[ReplyNotice/background] Diagnostic test notification requested');
      createSystemNotification({ message: 'ReplyNotice notification channel test.' }, sendResponse);
      return true;
    }

    if (typeof sender.tab?.id !== 'number' || typeof message.cycleId !== 'string' || !message.cycleId) {
      console.warn('[ReplyNotice/background] Invalid reply completion message:', message);
      sendResponse({ status: 'invalid-message' });
      return;
    }

    const key = sender.tab.id + ':' + message.cycleId;
    if (notifiedCycles.has(key)) {
      console.info('[ReplyNotice/background] Duplicate reply completion ignored:', key);
      sendResponse({ status: 'duplicate' });
      return;
    }
    notifiedCycles.add(key);
    if (notifiedCycles.size > MAX_REMEMBERED_CYCLES) {
      notifiedCycles.delete(notifiedCycles.values().next().value!);
    }

    console.info('[ReplyNotice/background] Reply completion received:', key);
    const senderUrl = trustedConversationUrl(sender.url);
    if (!senderUrl) {
      console.warn('[ReplyNotice/background] Reply completion came from an untrusted page');
      sendResponse({ status: 'invalid-message' });
      return;
    }
    chrome.storage.local.get([SYSTEM_NOTIFICATION_KEY, PREVIEW_KEY], (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        console.error('[ReplyNotice/background] Notification setting lookup failed:', error.message);
        sendResponse({ status: 'error', detail: error.message });
        return;
      }
      if (result[SYSTEM_NOTIFICATION_KEY] !== true) {
        console.info('[ReplyNotice/background] System Notification is off; skipping:', key);
        sendResponse({ status: 'disabled' });
        return;
      }
      const origin: NotificationOrigin = {
        tabId: sender.tab!.id!,
        url: trustedConversationUrl(message.payload?.conversationUrl) || senderUrl,
        createdAt: Date.now(),
      };
      createSystemNotification({
        title: '答讯 · ReplyNotice',
        message: notificationText(message.payload, result[PREVIEW_KEY] === true),
      }, sendResponse, origin);
    });
    return true;
  });
});
