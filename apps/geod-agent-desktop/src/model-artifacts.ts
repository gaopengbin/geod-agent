import type { AgentMessage, Manifest } from "./api";

const boundaryWarning = "MBTiles preserves complete source tiles; the boundary alpha mask applies to GeoTIFF and preview only";

/** Keep verified facts for the model while leaving local file names in the desktop UI. */
export function artifactResultForModel(jobId: string, manifest: Manifest) {
  return {
    jobId,
    quality: {
      status: manifest.quality.status,
      missingTiles: manifest.quality.missingTiles,
      warnings: manifest.quality.warnings.map(warning => warning === boundaryWarning ? warning : "See the desktop results for a local verification warning"),
    },
    assets: manifest.assets.map(asset => ({
      ...(typeof asset.id === "string" && /^[\w-]{1,100}$/.test(asset.id) ? { id:asset.id } : {}),
      kind: asset.kind,
      role: asset.role,
      bytes: asset.bytes,
      sha256: asset.sha256,
      bounds: asset.bounds,
      ...(asset.width === undefined ? {} : { width: asset.width }),
      ...(asset.height === undefined ? {} : { height: asset.height }),
    })),
    provenance: manifest.provenance.map(item => ({ source: item.source, attribution: item.attribution, retrievedAt: item.retrievedAt })),
  };
}

/** Rebuild older persisted inspection messages before they are sent to the gateway. */
export function modelMessagesWithoutArtifactPaths(messages: AgentMessage[]): AgentMessage[] {
  const inspectionCalls = new Set(messages.flatMap(message => message.role === "assistant"
    ? (message.tool_calls ?? []).filter(call => call.function.name === "artifacts_inspect").map(call => call.id)
    : []));
  return messages.map(message => {
    if (message.role !== "tool") return message;
    let isInspection = Boolean(message.tool_call_id && inspectionCalls.has(message.tool_call_id));
    try {
      const value = JSON.parse(message.content ?? "null") as Record<string, unknown>;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid tool result");
      isInspection ||= Array.isArray(value.assets) && Boolean(value.quality);
      if (!isInspection) return message;
      if (typeof value.error === "string") return { ...message, content: JSON.stringify({ error: /^[A-Z_]{1,60}$/.test(value.error) ? value.error : "LOCAL_TOOL_ERROR" }) };
      if (typeof value.jobId !== "string" || !value.quality || !Array.isArray(value.assets) || !Array.isArray(value.provenance)) throw new Error("Invalid artifact result");
      return { ...message, content: JSON.stringify(artifactResultForModel(value.jobId, value as unknown as Manifest)) };
    } catch {
      return isInspection
        ? { ...message, content: JSON.stringify({ error: "LOCAL_RESULT_UNAVAILABLE", next: "Inspect the completed job again" }) }
        : message;
    }
  });
}
