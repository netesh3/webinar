import pytest

from webcaptions.config import Config, ConfigError
from webcaptions.transcriber import HINDI_PROMPT, choose_language, clean_text, has_arabic_script, prompt_for

ENV = {"CAPTIONS_API_URL": "https://webinarliv.com/", "CAPTIONS_SECRET": "k" * 40}


def test_defaults():
    c = Config.from_env(ENV)
    assert c.api_url == "https://webinarliv.com"
    assert c.model == "small" and c.fallback_model == "base" and c.final_model == "large-v3-turbo"
    assert c.language == "auto" and c.whisper_language is None
    assert c.script == "roman"  # Hindi and Hinglish captions in Latin letters by default
    assert c.max_speakers == 2 and c.cpus == 2.0 and c.cpu_threads == 2
    assert c.agent_name == "webinar-captions"


def test_overrides_and_validation():
    c = Config.from_env({**ENV, "CAPTIONS_LANGUAGE": "HI", "CAPTIONS_SCRIPT": "native", "CAPTIONS_CPUS": "1.5"})
    assert c.whisper_language == "hi" and c.script == "native" and c.cpu_threads == 1
    for bad in ({"CAPTIONS_LANGUAGE": "fr"}, {"CAPTIONS_SCRIPT": "itrans"}, {"CAPTIONS_MAX_SPEAKERS": "0"},
                {"CAPTIONS_SECRET": "short"}, {"CAPTIONS_API_URL": ""}, {"CAPTIONS_CPU_LOW": "90"}):
        with pytest.raises(ConfigError):
            Config.from_env({**ENV, **bad})


def test_language_is_english_or_hindi_only():
    # Whisper often calls Hindi "Urdu"; that counts as Hindi, never as Arabic script.
    assert choose_language([("ur", 0.5), ("hi", 0.2), ("en", 0.3)]) == "hi"
    assert choose_language([("en", 0.7), ("hi", 0.2)]) == "en"
    assert choose_language([("fr", 0.9)], previous="hi") == "hi"
    assert choose_language([("fr", 0.9)]) == "en"


def test_language_sticks_unless_clearly_ahead():
    assert choose_language([("en", 0.52), ("hi", 0.48)], previous="hi") == "hi"
    assert choose_language([("en", 0.8), ("hi", 0.2)], previous="hi") == "en"


def test_hindi_decoding_is_primed_with_devanagari():
    assert prompt_for("hi") == HINDI_PROMPT
    assert prompt_for("hi", "Webinar Liv") == HINDI_PROMPT + " Webinar Liv"
    assert prompt_for("en") is None
    assert prompt_for("en", "Webinar Liv") == "Webinar Liv"


def test_urdu_script_is_detected():
    assert has_arabic_script("آج ہم بات کریں گے")
    assert not has_arabic_script("आज हम बात करेंगे")
    assert not has_arabic_script("aaj hum baat karenge")


def test_clean_text():
    assert clean_text("बात करें�") == "बात करें"
    assert clean_text("  Thank you.  ") == ""
    assert clean_text("[Music] hello  there ") == "hello there"
    assert clean_text("...") == ""
    assert clean_text("haan haan haan haan haan") == "haan"
    assert clean_text("नमस्ते सब") == "नमस्ते सब"
