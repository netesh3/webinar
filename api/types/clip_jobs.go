package types

/* Clips and reels: short videos cut from a session's recording, made on the video server.
 * See api/internal/api/clip_jobs.go (the jobs and their endpoints), api/internal/clips (the
 * captions and the reel rules) and deploy/livekit-hetzner/mixrec/clips.go (the renderer).
 *
 * A clip is one moment (a highlight, or any stretch the host picks); a reel stitches 2-4
 * short moments on one theme into 30-60 seconds with quick cuts. Each is made in one format
 * per job: 9:16 (Reels, Shorts, TikTok), 1:1 (LinkedIn) or 16:9 (YouTube, LinkedIn), with big
 * word-by-word captions and a hook title over the first seconds when asked for. Clips count
 * against the host's recording storage and are deleted with the recording they came from. */

// AIFeatureReels is the ai_usage feature name for planning a recording's suggested reels.
const AIFeatureReels = "reels"

// AIFeatureClipPosts is the ai_usage feature name for writing a clip's suggested post text.
const AIFeatureClipPosts = "clip_posts"

// Formats (Clip.Format): the frame a clip is made in.
const (
	ClipFormatVertical = "9x16" // 1080x1920: Reels, Shorts, TikTok
	ClipFormatSquare   = "1x1"  // 1080x1080: LinkedIn
	ClipFormatWide     = "16x9" // 1920x1080: YouTube, LinkedIn
)

/* Framings (Clip.Framing): how a 16:9 recording fills a 9:16 or 1:1 frame. A recording is
 * one mixed picture (the session's layout as the audience saw it), never a separate camera
 * file, so the speaker cannot be found automatically: "fit" keeps the whole picture over a
 * blurred copy of itself, and the others fill the frame with one part of the picture (the
 * middle, the left or the right) for when a camera fills that part. 16:9 is always whole. */
const (
	ClipFramingFit    = "fit"
	ClipFramingCenter = "center"
	ClipFramingLeft   = "left"
	ClipFramingRight  = "right"
)

// Kinds (Clip.Kind).
const (
	ClipKindClip = "clip"
	ClipKindReel = "reel"
)

// Statuses (Clip.Status).
const (
	ClipQueued     = "queued"
	ClipProcessing = "processing"
	ClipReady      = "ready"
	ClipFailed     = "failed"
)

// Post text statuses (Clip.PostStatus).
const (
	ClipPostPending = "pending"
	ClipPostReady   = "ready"
	ClipPostFailed  = "failed"
	// ClipPostOff is no post text: AI is off for the account or the session.
	ClipPostOff = "off"
)

// Bounds, in seconds and characters.
const (
	// ClipMinSec and ClipMaxSec bound a single-moment clip.
	ClipMinSec = 5
	ClipMaxSec = 120
	// ReelMomentMinSec and ReelMomentMaxSec bound one moment of a reel.
	ReelMomentMinSec = 4
	ReelMomentMaxSec = 25
	// ReelMinSec and ReelMaxSec bound a whole reel (30-60 s is the aim).
	ReelMinSec = 20
	ReelMaxSec = 75
	// ReelMinMoments and ReelMaxMoments bound how many moments a reel stitches.
	ReelMinMoments = 2
	ReelMaxMoments = 4
	// ClipHookMaxRunes is the longest hook title.
	ClipHookMaxRunes = 70
	// ClipTitleMaxRunes is the longest clip title.
	ClipTitleMaxRunes = 100
)

// Platforms (ClipPost.Platform) the suggested post text is written for.
const (
	ClipPlatformReels    = "instagram_reels"
	ClipPlatformShorts   = "youtube_shorts"
	ClipPlatformTikTok   = "tiktok"
	ClipPlatformLinkedIn = "linkedin"
	ClipPlatformYouTube  = "youtube"
)

/* ReelMoment is one stretch a suggested reel stitches. StartSec and EndSec are on the
 * recording's player timeline; PartID is the take it lies in. */
type ReelMoment struct {
	StartSec float64 `json:"startSec"`
	EndSec   float64 `json:"endSec"`
	PartID   string  `json:"partId"`
	// Quote is the first sentence said in it.
	Quote string `json:"quote,omitempty"`
}

/* Reel is one suggested reel: 2-4 short moments on one theme, in the order they play. */
type Reel struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// Hook is the line shown over the first seconds.
	Hook        string       `json:"hook"`
	Why         string       `json:"why"`
	Moments     []ReelMoment `json:"moments"`
	DurationSec float64      `json:"durationSec"`
}

/* ReelsResponse is GET /api/host/webinars/{slug}/recordings/{id}/reels, the suggested reels.
 * Status is as HighlightsResponse's. */
type ReelsResponse struct {
	Status      string `json:"status"`
	Reels       []Reel `json:"reels"`
	GeneratedAt string `json:"generatedAt,omitempty"`
}

// ClipRange is one stretch of a clip, on the recording's player timeline.
type ClipRange struct {
	StartSec float64 `json:"startSec"`
	EndSec   float64 `json:"endSec"`
}

/* ClipPost is the suggested post text for one platform: Title only where the platform has
 * one (YouTube, Shorts), Text the caption or description, Hashtags without the "#". */
type ClipPost struct {
	Platform string   `json:"platform"`
	Title    string   `json:"title,omitempty"`
	Text     string   `json:"text"`
	Hashtags []string `json:"hashtags"`
}

/* CreateClipsRequest is POST …/recordings/{id}/clips: one job per format. Ranges are on the
 * player timeline: one for a clip, 2-4 for a reel (played in the order given). SourceID is
 * the highlight or suggested reel it came from, when it did. */
type CreateClipsRequest struct {
	Kind     string      `json:"kind"`
	SourceID string      `json:"sourceId,omitempty"`
	Title    string      `json:"title"`
	Ranges   []ClipRange `json:"ranges"`
	Formats  []string    `json:"formats"`
	Framing  string      `json:"framing"`
	Captions bool        `json:"captions"`
	Hook     string      `json:"hook"`
}

/* Clip is one clip job and, once made, its file. Status queued (waiting for the video
 * server), processing (Progress 0-100), ready (download it) or failed (Error says why, in
 * plain words). */
type Clip struct {
	ID          string      `json:"id"`
	Kind        string      `json:"kind"`
	SourceID    string      `json:"sourceId,omitempty"`
	Title       string      `json:"title"`
	Format      string      `json:"format"`
	Framing     string      `json:"framing"`
	Captions    bool        `json:"captions"`
	Hook        string      `json:"hook"`
	Ranges      []ClipRange `json:"ranges"`
	DurationSec float64     `json:"durationSec"`
	Status      string      `json:"status"`
	Error       string      `json:"error,omitempty"`
	Progress    int         `json:"progress"`
	SizeBytes   int64       `json:"sizeBytes"`
	Posts       []ClipPost  `json:"posts"`
	PostStatus  string      `json:"postStatus"`
	CreatedAt   string      `json:"createdAt"`
	FinishedAt  string      `json:"finishedAt,omitempty"`
}

// Video server states for clips (ClipServer.State).
const (
	// ClipServerReady is the video server up and free: queued clips start shortly.
	ClipServerReady = "ready"
	// ClipServerBusy is a live session on it: clips wait until it ends.
	ClipServerBusy = "busy"
	// ClipServerWaiting is the video server off until the next session (or "Make it now").
	ClipServerWaiting = "waiting"
	// ClipServerStarting is the video server starting.
	ClipServerStarting = "starting"
)

/* ClipServer is where the queue stands, for the "Waiting for the video server" line. Text is
 * the plain sentence for the host. */
type ClipServer struct {
	State string `json:"state"`
	Text  string `json:"text"`
}

/* ClipsResponse is GET …/recordings/{id}/clips: the recording's clips, newest first, and the
 * video server's state. CanMakeNow is true for an admin when clips are waiting for a server
 * that is off: they may start it to make them (POST /api/admin/clips/make-now). */
type ClipsResponse struct {
	Clips      []Clip     `json:"clips"`
	Server     ClipServer `json:"server"`
	CanMakeNow bool       `json:"canMakeNow"`
	// Available is false when this instance cannot make clips at all (no video server
	// worker or no cloud storage); Reason says so in plain words.
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}

// ClipMakeNowResponse is POST /api/admin/clips/make-now.
type ClipMakeNowResponse struct {
	Queued int    `json:"queued"`
	Text   string `json:"text"`
}
