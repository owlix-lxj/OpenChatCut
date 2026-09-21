// Profile endpoint used by the creator center; not the OAuth/open-platform API.
// Reference: https://multipost.app/docs/en/development/douyin-account
export const DOUYIN_ACCOUNT_URL = 'https://creator.douyin.com/web/api/media/user/info/';

export async function readDouyinAccount(request = fetch) {
  try {
    const response = await request(DOUYIN_ACCOUNT_URL, {
      method: 'GET', credentials: 'include', redirect: 'error',
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000),
    });
    if (response.status === 401) return { isAuthenticated: false, verified: true };
    if (!response.ok) throw new Error('profile unavailable');
    const raw = await response.text();
    if (raw.length > 1024 * 1024) throw new Error('profile too large');
    const data = JSON.parse(raw);
    // A cookie, a redirect, an empty object or an error response is not proof of login.
    const user = data?.user;
    if ((data?.status_code !== undefined && data.status_code !== 0)
      || !user || !(typeof user.sec_uid === 'string' && user.sec_uid.trim()
        || typeof user.uid === 'string' && user.uid.trim())) throw new Error('profile not verified');
    const username = typeof user.nickname === 'string'
      ? user.nickname.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) : '';
    if (!username) throw new Error('nickname missing');
    // Do not send cookies, identifiers or the complete platform response to the renderer.
    return { isAuthenticated: true, verified: true, username };
  } catch {
    return { isAuthenticated: false, verified: false, error: '账号资料暂未获取，请打开平台核对或刷新；不代表已退出登录。' };
  }
}
