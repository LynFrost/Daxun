import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: '答讯 · ReplyNotice',
    version: '2.0.6',
    description: 'A Chrome extension that notifies you when ChatGPT has finished processing your request.',
    permissions: ['storage', 'notifications'],
    host_permissions: ['https://ntfy.sh/*'],
    minimum_chrome_version: '116',
    icons: {
      '128': '/logo.png',
    },
    web_accessible_resources: [
      {
        resources: ['notification.mp3'],
        matches: ['https://chatgpt.com/*'],
      },
    ],
  },
});
