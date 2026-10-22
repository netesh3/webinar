package knowledge

import (
	"strings"
	"unicode"
)

/* The full-text query a question is searched with.
 *
 * Not plainto_tsquery or websearch_to_tsquery: both AND every word together, and with the
 * 'simple' configuration (no stop words, so Hinglish survives) "what is the fee for the
 * course" would only match a chunk containing "what", "is" and "the" as well. Instead the
 * question's content words are OR-ed, each as a prefix ("fee:*" also finds "fees"), and
 * ts_rank orders chunks by how many of them, and how often, they contain. The words common
 * to every question, English and Roman Hindi, are left out so they do not rank by themselves. */

// MaxQueryTerms bounds the words a question contributes.
const MaxQueryTerms = 24

var stopWords = map[string]bool{}

func init() {
	for _, w := range strings.Fields(`
		a an the and or but if then so to of in on at by for from with about as into over under
		is are was were be been being am do does did done have has had having will would shall
		should can could may might must i me my we our you your he she it its they them their
		this that these those there here what which who whom whose when where why how
		not no yes any some all just also very too more most much many please pls plz sir mam
		maam madam hi hello hey thanks thank ok okay get got tell know want need like one
		kya hai hain ka ki ke ko se me mein main mai hum ham aap ap tum tu yeh ye woh wo voh
		kaise kaisa kaisi kab kahan kyu kyun kyon kaun kitna kitni kitne bhi to toh hi na nahi
		nahin aur ya par pe tha thi the ho hoga hogi hoge raha rahi rahe sakte sakta sakti
		karna karte karta karti kare karo kar diya liye lie wala wali wale koi kuch sab ek
		bata batao bataiye batayein please ji
	`) {
		stopWords[w] = true
	}
}

/* Terms is a question's searchable words: lower case, letters and digits only, stop words
 * and one-letter words out, each once, at most MaxQueryTerms. */
func Terms(question string) []string {
	seen := map[string]bool{}
	var out []string
	for _, f := range strings.FieldsFunc(strings.ToLower(question), func(r rune) bool {
		return !(unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsMark(r))
	}) {
		if len([]rune(f)) < 2 || stopWords[f] || seen[f] {
			continue
		}
		seen[f] = true
		out = append(out, f)
		if len(out) == MaxQueryTerms {
			break
		}
	}
	return out
}

/* TSQuery is the to_tsquery('simple', …) text for a question: its terms as prefixes, OR-ed.
 * A plural's singular stands in for it ("fees" is searched as "fee:*", which finds both).
 * "" when the question has no searchable word. Terms hold letters and digits only, so the
 * result cannot carry tsquery syntax of its own. */
func TSQuery(question string) string {
	var parts []string
	for _, t := range Terms(question) {
		if r := []rune(t); len(r) > 3 && r[len(r)-1] == 's' && r[len(r)-2] != 's' {
			t = string(r[:len(r)-1])
		}
		parts = append(parts, t+":*")
	}
	return strings.Join(parts, " | ")
}
