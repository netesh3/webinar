import pytest

from webcaptions.roman import apply_script, to_roman


@pytest.mark.parametrize(
    "devanagari, roman",
    [
        ("आप कैसे हैं?", "aap kaise hain?"),
        ("मैं ठीक हूँ", "main theek hoon"),
        ("क्या बात है", "kya baat hai"),
        ("करते", "karte"),
        ("समझना", "samajhna"),
        ("मिलकर", "milkar"),
        ("कमल", "kamal"),
        ("आपका", "aapka"),
        ("देखना", "dekhna"),
        ("नहीं", "nahin"),
        ("में", "mein"),
        ("हमें", "hamein"),
        ("जी", "ji"),
        ("भी", "bhi"),
        ("शुरू", "shuru"),
        ("ज्ञान", "gyaan"),
        ("ज़रूर", "zaroor"),
        ("मंत्र", "mantra"),
        ("दोस्त", "dost"),
        ("धन्यवाद", "dhanyavaad"),
        ("न", "na"),
        ("मीटिंग", "meeting"),
    ],
)
def test_words(devanagari, roman):
    assert to_roman(devanagari) == roman


def test_english_is_left_exactly_as_is():
    for s in ["Hello world, no change.", "Q3 revenue was 12.5% up!", "", "  spaced  out  "]:
        assert to_roman(s) == s


def test_code_mixed_line_keeps_the_english_words():
    line = "आज हम pricing के बारे में बात करेंगे, and then Q&A"
    assert to_roman(line) == "aaj ham pricing ke baare mein baat karenge, and then Q&A"


def test_danda_and_digits():
    assert to_roman("२०२४ में शुरू हुआ।") == "2024 mein shuru hua."


def test_nukta_letters_precomposed_and_combining():
    assert to_roman("फ़ोन") == "fon"  # फ + nukta
    assert to_roman("फ़ोन") == "fon"  # U+095E precomposed
    assert to_roman("ज़रूर") == "zaroor"


def test_output_is_ascii_for_hindi():
    out = to_roman("प्रधानमंत्री ने कहा कि अध्यक्षता करेंगे")
    assert out.isascii()
    assert out.startswith("pradhaanmantri ne kaha ki")


def test_apply_script_native_keeps_devanagari():
    assert apply_script("नमस्ते", "native") == "नमस्ते"
    assert apply_script("नमस्ते", "roman") == "namaste"
