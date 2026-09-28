"""Reject release archives that could write outside their extraction root."""

import posixpath
import sys
import tarfile
from pathlib import Path


def confined(path: str) -> bool:
    normalized = posixpath.normpath(path)
    return not path.startswith("/") and normalized != ".." and not normalized.startswith("../")


def verify(archive: Path) -> None:
    members: set[str] = set()
    links: list[tuple[str, str]] = []
    with tarfile.open(archive, "r:gz") as source:
        for member in source:
            if not confined(member.name):
                raise ValueError(f"{archive.name}: unsafe member path {member.name!r}")
            name = posixpath.normpath(member.name)
            if name in members:
                raise ValueError(f"{archive.name}: duplicate member {name!r}")
            members.add(name)
            if member.issym():
                target = posixpath.join(posixpath.dirname(name), member.linkname)
                if not confined(target):
                    raise ValueError(f"{archive.name}: unsafe symbolic link {name!r}")
                links.append((name, posixpath.normpath(target)))
            elif member.islnk():
                if not confined(member.linkname):
                    raise ValueError(f"{archive.name}: unsafe hard link {name!r}")
                links.append((name, posixpath.normpath(member.linkname)))
            elif not (member.isfile() or member.isdir()):
                raise ValueError(f"{archive.name}: unsupported member type {name!r}")
    for name, target in links:
        if target not in members:
            raise ValueError(f"{archive.name}: unresolved link {name!r} -> {target!r}")
    print(f"{archive.name}: {len(members)} members, {len(links)} links, paths confined")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("Usage: verify-release-archives.py <archive.tar.gz> [...]")
    for filename in sys.argv[1:]:
        verify(Path(filename))
