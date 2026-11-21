// 隨筆花園：雲端傳輸深模組（封裝單一 POST text/plain 免預檢請求、永不過期 Session 與 AUTH_INVALID 通知）

export const SESSION_STORAGE_KEY = 'essay_garden_session_v1';

export class CloudClient {
  constructor({
    gasWebAppUrl,
    storage = globalThis.localStorage,
    fetchImpl = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null,
    onAuthInvalid = null,
    onServerTime = null
  } = {}) {
    if (!gasWebAppUrl || typeof gasWebAppUrl !== 'string') {
      throw new Error('CloudClient requires a valid gasWebAppUrl');
    }
    if (!fetchImpl) {
      throw new Error('CloudClient requires a fetch implementation');
    }
    this.gasWebAppUrl = gasWebAppUrl.trim();
    this.storage = storage;
    this.fetchImpl = fetchImpl;
    this.onAuthInvalid = onAuthInvalid;
    this.onServerTime = onServerTime;
  }

  getSessionToken() {
    if (!this.storage) return '';
    return String(this.storage.getItem(SESSION_STORAGE_KEY) || '').trim();
  }

  setSessionToken(token) {
    if (!this.storage) return;
    const cleaned = String(token || '').trim();
    if (cleaned) {
      this.storage.setItem(SESSION_STORAGE_KEY, cleaned);
    } else {
      this.storage.removeItem(SESSION_STORAGE_KEY);
    }
  }

  clearSessionToken() {
    if (!this.storage) return;
    this.storage.removeItem(SESSION_STORAGE_KEY);
  }

  hasSession() {
    return Boolean(this.getSessionToken());
  }

  async request(action, payload = {}, options = {}) {
    const authToken = options.authToken !== undefined ? String(options.authToken || '') : this.getSessionToken();
    const body = JSON.stringify({
      action,
      authToken,
      payload: payload || {}
    });

    let response;
    try {
      response = await this.fetchImpl(this.gasWebAppUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8'
        },
        body
      });
    } catch (networkErr) {
      const err = new Error('網路連線異常，請檢查網路狀態後再試');
      err.code = 'NETWORK_ERROR';
      err.cause = networkErr;
      throw err;
    }

    if (!response || !response.ok) {
      const err = new Error(`雲端伺服器回應異常 (HTTP ${response ? response.status : 'ERR'})`);
      err.code = 'HTTP_ERROR';
      throw err;
    }

    let parsed;
    try {
      const text = await response.text();
      parsed = JSON.parse(text);
    } catch (parseErr) {
      const err = new Error('雲端伺服器回應格式無法解析');
      err.code = 'PARSE_ERROR';
      err.cause = parseErr;
      throw err;
    }

    if (typeof parsed?.serverTimeMs === 'number' && Number.isFinite(parsed.serverTimeMs)) {
      if (typeof this.onServerTime === 'function') {
        this.onServerTime(parsed.serverTimeMs);
      }
    }

    if (!parsed || parsed.ok !== true) {
      const err = new Error(parsed?.message || '雲端操作失敗');
      err.code = parsed?.code || 'UNKNOWN_ERROR';
      if (err.code === 'AUTH_INVALID' && action !== 'auth') {
        this.clearSessionToken();
        if (typeof this.onAuthInvalid === 'function') {
          this.onAuthInvalid(err);
        }
      }
      throw err;
    }

    return parsed.data;
  }

  // 開啟寫作彈窗時背景靜默預熱 GAS 實例（失敗不拋錯、不打斷輸入）
  async ping() {
    try {
      return await this.request('ping', {}, { authToken: '' });
    } catch (_err) {
      return { pong: false };
    }
  }
}
