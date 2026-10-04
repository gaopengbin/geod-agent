import { localize } from "./i18n";
// i18n: presentation strings migrated
import { useId } from "react";
import { Button } from "@/components/motion/button/base";

// Shared workbench tabs: roving focus, arrow/Home/End keys and no row scaling.
export function PanelTabs<T extends string>({ label, value, items, onChange }: {
  label: string; value: T; items: { value: T; label: string }[]; onChange: (value: T) => void;
}) {
  const id = useId();
  return <div className="panel-tabs" role="tablist" aria-label={label} onKeyDown={event => {
    const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!direction && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (items.findIndex(item => item.value === value) + direction + items.length) % items.length;
    onChange(items[index].value);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")[index]?.focus();
  }}>{items.map(item => <Button key={item.value} id={`${id}-${item.value}`} variant="ghost" size="sm" role="tab" tabIndex={value === item.value ? 0 : -1} aria-selected={value === item.value} whileHover={undefined} whileTap={undefined} onClick={() => onChange(item.value)}>{localize(item.label)}</Button>)}</div>;
}
