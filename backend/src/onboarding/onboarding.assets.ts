export const ONBOARDING_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Connect your store · WCTM</title>
  <link rel="stylesheet" href="/onboarding/styles.css">
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">WCTM</p>
      <h1>Connect WooCommerce to Telegram</h1>
      <p>Complete the secure connection once, then manage your store in Telegram.</p>
    </header>

    <p id="message" class="message" role="status" aria-live="polite"></p>

    <section id="auth-step" class="card">
      <h2>1. Your account</h2>
      <div class="tabs" role="tablist" aria-label="Account action">
        <button type="button" class="tab active" data-mode="register">Register</button>
        <button type="button" class="tab" data-mode="login">Log in</button>
      </div>
      <form id="auth-form" autocomplete="on">
        <label>Email <input name="email" type="email" autocomplete="email" required></label>
        <label>Password <input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
        <button type="submit" id="auth-submit">Create account</button>
      </form>
    </section>

    <section id="tenant-step" class="card" hidden>
      <h2>2. Create your workspace</h2>
      <p>This creates your first Tenant and OWNER membership atomically.</p>
      <form id="tenant-form">
        <label>Business name <input name="name" maxlength="100" required></label>
        <button type="submit">Create workspace</button>
      </form>
    </section>

    <section id="store-step" class="card" hidden>
      <h2>3. Add your WooCommerce store</h2>
      <p>Credentials are submitted once over HTTPS and are never saved in this browser.</p>
      <form id="store-form" autocomplete="off">
        <label>Store name <input name="name" maxlength="100" required></label>
        <label>Store URL <input name="storeUrl" type="url" placeholder="https://shop.example" required></label>
        <label>Consumer key <input name="consumerKey" type="password" required></label>
        <label>Consumer secret <input name="consumerSecret" type="password" required></label>
        <button type="submit">Validate and add store</button>
      </form>
    </section>

    <section id="connector-step" class="card" hidden>
      <h2>4. Connect the WordPress plugin</h2>
      <ol class="progress">
        <li id="progress-store">Store credentials validated</li>
        <li id="progress-plugin">Plugin registration pending</li>
        <li id="progress-webhooks">Order webhooks pending</li>
        <li id="progress-health">Store health pending</li>
      </ol>
      <button type="button" id="issue-registration">Issue registration token</button>
      <div id="registration-token" class="secret" hidden>
        <p>Paste this one-time token into <strong>WooCommerce → WCTM Connector</strong>. It expires shortly.</p>
        <code id="registration-token-value"></code>
        <button type="button" data-copy="registration-token-value">Copy token</button>
      </div>
      <button type="button" id="refresh-health" class="secondary">Refresh connection status</button>
    </section>

    <section id="telegram-step" class="card" hidden>
      <h2>5. Link Telegram</h2>
      <p>Your Store is ACTIVE and its required order webhooks are verified.</p>
      <button type="button" id="issue-telegram">Create Telegram link command</button>
      <div id="telegram-token" class="secret" hidden>
        <p>Send this command to the WCTM bot in a private chat:</p>
        <code id="telegram-token-value"></code>
        <button type="button" data-copy="telegram-token-value">Copy command</button>
      </div>
    </section>
  </main>
  <script src="/onboarding/app.js" defer></script>
</body>
</html>`;

export const ONBOARDING_STYLES = `:root {
  color-scheme: light;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #172018;
  background: #f3f5f1;
}
* { box-sizing: border-box; }
body { margin: 0; }
main { width: min(680px, calc(100% - 32px)); margin: 0 auto; padding: 56px 0 80px; }
header { margin-bottom: 28px; }
h1 { margin: 6px 0 10px; font-size: clamp(2rem, 7vw, 3.5rem); line-height: 1.02; letter-spacing: -0.045em; }
h2 { margin: 0 0 16px; font-size: 1.15rem; }
p { line-height: 1.55; color: #526057; }
.eyebrow { color: #23633b; font-weight: 800; letter-spacing: .14em; font-size: .76rem; }
.card { background: #fff; border: 1px solid #dce2db; border-radius: 18px; padding: 24px; margin-top: 16px; box-shadow: 0 12px 36px rgba(31, 52, 36, .05); }
label { display: grid; gap: 7px; font-size: .88rem; font-weight: 700; margin: 14px 0; }
input { width: 100%; padding: 12px 13px; border: 1px solid #bac5ba; border-radius: 9px; font: inherit; }
input:focus { outline: 3px solid #cce8d5; border-color: #23633b; }
button { border: 0; border-radius: 9px; padding: 11px 15px; background: #23633b; color: #fff; font: inherit; font-weight: 750; cursor: pointer; }
button:disabled { opacity: .55; cursor: wait; }
button.secondary, .tabs button { background: #edf2ed; color: #27342b; }
.tabs { display: flex; gap: 8px; margin-bottom: 14px; }
.tabs button.active { background: #23633b; color: #fff; }
.message { min-height: 24px; margin: 0; font-weight: 650; color: #8d2d26; }
.message.success { color: #23633b; }
.progress { padding-left: 22px; color: #667168; line-height: 1.9; }
.progress .done { color: #23633b; font-weight: 750; }
.secret { margin-top: 16px; padding: 16px; border: 1px solid #d6ded5; border-radius: 12px; background: #f8faf7; }
code { display: block; overflow-wrap: anywhere; margin: 10px 0; padding: 12px; border-radius: 8px; background: #e8eee8; color: #172018; }
#refresh-health { margin-left: 8px; }
[hidden] { display: none !important; }
@media (max-width: 520px) { main { padding-top: 32px; } .card { padding: 19px; } #refresh-health { margin: 10px 0 0; display: block; } }
`;

export const ONBOARDING_JAVASCRIPT = `'use strict';
(() => {
  let accountToken = null;
  let tenantToken = null;
  let currentStore = null;
  let authMode = 'register';

  const byId = (id) => document.getElementById(id);
  const show = (id, visible = true) => { byId(id).hidden = !visible; };
  const message = (text, success = false) => {
    const node = byId('message');
    node.textContent = text;
    node.classList.toggle('success', success);
  };

  async function api(path, options = {}, token = tenantToken || accountToken) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await fetch('/api' + path, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer',
    });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 403 && data?.code === 'ENTITLEMENT_INACTIVE') {
        const error = new Error('Service access is inactive. Store registration and Telegram linking are unavailable; account and connection status remain available.');
        error.status = response.status;
        throw error;
      }
      const detail = Array.isArray(data?.message) ? data.message.join(' ') : data?.message;
      const error = new Error(typeof detail === 'string' ? detail : 'The request could not be completed.');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function acquireTenantContext() {
    try {
      const result = await api('/auth/tenant-context', { method: 'POST' }, accountToken);
      tenantToken = result.accessToken;
      show('auth-step', false);
      show('tenant-step', false);
      await loadStores();
    } catch (error) {
      if (error.status === 409 && error.message.includes('bootstrap')) {
        show('auth-step', false);
        show('tenant-step');
        message('Create your first workspace to continue.');
        return;
      }
      message(error.message);
    }
  }

  async function loadStores() {
    const stores = await api('/stores');
    if (stores.length === 0) {
      show('store-step');
      message('Your workspace is ready.', true);
      return;
    }
    if (stores.length !== 1) {
      message('This onboarding flow requires exactly one Store. Store selection is outside M16.');
      return;
    }
    currentStore = stores[0];
    show('store-step', false);
    show('connector-step');
    await refreshHealth();
  }

  async function refreshHealth() {
    if (!currentStore) return;
    try {
      const health = await api('/stores/' + encodeURIComponent(currentStore.id) + '/connection-health');
      byId('progress-store').classList.add('done');
      byId('progress-plugin').classList.toggle('done', health.registered);
      const usable = health.status === 'ACTIVE' && Boolean(health.lastHealthyAt);
      byId('progress-webhooks').classList.toggle('done', usable);
      byId('progress-health').classList.toggle('done', usable);
      show('telegram-step', usable);
      if (usable) {
        byId('registration-token-value').textContent = '';
        show('registration-token', false);
        message('Store connection is healthy. You can now link Telegram.', true);
      }
      else message(health.registered ? 'Plugin registered. Finish or retry webhook setup in WordPress.' : 'Issue a token and connect the WordPress plugin.');
    } catch (error) {
      message(error.message);
    }
  }

  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    authMode = tab.dataset.mode;
    document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === tab));
    byId('auth-submit').textContent = authMode === 'register' ? 'Create account' : 'Log in';
    byId('auth-form').elements.password.autocomplete = authMode === 'register' ? 'new-password' : 'current-password';
    message('');
  }));

  byId('auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = byId('auth-submit');
    const body = { email: form.elements.email.value, password: form.elements.password.value };
    form.elements.password.value = '';
    button.disabled = true;
    try {
      const result = await api('/auth/' + authMode, { method: 'POST', body }, null);
      accountToken = result.accessToken;
      message('Account authenticated.', true);
      await acquireTenantContext();
    } catch (error) { message(error.message); }
    finally { body.password = ''; button.disabled = false; }
  });

  byId('tenant-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await api('/tenants', { method: 'POST', body: { name: form.elements.name.value } }, accountToken);
      form.reset();
      await acquireTenantContext();
    } catch (error) { message(error.message); }
    finally { button.disabled = false; }
  });

  byId('store-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    const body = {
      name: form.elements.name.value,
      storeUrl: form.elements.storeUrl.value,
      consumerKey: form.elements.consumerKey.value,
      consumerSecret: form.elements.consumerSecret.value,
    };
    form.reset();
    button.disabled = true;
    message('Validating WooCommerce credentials…');
    try {
      currentStore = await api('/stores', { method: 'POST', body });
      show('store-step', false);
      show('connector-step');
      byId('progress-store').classList.add('done');
      message('Store validated. Connect the WordPress plugin.', true);
    } catch (error) { message(error.message); show('store-step'); }
    finally { body.consumerKey = ''; body.consumerSecret = ''; button.disabled = false; }
  });

  byId('issue-registration').addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      const result = await api('/stores/' + encodeURIComponent(currentStore.id) + '/registration-token', { method: 'POST' });
      byId('registration-token-value').textContent = result.token;
      show('registration-token');
      message('Registration token issued. It is shown only for copy/paste.');
    } catch (error) { message(error.message); }
    finally { event.currentTarget.disabled = false; }
  });

  byId('refresh-health').addEventListener('click', refreshHealth);

  byId('issue-telegram').addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      await refreshHealth();
      const result = await api('/internal/telegram/link-tokens', { method: 'POST' });
      byId('telegram-token-value').textContent = '/start ' + result.token;
      show('telegram-token');
      message('Telegram link command created.', true);
    } catch (error) { message(error.message); }
    finally { event.currentTarget.disabled = false; }
  });

  document.querySelectorAll('[data-copy]').forEach((button) => button.addEventListener('click', async () => {
    const value = byId(button.dataset.copy).textContent;
    try { await navigator.clipboard.writeText(value); message('Copied.', true); }
    catch { message('Copy was unavailable. Select the value manually.'); }
  }));
})();`;
