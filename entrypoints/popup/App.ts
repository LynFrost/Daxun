import { SYNC_KEYS, newRandomTopic, validDeviceName, validTopic } from '@/lib/ntfySync';
import { SOUNDS, playTone } from '@/lib/sounds';

document.addEventListener('DOMContentLoaded', () => {
  const slider = document.getElementById('volumeSlider') as HTMLInputElement;
  const valueDisplay = document.getElementById('volumeValue')!;
  const systemNotifyToggle = document.getElementById('systemNotifyToggle') as HTMLInputElement;
  const previewToggle = document.getElementById('qaPreviewToggle') as HTMLInputElement;
  const soundList = document.getElementById('soundList')!;
  const VOLUME_STORAGE_KEY = 'chatgpt_notifier_volume';
  const SYSTEM_NOTIFICATION_KEY = 'chatgpt_notifier_system_notification_enabled';
  const PREVIEW_KEY = 'chatgpt_notifier_qa_preview_enabled';
  const SOUND_STORAGE_KEY = 'chatgpt_notifier_sound_id';
  const SOUND_COLLAPSED_KEY = 'chatgpt_notifier_sound_collapsed';

  const defaultAudio = new Audio(chrome.runtime.getURL('notification.mp3'));

  // Set version from manifest
  const versionLabel = document.getElementById('versionLabel')!;
  versionLabel.textContent = `v${chrome.runtime.getManifest().version}`;

  // --- Sound collapsible ---
  const soundHeader = document.getElementById('soundHeader')!;
  const soundChevron = document.getElementById('soundChevron')!;

  function setSoundOpen(open: boolean) {
    soundList.classList.toggle('collapsed', !open);
    soundChevron.classList.toggle('open', open);
  }

  soundHeader.addEventListener('click', () => {
    const collapsed = soundList.classList.contains('collapsed');
    setSoundOpen(collapsed);
    chrome.storage.local.set({ [SOUND_COLLAPSED_KEY]: collapsed });
  });

  // --- Sound list ---
  let activeSoundId = 'default';

  function preview(soundId: string) {
    const vol = parseFloat(slider.value);
    const sound = SOUNDS.find((s) => s.id === soundId)!;
    if (sound.freqs.length > 0) {
      playTone(sound.freqs, vol, sound.type);
    } else {
      defaultAudio.volume = vol;
      defaultAudio.currentTime = 0;
      defaultAudio.play().catch(() => {});
    }
  }

  function renderSoundList() {
    soundList.innerHTML = '';
    SOUNDS.forEach((sound) => {
      const item = document.createElement('div');
      item.className = `sound-item${sound.id === activeSoundId ? ' active' : ''}`;

      item.innerHTML = `<span class="sound-dot"></span><span class="sound-name">${sound.name}</span>`;

      item.addEventListener('click', () => {
        activeSoundId = sound.id;
        chrome.storage.local.set({ [SOUND_STORAGE_KEY]: sound.id });
        renderSoundList();
        preview(sound.id);
      });

      soundList.appendChild(item);
    });
  }

  // --- Volume ---
  function updateDisplay(val: number) {
    valueDisplay.textContent = String(Math.round(val * 100));
  }

  function updateSliderBackground(target: HTMLInputElement) {
    const val = parseFloat(target.value);
    const percentage = val * 100;
    target.style.background = `linear-gradient(to right, #343541 ${percentage}%, #ececf1 ${percentage}%)`;
  }

  slider.addEventListener('change', () => {
    defaultAudio.volume = parseFloat(slider.value);
    preview(activeSoundId);
  });

  chrome.storage.local.get(
    [VOLUME_STORAGE_KEY, SYSTEM_NOTIFICATION_KEY, PREVIEW_KEY, SOUND_STORAGE_KEY, SOUND_COLLAPSED_KEY],
    (result) => {
      let vol: number = result[VOLUME_STORAGE_KEY] as number;
      if (typeof vol !== 'number') vol = 0.5;
      slider.value = String(vol);
      defaultAudio.volume = vol;
      updateDisplay(vol);
      updateSliderBackground(slider);

      systemNotifyToggle.checked = result[SYSTEM_NOTIFICATION_KEY] === true;
      previewToggle.checked = result[PREVIEW_KEY] === true; // default off for privacy

      activeSoundId = (result[SOUND_STORAGE_KEY] as string) || 'default';
      setSoundOpen(result[SOUND_COLLAPSED_KEY] !== false);
      renderSoundList();
    },
  );

  slider.addEventListener('input', (e) => {
    const val = parseFloat((e.target as HTMLInputElement).value);
    updateDisplay(val);
    updateSliderBackground(e.target as HTMLInputElement);
    chrome.storage.local.set({ [VOLUME_STORAGE_KEY]: val });
  });

  systemNotifyToggle.addEventListener('change', (e) => {
    chrome.storage.local.set({
      [SYSTEM_NOTIFICATION_KEY]: (e.target as HTMLInputElement).checked,
    });
  });

  previewToggle.addEventListener('change', (e) => {
    chrome.storage.local.set({
      [PREVIEW_KEY]: (e.target as HTMLInputElement).checked,
    });
  });

  // Cross-computer sync settings are local-only (never chrome.storage.sync).
  const syncSend = document.getElementById('syncSendToggle') as HTMLInputElement;
  const syncReceive = document.getElementById('syncReceiveToggle') as HTMLInputElement;
  const syncPreview = document.getElementById('syncPreviewToggle') as HTMLInputElement;
  const syncTopic = document.getElementById('syncTopicInput') as HTMLInputElement;
  const syncName = document.getElementById('syncNameInput') as HTMLInputElement;
  const syncGenerate = document.getElementById('syncGenerateTopic') as HTMLButtonElement;
  const syncTest = document.getElementById('syncTestButton') as HTMLButtonElement;
  const syncStatus = document.getElementById('syncStatus')!;
  let statusTimer: ReturnType<typeof setInterval> | undefined;

  function report(message: string) { syncStatus.textContent = message; }

  function validateConfig(): boolean {
    if (!validTopic(syncTopic.value.trim()) || !validDeviceName(syncName.value.trim())) {
      report('请设置有效设备名称及至少22位的随机主题；建议使用“生成随机主题”。');
      return false;
    }
    return true;
  }

  function saveText() {
    const topic = syncTopic.value.trim();
    const name = syncName.value.trim();
    chrome.storage.local.set({ [SYNC_KEYS.topic]: topic, [SYNC_KEYS.deviceName]: name }, () => {
      if (chrome.runtime.lastError) report('保存设置失败');
      else if (syncSend.checked || syncReceive.checked) validateConfig();
    });
  }

  chrome.storage.local.get(Object.values(SYNC_KEYS), (stored) => {
    syncSend.checked = stored[SYNC_KEYS.send] === true;
    syncReceive.checked = stored[SYNC_KEYS.receive] === true;
    syncPreview.checked = stored[SYNC_KEYS.sharePreview] === true;
    syncTopic.value = typeof stored[SYNC_KEYS.topic] === 'string' ? stored[SYNC_KEYS.topic] : '';
    syncName.value = typeof stored[SYNC_KEYS.deviceName] === 'string' ? stored[SYNC_KEYS.deviceName] : '';
    if (syncSend.checked || syncReceive.checked) validateConfig();
    else report('跨电脑同步已关闭');
    updateConnectionStatus();
  });

  syncSend.addEventListener('change', () => {
    if (syncSend.checked && !validateConfig()) {
      syncSend.checked = false;
      return;
    }
    chrome.storage.local.set({ [SYNC_KEYS.send]: syncSend.checked });
  });

  syncReceive.addEventListener('change', () => {
    if (syncReceive.checked && !validateConfig()) {
      syncReceive.checked = false;
      return;
    }
    chrome.storage.local.set({ [SYNC_KEYS.receive]: syncReceive.checked });
    updateConnectionStatus();
  });

  syncPreview.addEventListener('change', () => {
    chrome.storage.local.set({ [SYNC_KEYS.sharePreview]: syncPreview.checked });
  });

  syncTopic.addEventListener('change', saveText);
  syncName.addEventListener('change', saveText);
  syncGenerate.addEventListener('click', () => {
    syncTopic.value = newRandomTopic();
    saveText();
    report('已生成本机随机主题；请将它手动复制到其他电脑（不要公开分享）。');
  });

  function updateConnectionStatus() {
    chrome.runtime.sendMessage({ type: 'REPLYNOTICE_SYNC_STATUS' },
      (response?: { status?: string; connection?: { state?: string; detail?: string } }) => {
        if (chrome.runtime.lastError || !response?.connection) return;
        const state = response.connection.state;
        const labels: Record<string, string> = {
          disabled: '接收关闭',
          'invalid-config': '配置无效',
          connecting: '正在连接',
          connected: '接收已连接',
          reconnecting: '连接中断，正在重试',
        };
        report((labels[state || ''] || '状态未知') + (response.connection.detail ? '：' + response.connection.detail : ''));
      });
  }

  syncTest.addEventListener('click', () => {
    if (!syncSend.checked || !validateConfig()) {
      report('先开启发送并配置设备名称与主题');
      return;
    }
    syncTest.disabled = true;
    report('正在向 ntfy 发送测试消息…');
    chrome.runtime.sendMessage({ type: 'REPLYNOTICE_SYNC_TEST' },
      (response?: { status?: string; detail?: string }) => {
        syncTest.disabled = false;
        if (chrome.runtime.lastError) {
          report('发送失败：后台连接不可用');
        } else {
          report(response?.status === 'sent' ? '测试消息已发布（请检查其他电脑）' :
            '发送失败：' + (response?.detail || response?.status || '未知错误'));
        }
      });
  });

  statusTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && syncReceive.checked) updateConnectionStatus();
  }, 5000);
  window.addEventListener('unload', () => {
    if (statusTimer) clearInterval(statusTimer);
  });

});
