// Real native IPC for browser-only component acceptance, not a mock API.
const runtime = window as unknown as Record<string, unknown>;
runtime.__TAURI__ = {};
runtime.isTauri = true;
runtime.__TAURI_INTERNALS__ = {
  convertFileSrc: (path: string) => "http://127.0.0.1:1421/raster/" + path,
  invoke: async (command: string, args: unknown) => {
    const response = await fetch("http://127.0.0.1:1421/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command, args }),
    });
    const result = await response.json();
    if (result.error) throw result.error;
    return result.value;
  },
};
