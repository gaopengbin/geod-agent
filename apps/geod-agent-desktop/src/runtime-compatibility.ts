import {runtimeCompatibilityFailure, runtimeUpdateError} from "./app-error.ts";

export interface NativeRuntimeCapabilities {
  version: string;
  exportCrs: boolean;
  conversationOutputCrs: boolean;
  exportOptions: string[];
}

/** Check the running binary before spending model tokens or creating a plan. */
export async function ensureExportRuntime(read: () => Promise<NativeRuntimeCapabilities>) {
  try {
    const native = await read();
    if (native.exportCrs !== true || native.conversationOutputCrs !== true ||
        !Array.isArray(native.exportOptions) || !["targetCrs","resampling"].every(field=>native.exportOptions.includes(field))) throw runtimeUpdateError();
  } catch (cause) {
    if (runtimeCompatibilityFailure(cause)) throw runtimeUpdateError();
    throw cause;
  }
}
