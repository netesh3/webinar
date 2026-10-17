package engage

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/netkumar/webcast/api/internal/engage/crmstore"
	"github.com/netkumar/webcast/api/internal/wa"
)

/* MediaBlobs is the part of the app's media store the CRM keeps WhatsApp
 * attachments in. cmd/server passes the recordings store; declaring the methods
 * here keeps the CRM from importing internal/media (see boundary_test.go). */
type MediaBlobs interface {
	Append(ctx context.Context, key string, r io.Reader) (int64, error)
	Finalize(ctx context.Context, key string) error
	Open(ctx context.Context, key string) (io.ReadSeekCloser, int64, error)
	Delete(ctx context.Context, key string) error
}

// UseMediaStore turns on keeping our own copy of WhatsApp attachments.
func (s *Module) UseMediaStore(b MediaBlobs) { s.blobs = b }

const (
	// mediaCopyBatch is how many attachments one tick downloads.
	mediaCopyBatch = 10
	// mediaCopyBudget bounds one tick's downloads so the rest of the pass keeps its time.
	mediaCopyBudget = 20 * time.Second
	// maxCopiedMedia is Meta's limit for images, stickers and audio. Larger video
	// and documents are not copied; they stream from Graph while Meta has them.
	maxCopiedMedia = 16 << 20
	// mediaExpireBatch is how many copies one retention pass deletes per query.
	mediaExpireBatch = 500
)

func mediaKey(hostID, messageID string) string { return "wa/" + hostID + "/" + messageID }

// copyWhatsAppMedia downloads attachments that arrived recently and are not copied yet.
func (s *Module) copyWhatsAppMedia(ctx context.Context) {
	if s.blobs == nil || s.whatsapp == nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, mediaCopyBudget)
	defer cancel()
	due, err := s.store.PendingMediaFetches(ctx, mediaCopyBatch)
	if err != nil {
		s.log.Error("whatsapp media copy: could not list", "error", err)
		return
	}
	for _, f := range due {
		if ctx.Err() != nil {
			return
		}
		s.copyOneMedia(ctx, f)
	}
}

func (s *Module) copyOneMedia(ctx context.Context, f crmstore.MediaFetch) {
	fail := func(err error, gone, final bool) {
		if mErr := s.store.MarkMediaFailed(ctx, f.MessageID, f.HostID, err.Error(), gone, final); mErr != nil {
			s.log.Error("whatsapp media copy: could not record failure", "error", mErr, "message", f.MessageID)
		}
	}
	file, err := s.whatsapp.OpenMedia(ctx, f.Token, f.MediaID)
	if err != nil {
		s.noteWhatsAppError(ctx, f.HostID, f.Token, err)
		fail(err, errors.Is(err, wa.ErrMediaGone), false)
		return
	}
	defer file.Body.Close()
	body, err := io.ReadAll(io.LimitReader(file.Body, maxCopiedMedia+1))
	if err != nil {
		fail(err, false, false)
		return
	}
	if len(body) > maxCopiedMedia {
		fail(errors.New("attachment too large to copy"), false, true)
		return
	}
	mime := strings.TrimSpace(file.MimeType)
	if mime == "" {
		mime = f.MimeType
	}
	key := mediaKey(f.HostID, f.MessageID)
	// Append adds to an existing object, so a half-written earlier try goes first.
	if err := s.blobs.Delete(ctx, key); err != nil {
		fail(err, false, false)
		return
	}
	if _, err := s.blobs.Append(ctx, key, bytes.NewReader(body)); err != nil {
		fail(err, false, false)
		return
	}
	if err := s.blobs.Finalize(ctx, key); err != nil {
		fail(err, false, false)
		return
	}
	if err := s.store.MarkMediaStored(ctx, f.MessageID, f.HostID, key, mime, int64(len(body))); err != nil {
		// Usually the message was deleted mid-download (a contact erased): a file no
		// row names would never be cleaned up, so it goes too.
		s.log.Error("whatsapp media copy: could not record", "error", err, "message", f.MessageID)
		if dErr := s.blobs.Delete(ctx, key); dErr != nil {
			s.log.Error("whatsapp media copy: could not remove unrecorded file", "error", dErr, "key", key)
		}
	}
}

// expireWhatsAppMedia deletes copies past retention, once a day.
func (s *Module) expireWhatsAppMedia(ctx context.Context) {
	if s.blobs == nil {
		return
	}
	if _, due, err := s.store.TryLease(ctx, "wa-media-retention", 24*time.Hour); err != nil || !due {
		return
	}
	for {
		batch, err := s.store.MediaCopiesStoredBefore(ctx, time.Now().Add(-crmstore.MediaCopyRetention), mediaExpireBatch)
		if err != nil {
			s.log.Error("whatsapp media retention: could not list", "error", err)
			return
		}
		for _, e := range batch {
			if err := s.blobs.Delete(ctx, e.Key); err != nil {
				s.log.Error("whatsapp media retention: delete failed", "error", err, "key", e.Key)
				return
			}
			if err := s.store.MarkMediaCopyExpired(ctx, e.MessageID); err != nil {
				s.log.Error("whatsapp media retention: could not record", "error", err, "message", e.MessageID)
				return
			}
		}
		if len(batch) > 0 {
			s.log.Info("whatsapp media retention: deleted copies", "files", len(batch))
		}
		if len(batch) < mediaExpireBatch || ctx.Err() != nil {
			return
		}
	}
}
