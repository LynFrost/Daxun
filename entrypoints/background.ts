import { NtfySubscription, SYNC_KEYS, SYNC_TITLE, GENERIC_MESSAGE, ensureDeviceId, publishSyncEvent, readSyncSettings, validDeviceName, validTopic } from '@/lib/ntfySync';

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
  const REMOTE_NOTIFICATION_PREFIX = 'replynotice_remote_';
  const sync = new NtfySubscription((event) => {
    // Type is encoded in the notification ID so it survives worker suspension.
    chrome.storage.local.get([SYSTEM_NOTIFICATION_KEY], (settings) => {
      if (chrome.runtime.lastError || settings[SYSTEM_NOTIFICATION_KEY] !== true) return;
      const source = event.deviceName.replace(/[\r\n]/g, ' ');
      createSystemNotification({
        title: SYNC_TITLE,
        message: '来源：' + source + '\n' + event.message,
      }, () => {}, undefined, REMOTE_NOTIFICATION_PREFIX + event.eventId);
    });
  });
  sync.start();

  type NotificationMessage = {
    type: 'CHATGPT_REPLY_DONE' | 'CHATGPT_TEST_NOTIFICATION' | 'REPLYNOTICE_SYNC_STATUS' | 'REPLYNOTICE_SYNC_TEST';
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


  const MAX_NOTIFICATIONS = 3;
  const NOTIFICATION_QUEUE_KEY = 'replynotice_notification_queue';
  let notificationOperation = Promise.resolve();

  // Serialize create/evict and "清空全部", including their storage writes.
  function enqueueNotificationOperation<T>(work: () => Promise<T>): Promise<T> {
    const current = notificationOperation.then(work);
    notificationOperation = current.then(() => undefined, () => undefined);
    return current;
  }

  function listManagedNotifications(): Promise<Record<string, boolean>> {
    return new Promise((resolve, reject) => {
      try {
        chrome.notifications.getAll((notifications) => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(notifications || {});
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function readNotificationQueue(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      chrome.storage.session.get([NOTIFICATION_QUEUE_KEY], (stored) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        const value: unknown = stored[NOTIFICATION_QUEUE_KEY];
        const queue = Array.isArray(value) ? value.filter((id): id is string =>
          typeof id === 'string' && id.length > 0) : [];
        resolve([...new Set(queue)]);
      });
    });
  }

  function saveNotificationQueue(queue: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      chrome.storage.session.set({ [NOTIFICATION_QUEUE_KEY]: queue }, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  }

  async function clearManagedNotification(id: string): Promise<boolean> {
    const wasCleared = await new Promise<boolean>((resolve, reject) => {
      try {
        chrome.notifications.clear(id, (cleared) => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(cleared);
        });
      } catch (error) {
        reject(error);
      }
    });
    if (wasCleared) return true;
    // A click or close event may have removed it before the callback.
    const remaining = await listManagedNotifications();
    return !Object.prototype.hasOwnProperty.call(remaining, id);
  }

  function forgetNotificationOrigin(id: string): Promise<void> {
    // A body click has already requested the origin snapshot; let it finish.
    if (pendingNotificationClicks.has(id)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      chrome.storage.session.remove(NOTIFICATION_ORIGIN_PREFIX + id, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  }

  async function reconcileNotificationQueue(): Promise<string[]> {
    const stored = await readNotificationQueue();
    const actual = await listManagedNotifications();
    const queue = stored.filter((id) => Object.prototype.hasOwnProperty.call(actual, id));
    const known = new Set(queue);
    const untracked = Object.keys(actual).filter((id) => !known.has(id));

    if (untracked.length) {
      // After an upgrade/restart, old notifications have no trustworthy
      // creation order. Reset just those untracked notices instead of
      // pretending an ID sort identifies the oldest.
      console.warn('[ReplyNotice/background] Resetting untracked notifications (unknown FIFO order):', untracked.length);
      for (const id of untracked) {
        if (!await clearManagedNotification(id)) {
          throw new Error('Could not clear untracked notification: ' + id);
        }
        await forgetNotificationOrigin(id);
      }
    }
    await saveNotificationQueue(queue);
    return queue;
  }

  function openChat(url: string) {
    chrome.tabs.create({ url }, () => {
      if (chrome.runtime.lastError) {
        console.error('[ReplyNotice/background] Could not open ChatGPT:', chrome.runtime.lastError.message);
      }
    });
  }

  chrome.notifications.onClicked.addListener((notificationId) => {
    if (notificationId.startsWith(REMOTE_NOTIFICATION_PREFIX)) {
      // Remote notifications can never navigate, even after SW restart.
      chrome.notifications.clear(notificationId, () => { void chrome.runtime.lastError; });
      return;
    }
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

  chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
    if (buttonIndex === 0) {
      // "关闭" only dismisses this notification. Do not navigate or
      // interfere with any other notification in Windows Notification Center.
      const forgetClosedOrigin = () => {
        // A concurrent body click has requested its own origin snapshot.
        if (pendingNotificationClicks.has(notificationId)) return;
        chrome.storage.session.remove(NOTIFICATION_ORIGIN_PREFIX + notificationId, () => {
          const storageError = chrome.runtime.lastError;
          if (storageError) {
            console.warn('[ReplyNotice/background] Could not forget closed notification origin:', {
              notificationId, detail: storageError.message,
            });
          }
        });
      };

      try {
        chrome.notifications.clear(notificationId, (wasCleared) => {
          const clearError = chrome.runtime.lastError;
          if (clearError) {
            console.warn('[ReplyNotice/background] Could not close notification:', {
              notificationId, detail: clearError.message,
            });
            return;
          }
          if (wasCleared) {
            forgetClosedOrigin();
            return;
          }

          // A second event may have removed it before the callback ran.
          // Preserve the mapping if the notification is still active.
          chrome.notifications.getAll((remaining) => {
            const checkError = chrome.runtime.lastError;
            if (checkError) {
              console.warn('[ReplyNotice/background] Could not verify closed notification:', {
                notificationId, detail: checkError.message,
              });
            } else if (!Object.prototype.hasOwnProperty.call(remaining || {}, notificationId)) {
              forgetClosedOrigin();
            } else {
              console.warn('[ReplyNotice/background] Notification was not closed:', notificationId);
            }
          });
        });
      } catch (error) {
        console.warn('[ReplyNotice/background] Closing notification threw:', {
          notificationId, error,
        });
      }
      return;
    }

    // Button 1 is "清空全部". Unknown button indexes do nothing.
    if (buttonIndex !== 1) return;

    // Serialize the snapshot and every clear with new notification creation.
    void enqueueNotificationOperation(async () => {
      const notifications = await listManagedNotifications();
      const ids = Object.keys(notifications);
      let cleared = 0;
      let alreadyAbsent = 0;
      let failed = 0;

      for (const id of ids) {
        try {
          const removed = await clearManagedNotification(id);
          if (!removed) {
            failed += 1;
            console.warn('[ReplyNotice/background] Notification still exists after clear:', id);
            continue;
          }
          if (Object.prototype.hasOwnProperty.call(notifications, id)) cleared += 1;
          await forgetNotificationOrigin(id);
        } catch (error) {
          failed += 1;
          console.warn('[ReplyNotice/background] Clear-all failed for notification:', { notificationId: id, error });
        }
      }

      // Preserve only notifications that actually survived (e.g. clear failed).
      const remaining = await listManagedNotifications();
      const queue = await readNotificationQueue();
      await saveNotificationQueue(queue.filter((id) =>
        Object.prototype.hasOwnProperty.call(remaining, id)));
      console.info('[ReplyNotice/background] Clear-all complete:', {
        requested: ids.length, cleared, alreadyAbsent, failed,
      });
    }).catch((error) => {
      console.error('[ReplyNotice/background] Clear-all failed:', error);
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
    notificationId?: string,
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

      void enqueueNotificationOperation(async () => {
        const queue = await reconcileNotificationQueue();
        const updatingExisting = !!notificationId && queue.includes(notificationId);
        if (!updatingExisting) {
          while (queue.length >= MAX_NOTIFICATIONS) {
            const oldestId = queue[0];
            // Do not create a fourth notification until clear is confirmed.
            if (!await clearManagedNotification(oldestId)) {
              throw new Error('Could not free notification slot: ' + oldestId);
            }
            await forgetNotificationOrigin(oldestId);
            queue.shift();
            await saveNotificationQueue(queue);
          }
        }

        const createdId = await new Promise<string>((resolve, reject) => {
          try {
            chrome.notifications.create(notificationId || '', {
              type: 'basic',
              iconUrl: chrome.runtime.getURL('logo.png'),
              title: payload?.title || '答讯 · ReplyNotice',
              message: payload?.message || 'ChatGPT has finished responding.',
              priority: 1,
              requireInteraction: true,
              buttons: [
                { title: '关闭' },
                { title: '清空全部' },
              ],
            }, (createdId) => {
              const error = chrome.runtime.lastError;
              if (error || !createdId) {
                reject(new Error(error?.message || 'No notification ID returned'));
              } else {
                resolve(createdId);
              }
            });
          } catch (error) {
            reject(error);
          }
        });

        // Re-delivery of an existing remote ID keeps its original FIFO place.
        if (!queue.includes(createdId)) queue.push(createdId);
        await saveNotificationQueue(queue);

        if (origin) {
          await new Promise<void>((resolve) => {
            rememberOrigin(createdId, origin, () => {
              pruneOrigins();
              resolve();
            });
          });
        }
        // Successful create does not guarantee a Windows banner (DND / Edge).
        console.info('[ReplyNotice/background] Notification created:', createdId);
      }).then(() => {
        sendResponse({ status: 'created' });
      }).catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        console.error('[ReplyNotice/background] Notification operation failed:', detail);
        sendResponse({ status: 'error', detail });
      });
    });
  }

  chrome.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
    const message = rawMessage as NotificationMessage | null;
    if (message?.type === 'REPLYNOTICE_SYNC_STATUS' || message?.type === 'REPLYNOTICE_SYNC_TEST') {
      // Only extension pages may request status or a deliberate sync test.
      if (sender.id !== chrome.runtime.id || sender.tab || !sender.url?.startsWith(chrome.runtime.getURL(''))) {
        sendResponse({ status: 'invalid-message' });
        return;
      }
      if (message.type === 'REPLYNOTICE_SYNC_STATUS') {
        sendResponse({ status: 'ok', connection: sync.status() });
        return;
      }
      chrome.storage.local.get(Object.values(SYNC_KEYS), async (stored) => {
        if (chrome.runtime.lastError) {
          sendResponse({ status: 'error', detail: '读取设置失败' });
          return;
        }
        const settings = readSyncSettings(stored);
        if (!settings.send || !validTopic(settings.topic) || !validDeviceName(settings.deviceName)) {
          sendResponse({ status: 'invalid-config', detail: '请启用发送并配置有效主题及设备名称' });
          return;
        }
        try {
          await publishSyncEvent(settings, await ensureDeviceId(), 'ReplyNotice cross-computer test.', 'test');
          sendResponse({ status: 'sent' });
        } catch (error) {
          sendResponse({ status: 'error', detail: error instanceof Error ? error.message : '发送失败' });
        }
      });
      return true;
    }
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

    const senderUrl = trustedConversationUrl(sender.url);
    if (!senderUrl) {
      console.warn('[ReplyNotice/background] Reply completion came from an untrusted page');
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
    chrome.storage.local.get([SYSTEM_NOTIFICATION_KEY, PREVIEW_KEY, ...Object.values(SYNC_KEYS)], (result) => {
      const error = chrome.runtime.lastError;
      if (error) {
        console.error('[ReplyNotice/background] Notification setting lookup failed:', error.message);
        sendResponse({ status: 'error', detail: error.message });
        return;
      }
      const previewEnabled = result[PREVIEW_KEY] === true;
      const localText = notificationText(message.payload, previewEnabled);
      const settings = readSyncSettings(result);
      const localEnabled = result[SYSTEM_NOTIFICATION_KEY] === true;
      if (settings.send) {
        if (!validTopic(settings.topic) || !validDeviceName(settings.deviceName)) {
          console.warn('[ReplyNotice/background] Cross-computer sending not configured');
        } else {
          // Independent of local notification permissions and completion callback.
          const remoteText = previewEnabled && settings.sharePreview ? localText : GENERIC_MESSAGE;
          void ensureDeviceId()
            .then((deviceId) => publishSyncEvent(settings, deviceId, remoteText))
            .catch((err) => console.warn('[ReplyNotice/background] Cross-computer send failed:', err instanceof Error ? err.message : 'unknown'));
        }
      }
      if (!localEnabled) {
        sendResponse({ status: 'disabled' });
        return;
      }
      const origin: NotificationOrigin = {
        tabId: sender.tab!.id!,
        url: trustedConversationUrl(message.payload?.conversationUrl) || senderUrl,
        createdAt: Date.now(),
      };
      createSystemNotification({
        title: SYNC_TITLE,
        message: localText,
      }, sendResponse, origin);
    });
    return true;
  });
});
