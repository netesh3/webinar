package engage

import (
	"fmt"
	"strings"
)

/* Template names.
 *
 * Meta allows lowercase letters, digits and underscores in a template's name, up to 512
 * characters. A template written here is named from the title the host typed, so they
 * recognise it here and in WhatsApp Manager. web/engage/template-name.ts follows the
 * same rules; keep the two in step (their tests share cases).
 */

// templateNameMax is well under Meta's 512: the name is also what a host reads in
// every list and picker.
const templateNameMax = 60

/* normaliseTemplateName turns a title into a name Meta accepts. It lowercases the
 * title, turns spaces and hyphens into underscores, and drops anything else outside
 * [a-z0-9_]. Runs of underscores collapse, and underscores are trimmed from both ends.
 * "t_" goes in front when the result does not start with a letter. At most 60
 * characters. Empty when nothing usable is left. */
func normaliseTemplateName(title string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(title)) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_':
			b.WriteRune(r)
		case r == ' ' || r == '-':
			b.WriteByte('_')
		}
	}
	name := collapseUnderscores(b.String())
	if name == "" {
		return ""
	}
	if name[0] < 'a' || name[0] > 'z' {
		name = "t_" + name
	}
	if len(name) > templateNameMax {
		name = strings.TrimRight(name[:templateNameMax], "_")
	}
	return name
}

func collapseUnderscores(s string) string {
	var b strings.Builder
	prev := false
	for i := 0; i < len(s); i++ {
		under := s[i] == '_'
		if under && prev {
			continue
		}
		prev = under
		b.WriteByte(s[i])
	}
	return strings.Trim(b.String(), "_")
}

/* nextFreeTemplateName returns the first of name_2, name_3, … that taken says is
 * free. The suffix stays inside the length limit. */
func nextFreeTemplateName(name string, taken func(string) bool) string {
	for n := 2; ; n++ {
		suffix := fmt.Sprintf("_%d", n)
		base := name
		if len(base)+len(suffix) > templateNameMax {
			base = strings.TrimRight(base[:templateNameMax-len(suffix)], "_")
		}
		if c := base + suffix; !taken(c) {
			return c
		}
	}
}
