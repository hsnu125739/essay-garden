// 隨筆花園：雲端傳輸深模組（封裝單一 POST text/plain 免預檢請求、逾時中止、永不過期 Session 與 AUTH_INVALID 通知）

export const SESSION_STORAGE_KEY = 'essay_garden_session_v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 25000;

function createClientError(message, code, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause !== undefined) err.cause = cause;
  return err;
}

function mapAbortOrError(cause, timedOut, fallbackMessage, fallbackCode) {
  if (timedOut || cause?.name === 'AbortError') {
    return createClientError('雲端伺服器連線逾時，請稍後再試', 'TIMEOUT_ERROR', cause);
  }
  return createClientError(fallbackMessage, fallbackCode, cause);
}

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

    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timeoutId = null;
    let timedOut = false;
    let timeoutPromise = null;

    if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          if (controller) controller.abort();
          const abortErr = new Error('雲端伺服器連線逾時，請稍後再試');
          abortErr.name = 'AbortError';
          reject(abortErr);
        }, timeoutMs);
      });
    }
    const withTimeout = (promise) => (timeoutPromise ? Promise.race([promise, timeoutPromise]) : promise);

    let parsed;
    try {
      let response;
      try {
        const fetchInit = {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain;charset=utf-8'
          },
          body
        };
        if (controller) {
          fetchInit.signal = controller.signal;
        }
        response = await withTimeout(this.fetchImpl(this.gasWebAppUrl, fetchInit));
      } catch (networkErr) {
        throw mapAbortOrError(networkErr, timedOut, '網路連線異常，請檢查網路狀態後再試', 'NETWORK_ERROR');
      }

      if (!response || !response.ok) {
        throw createClientError(`雲端伺服器回應異常 (HTTP ${response ? response.status : 'ERR'})`, 'HTTP_ERROR');
      }

      try {
        const text = await withTimeout(response.text());
        parsed = JSON.parse(text);
      } catch (parseErr) {
        throw mapAbortOrError(parseErr, timedOut, '雲端伺服器回應格式無法解析', 'PARSE_ERROR');
      }
    } finally {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    }

    if (typeof parsed?.serverTimeMs === 'number' && Number.isFinite(parsed.serverTimeMs)) {
      if (typeof this.onServerTime === 'function') {
        this.onServerTime(parsed.serverTimeMs);
      }
    }

    if (!parsed || parsed.ok !== true) {
      const err = createClientError(parsed?.message || '雲端操作失敗', parsed?.code || 'UNKNOWN_ERROR');
      if (err.code === 'AUTH_INVALID' && action !== 'auth' && action !== 'logout') {
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
