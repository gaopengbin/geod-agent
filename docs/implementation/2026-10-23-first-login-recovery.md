# 首次登录授权超时与恢复

## 已确认的问题与证据边界

- 修复前桌面 OAuth 回调监听只等待 120 秒。首次注册需完成邮箱验证码、密码设置及浏览器授权，可能超过这一窗口。
- 原来的“重新检查登录状态”只读取本地授权，不会建立新的回调入口；等待中也没有重新发起授权的操作。
- 线上只读检查：未登录访问有效的 `/api/geod/oauth/authorize` 请求返回 303 到 `/login`，完整保留 `returnTo`。线上登录页的注册、登录提交也使用该返回地址。未发现这一步丢失参数。
- 未取得反馈用户的完整操作时间及回调日志，因此不能把所有首次登录失败都归结于这个原因。

## 修复

- 桌面回调等待延长至 10 分钟，满足首次注册流程的正常耗时；超时仍释放监听入口，并提示直接重新登录，无需重启。
- 等待页保留状态检查，另提供“重新发起授权”。该操作通过原生 `auth_begin(restart: true)` 替换当前授权，创建新的回调端口、state 和 PKCE verifier。
- 每次授权分配独立 generation。旧流程的准备失败、回调超时及迟到的 token 响应不能更改新流程的状态或凭据；替换后的旧监听线程退出。
- 凭据写入与流程替换通过同一流程锁串行处理，仍保留账号凭据锁和进程间锁。
- 若点击重试前旧授权已经成功，直接采用已保存的有效账号，不要求退出再登录。
- 等待中返回应用焦点时立即检查状态，继续保留轮询兜底。登录页使用原有按钮组件及样式。

## 验证

1. 原生服务相关测试：23 项通过；其中新增覆盖同进程超时后重新授权、旧请求失败/超时不影响新流程、迟到 token 响应不覆盖新账号。原有授权并发保护、凭据刷新和隔离测试保持通过。
2. 单独执行真实耗时回归 `first_registration_callback_after_two_minutes_still_connects`：实际等待 125 秒后发送回调，真实本机 HTTP token 交换及 Windows 凭据写入成功，用时 125.13 秒。
3. 真实 App 组件及账号控制器的浏览器交互回归：16 项通过，无页面错误。覆盖等待中重试、连续点击防重复、超时后无需重新加载页面即可进入工作区、已保存登录、错误恢复、头像/账号切换，以及窄屏和英文布局。
4. `npm run build` 通过；保留现有大资源包提示。`git diff --check` 通过。

原生回归使用独立 loopback 身份服务和独立 Windows 凭据条目，结束时删除测试凭据。UI 回归使用隔离的原生接口响应；两者不创建线上账号、不发送验证码、不调用模型、不上传运营埋点。因此不是对线上真实邮箱注册全流程的验收。

## 复跑

在仓库根目录执行：

```powershell
rtk proxy cargo test --manifest-path apps/geod-agent-desktop/src-tauri/Cargo.toml --lib services:: -- --test-threads=1
rtk proxy cargo test --manifest-path apps/geod-agent-desktop/src-tauri/Cargo.toml --lib services::auth_recovery_tests::first_registration_callback_after_two_minutes_still_connects -- --ignored --exact --nocapture
```

在 `apps/geod-agent-desktop` 启动 Vite 后执行：

```powershell
rtk proxy node test/login-screen-ui.mjs
rtk proxy npm run build
```

UI 记录和截图：`artifacts/login-recovery-20261023/`。

修复在本地源码，尚未发布到线上安装包。本次无需修改注册服务或线上账号数据。
