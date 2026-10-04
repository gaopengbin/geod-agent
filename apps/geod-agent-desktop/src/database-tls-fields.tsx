import { t } from "./i18n";
// i18n: presentation strings migrated
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/motion/button/base";
import { ChevronDown, File, X } from "./icons";
import { errorMessage, type DataConnectionDraft } from "./api";

type TlsDraft = Pick<DataConnectionDraft, "sslMode" | "sslRootCert" | "sslClientCert" | "sslClientKey" | "sslClientKeyPassword">;
export function DatabaseTlsFields({ draft, disabled, requireClientCertificate, allowClientCertificate = true, showCa = false, passwordReset = 0,onChange, onError }: {
  draft: TlsDraft; disabled: boolean; requireClientCertificate?: boolean; allowClientCertificate?: boolean; showCa?: boolean;passwordReset?:number;
  onChange: (value: Partial<TlsDraft>) => void; onError: (message: string) => void;
}) {
  const caInput = useRef<HTMLInputElement>(null);
  const clientInput = useRef<HTMLInputElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const passwordInput=useRef<HTMLInputElement>(null);
  const appliedPasswordReset=useRef(0);
  const [expanded, setExpanded] = useState(Boolean(requireClientCertificate || draft.sslClientCert));
  const [names, setNames] = useState<{ certificate?: string; key?: string }>({});
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(()=>{if(passwordReset!==appliedPasswordReset.current&&!disabled){appliedPasswordReset.current=passwordReset;onChange({sslClientKeyPassword:undefined});passwordInput.current?.focus();}},[passwordReset,disabled]);
  async function read(file: File | undefined, field: "sslRootCert" | "sslClientCert" | "sslClientKey") {
    if (!file) return;
    const limit = field === "sslClientKey" ? 64 : 256;
    if (file.size > limit * 1024) { onError(t("证书文件不能超过 {0} KiB", {0: limit})); return; }
    try {
      const text = await file.text();
      if (!active.current) return;
      onChange({ [field]: text,...(field==='sslClientKey'?{sslClientKeyPassword:undefined}:{}) });
      if (field !== "sslRootCert") setNames(current => ({ ...current, [field === "sslClientCert" ? "certificate" : "key"]: file.name }));
    } catch (cause) { onError(errorMessage(cause)); }
  }
  return <>
    {(showCa || ["verify-ca", "verify-full"].includes(draft.sslMode)) && <label className="data-input-ca">
      {t("CA 证书 · 可选，留空使用默认信任库 ")}<textarea rows={3} value={draft.sslRootCert ?? ""} placeholder="-----BEGIN CERTIFICATE-----" disabled={disabled} onChange={event => onChange({ sslRootCert: event.target.value })} />
      <input hidden ref={caInput} type="file" accept=".pem,.crt,.cer" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; void read(file, "sslRootCert"); }} />
      <Button variant="outline" type="button" size="sm" disabled={disabled} onClick={() => caInput.current?.click()}>{t("选择 CA 文件")}</Button>
    </label>}
    {allowClientCertificate && <div className="data-input-client-tls">
      <Button variant="ghost" type="button" aria-expanded={expanded} disabled={disabled} onClick={() => {
        const next = !expanded; setExpanded(next);
        if (next && !["require", "verify-ca", "verify-full"].includes(draft.sslMode)) onChange({ sslMode: "verify-full" });
        if (!next) { onChange({ sslClientCert: undefined, sslClientKey: undefined,sslClientKeyPassword:undefined }); setNames({}); }
      }}>{t("客户端证书 · 双向 TLS")}<ChevronDown size={14} style={{ transform: expanded ? "rotate(180deg)" : undefined }} /></Button>
      {expanded && <>
        <div className="data-input-cert-files">
          <div><span>{t("客户端证书")}</span><Button variant="outline" type="button" size="sm" disabled={disabled} onClick={() => clientInput.current?.click()}><File size={14} />{names.certificate ?? (draft.sslClientCert ? t("已选择证书") : t("选择 PEM 证书"))}</Button>{draft.sslClientCert && <Button variant="ghost" type="button" size="icon" aria-label={t("移除客户端证书")} disabled={disabled} onClick={() => { onChange({ sslClientCert: undefined }); setNames(current => ({ ...current, certificate: undefined })); }}><X size={14} /></Button>}</div>
          <div><span>{t("客户端私钥")}</span><Button variant="outline" type="button" size="sm" disabled={disabled} onClick={() => keyInput.current?.click()}><File size={14} />{names.key ?? (draft.sslClientKey ? t("已选择私钥") : t("选择 PEM 私钥"))}</Button>{draft.sslClientKey && <Button variant="ghost" type="button" size="icon" aria-label={t("移除客户端私钥")} disabled={disabled} onClick={() => { onChange({ sslClientKey: undefined,sslClientKeyPassword:undefined }); setNames(current => ({ ...current, key: undefined })); }}><X size={14} /></Button>}</div>
        </div>
        <input hidden ref={clientInput} type="file" accept=".pem,.crt,.cer" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; void read(file, "sslClientCert"); }} />
        <input hidden ref={keyInput} type="file" accept=".pem,.key" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; void read(file, "sslClientKey"); }} />
        {draft.sslClientKey?.includes('ENCRYPTED')&&<label className="data-input-key-password">{t("客户端私钥密码")}<input ref={passwordInput} name="ssl-client-key-password" type="password" autoComplete="off" maxLength={1024} disabled={disabled} value={draft.sslClientKeyPassword??''} onChange={event=>onChange({sslClientKeyPassword:event.target.value})}/></label>}
        <p className="data-input-hint">{t("选择匹配的证书与 PEM 私钥。加密私钥在本机解锁，保存后使用系统加密存储；密码不保存，AI 不会读取私钥。")}</p>
      </>}
    </div>}
  </>;
}
