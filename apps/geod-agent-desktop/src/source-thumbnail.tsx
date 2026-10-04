import { t, localize } from "./i18n";
// i18n: presentation strings migrated
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/motion/button/base";
import { Loader2, MapTrifold, RefreshCw } from "./icons";
import { desktopAvailable, errorMessage } from "./api";
import { getSourceThumbnail, thumbnailKey, type SourceThumbnailImage, type ThumbnailTarget } from "./source-thumbnails";

export function SourceThumbnail({ target, name, detailed = false, refresh = false }: { target: ThumbnailTarget; name: string; detailed?: boolean; refresh?: boolean }) {
  const host = useRef<HTMLDivElement>(null), latest = useRef(target); latest.current = target;
  const [visible, setVisible] = useState(false), [attempt, setAttempt] = useState(0);
  const [image, setImage] = useState<SourceThumbnailImage | null>(null), [error, setError] = useState("");
  const key = thumbnailKey(target);
  useEffect(() => {
    const element = host.current; if (!element) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "80px" });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !desktopAvailable) return;
    let cancelled = false; setImage(null); setError("");
    getSourceThumbnail(latest.current, refresh || attempt > 0).then(value => { if (!cancelled) setImage(value); })
      .catch(cause => { if (!cancelled) setError(errorMessage(cause)); });
    return () => { cancelled = true; };
  }, [key, visible, attempt, refresh]);
  return <div ref={host} className={`source-thumbnail ${detailed ? "is-detailed" : ""}`} aria-label={t("{0}预览", {"0": name || "图源"})}>
    <div className="source-thumbnail-image" aria-busy={desktopAvailable && !image && !error}>
      {image && !error ? <img src={image.url} alt={t("{0}的示例瓦片", {"0": name || "图源"})} onError={() => setError("预览图片无法显示。")} /> : <div className="source-thumbnail-placeholder" title={error || undefined}>
        {desktopAvailable && !error ? <Loader2 size={detailed ? 20 : 16} className="extension-spin"/> : <MapTrifold size={detailed ? 24 : 18}/>}
        <span>{!desktopAvailable ? t("桌面端预览") : error ? t("暂无预览") : t("加载中")}</span>
      </div>}
    </div>
    {detailed && <div className="source-thumbnail-caption">{image && !error ? <span title={`${image.tile.longitude.toFixed(3)}°, ${image.tile.latitude.toFixed(3)}°`}>{t("示例瓦片 · Z")}{image.tile.z}</span> : <span>{error ? t("预览暂不可用") : desktopAvailable ? t("正在读取图源…") : t("在桌面应用中查看实际图源")}</span>}
      <Button type="button" variant="ghost" size="sm" aria-label={error ? t("重试图源预览") : t("刷新图源预览")} disabled={!desktopAvailable || !image && !error} onClick={() => setAttempt(value => value + 1)}><RefreshCw size={14}/>{error ? t("重试") : t("刷新")}</Button>
    </div>}
    {detailed && error && <p className="source-preview-note" role="status">{localize(error)}</p>}
  </div>;
}
