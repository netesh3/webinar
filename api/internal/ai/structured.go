package ai

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

/* Structured output: one JSON object, the same shape whichever provider answered.
 *
 * OpenAI (and any provider flagged structuredOutput) is sent the schema as
 * response_format json_schema with strict:true, and the model is constrained to it.
 * The free providers mostly are not, so they are asked in words — "reply with JSON
 * only, matching this schema" — and the reply is read tolerantly: code fences and a
 * sentence of preamble are skipped, the first complete JSON object is taken.
 *
 * Either way the result is validated here before a caller sees it, because "strict"
 * on one provider is not a guarantee about the next. A reply that does not validate
 * is a failure of that provider for this request (not benched), and the chain moves
 * on. A caller therefore gets JSON that matches, or an error.
 *
 * The validator covers the subset of JSON Schema these features use: type (object,
 * array, string, integer, number, boolean), properties, required, items, minItems,
 * maxItems, minLength, maxLength and enum. That is also the subset OpenAI's strict
 * mode is happy with, which keeps the two honest with each other.
 */

// Schema is a named JSON Schema for Request.Schema.
type Schema struct {
	// Name identifies it to the provider: a-z, 0-9, _ and -.
	Name string
	// JSON is the schema document. Strict mode wants every object to list all its
	// properties in required and set additionalProperties false.
	JSON json.RawMessage

	parsed map[string]any
}

// NewSchema parses raw once, so a malformed schema is a startup panic in a test
// rather than every request failing.
func NewSchema(name string, raw string) *Schema {
	var parsed map[string]any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		panic(fmt.Sprintf("ai: schema %s: %v", name, err))
	}
	var compact bytes.Buffer
	_ = json.Compact(&compact, []byte(raw))
	return &Schema{Name: name, JSON: compact.Bytes(), parsed: parsed}
}

// instruct is the in-words request for providers without response_format: the
// schema appended to the system prompt (or a system prompt added). Never mutates msgs.
func (s *Schema) instruct(msgs []Message) []Message {
	note := "Reply with one JSON object and nothing else: no prose before or after it, no code fences. " +
		"It must match this JSON Schema exactly:\n" + string(s.JSON)
	out := make([]Message, 0, len(msgs)+1)
	if len(msgs) > 0 && msgs[0].Role == "system" {
		out = append(out, Message{Role: "system", Content: msgs[0].Content + "\n\n" + note})
		out = append(out, msgs[1:]...)
		return out
	}
	out = append(out, Message{Role: "system", Content: note})
	return append(out, msgs...)
}

// Extract finds the JSON object in a reply, validates it, and returns it compacted.
func (s *Schema) Extract(text string) (string, error) {
	raw, err := extractObject(text)
	if err != nil {
		return "", err
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return "", err
	}
	if s.parsed != nil {
		if err := validate(s.parsed, v, "$"); err != nil {
			return "", err
		}
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return "", err
	}
	return compact.String(), nil
}

// extractObject is the first complete JSON object in text, wherever it starts.
func extractObject(text string) ([]byte, error) {
	for i := 0; i < len(text); i++ {
		if text[i] != '{' {
			continue
		}
		dec := json.NewDecoder(strings.NewReader(text[i:]))
		var raw json.RawMessage
		if err := dec.Decode(&raw); err == nil {
			return raw, nil
		}
	}
	return nil, errors.New("no JSON object in the reply")
}

func validate(schema map[string]any, v any, path string) error {
	if enum, ok := schema["enum"].([]any); ok {
		found := false
		for _, e := range enum {
			if e == v {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("%s: not one of the allowed values", path)
		}
	}
	typ, _ := schema["type"].(string)
	switch typ {
	case "object":
		obj, ok := v.(map[string]any)
		if !ok {
			return fmt.Errorf("%s: want an object", path)
		}
		props, _ := schema["properties"].(map[string]any)
		if req, ok := schema["required"].([]any); ok {
			for _, k := range req {
				name, _ := k.(string)
				if _, present := obj[name]; !present {
					return fmt.Errorf("%s.%s: missing", path, name)
				}
			}
		}
		for name, sub := range props {
			val, present := obj[name]
			sm, ok := sub.(map[string]any)
			if !present || !ok {
				continue
			}
			if err := validate(sm, val, path+"."+name); err != nil {
				return err
			}
		}
	case "array":
		arr, ok := v.([]any)
		if !ok {
			return fmt.Errorf("%s: want an array", path)
		}
		if n, ok := num(schema["minItems"]); ok && float64(len(arr)) < n {
			return fmt.Errorf("%s: want at least %v items, got %d", path, n, len(arr))
		}
		if n, ok := num(schema["maxItems"]); ok && float64(len(arr)) > n {
			return fmt.Errorf("%s: want at most %v items, got %d", path, n, len(arr))
		}
		if items, ok := schema["items"].(map[string]any); ok {
			for i, el := range arr {
				if err := validate(items, el, fmt.Sprintf("%s[%d]", path, i)); err != nil {
					return err
				}
			}
		}
	case "string":
		str, ok := v.(string)
		if !ok {
			return fmt.Errorf("%s: want a string", path)
		}
		n := float64(utf8.RuneCountInString(str))
		if m, ok := num(schema["minLength"]); ok && n < m {
			return fmt.Errorf("%s: too short", path)
		}
		if m, ok := num(schema["maxLength"]); ok && n > m {
			return fmt.Errorf("%s: too long", path)
		}
	case "integer":
		f, ok := v.(float64)
		if !ok || f != float64(int64(f)) {
			return fmt.Errorf("%s: want an integer", path)
		}
	case "number":
		if _, ok := v.(float64); !ok {
			return fmt.Errorf("%s: want a number", path)
		}
	case "boolean":
		if _, ok := v.(bool); !ok {
			return fmt.Errorf("%s: want true or false", path)
		}
	}
	return nil
}

func num(v any) (float64, bool) {
	f, ok := v.(float64)
	return f, ok
}
