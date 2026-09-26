package engage_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

/* The module boundary, checked rather than hoped for.
 *
 * The webinar API (internal/api) and the CRM (internal/engage) meet only through the
 * api.Engage interface, wired in cmd/server. These rules are what keep that true when
 * somebody is in a hurry: a direct import in either direction compiles fine, and would
 * quietly make the CRM impossible to switch off or lift out. See docs/engage/MODULES.md.
 *
 * Tests (_test.go) are exempt on the api side: the integration harness boots the real app,
 * CRM included, the same way main does.
 */

const mod = "github.com/netkumar/webcast/api/"

type rule struct {
	dir       string   // relative to api/
	forbidden []string // import path prefixes, relative to the module
	why       string
}

var rules = []rule{
	{"internal/api", []string{"internal/engage", "internal/wa"},
		"webinar code reaches the CRM only through the Engage interface"},
	{"internal/store", []string{"internal/engage", "internal/wa", "internal/api"},
		"the core store knows nothing about the CRM; its SQL is in engage/crmstore"},
	{"internal/engage", []string{"internal/api", "internal/lk", "internal/media", "internal/yt"},
		"the CRM does not import the webinar API or its media/SFU/YouTube clients"},
	{"internal/authctx", []string{"internal/api", "internal/engage"},
		"authctx is shared by both modules and imports neither"},
	{"internal/notify", []string{"internal/api", "internal/engage"},
		"notify is shared by both modules and imports neither"},
}

func TestModuleBoundary(t *testing.T) {
	root := filepath.Join("..", "..") // api/
	for _, r := range rules {
		err := filepath.WalkDir(filepath.Join(root, r.dir), func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(path, ".go") {
				return nil
			}
			if r.dir == "internal/api" && strings.HasSuffix(path, "_test.go") {
				return nil
			}
			f, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
			if err != nil {
				return err
			}
			for _, imp := range f.Imports {
				p := strings.Trim(imp.Path.Value, `"`)
				for _, bad := range r.forbidden {
					if p == mod+bad || strings.HasPrefix(p, mod+bad+"/") {
						rel, _ := filepath.Rel(root, path)
						t.Errorf("%s imports %s: %s", rel, p, r.why)
					}
				}
			}
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", r.dir, err)
		}
	}
}

/* The CRM's SQL writes only what it owns. A crmstore statement that INSERTs, UPDATEs or
 * DELETEs a webinar table would make "switch the CRM off" leave the webinar product in a
 * state it did not put itself in. Reads are fine: the CRM is about webinar registrants.
 *
 * Only string literals are inspected (parsed with go/ast), so prose in comments does not
 * count, and each literal is matched as SQL rather than as words. */
var writeRe = regexp.MustCompile(`(?i)\b(?:insert\s+into|update|delete\s+from)\s+([a-z_][a-z0-9_]*)`)

func TestCRMStoreWritesOnlyItsOwnTables(t *testing.T) {
	owned := map[string]bool{"notifications": true, "users": true} // its own rows / whatsapp_* columns
	files, err := filepath.Glob(filepath.Join("crmstore", "*.go"))
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(f, func(n ast.Node) bool {
			lit, ok := n.(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			sql, err := strconv.Unquote(lit.Value)
			if err != nil {
				return true
			}
			for _, m := range writeRe.FindAllStringSubmatch(sql, -1) {
				table := strings.ToLower(m[1])
				if strings.HasPrefix(table, "crm_") || owned[table] || table == "set" {
					continue
				}
				t.Errorf("%s writes %q: the CRM writes crm_* tables, its own notifications rows and users.whatsapp_* only", path, table)
			}
			return true
		})
	}
}
