"""Check local assets referenced by the staged GeoD login page."""

import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


class References(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.paths: set[str] = set()

    def handle_starttag(self, _tag: str, attrs: list[tuple[str, str | None]]) -> None:
        for name, value in attrs:
            if name not in {"src", "href"} or not value:
                continue
            path = unquote(urlsplit(value).path)
            if path.startswith(("/_next/static/", "/geod/")):
                self.paths.add(path.lstrip("/"))


root = Path(sys.argv[1]).resolve(strict=True)
page = root / "login.html"
references = References()
references.feed(page.read_text(encoding="utf-8"))
if not references.paths:
    raise SystemExit("No local login assets were found")
for name in references.paths:
    target = (root / name).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        raise SystemExit(f"Missing or unsafe login asset: {name}")
print(f"GeoD login page: {len(references.paths)} local assets verified")
