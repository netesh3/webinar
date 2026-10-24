package api

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/netkumar/webcast/api/internal/config"
	"github.com/netkumar/webcast/api/internal/doapi"
)

/* The captions box's Grafana Cloud settings (captionsGrafana): in the user data only when all five
 * are usable, in a file of their own (never the agent's captions.env), and never in a log. */

const capGrafanaToken = "glc_eyJvIjoiMTIzIiwibiI6ImNhcHRpb25zIn0="

func capGrafana() config.BoxGrafana {
	return config.BoxGrafana{
		PromURL: "https://prometheus-prod-43-prod-ap-south-1.grafana.net/api/prom/push", PromUser: "1234567",
		LokiURL: "https://logs-prod-028.grafana.net/loki/api/v1/push", LokiUser: "765432", Token: capGrafanaToken,
	}
}

func capBoxConfig() (config.SFUBox, config.LiveKitProject) {
	c := config.SFUBox{Project: "do-blr", Region: "blr1", Repo: "netesh3/webinar", Ref: "main",
		Captions: config.CaptionsBox{On: true, Name: "captions-blr-1", Size: "s-2vcpu-4gb",
			SnapshotTag: "webinar-captions-image", Tags: []string{"webinar-captions"}, ManagedTag: "webinar-captions-ondemand",
			Model: "base.en", APIURL: "https://webinarliv.test"}.WithDefaults()}
	return c, config.LiveKitProject{ID: "do-blr", URL: "wss://lk.test", Key: "APIboxkey", Secret: "boxsecret123"}
}

func TestCaptionsUserDataGrafana(t *testing.T) {
	c, proj := capBoxConfig()
	secret := strings.Repeat("s", 40)

	// Unset: no Grafana lines at all, so captions-boot.sh starts no Alloy.
	ud, err := captionsUserData(c, proj, secret, "webinar-captions")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(ud, "GRAFANA") || strings.Contains(ud, captionsGrafanaFile) {
		t.Errorf("unset Grafana still in the captions user data:\n%s", ud)
	}

	c.Grafana = capGrafana()
	if ud, err = captionsUserData(c, proj, secret, "webinar-captions"); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"(umask 077; cat >" + captionsGrafanaFile + " <<'WEBINARLIV_GRAFANA'\n",
		"\nGRAFANA_CLOUD_PROM_URL=https://prometheus-prod-43-prod-ap-south-1.grafana.net/api/prom/push\n",
		"\nGRAFANA_CLOUD_PROM_USER=1234567\n",
		"\nGRAFANA_CLOUD_LOKI_URL=https://logs-prod-028.grafana.net/loki/api/v1/push\n",
		"\nGRAFANA_CLOUD_LOKI_USER=765432\n",
		"\nGRAFANA_CLOUD_TOKEN=" + capGrafanaToken + "\nWEBINARLIV_GRAFANA\n)\n",
	} {
		if !strings.Contains(ud, want) {
			t.Errorf("captions user data lacks %q:\n%s", want, ud)
		}
	}
	// Once, in the Grafana file, after the agent's env file is closed and before the boot script.
	agentEnd := strings.Index(ud, "\nWEBINARLIV_CAPTIONS\n")
	at := strings.Index(ud, "GRAFANA_CLOUD_TOKEN=")
	if strings.Count(ud, capGrafanaToken) != 1 || agentEnd < 0 || at < agentEnd || at > strings.Index(ud, "exec ") {
		t.Errorf("token placement:\n%s", ud)
	}
	if bash, err := exec.LookPath("bash"); err == nil {
		f := t.TempDir() + "/ud.sh"
		if err := os.WriteFile(f, []byte(ud), 0o600); err != nil {
			t.Fatal(err)
		}
		if out, err := exec.Command(bash, "-n", f).CombinedOutput(); err != nil { // #nosec G204 -- test, fixed args
			t.Errorf("bash -n: %v %s", err, out)
		}
	}
	for _, bad := range []string{"set -x", "echo $GRAFANA", "echo \"$GRAFANA"} {
		if strings.Contains(ud, bad) {
			t.Errorf("captions user data has %q", bad)
		}
	}

	// Four of five, or a value that is not plain: left out, and the box still created.
	for _, g := range []config.BoxGrafana{
		{PromURL: c.Grafana.PromURL, PromUser: "1", LokiURL: c.Grafana.LokiURL, LokiUser: "2"},
		{PromURL: c.Grafana.PromURL, PromUser: "1", LokiURL: c.Grafana.LokiURL, LokiUser: "2", Token: "tok\nWEBINARLIV_GRAFANA\nreboot"},
	} {
		c.Grafana = g
		ud, err := captionsUserData(c, proj, secret, "webinar-captions")
		if err != nil || strings.Contains(ud, "GRAFANA") {
			t.Errorf("unusable Grafana %q: err %v\n%s", g.PromUser, err, ud)
		}
	}
}

// capCloud is a boxCloud that answers the create path only, recording what it was asked.
type capCloud struct {
	boxCloud
	created []doapi.CreateDroplet
}

func (f *capCloud) LatestSnapshot(context.Context, string, string, string) (doapi.Image, error) {
	return doapi.Image{ID: 7, Name: "webinar-captions-image-1"}, nil
}

func (f *capCloud) CreateDroplet(_ context.Context, req doapi.CreateDroplet) (doapi.Droplet, error) {
	f.created = append(f.created, req)
	return doapi.Droplet{ID: 42, Status: "new"}, nil
}

/* Creating the captions droplet sends the token to DigitalOcean in the user data and nowhere
 * else: not in any log line, at any level. */
func TestCaptionsBoxCreateNeverLogsTheGrafanaToken(t *testing.T) {
	c, proj := capBoxConfig()
	c.Grafana = capGrafana()
	var logs bytes.Buffer
	cloud := &capCloud{}
	s := &Server{
		cfg: config.Config{CaptionsSecret: strings.Repeat("s", 40), LiveKitProjects: []config.LiveKitProject{proj}},
		log: slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
		box: &boxManager{cfg: c, cloud: cloud},
	}
	if _, err := s.captionsBoxCreate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(cloud.created) != 1 || !strings.Contains(cloud.created[0].UserData, "GRAFANA_CLOUD_TOKEN="+capGrafanaToken) {
		t.Fatalf("the create did not carry the Grafana settings: %+v", cloud.created)
	}
	if logs.Len() == 0 {
		t.Fatal("expected the create log line")
	}
	for _, leak := range []string{capGrafanaToken, "GRAFANA_CLOUD", "boxsecret123"} {
		if strings.Contains(logs.String(), leak) {
			t.Errorf("a log line carries %q:\n%s", leak, logs.String())
		}
	}

	// And no log call in captions_box.go names the user data or the Grafana settings.
	src, err := os.ReadFile("captions_box.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(src), "\n") {
		if strings.Contains(line, "s.log.") && (strings.Contains(line, "userData") || strings.Contains(line, "Grafana")) {
			t.Errorf("a log line names the user data or Grafana settings: %s", strings.TrimSpace(line))
		}
	}
}
