package api

import (
	"time"

	"github.com/netkumar/webcast/api/types"
)

func recordingExpiresAt(createdAt string, days int) string {
	if days <= 0 || createdAt == "" {
		return ""
	}
	t, err := time.Parse(time.RFC3339, createdAt)
	if err != nil {
		t, err = time.Parse(time.RFC3339Nano, createdAt)
		if err != nil {
			return ""
		}
	}
	return t.Add(time.Duration(days) * 24 * time.Hour).UTC().Format(time.RFC3339)
}

func (s *Server) stampRecording(rec *types.Recording) {
	days := s.cfg.RecordingsRetentionDays
	rec.RetentionDays = days
	rec.ExpiresAt = recordingExpiresAt(rec.CreatedAt, days)
}

func (s *Server) stampPublicRecording(rec *types.PublicRecording) {
	days := s.cfg.RecordingsRetentionDays
	rec.RetentionDays = days
	rec.ExpiresAt = recordingExpiresAt(rec.CreatedAt, days)
}

func (s *Server) stampRecordings(list []types.Recording) {
	for i := range list {
		s.stampRecording(&list[i])
	}
}
