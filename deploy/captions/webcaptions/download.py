"""Fetch the model weights into CAPTIONS_MODEL_DIR (a docker volume) before the worker starts.

    python -m webcaptions.download

Idempotent: a model already in the cache is not fetched again, so after the first start
this takes a second. The first start downloads small.en (~480 MB), base.en (~150 MB) and, unless
CAPTIONS_FINAL_ENABLED=false, large-v3-turbo (~1.6 GB).
"""

from __future__ import annotations

import logging
import sys

from .config import Config


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = Config.from_env()
    from faster_whisper import download_model

    names = [cfg.model, cfg.fallback_model]
    if cfg.final_enabled:
        names.append(cfg.final_model)
    for name in dict.fromkeys(names):
        logging.info("model %s -> %s", name, cfg.model_dir)
        download_model(name, cache_dir=cfg.model_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
