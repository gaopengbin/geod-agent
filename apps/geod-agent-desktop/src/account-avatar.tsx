import { useState } from "react";
import { Compass, Earth, MountainSnow, Orbit, ScanLine, Waves } from "lucide-react";
import { UserRound } from "./icons";
import type { AccountProfile } from "./api";

// Matches the GeoD account site's preset palette, selection and default hash.
const presets = [
  { id: "summit", colors: ["#2563eb", "#7dd3fc"], icon: MountainSnow },
  { id: "orbit", colors: ["#4938ba", "#a78bfa"], icon: Orbit },
  { id: "globe", colors: ["#087e8b", "#64d8cb"], icon: Earth },
  { id: "coast", colors: ["#0071a6", "#5bd4ed"], icon: Waves },
  { id: "terrain", colors: ["#198263", "#9ad49c"], icon: ScanLine },
  { id: "compass", colors: ["#b65342", "#f4b26e"], icon: Compass },
];
function defaultPreset(accountId: string) {
  let hash = 0;
  for (const character of accountId) hash = (31 * hash + character.charCodeAt(0)) >>> 0;
  return presets[hash % presets.length];
}
export function AccountAvatar({ profile }: { profile: AccountProfile | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  const source = profile?.avatarDataUrl ?? null;
  if (source && failed !== source) return <span className="account-avatar"><img src={source} alt="" width={30} height={30} draggable={false} onError={() => setFailed(source)}/></span>;
  if (!profile) return <span className="account-avatar" aria-hidden="true"><UserRound size={17}/></span>;
  const preset = presets.find(item => item.id === (profile.avatar?.kind === "preset" ? profile.avatar.id : "")) ?? defaultPreset(profile.accountId);
  const Icon = preset.icon;
  return <span className="account-avatar" data-avatar-preset={preset.id} aria-hidden="true" style={{ background: `linear-gradient(145deg, ${preset.colors[0]}, ${preset.colors[1]})`, color: "#fff" }}><Icon size={15} strokeWidth={1.8}/></span>;
}
