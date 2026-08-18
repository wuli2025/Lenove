#!/usr/bin/env python3
"""Fail a release if an exact embedded credential appears as plaintext.

The script prints labels and hit counts only. It never prints credential values.
"""

import argparse
import json
import os
from pathlib import Path
import sys

SEED = [0x8F, 0x2A, 0xD7, 0x41, 0x63, 0xBE, 0x19, 0xC5,
        0x7D, 0x04, 0xA8, 0x36, 0xEF, 0x92, 0x5B, 0x10]
CHUNK = 4 * 1024 * 1024


def transform(data: bytes) -> bytes:
    state = 0x9E3779B9
    out = bytearray(len(data))
    for index, value in enumerate(data):
        state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
        key = (state >> 24) ^ SEED[index % len(SEED)] ^ (index & 0xFF)
        out[index] = value ^ key
    return bytes(out)


def load_config(path: Path) -> dict:
    body = path.read_bytes()
    if body.startswith(b"YJO1"):
        body = transform(body[4:])
    return json.loads(body.decode("utf-8"))


def files_under(paths):
    for raw in paths:
        path = Path(raw)
        if path.is_file():
            yield path
        elif path.is_dir():
            for child in path.rglob("*"):
                if child.is_file() and not child.is_symlink():
                    yield child
        else:
            raise FileNotFoundError(path)


def contains(path: Path, needle: bytes) -> bool:
    overlap = max(0, len(needle) - 1)
    tail = b""
    with path.open("rb") as stream:
        while True:
            block = stream.read(CHUNK)
            if not block:
                return False
            window = tail + block
            if needle in window:
                return True
            tail = window[-overlap:] if overlap else b""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--path", action="append", required=True, dest="paths")
    parser.add_argument("--publish-env", default="MICA_PUBLISH_TOKEN")
    args = parser.parse_args()

    config = load_config(args.config)
    model = str(config.get("api_key") or "").encode()
    tts = str(config.get("tts_key") or config.get("api_key") or "").encode()
    publish = os.environ.get(args.publish_env, "").strip().encode()
    secrets = {"model_api_key": model, "tts_key": tts, "publish_token": publish}
    if any(len(secret) < 8 for secret in secrets.values()):
        print(json.dumps({"ok": False, "error": "one or more release secrets are missing"}))
        return 2

    findings = []
    scanned = 0
    for path in files_under(args.paths):
        scanned += 1
        for label, secret in secrets.items():
            if contains(path, secret):
                findings.append({"secret": label, "file": str(path)})

    result = {"ok": not findings, "scannedFiles": scanned,
              "plaintextSecretHits": len(findings), "findings": findings}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if not findings else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"ok": False, "error": type(error).__name__}))
        raise SystemExit(2)
