package types

/* Connect Zoom, Connect YouTube and the Drive picker from the desktop and mobile apps
 * (29 Oct 2026). See api/internal/api/app_connect.go. */

// AppConnectTicketRequest is POST /api/host/integrations/{zoom|youtube|drive}/app-ticket.
type AppConnectTicketRequest struct {
	// App is "desktop", "ios" or "android".
	App string `json:"app"`
	// Return is the same-site path to come back to once connected.
	Return string `json:"return,omitempty"`
}

// AppConnectTicketResponse is where the system browser goes, and the attempt's id.
type AppConnectTicketResponse struct {
	// StartURL is an absolute URL on the API's own origin with the one-time ticket in it.
	StartURL string `json:"startUrl"`
	// ID names the attempt. The room polls a Drive pick by it.
	ID string `json:"id"`
}

// AppConnectCompleteRequest is POST /api/host/integrations/app/complete.
type AppConnectCompleteRequest struct {
	// Code is the completion code from webinarliv://connect/complete.
	Code string `json:"code"`
}

// AppConnectCompleteResponse says what was connected and where to go.
type AppConnectCompleteResponse struct {
	Provider string `json:"provider"`
	// Next is a same-site path, with the result the settings page shows (?zoom=connected).
	Next string `json:"next"`
}

// AppDrivePickRequest is POST /api/integrations/drive/app-pick, from the picker page in the
// system browser.
type AppDrivePickRequest struct {
	FileID   string `json:"fileId"`
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	MimeType string `json:"mimeType"`
	// AccessToken is the short-lived drive.readonly token the picker page got from Google.
	AccessToken string `json:"accessToken"`
}

// AppDrivePickResponse is GET /api/host/integrations/drive/app-pick/{id}: "pending" until
// the system browser has handed a pick over, then the pick, once.
type AppDrivePickResponse struct {
	Status      string `json:"status"`
	FileID      string `json:"fileId,omitempty"`
	Name        string `json:"name,omitempty"`
	Size        int64  `json:"size,omitempty"`
	MimeType    string `json:"mimeType,omitempty"`
	AccessToken string `json:"accessToken,omitempty"`
}
