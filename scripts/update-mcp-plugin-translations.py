from pathlib import Path
import json

path = Path('apps/geod-agent-desktop/src/locales/en.json')
strings = json.loads(path.read_text(encoding='utf-8'))
strings.update({
    '继承变量': 'Inherited variables',
    '认证变量': 'Authentication variables',
    '超时设置': 'Timeouts',
    '启动 {0} 秒 · 调用 {1} 秒': 'Startup {0} s · Calls {1} s',
    '可用工具': 'Available tools',
    '排除工具': 'Excluded tools',
    '默认停用': 'Disabled by default',
    'MCP 超时须为正数秒': 'MCP timeouts must be positive numbers of seconds',
    'MCP 超时须为有效的正数秒': 'MCP timeouts must be valid positive numbers of seconds',
    'MCP 环境变量引用名称无效': 'Invalid MCP environment variable reference',
    'MCP startup_timeout_ms 须为正整数': 'MCP startup_timeout_ms must be a positive integer',
    'MCP env_vars 须为数组': 'MCP env_vars must be an array',
    'MCP env_vars 须包含名称或本机来源对象': 'MCP env_vars must contain names or local source objects',
    'MCP 环境变量引用含未知字段': 'MCP environment variable reference contains an unknown field',
    '此桌面应用仅支持本机环境变量来源': 'This desktop app supports local environment variable sources',
    'MCP 环境变量引用缺少名称': 'MCP environment variable reference is missing its name',
    'MCP 运行配置类型无效': 'Invalid MCP runtime configuration type',
    'MCP 工作目录无效': 'Invalid MCP working directory',
    'MCP 环境变量引用过多': 'Too many MCP environment variable references',
    '本机 MCP 不使用 HTTP 认证变量': 'Local MCP does not use HTTP authentication variables',
    'HTTP MCP 不使用工作目录或本机环境变量列表': 'HTTP MCP does not use working directories or process environment lists',
    'MCP 工具筛选列表无效': 'Invalid MCP tool filter',
    'MCP 工作目录不存在，请检查插件配置': 'The MCP working directory does not exist; check the plugin configuration',
    'MCP 需要本机环境变量 {0}，请配置后重新启动应用': 'MCP needs local environment variable {0}; set it and restart the app',
    '此工具已在连接器配置中排除': 'This tool is excluded by the connector configuration',
    'MCP enabled 须为布尔值': 'MCP enabled must be a boolean',
    'MCP 所需的 Node/npm 运行环境不完整，请修复应用或选择完整的本机 Node 安装': 'The Node/npm runtime required by MCP is incomplete; repair the app or select a complete local Node installation',
    'MCP 所需的配套 Node 运行环境缺失，请修复应用': 'The bundled Node runtime required by MCP is missing; repair the app',
    '未找到 MCP 所需的 Node/npm，请修复应用或选择完整的本机 Node 安装': 'The Node/npm runtime required by MCP was not found; repair the app or select a complete local Node installation',
    '所选 npm/npx 启动文件不存在，请检查本机 Node 安装': 'The selected npm/npx launcher does not exist; check the local Node installation',
    '所选 Node 安装路径无效': 'The selected Node installation path is invalid',
    'MCP 的 PATH 配置无效，请检查本机启动环境': 'The MCP PATH configuration is invalid; check the local launch environment',
})
path.write_text(json.dumps(strings, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
