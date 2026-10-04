from pathlib import Path
import json

path = Path('apps/geod-agent-desktop/src/locales/en.json')
catalogue = json.loads(path.read_text(encoding='utf-8'))
catalogue.update({
    '在浏览器中继续': 'Continue in your browser',
    '无效的浏览器地址': 'Invalid browser address',
    '将在系统浏览器中打开。完成后返回对话，是否成功以连接器结果为准。': 'This opens in your default browser. Return here when finished; the connector will report the result.',
    '仅支持 HTTPS 或本机 HTTP 地址，无法打开此页面。': 'Only HTTPS or local HTTP addresses can be opened.',
    '此连接器需要身份验证，当前客户端尚未支持此请求。': 'This connector requires an identity verification flow that this client does not yet support.',
    '正在打开…': 'Opening…',
    '打开浏览器继续': 'Open browser to continue',
    '连接器返回了无效的浏览器地址': 'The connector returned an invalid browser address.',
    '浏览器流程仅支持 HTTPS 或本机 HTTP 地址': 'Browser flows support HTTPS or local HTTP addresses only.',
    '此授权请求已失效': 'This authorization request is no longer active.',
    '请先打开连接器的浏览器页面': "Open the connector's browser page first.",
    '无法打开系统浏览器，请重试': 'Unable to open your default browser. Please try again.',
    '连接器回复格式无效': 'The connector response has an invalid format.',
    '此连接器请求已失效': 'This connector request is no longer active.',
    '连接器需要在前台对话中完成授权，请打开会话继续': 'The connector needs authorization in a foreground conversation. Open the conversation to continue.',
    '原会话还没有可分支的引擎记录': 'The original conversation has no engine history to fork yet.',
    '原会话的历史文件已无法读取': "The original conversation's history file cannot be read.",
    '目标分支已包含引擎记录，请创建新分支': 'The target branch already has engine history. Create a new branch.',
    '目标分支已包含历史文件，请创建新分支': 'The target branch already has a history file. Create a new branch.',
    '原会话正在执行，请等回复结束后再创建分支': 'The original conversation is running. Wait for its reply before creating a branch.',
    '应用正在准备更新，请稍后发送。': 'The application is preparing an update. Please send your message later.',
})
path.write_text(json.dumps(catalogue, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'Browser flow translations saved ({len(catalogue)} entries).')
