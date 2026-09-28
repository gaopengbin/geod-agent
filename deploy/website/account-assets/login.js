export function safeReturnTo(raw, origin) {
  if (!raw || !/^\/(?!\/)/.test(raw) || raw.includes("\\") || /[\u0000-\u001f]/.test(raw)) return "/dashboard";
  try {
    const target = new URL(raw, origin);
    return target.origin === origin ? target.pathname + target.search + target.hash : "/dashboard";
  } catch { return "/dashboard"; }
}

const errors = {
  INVALID_EMAIL: "请输入有效的邮箱地址。",
  INVALID_PASSWORD: "密码格式不正确，新账号密码需要 12–128 个字符。",
  INVALID_CREDENTIALS: "邮箱或密码不正确，请检查后重试。",
  INVITE_INVALID: "邀请码无效、已过期或与邮箱不符。",
  LOGIN_RATE_LIMIT: "尝试次数过多，请在 15 分钟后再试。",
  ORIGIN_REJECTED: "账号请求被拒绝，请从 GeoD 官网重新打开登录页。",
  AUTH_NOT_CONFIGURED: "账号服务尚未配置完成，请联系支持。",
  ACCOUNT_BUSY: "账号服务暂时繁忙，请稍后重试。",
};
export function accountErrorText(code) { return errors[code] || "暂时无法完成操作，请稍后重试。"; }

function initialize() {
  const form = document.getElementById("account-form");
  const email = document.getElementById("account-email");
  const password = document.getElementById("account-password");
  const invite = document.getElementById("account-invite");
  const inviteField = document.getElementById("invite-field");
  const submitButton = document.getElementById("submit-button");
  const submitLabel = document.getElementById("submit-label");
  const error = document.getElementById("form-error");
  const title = document.getElementById("form-title");
  const summary = document.getElementById("form-summary");
  const tabs = [document.getElementById("tab-login"), document.getElementById("tab-register")];
  let mode = "login";
  let busy = false;

  function setError(message) { error.textContent = message; error.hidden = !message; }
  function setBusy(next) {
    busy = next;
    for (const control of [email, password, invite, submitButton, ...tabs]) control.disabled = next;
    submitLabel.textContent = next ? "正在处理…" : mode === "login" ? "登录" : "创建账号";
  }
  function setMode(next) {
    if (busy || next === mode) return;
    mode = next; setError(""); password.value = "";
    inviteField.hidden = next !== "register";
    invite.required = next === "register";
    password.autocomplete = next === "register" ? "new-password" : "current-password";
    title.textContent = next === "login" ? "登录 GeoD" : "加入 GeoD";
    summary.textContent = next === "login" ? "使用你的 GeoD 账号继续。" : "使用受邀邮箱和邀请码创建 GeoD 账号。";
    submitLabel.textContent = next === "login" ? "登录" : "创建账号";
    tabs.forEach((tab, index) => {
      const selected = (index === 0 ? "login" : "register") === next;
      tab.classList.toggle("active", selected);
      tab.setAttribute("aria-selected", String(selected));
    });
  }
  tabs[0].addEventListener("click", () => setMode("login"));
  tabs[1].addEventListener("click", () => setMode("register"));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy) return;
    setError("");
    const address = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) { setError("请输入有效的邮箱地址。"); email.focus(); return; }
    if (!password.value || password.value.length > 128 || (mode === "register" && password.value.length < 12)) {
      setError(mode === "register" ? "新账号密码需要 12–128 个字符。" : "请输入密码。"); password.focus(); return;
    }
    if (mode === "register" && !invite.value.trim()) { setError("请输入此邮箱对应的邀请码。"); invite.focus(); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/account/${mode}`, {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: address, password: password.value, ...(mode === "register" ? { inviteCode: invite.value.trim() } : {}) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(accountErrorText(result?.error?.code));
      const requested = new URLSearchParams(window.location.search).get("returnTo");
      window.location.assign(safeReturnTo(requested, window.location.origin));
    } catch (cause) {
      setError(cause instanceof Error && errorsFromMessage(cause.message) ? cause.message : "账号服务暂时不可用，请稍后重试。");
      setBusy(false);
    }
  });
}

function errorsFromMessage(message) { return Object.values(errors).includes(message) || message === "暂时无法完成操作，请稍后重试。"; }
if (typeof document !== "undefined") initialize();
