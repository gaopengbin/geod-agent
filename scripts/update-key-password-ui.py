"""Update explicit local credential fields without adding secrets to tool schemas."""
from pathlib import Path
import json
desktop=Path(__file__).resolve().parents[1]/'apps/geod-agent-desktop/src'
changes={
    'sql-connections.tsx':[
        ('sslClientKey:draft.sslClientKey}} disabled={busy}', 'sslClientKey:draft.sslClientKey,sslClientKeyPassword:draft.sslClientKeyPassword}} disabled={busy} passwordReset={passwordReset}'),
        ('sslClientKey:undefined,clientCertificate:false','sslClientKey:undefined,sslClientKeyPassword:undefined,clientCertificate:false'),
    ],
    'data-input-panel.tsx':[
        ('<DatabaseTlsFields draft={draft} disabled={busy}', '<DatabaseTlsFields draft={draft} disabled={busy} passwordReset={passwordReset}'),
    ],
}
for name,replacements in changes.items():
    path=desktop/name;text=path.read_text(encoding='utf-8')
    for old,new in replacements:
        assert old in text,(name,old)
        text=text.replace(old,new)
    path.write_text(text,encoding='utf-8')
path=desktop/'locales/en.json'
value=json.loads(path.read_text(encoding='utf-8'))
value.update({
    '客户端私钥密码':'Client private key password',
    '请输入客户端私钥密码':'Enter the client private key password',
    '客户端私钥密码不正确，请重试':'Incorrect client private key password. Try again.',
    '客户端私钥密码格式无效':'Invalid client private key password',
    '此客户端私钥的加密方式暂不支持':'This client private key encryption is not supported yet',
    '内置私钥解析环境无法启动，请修复应用':'The bundled private key parser could not start. Repair the app.',
    '请选择匹配的客户端证书和 PEM 私钥':'Choose a matching client certificate and PEM private key',
    '请提供匹配的客户端证书和 PEM 私钥；双向证书需要启用 TLS':'Provide a matching client certificate and PEM private key; enable TLS for client authentication.',
    '选择匹配的证书与 PEM 私钥。加密私钥在本机解锁，保存后使用系统加密存储；密码不保存，AI 不会读取私钥。':'Choose a matching certificate and PEM private key. Encrypted keys are unlocked locally and saved in system-protected storage; the password is not saved and AI cannot read the key.',
})
path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print('Updated local TLS forms and English strings')
