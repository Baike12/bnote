#!/usr/bin/env python3
"""Build the embedded English→Chinese dictionary asset.

Source: ECDICT (https://github.com/skywind3000/ECDICT), MIT licensed.
Only a frequency-bounded common subset is kept; the result is a sorted,
length-prefixed binary blob compressed with zstd and compiled into the Rust
binary with `include_bytes!`.

Binary format (little endian):

    magic      8 bytes  b"BNOTED1\\0"
    count      u32
    offsets    count × u32   absolute file offset of each record
    records    count × record

    record:
      u16 key_len,  key bytes          (lowercase, sorted by bytes)
      u16 phon_len, phonetic bytes
      u32 trans_len, translation bytes
      u8  pos_len,  pos bytes

Usage:
    python3 scripts/build-dict.py            # download pinned ECDICT csv
    python3 scripts/build-dict.py --csv /tmp/ecdict.csv
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import os
import struct
import subprocess
import sys
import tempfile
import urllib.request

# The CSV's own last commit; pinning it keeps the generated asset reproducible.
ECDICT_COMMIT = "9c46923fb81a2eb6c264a3a1689562ea7bc56b6a"
ECDICT_URL = (
    "https://raw.githubusercontent.com/skywind3000/ECDICT/"
    f"{ECDICT_COMMIT}/ecdict.csv"
)

# Common-word filter: corpus frequency up to this rank, or an exam/learner tag.
MAX_RANK = 50_000
MAGIC = b"BNOTED1\0"
OUT_REL = os.path.join("src-tauri", "resources", "ecdict_common.zst")
MANIFEST_REL = os.path.join("src-tauri", "resources", "ecdict_common.json")


def unescape_translation(text: str) -> str:
    """Turn ECDICT's escaped sense breaks into real line breaks.

    The CSV stores one sense per line as the two characters ``\\n`` (and one
    record uses ``\\r\\n``); consumers split on a real newline, so the asset
    must carry LF, never the escape.
    """
    return text.replace("\\r\\n", "\n").replace("\\n", "\n")


def rank(value: str) -> int:
    try:
        return int(value or 0)
    except ValueError:
        return 0


def keep(row: dict[str, str]) -> bool:
    frq = rank(row.get("frq", ""))
    bnc = rank(row.get("bnc", ""))
    return (
        (0 < frq <= MAX_RANK)
        or (0 < bnc <= MAX_RANK)
        or rank(row.get("collins", "")) > 0
        or rank(row.get("oxford", "")) > 0
        or bool((row.get("tag") or "").strip())
    )


def read_rows(path: str) -> list[tuple[str, str, str, str]]:
    csv.field_size_limit(10**9)
    seen: set[str] = set()
    rows: list[tuple[str, str, str, str]] = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            translation = unescape_translation((row.get("translation") or "").strip())
            if not translation or not keep(row):
                continue
            word = (row.get("word") or "").strip().lower()
            if not word or word in seen:
                continue
            seen.add(word)
            rows.append(
                (
                    word,
                    (row.get("phonetic") or "").strip(),
                    translation,
                    (row.get("pos") or "").strip(),
                )
            )
    rows.sort(key=lambda r: r[0].encode("utf-8"))
    return rows


def encode(rows: list[tuple[str, str, str, str]]) -> bytes:
    header_len = 12 + 4 * len(rows)
    records = bytearray()
    offsets: list[int] = []
    for word, phonetic, translation, pos in rows:
        offsets.append(header_len + len(records))
        key = word.encode("utf-8")
        phon = phonetic.encode("utf-8")
        trans = translation.encode("utf-8")
        posb = pos.encode("utf-8")
        records += struct.pack("<H", len(key)) + key
        records += struct.pack("<H", len(phon)) + phon
        records += struct.pack("<I", len(trans)) + trans
        records += struct.pack("<B", len(posb)) + posb
    out = bytearray(MAGIC)
    out += struct.pack("<I", len(rows))
    for offset in offsets:
        out += struct.pack("<I", offset)
    out += records
    return bytes(out)


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", help="use an existing ecdict.csv instead of downloading")
    parser.add_argument("--out", default=OUT_REL, help=f"output asset (default: {OUT_REL})")
    args = parser.parse_args()

    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_path = args.out if os.path.isabs(args.out) else os.path.join(repo, args.out)
    manifest_path = os.path.join(repo, MANIFEST_REL)

    tmp_csv = args.csv
    downloaded = False
    if not tmp_csv:
        fd, tmp_csv = tempfile.mkstemp(prefix="ecdict-", suffix=".csv")
        os.close(fd)
        downloaded = True
        print(f"downloading {ECDICT_URL}")
        urllib.request.urlretrieve(ECDICT_URL, tmp_csv)

    rows = read_rows(tmp_csv)
    if not rows:
        print("no rows matched the filter", file=sys.stderr)
        return 1
    raw = encode(rows)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix="ecdict-", suffix=".bin", delete=False) as f:
        f.write(raw)
        tmp_bin = f.name
    try:
        subprocess.run(
            ["zstd", "-q", "-19", "-f", "-o", out_path, tmp_bin],
            check=True,
        )
    finally:
        os.unlink(tmp_bin)
        if downloaded:
            os.unlink(tmp_csv)

    with open(manifest_path, "w", encoding="utf-8") as f:
        f.write(
            "{\n"
            f'  "source": "skywind3000/ECDICT",\n'
            f'  "commit": "{ECDICT_COMMIT}",\n'
            f'  "license": "MIT",\n'
            f'  "filter": "frq<=50000 or bnc<=50000 or collins/oxford/tag",\n'
            f'  "entries": {len(rows)},\n'
            f'  "rawBytes": {len(raw)},\n'
            f'  "compressedBytes": {os.path.getsize(out_path)},\n'
            f'  "sha256": "{sha256(out_path)}"\n'
            "}\n"
        )

    print(f"entries      {len(rows)}")
    print(f"raw          {len(raw):,} bytes")
    print(f"compressed   {os.path.getsize(out_path):,} bytes")
    print(f"asset        {out_path}")
    print(f"sha256       {sha256(out_path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
