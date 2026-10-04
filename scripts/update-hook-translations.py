"""Maintain the source-message catalogue for plugin lifecycle automation."""
import json
from pathlib import Path

path=Path('apps/geod-agent-desktop/src/locales/en.json')
values=json.loads(path.read_text(encoding='utf-8'))
values.update({
    '会话开始':'Session started','会话结束':'Session ended','提交消息':'Message submitted',
    '工具执行前':'Before tool execution','请求权限时':'Permission requested','工具执行后':'After tool execution',
    '压缩上下文前':'Before context compaction','压缩上下文后':'After context compaction',
    '子任务开始':'Subagent started','子任务结束':'Subagent stopped','回复结束':'Response finished','中断回复':'Response interrupted',
    '插件自动化':'Plugin automation','同步运行':'Run synchronously','后台运行':'Run in background',
    '匹配：{0}':'Match: {0}','适用于此事件的每次调用':'Run whenever this event occurs','超时 {0} 秒':'Timeout: {0} seconds',
    '自动化操作 {0} 项':'{0} automation actions','启用自动化':'Enable automation','停用自动化':'Disable automation',
    '自动化 {0}/{1}':'Automation {0}/{1}',
    '我已审阅这些自动化命令，允许随会话运行':'I have reviewed these commands and allow them to run with conversations',
    '这些命令会在对应事件发生时由本机自动执行。资源变更后需重新导入并审阅；可随时停用。':'These commands run locally when the corresponding event occurs. Reimport and review changed resources. You can disable automation at any time.',
    '未勾选时，自动化保持停用，可稍后审阅启用。':'Automation stays disabled until reviewed. You can enable it later.',
    '后台自动化已启动 · {0}':'Background automation started · {0}',
    '自动化 · {0}':'Automation · {0}',
    '自动化配置须为对象或包内文件路径':'Automation must be an object or a path within the package',
    '自动化配置包含尚未支持的字段':'The automation configuration contains unsupported fields',
    '自动化配置缺少 hooks 对象':'The automation configuration is missing its hooks object',
    '自动化事件不属于当前 Codex 引擎支持的生命周期':'The event is not supported by the bundled Codex engine',
    '自动化事件须包含匹配组数组':'Each event must contain an array of matching groups',
    '自动化匹配组须为对象':'Each matching group must be an object',
    '自动化匹配组包含尚未支持的字段':'The matching group contains unsupported fields',
    '自动化 matcher 须为字符串':'The automation matcher must be a string',
    '自动化匹配组缺少 hooks 数组':'The matching group is missing its hooks array',
    '自动化操作须为对象':'Each automation action must be an object',
    '当前插件自动化支持 command；MCP、prompt 和 agent Handler 尚未接入':'Plugin automation supports command handlers. MCP, prompt and agent handlers are not yet integrated.',
    '自动化命令包含尚未支持的字段':'The command contains unsupported fields',
    '自动化命令不能为空或包含无效字符':'The command cannot be empty or contain invalid characters',
    '自动化命令和提示文字须为字符串':'Commands and status messages must be strings',
    '自动化时间和内容限制须为非负整数':'Timeouts and content limits must be nonnegative integers',
    '自动化 async 须为布尔值':'The async setting must be a boolean',
    '已安装插件的资源目录不可读':'Unable to read the installed plugin resources',
    '插件资源已变化，请重新导入后审阅自动化':'The plugin resources changed. Reimport and review the automation.',
    '无法准备插件自动化数据目录':'Unable to prepare the automation data directory',
    '插件已停用，自动化数据清理失败':'The plugin is disabled, but its automation data could not be removed',
    '插件保存位置不可读':'Unable to read the plugin storage location',
    '插件保存位置越出了应用保存范围':'The plugin storage location is outside application storage',
    '此插件包含尚未接入的注册 App 映射；当前支持 Skill、HTTP/stdio MCP 与命令自动化':'This plugin includes an app mapping that is not yet integrated. Skills, HTTP/stdio MCP and command automation are supported.',
    '插件自动化配置未被配套引擎完整识别':'The bundled engine did not fully recognize the plugin automation configuration',
})
path.write_text(json.dumps(values,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'translationEntries':len(values)}))
