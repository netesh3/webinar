package replay

import (
	"strconv"
	"strings"

	"github.com/netkumar/webcast/api/types"
)

/* The host's curation list, paged. A long session is thousands of items, so the Setup tab
 * reads them a page at a time, by filter, search and offset into the video. The timeline is
 * built whole either way (it is bounded, see store.ReplaySource); this only narrows it. */

const (
	DefaultPageSize = 50
	MaxPageSize     = 200
)

// FilterOf is the filter an item kind belongs to.
func FilterOf(kind string) string {
	switch kind {
	case KindChat:
		return types.ReplayFilterChat
	case KindQuestion, KindAnswer:
		return types.ReplayFilterQA
	case KindPoll, KindPollClose:
		return types.ReplayFilterPolls
	case KindReaction:
		return types.ReplayFilterReactions
	}
	return ""
}

// ValidFilter reports whether f is a filter; "" is all.
func ValidFilter(f string) bool {
	switch f {
	case "", types.ReplayFilterAll, types.ReplayFilterChat, types.ReplayFilterQA,
		types.ReplayFilterPolls, types.ReplayFilterReactions:
		return true
	}
	return false
}

// Matches reports whether an item is in the filter and contains the search (any case).
func Matches(it types.ReplayItem, filter, q string) bool {
	if filter != "" && filter != types.ReplayFilterAll && FilterOf(it.Kind) != filter {
		return false
	}
	q = strings.ToLower(strings.TrimSpace(q))
	if q == "" {
		return true
	}
	hay := []string{it.Text, it.Name}
	if it.Poll != nil {
		hay = append(hay, it.Poll.Question)
		hay = append(hay, it.Poll.Options...)
	}
	for _, r := range it.Reactions {
		hay = append(hay, r.Emoji)
	}
	for _, h := range hay {
		if strings.Contains(strings.ToLower(h), q) {
			return true
		}
	}
	return false
}

// CountItems is how many items each filter holds, and how many are hidden.
func CountItems(items []types.ReplayItem) types.ReplayCounts {
	var c types.ReplayCounts
	for _, it := range items {
		c.All++
		if it.Hidden {
			c.Hidden++
		}
		switch FilterOf(it.Kind) {
		case types.ReplayFilterChat:
			c.Chat++
		case types.ReplayFilterQA:
			c.QA++
		case types.ReplayFilterPolls:
			c.Polls++
		case types.ReplayFilterReactions:
			c.Reactions++
		}
	}
	return c
}

/* Page is one page of the preview. at ≥ 0 (and no cursor) jumps: the page starts at the first
 * matching item at or after that offset — at the last item if there is none. The cursor
 * is an offset among the matching items; one that is not a number starts at the top. */
func Page(items []types.ReplayItem, filter, q string, at int64, cursor string, limit int) types.ReplayPage {
	if limit <= 0 {
		limit = DefaultPageSize
	}
	if limit > MaxPageSize {
		limit = MaxPageSize
	}
	matching := make([]types.ReplayItem, 0, len(items))
	for _, it := range items {
		if Matches(it, filter, q) {
			matching = append(matching, it)
		}
	}
	offset := 0
	if n, err := strconv.Atoi(cursor); cursor != "" && err == nil && n > 0 {
		offset = n
	} else if cursor == "" && at >= 0 {
		offset = len(matching)
		for i, it := range matching {
			if it.AtMs >= at {
				offset = i
				break
			}
		}
		if offset >= len(matching) && len(matching) > 0 {
			offset = len(matching) - 1
		}
	}
	if offset > len(matching) {
		offset = len(matching)
	}
	end := min(offset+limit, len(matching))
	page := types.ReplayPage{
		Items:  append([]types.ReplayItem{}, matching[offset:end]...),
		Total:  len(matching),
		Offset: offset,
		Counts: CountItems(items),
	}
	if end < len(matching) {
		page.NextCursor = strconv.Itoa(end)
	}
	if offset > 0 {
		page.PrevCursor = strconv.Itoa(max(0, offset-limit))
	}
	return page
}

// KeysMatching is the distinct curation keys of the items in the filter and search.
func KeysMatching(items []types.ReplayItem, filter, q string) []string {
	seen := map[string]bool{}
	var out []string
	for _, it := range items {
		if it.Key == "" || seen[it.Key] || !Matches(it, filter, q) {
			continue
		}
		seen[it.Key] = true
		out = append(out, it.Key)
	}
	return out
}
