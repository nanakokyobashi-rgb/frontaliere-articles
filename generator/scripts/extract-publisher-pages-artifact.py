#!/usr/bin/env python3
"""Safely stage the small publisher-owned subset from a Pages artifact tar."""

from __future__ import annotations

import argparse
import os
import re
import shutil
import stat
import tarfile
from pathlib import Path, PurePosixPath


MAX_MEMBERS = 200_000
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024
REQUIRED_FILES = {"manifest.json", "edge/sections/registry.json"}
SITEMAP_RE = re.compile(r"sitemap-articles-canton-[a-z]+\.xml\Z")


def normalized_member_name(member: tarfile.TarInfo) -> str:
    name = member.name
    if (not name or "\x00" in name or "\\" in name or name.startswith("/")
            or re.match(r"^[A-Za-z]:", name)):
        raise ValueError(f"percorso artifact non valido: {name!r}")

    parts = name.split("/")
    if parts and parts[0] == ".":
        parts = parts[1:]
    if member.isdir() and parts and parts[-1] == "":
        parts = parts[:-1]
    if not parts:
        if member.isdir():
            return ""
        raise ValueError(f"file root non valido: {name!r}")
    if any(part in ("", ".", "..") for part in parts):
        raise ValueError(f"percorso artifact non valido: {name!r}")

    normalized = str(PurePosixPath(*parts))
    if normalized.startswith("/"):
        raise ValueError(f"percorso assoluto nell'artifact: {name!r}")
    return normalized


def is_expected_file(path: str) -> bool:
    return path in REQUIRED_FILES or bool(SITEMAP_RE.fullmatch(path))


def safe_extract(archive_path: Path, destination: Path) -> None:
    archive_mode = archive_path.lstat().st_mode
    if not stat.S_ISREG(archive_mode):
        raise ValueError("artifact.tar non e' un file regolare")
    if destination.exists() or destination.is_symlink():
        raise ValueError(f"directory staging gia' esistente: {destination}")

    destination.mkdir(parents=True)
    extracted: set[str] = set()
    total_bytes = 0
    try:
        with tarfile.open(archive_path, mode="r:*") as archive:
            members = []
            for member in archive:
                members.append(member)
                if len(members) > MAX_MEMBERS:
                    raise ValueError(f"artifact con piu' di {MAX_MEMBERS} membri")

            normalized_members: list[tuple[tarfile.TarInfo, str]] = []
            seen: set[str] = set()
            for member in members:
                path = normalized_member_name(member)
                if path and path in seen:
                    raise ValueError(f"percorso duplicato nell'artifact: {path}")
                if path:
                    seen.add(path)

                if not (member.isdir() or member.isreg()):
                    raise ValueError(f"tipo di membro non ammesso nell'artifact: {member.name!r}")
                if member.isdir() and member.size != 0:
                    raise ValueError(f"directory con dimensione non valida: {member.name!r}")
                normalized_members.append((member, path))

            # Evita conflitti strutturali come un file `edge` insieme al file
            # atteso `edge/sections/registry.json`, o una directory chiamata
            # `manifest.json` al posto del manifest.
            for member, path in normalized_members:
                if not path:
                    continue
                if member.isdir() and is_expected_file(path):
                    raise ValueError(f"file atteso dichiarato come directory: {path}")
                if member.isreg():
                    for expected in REQUIRED_FILES:
                        if expected.startswith(path + "/"):
                            raise ValueError(f"file in conflitto con percorso atteso: {path}")
                    for other in seen:
                        if other.startswith(path + "/"):
                            raise ValueError(f"file in conflitto con percorso atteso: {path}")

            for member, path in normalized_members:
                if not path or member.isdir() or not is_expected_file(path):
                    continue
                if member.size < 0 or member.size > MAX_FILE_BYTES:
                    raise ValueError(f"dimensione non ammessa per {path}: {member.size}")
                total_bytes += member.size
                if total_bytes > MAX_TOTAL_BYTES:
                    raise ValueError("dimensione totale dei file publisher supera il limite")

                target = destination.joinpath(*PurePosixPath(path).parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(member)
                if source is None:
                    raise ValueError(f"contenuto assente per {path}")
                with source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                    output.flush()
                    os.fsync(output.fileno())
                if target.stat().st_size != member.size:
                    raise ValueError(f"dimensione estratta diversa dal tar per {path}")
                extracted.add(path)

            missing = sorted(REQUIRED_FILES - extracted)
            if missing:
                raise ValueError(f"artifact privo dei file publisher richiesti: {', '.join(missing)}")
    except Exception:
        shutil.rmtree(destination, ignore_errors=True)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    args = parser.parse_args()
    safe_extract(args.archive, args.destination)


if __name__ == "__main__":
    main()
