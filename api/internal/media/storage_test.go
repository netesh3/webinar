package media

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDiskAppendsInOrder(t *testing.T) {
	d := newDisk(t)
	ctx := context.Background()

	// A recording arrives in chunks over its whole duration, so append has to mean
	// append. Overwriting would leave only the last few seconds of a webinar.
	for _, part := range []string{"one-", "two-", "three"} {
		if _, err := d.Append(ctx, "ab/cd/rec.webm", strings.NewReader(part)); err != nil {
			t.Fatalf("append %q: %v", part, err)
		}
	}

	f, size, err := d.Open(ctx, "ab/cd/rec.webm")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	got, err := io.ReadAll(f)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "one-two-three" {
		t.Errorf("read %q, want %q", got, "one-two-three")
	}
	if size != int64(len("one-two-three")) {
		t.Errorf("size = %d, want %d", size, len("one-two-three"))
	}
}

func TestDiskOpenIsSeekable(t *testing.T) {
	d := newDisk(t)
	ctx := context.Background()
	if _, err := d.Append(ctx, "x/y/z.webm", strings.NewReader("0123456789")); err != nil {
		t.Fatal(err)
	}

	// Seeking is what makes a range request possible, and a range request is what
	// makes a recording scrubbable in a browser rather than playable only from the
	// beginning.
	f, _, err := d.Open(ctx, "x/y/z.webm")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.Seek(4, io.SeekStart); err != nil {
		t.Fatalf("seek: %v", err)
	}
	rest, err := io.ReadAll(f)
	if err != nil {
		t.Fatal(err)
	}
	if string(rest) != "456789" {
		t.Errorf("after seeking to 4, read %q", rest)
	}
}

// Keys are generated from UUIDs by the only caller, so this should be
// unreachable. It is tested because "the key is always safe" is exactly the
// assumption that stops being true when somebody adds a second caller, and the
// consequence is writing or reading files anywhere the process can reach.
func TestDiskRefusesKeysThatEscapeTheRoot(t *testing.T) {
	d := newDisk(t)
	ctx := context.Background()

	for _, key := range []string{
		"../escaped.webm",
		"ab/../../escaped.webm",
		"/etc/passwd",
		"",
		`..\escaped.webm`,
		"ab/cd/../../../escaped.webm",
	} {
		if _, err := d.Append(ctx, key, strings.NewReader("nope")); err == nil {
			t.Errorf("Append(%q) was allowed", key)
		}
		if _, _, err := d.Open(ctx, key); err == nil {
			t.Errorf("Open(%q) was allowed", key)
		}
		if err := d.Delete(ctx, key); err == nil {
			t.Errorf("Delete(%q) was allowed", key)
		}
	}

	// Nothing escaped into the parent of the root.
	parent := filepath.Dir(d.root)
	entries, err := os.ReadDir(parent)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), "escaped") {
			t.Fatalf("a file escaped the root: %s", e.Name())
		}
	}
}

func TestDiskMissingObject(t *testing.T) {
	d := newDisk(t)
	if _, _, err := d.Open(context.Background(), "no/such/file.webm"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Open of a missing object = %v, want ErrNotFound", err)
	}
	// Deleting something that is not there is the requested end state.
	if err := d.Delete(context.Background(), "no/such/file.webm"); err != nil {
		t.Errorf("Delete of a missing object = %v, want nil", err)
	}
}

// A directory that cannot be written to has to fail at startup. Discovering it
// when somebody presses record means a webinar recorded nothing.
func TestNewDiskRejectsAnUnwritableRoot(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: every directory is writable")
	}
	root := filepath.Join(t.TempDir(), "locked")
	if err := os.Mkdir(root, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(root, 0o700) })

	if _, err := NewDisk(filepath.Join(root, "recordings")); err == nil {
		t.Error("an unwritable root was accepted")
	}
	if _, err := NewDisk(" "); err == nil {
		t.Error("an empty root was accepted")
	}
}

func newDisk(t *testing.T) *Disk {
	t.Helper()
	// A nested directory so the traversal test has a parent to inspect.
	d, err := NewDisk(filepath.Join(t.TempDir(), "root"))
	if err != nil {
		t.Fatal(err)
	}
	return d
}
