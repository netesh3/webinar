import os

from webcaptions.download import ensure


def fake_download(log):
    """A stand-in for faster_whisper.download_model: a model is "cached" in a dir when the
    HF-style folder exists there; a real download creates it."""

    def download_model(name, cache_dir, local_files_only=False):
        path = os.path.join(cache_dir, f"models--Systran--faster-whisper-{name}")
        if os.path.isdir(path):
            return path
        if local_files_only:
            raise FileNotFoundError(path)
        log.append(name)
        os.makedirs(os.path.join(path, "snapshots"))
        return path

    return download_model


def test_cached_model_is_not_fetched(tmp_path):
    log = []
    dl = fake_download(log)
    dl("base.en", cache_dir=str(tmp_path / "models"))
    log.clear()
    assert ensure(dl, "base.en", str(tmp_path / "models"), str(tmp_path / "seed")) == "cached"
    assert log == []


def test_missing_model_comes_from_the_seed_without_a_download(tmp_path):
    log = []
    dl = fake_download(log)
    seed, models = str(tmp_path / "seed"), str(tmp_path / "models")
    dl("base.en", cache_dir=seed)
    log.clear()
    assert ensure(dl, "base.en", models, seed) == "seed"
    assert log == [] and os.path.isdir(os.path.join(models, "models--Systran--faster-whisper-base.en"))


def test_model_not_in_seed_is_downloaded(tmp_path):
    log = []
    dl = fake_download(log)
    seed, models = str(tmp_path / "seed"), str(tmp_path / "models")
    dl("base.en", cache_dir=seed)
    log.clear()
    assert ensure(dl, "small.en", models, seed) == "download"
    assert log == ["small.en"]
    # No seed directory at all (an image built before the seed): plain download.
    assert ensure(dl, "tiny.en", models, str(tmp_path / "none")) == "download"
