"""Fetch the model weights into CAPTIONS_MODEL_DIR (a docker volume) before the worker starts.

    python -m webcaptions.download

Idempotent: a model already in the cache is not fetched again, so after the first start
this takes a second. A model missing from the cache is first copied from the seed the image
carries (CAPTIONS_MODEL_SEED_DIR, /opt/models-seed: base.en, baked in by the Dockerfile), so
a fresh volume does not wait on Hugging Face for the live model. Anything else is downloaded:
the first start fetches base.en (~150 MB) if the image has no seed, CAPTIONS_MODEL if it is
another model (small.en ~480 MB), and, unless CAPTIONS_FINAL_ENABLED=false, large-v3-turbo
(~1.6 GB).
"""

from __future__ import annotations

import logging
import os
import shutil
import sys
from collections.abc import Callable

from .config import Config

SEED_DIR = "/opt/models-seed"


def _cached(download_model: Callable[..., str], name: str, cache_dir: str) -> bool:
    try:
        download_model(name, cache_dir=cache_dir, local_files_only=True)
        return True
    except Exception:  # noqa: BLE001 - huggingface_hub raises several types for "not cached"
        return False


def ensure(download_model: Callable[..., str], name: str, model_dir: str, seed_dir: str) -> str:
    """Make sure model `name` is in model_dir. Returns how: "cached", "seed" or "download"."""
    if _cached(download_model, name, model_dir):
        return "cached"
    if seed_dir and os.path.isdir(seed_dir) and _cached(download_model, name, seed_dir):
        # The Hugging Face cache layout (models--org--name/{blobs,refs,snapshots}) with
        # relative symlinks, so a plain tree copy is a valid cache in the new place.
        shutil.copytree(seed_dir, model_dir, symlinks=True, dirs_exist_ok=True)
        if _cached(download_model, name, model_dir):
            return "seed"
    download_model(name, cache_dir=model_dir)
    return "download"


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    from faster_whisper import download_model

    cfg = Config.from_env()
    seed_dir = os.environ.get("CAPTIONS_MODEL_SEED_DIR", "").strip() or SEED_DIR
    names = [cfg.model, cfg.fallback_model]
    if cfg.final_enabled:
        names.append(cfg.final_model)
    for name in dict.fromkeys(names):
        how = ensure(download_model, name, cfg.model_dir, seed_dir)
        logging.info("model %s -> %s (%s)", name, cfg.model_dir, how)
    return 0


if __name__ == "__main__":
    sys.exit(main())
