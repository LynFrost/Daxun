export default defineBackground(() => {
  const SYSTEM_NOTIFICATION_KEY = 'chatgpt_notifier_system_notification_enabled';
  const notifiedCycles = new Set<string>();
  const MAX_REMEMBERED_CYCLES = 200;

  type NotificationMessage = {
    type: 'CHATGPT_REPLY_DONE' | 'CHATGPT_TEST_NOTIFICATION';
    cycleId?: string;
    payload?: { title?: string; message?: string };
  };

  function createSystemNotification(
    payload: NotificationMessage['payload'],
    sendResponse: (response: { status: string; detail?: string }) => void,
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
        }, (notificationId) => {
          const error = chrome.runtime.lastError;
          if (error || !notificationId) {
            console.error('[ReplyNotice/background] Notification creation failed:', error?.message || 'No notification ID returned');
            sendResponse({ status: 'error', detail: error?.message || 'No notification ID returned' });
            return;
          }
          // Successful creation does not guarantee a Windows banner (Focus Assist / DND / Edge settings).
          console.info('[ReplyNotice/background] Notification created:', notificationId);
          sendResponse({ status: 'created' });
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
    chrome.storage.local.get([SYSTEM_NOTIFICATION_KEY], (result) => {
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
      createSystemNotification(message.payload, sendResponse);
    });
    return true;
  });
});
