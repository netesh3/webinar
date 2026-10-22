"""Devanagari to Roman Hindi, the way people type Hinglish.

Whisper writes Hindi (and the English words inside Hindi sentences) in Devanagari. Most of
this platform's audience reads Hinglish in Latin letters — "aap kaise hain", not "आप कैसे
हैं" and not the scholarly "āpa kaise haiṃ" — so CAPTIONS_SCRIPT=roman (the default) runs
every caption and transcript line through `to_roman`. Only Devanagari runs are rewritten;
Latin text, digits and punctuation pass through untouched, so English stays English.

A transliteration library (indic-transliteration) produces ITRANS/IAST, which keeps the
inherent vowel everywhere ("karate", "Apa") and spells long vowels with capitals or
diacritics. Neither reads as Hinglish, so this is a small dedicated mapper instead:

  * consonants and vowel signs map to their everyday spellings (ठ th, श sh, ी ee, ू oo);
  * the inherent "a" is dropped where Hindi does not pronounce it (schwa deletion): at the
    end of a word ("बात" baat), and in the middle in a vowel–consonant–a–consonant–vowel
    context, applied right to left ("करते" karte, "समझना" samajhna);
  * word-final long vowels are written short, as they usually are ("क्या" kya, "जी" ji,
    "शुरू" shuru), anusvara and chandrabindu become n (m before p/b/m), and "ें" at the
    end of a word is "ein" ("में" mein);
  * nukta letters become the sounds they stand for (ज़ z, फ़ f, क़ q), and ज्ञ is "gy".

It is a heuristic, not a dictionary: some words come out in a defensible but unusual
spelling. That is the trade for having no per-word data to maintain.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

CONSONANTS = {
    "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n",
    "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
    "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
    "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n", "ऩ": "n",
    "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
    "य": "y", "र": "r", "ऱ": "r", "ल": "l", "ळ": "l", "व": "v",
    "श": "sh", "ष": "sh", "स": "s", "ह": "h",
}
# A consonant followed by NUKTA (precomposed forms are decomposed by NFC).
NUKTA_FORMS = {"क": "q", "ख": "kh", "ग": "gh", "ज": "z", "ड": "r", "ढ": "rh", "फ": "f", "य": "y"}
INDEPENDENT_VOWELS = {
    "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo",
    "ऋ": "ri", "ॠ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au",
    "ऑ": "o", "ऍ": "e", "ॲ": "e", "ऌ": "li",
}
VOWEL_SIGNS = {
    "ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo", "ृ": "ri", "ॄ": "ri",
    "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o", "ॅ": "e", "ॆ": "e", "ॊ": "o",
}
VIRAMA = "्"
NUKTA = "़"
ANUSVARA = "ं"
CHANDRABINDU = "ँ"
VISARGA = "ः"
OTHER = {
    "।": ".", "॥": ".", "ॐ": "om", "ऽ": "", "॰": ".",
    "०": "0", "१": "1", "२": "2", "३": "3", "४": "4",
    "५": "5", "६": "6", "७": "7", "८": "8", "९": "9",
}
ZERO_WIDTH = {"‌", "‍"}

_DEVANAGARI = re.compile(r"[ऀ-ॿ‌‍]+")


@dataclass
class _Syllable:
    cons: list[str]  # romanised consonants of the cluster, in order
    vowel: str | None  # romanised vowel; None = inherent schwa
    dead: bool = False  # explicit virama at the end of the word: no vowel at all
    nasal: bool = False
    visarga: bool = False
    deleted: bool = False  # inherent schwa dropped

    @property
    def onset(self) -> str:
        return "".join(self.cons)


def _parse(word: str) -> tuple[list[_Syllable], str]:
    """Split one Devanagari word into syllables. Returns (syllables, trailing literal)."""
    syls: list[_Syllable] = []
    i, n = 0, len(word)
    while i < n:
        ch = word[i]
        if ch in ZERO_WIDTH:
            i += 1
            continue
        if ch in CONSONANTS:
            cluster: list[str] = []
            while i < n and word[i] in CONSONANTS:
                base = word[i]
                i += 1
                if i < n and word[i] == NUKTA:
                    cluster.append(NUKTA_FORMS.get(base, CONSONANTS[base]))
                    i += 1
                else:
                    cluster.append(CONSONANTS[base])
                while i < n and word[i] in ZERO_WIDTH:
                    i += 1
                if i < n and word[i] == VIRAMA and i + 1 < n and word[i + 1] in CONSONANTS:
                    i += 1  # conjunct: the next consonant joins this cluster
                    continue
                break
            syl = _Syllable(cons=_conjunct(cluster), vowel=None)
            if i < n and word[i] == VIRAMA:
                syl.dead = True
                i += 1
            elif i < n and word[i] in VOWEL_SIGNS:
                syl.vowel = VOWEL_SIGNS[word[i]]
                i += 1
            syls.append(syl)
        elif ch in INDEPENDENT_VOWELS:
            syls.append(_Syllable(cons=[], vowel=INDEPENDENT_VOWELS[ch]))
            i += 1
        elif ch in (ANUSVARA, CHANDRABINDU):
            if syls:
                syls[-1].nasal = True
            i += 1
        elif ch == VISARGA:
            if syls:
                syls[-1].visarga = True
            i += 1
        elif ch == NUKTA or ch == VIRAMA or ch in VOWEL_SIGNS:
            i += 1  # stray mark with nothing to attach to
        else:
            # Danda, digits, OM: close the word here and emit them literally.
            return syls, "".join(OTHER.get(c, "") for c in word[i:])
    return syls, ""


def _conjunct(cluster: list[str]) -> list[str]:
    # ज्ञ is said "gy" in Hindi, not "jn".
    out: list[str] = []
    for c in cluster:
        if c == "n" and out and out[-1] == "j" and len(cluster) >= 2:
            out[-1] = "g"
            out.append("y")
        else:
            out.append(c)
    return out


def _delete_schwas(syls: list[_Syllable]) -> None:
    n = len(syls)
    if n == 0:
        return
    last = syls[-1]
    # Word-final: dropped unless the word is one syllable ("न" na) or ends in a conjunct
    # closing on r, y or v ("मंत्र" mantra, "सत्य" satya), where Hindi keeps it. Other
    # final conjuncts lose it ("दोस्त" dost, "प्रोडक्ट" prodakt).
    keeps = len(last.cons) > 1 and last.cons[-1] in ("r", "y", "v")
    if n > 1 and last.vowel is None and not last.dead and not keeps and not last.nasal:
        last.deleted = True

    def has_vowel(s: _Syllable) -> bool:
        return not s.dead and not s.deleted

    # Medial, right to left: V C(a) C V -> V C C V. Only between single consonants: a
    # schwa next to a conjunct is said ("नमस्ते" namaste, "धन्यवाद" dhanyavaad), because
    # dropping it would stack three consonants.
    for i in range(n - 2, 0, -1):
        s = syls[i]
        if s.vowel is not None or s.dead or s.nasal or s.visarga or len(s.cons) != 1:
            continue
        prev, nxt = syls[i - 1], syls[i + 1]
        if has_vowel(prev) and len(nxt.cons) == 1 and has_vowel(nxt):
            s.deleted = True


def _render(syls: list[_Syllable]) -> str:
    out: list[str] = []
    n = len(syls)
    for i, s in enumerate(syls):
        out.append(s.onset)
        if s.dead or s.deleted:
            continue
        vowel = "a" if s.vowel is None else s.vowel
        final = i == n - 1
        # Word-final long vowels are written short ("क्या" kya, "हुआ" hua, "जी" ji), except
        # a word that is only that vowel ("आ" aa).
        if final and (n > 1 or s.cons):
            if vowel == "aa":
                vowel = "a"
            elif vowel == "ee":
                vowel = "i"
            elif vowel == "oo" and not s.nasal:
                vowel = "u"
        if s.nasal:
            if final and vowel == "e":
                vowel = "ei"
            nxt = syls[i + 1].onset if i + 1 < n else ""
            vowel += "m" if nxt[:1] in ("p", "b", "m") else "n"
        if s.visarga:
            vowel += "h"
        out.append(vowel)
    return "".join(out)


def _word(word: str) -> str:
    syls, tail = _parse(word)
    _delete_schwas(syls)
    return _render(syls) + tail


def to_roman(text: str) -> str:
    """Romanise every Devanagari run in `text`; everything else is left exactly as it was."""
    if not text:
        return text
    text = unicodedata.normalize("NFC", text)
    if not _DEVANAGARI.search(text):
        return text

    def repl(m: re.Match[str]) -> str:
        run = m.group(0)
        # A run can hold punctuation (danda) between words; split on it so each word gets
        # its own schwa rules.
        parts = re.split(r"([।॥॰०-९ॐऽ]+)", run)
        rendered = []
        for part in parts:
            if not part:
                continue
            if re.fullmatch(r"[।॥॰०-९ॐऽ]+", part):
                rendered.append("".join(OTHER.get(c, "") for c in part))
            else:
                rendered.append(_word(part))
        return "".join(rendered)

    out = _DEVANAGARI.sub(repl, text)
    # "हैं।" -> "hain." ; tidy spaces a danda left before itself.
    return re.sub(r"\s+\.", ".", out)


def apply_script(text: str, script: str) -> str:
    return to_roman(text) if script == "roman" else text
