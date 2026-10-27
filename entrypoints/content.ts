import { SOUNDS, playTone } from '@/lib/sounds';

export default defineContentScript({
  matches: ['https://chatgpt.com/*'],

  main() {
    const AUDIO_URL = chrome.runtime.getURL('notification.mp3');
    const audio = new Audio(AUDIO_URL);
    const VOLUME_STORAGE_KEY = 'chatgpt_notifier_volume';
    const SOUND_STORAGE_KEY = 'chatgpt_notifier_sound_id';

    let currentSoundId = 'default';
    let currentVolume = 0.5;

    // Initialize volume and sound from storage
    chrome.storage.local.get([VOLUME_STORAGE_KEY, SOUND_STORAGE_KEY], (result) => {
      const vol = result[VOLUME_STORAGE_KEY];
      if (typeof vol === 'number') {
        currentVolume = vol;
        audio.volume = vol;
      }

      const soundId = result[SOUND_STORAGE_KEY] as string | undefined;
      if (soundId) {
        currentSoundId = soundId;
      }
    });

    // Listen for changes from popup
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;

      if (changes[VOLUME_STORAGE_KEY]) {
        const newVol = changes[VOLUME_STORAGE_KEY].newValue;
        if (typeof newVol === 'number') {
          currentVolume = newVol;
          audio.volume = newVol;
        }
      }

      if (changes[SOUND_STORAGE_KEY]) {
        const newSound = changes[SOUND_STORAGE_KEY].newValue as string | undefined;
        currentSoundId = newSound || 'default';
      }
    });

    function playNotification() {
      const sound = SOUNDS.find((s) => s.id === currentSoundId);
      if (sound && sound.freqs.length > 0) {
        playTone(sound.freqs, currentVolume, sound.type);
      } else {
        audio.play().catch(() => {
          /* ignore autoplay restrictions */
        });
      }
    }

    /**
     * All known "streaming" DOM selectors.
     * If OpenAI changes the UI again, just add new selectors here.
     */
    const STREAM_SELECTORS = [
      '.result-streaming',
      'button[data-testid$="stop-button"]',
      '[data-testid="assistant-response-spinner"]',
    ].join(',');

    let isStreaming = false;
    let doneTimerId: ReturnType<typeof setTimeout> | null = null;
    const DEBOUNCE_MS = 300;

    function checkStreaming() {
      const stillStreaming = document.querySelector(STREAM_SELECTORS) !== null;

      if (stillStreaming) {
        isStreaming = true;
        clearTimeout(doneTimerId!);
        doneTimerId = null;
      } else if (isStreaming && !doneTimerId) {
        doneTimerId = setTimeout(() => {
          if (document.querySelector(STREAM_SELECTORS) === null) {
            playNotification();
            isStreaming = false;
          }
          doneTimerId = null;
        }, DEBOUNCE_MS);
      }
    }

    // ChatGPT's thinking/tool phases and generation all count as activity.
    // The notification detector is separate from the existing sound behavior.
    const ACTIVE_SELECTORS = [
      STREAM_SELECTORS,
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop response"]',
      'button[aria-label="停止生成"]',
      '[data-message-author-role="assistant"][aria-busy="true"]',
      '[data-is-streaming="true"]',
      '[data-testid="thinking-indicator"]',
    ].join(',');
    const USER_SELECTOR = '[data-message-author-role="user"], [data-role="user"]';
    const ASSISTANT_SELECTOR = [
      '[data-turn-key]:has([data-conversation-role="assistant"])',
      '[data-message-author-role="assistant"]',
      '[data-role="assistant"]',
    ].join(',');
    const RESPONSE_COPY_SELECTOR = [
      'button[data-testid="copy-turn-action-button"]',
      'button[data-testid="copy-response-button"]',
      'button[aria-label="Copy"]',
      'button[aria-label="Copy response"]',
      'button[aria-label="复制"]',
      'button[aria-label="复制回复"]',
    ].join(',');
    const QUIET_WITH_COPY_MS = 2500;
    const QUIET_FALLBACK_MS = 30000;
    const POLL_MS = 500;
    const DIAGNOSTIC_MS = 45000;
    const QUESTION_PREVIEW_LIMIT = 50;
    const ANSWER_PREVIEW_LIMIT = 100;
    const ANSWER_BODY_SELECTORS = [
      '.markdown',
      '[data-testid="message-text"]',
      '[data-message-content]',
      '.prose',
    ];
    const ANSWER_EXCLUDE_SELECTOR = [
      'button', 'nav', 'header', 'footer', 'svg', 'script', 'style',
      '[hidden]', '[aria-hidden="true"]', '[role="toolbar"]', '[role="button"]',
      '[data-conversation-role]', 'details',
      '[data-testid*="thinking"]', '[data-testid*="reasoning"]',
      '[data-testid*="tool"]', '[data-testid*="activity"]',
      '.sr-only',
    ].join(',');

    function summarize(text: string, limit: number): string {
      const normalized = text.replace(/\s+/g, ' ').trim();
      const characters = Array.from(normalized);
      return characters.length > limit ? characters.slice(0, limit).join('') + '……' : normalized;
    }

    function captureQuestionPreview(): string {
      // Capture before ChatGPT clears its composer; do not read historical turns.
      const composer = document.querySelector<HTMLElement>(
        '#prompt-textarea, textarea[name="prompt-textarea"], [contenteditable="true"][data-placeholder]',
      );
      if (!composer) return '';
      const text = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
        ? composer.value
        : composer.innerText || composer.textContent || '';
      return summarize(text, QUESTION_PREVIEW_LIMIT);
    }

    function visibleResponseText(root: Element): string {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const fragments: string[] = [];
      let current: Node | null;
      while ((current = walker.nextNode())) {
        const parent = current.parentElement;
        if (!parent || !current.textContent?.trim()) continue;
        if (parent.closest(ANSWER_EXCLUDE_SELECTOR)) continue;
        let visible = true;
        for (let ancestor: Element | null = parent; ancestor && root.contains(ancestor); ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
            visible = false;
            break;
          }
        }
        if (visible) fragments.push(current.textContent);
      }
      return fragments.join(' ');
    }

    function extractAnswerPreview(assistant: Element): string {
      // Prefer rendered answer blocks, never the whole turn (which also contains
      // toolbar labels, thinking details and tool progress).
      for (const selector of ANSWER_BODY_SELECTORS) {
        const candidates = Array.from(assistant.querySelectorAll(selector));
        if (assistant.matches(selector)) candidates.unshift(assistant);
        const eligible = candidates.filter((element) =>
          !element.closest(ANSWER_EXCLUDE_SELECTOR) &&
          !candidates.some((ancestor) => ancestor !== element && ancestor.contains(element)),
        );
        const body = eligible.map(visibleResponseText).filter(Boolean).join(' ');
        const preview = summarize(body, ANSWER_PREVIEW_LIMIT);
        if (preview) return preview;
      }
      return '';
    }

    type ReplyCycle = {
      id: string;
      questionPreview: string;
      user: Element | null;
      baselineAssistant: Element | null;
      newUserSeen: boolean;
      assistant: Element | null;
      signature: string;
      startedAt: number;
      lastContentChangeAt: number;
      quietSince: number | null;
      activeSeen: boolean;
      notified: boolean;
      warned: boolean;
    };

    function latest(selector: string): Element | null {
      const nodes = document.querySelectorAll(selector);
      return nodes.length ? nodes[nodes.length - 1] : null;
    }

    function findResponse(user: Element | null): Element | null {
      const assistant = latest(ASSISTANT_SELECTOR);
      if (!assistant) return null;
      if (user?.isConnected && !(user.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        return null;
      }
      return assistant;
    }

    function hasCompletionAction(assistant: Element): boolean {
      const turn = assistant.closest('[data-testid^="conversation-turn-"], [data-turn-key], article') || assistant;
      return turn.querySelector(RESPONSE_COPY_SELECTOR) !== null;
    }

    function responseSignature(assistant: Element): string {
      return (assistant.textContent || '') + '|' + assistant.querySelectorAll('img, canvas, video, pre, table').length;
    }

    let knownUser = latest(USER_SELECTOR);
    let route = location.pathname + location.search;
    let cycle: ReplyCycle | null = null;
    let lastSubmitAt = 0;
    let cycleSequence = 0;

    function beginCycle(reason: string, user: Element | null = latest(USER_SELECTOR), questionPreview = '') {
      cycleSequence += 1;
      const now = Date.now();
      // An activity signal immediately following the same submit must not lose
      // the pending question snapshot.
      if (!questionPreview && cycle && now - lastSubmitAt < 10000 && !cycle.notified) {
        questionPreview = cycle.questionPreview;
      }
      cycle = {
        id: now + '-' + cycleSequence + '-' + crypto.randomUUID(),
        questionPreview,
        user,
        baselineAssistant: latest(ASSISTANT_SELECTOR),
        newUserSeen: false,
        assistant: null,
        signature: '',
        startedAt: now,
        lastContentChangeAt: now,
        quietSince: null,
        activeSeen: false,
        notified: false,
        warned: false,
      };
      console.debug('[ReplyNotice/content] Tracking reply cycle:', cycle.id, reason);
    }

    function composerContains(target: EventTarget | null): boolean {
      if (!(target instanceof Element)) return false;
      const form = target.closest('form');
      return !!form?.querySelector('#prompt-textarea, [contenteditable="true"], textarea[name="prompt-textarea"]');
    }

    function onSubmitIntent() {
      const now = Date.now();
      if (now - lastSubmitAt < 700) return;
      lastSubmitAt = now;
      beginCycle('composer submitted', latest(USER_SELECTOR), captureQuestionPreview());
    }

    document.addEventListener('submit', (event) => {
      if (composerContains(event.target)) onSubmitIntent();
    }, true);
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest('button[data-testid="send-button"], button[aria-label="Send prompt"]');
      if (button && composerContains(button)) onSubmitIntent();
    }, true);
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing || !composerContains(event.target)) return;
      onSubmitIntent();
    }, true);

    function notifyBackground(reply: ReplyCycle, assistant: Element) {
      try {
        chrome.runtime.sendMessage({
          type: 'CHATGPT_REPLY_DONE',
          cycleId: reply.id,
          payload: {
            title: '答讯 · ReplyNotice',
            message: 'ChatGPT has finished responding.',
            questionPreview: reply.questionPreview,
            answerPreview: extractAnswerPreview(assistant),
            conversationUrl: location.href,
          },
        }, (response?: { status?: string; detail?: string }) => {
          const error = chrome.runtime.lastError;
          if (error) {
            console.error('[ReplyNotice/content] Sending completion message failed:', error.message);
          } else if (response?.status === 'error' || response?.status === 'permission-denied') {
            console.error('[ReplyNotice/content] Background could not create notification:', response);
          } else {
            console.debug('[ReplyNotice/content] Background completion result:', response?.status);
          }
        });
      } catch (error) {
        console.error('[ReplyNotice/content] Sending completion message threw:', error);
      }
    }

    function checkSystemNotification() {
      const now = Date.now();
      const currentRoute = location.pathname + location.search;
      const user = latest(USER_SELECTOR);
      const active = document.querySelector(ACTIVE_SELECTORS) !== null;

      if (currentRoute !== route) {
        route = currentRoute;
        if (!cycle || cycle.notified) cycle = null;
        else if (cycle.user && !cycle.user.isConnected) cycle.user = user;
        knownUser = user;
      }

      if (user !== knownUser) {
        knownUser = user;
        if (user && cycle && !cycle.notified && cycle.user !== user) {
          if (!cycle.newUserSeen && now - lastSubmitAt < 10000) {
            cycle.user = user;
            cycle.newUserSeen = true;
          } else if (active && cycle.user?.isConnected) {
            beginCycle('another user turn observed', user);
            if (cycle) cycle.newUserSeen = true;
          } else if (!cycle.user?.isConnected) {
            cycle.user = user;
          }
        }
      }

      if ((!cycle || (cycle.notified && active && user !== cycle.user)) && active) {
        beginCycle('generation activity observed', user);
        if (cycle) cycle.newUserSeen = true;
      }
      const reply = cycle;
      if (!reply || reply.notified) return;

      if (reply.user && !reply.user.isConnected) reply.user = user;
      const assistant = findResponse(reply.user);
      if (assistant !== reply.assistant) {
        reply.assistant = assistant;
        reply.signature = assistant ? responseSignature(assistant) : '';
        reply.lastContentChangeAt = now;
      } else if (assistant) {
        const signature = responseSignature(assistant);
        if (signature !== reply.signature) {
          reply.signature = signature;
          reply.lastContentChangeAt = now;
        }
      }

      if (active) {
        reply.activeSeen = true;
        reply.quietSince = null;
        return;
      }

      if (reply.quietSince === null) reply.quietSince = now;
      const quietFor = now - Math.max(reply.quietSince, reply.lastContentChangeAt);
      const hasNewResponse = reply.activeSeen || reply.newUserSeen || (!!assistant && assistant !== reply.baselineAssistant);
      const completed = hasNewResponse && !!assistant && hasCompletionAction(assistant);
      const fallback = reply.activeSeen && !!assistant && !!reply.signature.trim() && quietFor >= QUIET_FALLBACK_MS;
      if (assistant && ((completed && quietFor >= QUIET_WITH_COPY_MS) || fallback)) {
        reply.notified = true;
        console.info('[ReplyNotice/content] Final reply detected:', reply.id, completed ? 'completion action' : 'quiet fallback');
        notifyBackground(reply, assistant);
      } else if (!reply.warned && now - reply.startedAt >= DIAGNOSTIC_MS) {
        reply.warned = true;
        console.warn('[ReplyNotice/content] No confirmed reply completion yet; check ChatGPT selectors/activity:', {
          cycleId: reply.id, activeSeen: reply.activeSeen, active, assistantFound: !!assistant, completionActionFound: completed,
        });
      }
    }

    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        checkStreaming();
        checkSystemNotification();
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: ['class', 'data-testid', 'aria-busy', 'aria-label', 'data-is-streaming'],
    });

    setInterval(checkSystemNotification, POLL_MS);
    checkStreaming();
    checkSystemNotification();
  },
});
