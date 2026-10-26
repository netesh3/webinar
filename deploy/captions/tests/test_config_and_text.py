import pytest

from webcaptions.config import Config, ConfigError
from webcaptions.transcriber import clean_text, prompt_for

ENV = {"CAPTIONS_API_URL": "https://webinarliv.com/", "CAPTIONS_SECRET": "k" * 40}


def test_defaults_are_english_only():
    c = Config.from_env(ENV)
    assert c.api_url == "https://webinarliv.com"
    assert c.model == "base.en" and c.fallback_model == "base.en" and c.final_model == "large-v3-turbo"
    assert c.partial_model_name == "base.en"
    assert c.language == "en" and c.whisper_language == "en"
    assert c.max_speakers == 2 and c.cpus == 2.0 and c.cpu_threads == 2
    assert c.agent_name == "webinar-captions"


def test_overrides_and_validation():
    c = Config.from_env({**ENV, "CAPTIONS_LANGUAGE": "EN", "CAPTIONS_CPUS": "1.5"})
    assert c.whisper_language == "en" and c.cpu_threads == 1
    for bad in ({"CAPTIONS_MAX_SPEAKERS": "0"}, {"CAPTIONS_SECRET": "short"}, {"CAPTIONS_API_URL": ""},
                {"CAPTIONS_CPU_LOW": "90"}):
        with pytest.raises(ConfigError):
            Config.from_env({**ENV, **bad})


@pytest.mark.parametrize("old", [{"CAPTIONS_LANGUAGE": "auto"}, {"CAPTIONS_LANGUAGE": "hi"},
                                 {"CAPTIONS_SCRIPT": "roman"}, {"CAPTIONS_LANGUAGE": "hi", "CAPTIONS_SCRIPT": "native"}])
def test_old_language_settings_warn_and_still_start_in_english(old, caplog):
    with caplog.at_level("WARNING", logger="captions.config"):
        c = Config.from_env({**ENV, **old})
    assert c.language == "en" and c.whisper_language == "en"
    assert "ignored" in caplog.text


def test_english_setting_does_not_warn(caplog):
    with caplog.at_level("WARNING", logger="captions.config"):
        Config.from_env({**ENV, "CAPTIONS_LANGUAGE": "en"})
    assert caplog.text == ""


def test_metrics_port_off_by_default_and_checked():
    assert Config.from_env(ENV).metrics_port == 0
    assert Config.from_env({**ENV, "CAPTIONS_METRICS_PORT": "8092"}).metrics_port == 8092
    for bad in ("8091", "70000", "-1"):  # the health port, out of range
        with pytest.raises(ConfigError):
            Config.from_env({**ENV, "CAPTIONS_METRICS_PORT": bad})


def test_prompt_is_only_the_hosts():
    assert prompt_for() is None
    assert prompt_for("Webinar Liv") == "Webinar Liv"


def test_clean_text():
    assert clean_text("hello�") == "hello"
    assert clean_text("  Thank you.  ") == ""
    assert clean_text("[Music] hello  there ") == "hello there"
    assert clean_text("...") == ""
    assert clean_text("yes yes yes yes yes") == "yes"


def test_rooms_default_to_one_per_two_vcpus_and_split_the_threads():
    from webcaptions.config import Config, default_max_rooms

    assert [default_max_rooms(c) for c in (1, 2, 3, 4, 8)] == [1, 1, 1, 2, 4]
    base = {"CAPTIONS_API_URL": "https://x.test", "CAPTIONS_SECRET": "s" * 40}
    four = Config.from_env({**base, "CAPTIONS_CPUS": "4"})
    assert four.max_rooms == 2 and four.cpu_threads == 4 and four.live_threads == 2
    two = Config.from_env({**base, "CAPTIONS_CPUS": "2"})
    assert two.max_rooms == 1 and two.live_threads == 2
    # An explicit limit still wins, and the threads follow it.
    forced = Config.from_env({**base, "CAPTIONS_CPUS": "4", "CAPTIONS_MAX_ROOMS": "4"})
    assert forced.max_rooms == 4 and forced.live_threads == 1


def test_job_metadata_skip_flag_is_strict():
    from webcaptions.config import job_skips_final

    assert job_skips_final('{"slug": "x", "room": "webinar_x", "final": "skip"}')
    for md in (None, "", "{}", '{"final": "yes"}', "not json", "[1, 2]", '{"mode": "transcript"}'):
        assert not job_skips_final(md), md
