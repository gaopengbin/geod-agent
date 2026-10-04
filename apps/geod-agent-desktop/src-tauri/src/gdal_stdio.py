"""Pinned GDAL MCP launcher with workspace-local Windows-safe reflection storage."""

import json
import os
from pathlib import Path
import re
import tempfile
import time

from src.middleware import reflection_store


class WorkspaceDiskStore(reflection_store.DiskStore):
    def _path_for(self, key, domain):
        # Upstream 1.1.3 uses sha256:<digest> as a filename, invalid on Windows.
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", key):
            raise ValueError("Invalid reflection cache key")
        if domain not in {"crs_datum", "resampling"}:
            raise ValueError("Unsupported reflection domain")
        path = self._root / domain / (key.replace(":", "-") + ".json")
        workspace = Path.cwd().resolve()
        if not path.resolve().is_relative_to(workspace):
            raise ValueError("Reflection cache must remain in the workspace")
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def put(self, key, value, domain):
        path = self._path_for(key, domain)
        payload = value.model_dump()
        payload["_meta"] = {"created_at": int(time.time())}
        fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".geod-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(payload, stream, indent=2)
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)
        return path


# Keep initialization lazy: read-only tools must not create cache directories.
reflection_store.DiskStore = WorkspaceDiskStore

from src.server import mcp

mcp.run(transport="stdio")
