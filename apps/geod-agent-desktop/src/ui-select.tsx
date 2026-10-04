import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown } from "./icons";
import { ScrollArea } from "@/components/ui/scroll-area";

export function UiSelect({ value, onValueChange, options, ariaLabel, disabled }: {
  value: string; onValueChange: (value: string) => void; options: {value:string;label:string}[];
  ariaLabel: string; disabled?: boolean;
}) {
  return <Select.Root value={value} onValueChange={onValueChange} disabled={disabled}>
    <Select.Trigger className="select-trigger" aria-label={ariaLabel}><Select.Value/><Select.Icon><ChevronDown size={15}/></Select.Icon></Select.Trigger>
    <Select.Portal><Select.Content className="select-content" position="popper" sideOffset={6} collisionPadding={8}>
      <ScrollArea style={{maxHeight:280}}><Select.Viewport>{options.map(option => <Select.Item key={option.value} value={option.value} className="select-item">
        <Select.ItemText>{option.label}</Select.ItemText><Select.ItemIndicator className="select-item-indicator"><Check size={14}/></Select.ItemIndicator>
      </Select.Item>)}</Select.Viewport></ScrollArea>
    </Select.Content></Select.Portal>
  </Select.Root>;
}
