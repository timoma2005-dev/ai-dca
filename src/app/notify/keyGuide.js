/** 通知渠道「怎么拿 Key」看图教程（图片在 public/notify-guide/，来自产品介绍文档）。 */
export const BARK_APP_STORE_URL = 'https://apps.apple.com/cn/app/id1403753865';
export const SERVERCHAN3_ANDROID_URL = 'https://sc3.ft07.com/client';
export const SERVERCHAN3_SENDKEY_URL = 'https://sc3.ft07.com/sendkey';

export const NOTIFY_KEY_GUIDE_EVENT = 'notify-key-guide:open';

export const NOTIFY_KEY_GUIDES = {
  ios: {
    trigger: '怎么拿 Bark 链接？看图教程',
    title: 'Bark 接通教程（iPhone）',
    description: '三步搞定，大约 1 分钟。',
    steps: [
      {
        title: '安装 Bark',
        body: '在 App Store 搜「Bark - 给你的手机发推送」，红色图标那个，免费。',
        link: { label: '去 App Store 下载 Bark', href: BARK_APP_STORE_URL },
        image: '/notify-guide/bark-1.webp'
      },
      {
        title: '复制推送链接',
        body: '打开 Bark，首页「使用示例」里有一条 https://api.day.app/… 的链接，点「复制」，整段粘贴到输入框就行（会自动提取 Device Key）。',
        image: '/notify-guide/bark-2.webp'
      },
      { title: '发送测试，再保存', body: '点「发送测试」，iPhone 收到推送后点「保存并连接」。' }
    ]
  },
  serverchan3: {
    trigger: '怎么拿 UID 和 SendKey？看图教程',
    title: 'Server酱³ 接通教程（安卓）',
    description: '安卓推送通过 Server酱³ 转发，四步搞定。',
    steps: [
      {
        title: '安装 Server酱³ App',
        body: '小米、华为、荣耀、vivo、OPPO 等手机支持系统级推送，App 不用常驻后台。',
        link: { label: '安卓客户端下载', href: SERVERCHAN3_ANDROID_URL },
        image: '/notify-guide/sc3-1.webp'
      },
      {
        title: '打开 App，点「扫码以获取 SendKey」',
        image: '/notify-guide/sc3-2.webp'
      },
      {
        title: '扫码登录，拿到 SendKey 和 UID',
        body: '在电脑上打开 SendKey 页面，右上角微信登录，再用 App 扫页面上的二维码。页面里红框的 SendKey 和 UID 就是要填的。',
        link: { label: '打开 SendKey 页面', href: SERVERCHAN3_SENDKEY_URL },
        image: '/notify-guide/sc3-3.webp'
      },
      {
        title: '发送测试，再保存',
        body: '填好后点「发送测试」，手机收到这样的消息就接通了，再点「保存并连接」。',
        image: '/notify-guide/sc3-4.webp'
      }
    ]
  }
};

/** 从任意地方（比如教程气泡）打开某个渠道的看图教程。 */
export function openNotifyKeyGuide(channel) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(NOTIFY_KEY_GUIDE_EVENT, { detail: { channel } }));
}

/** 看图教程弹窗开 / 关（新手入门气泡据此收起 / 恢复）。 */
export const NOTIFY_KEY_GUIDE_STATE_EVENT = 'notify-key-guide:state';
export function setNotifyKeyGuideOpen(open) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(NOTIFY_KEY_GUIDE_STATE_EVENT, { detail: { open: Boolean(open) } }));
}
