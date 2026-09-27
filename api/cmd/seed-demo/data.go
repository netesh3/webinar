package main

import "time"

// The demo coach: a mindset and habits coach who runs free webinars and follows up on
// WhatsApp. Everything below hangs off this account.
var coach = struct {
	name, title, org, initials, hue, phone string
	waDisplay, waName                      string
}{
	name: "Aarti Menon", title: "Habits & mindset coach", org: "Aarti Menon Coaching",
	initials: "AM", hue: "#0F766E", phone: "+919820011223",
	waDisplay: "+91 98200 11223", waName: "Aarti Menon Coaching",
}

// template is a Meta-approved message template, as the sync would have cached it.
type template struct {
	name, category, body string
	vars                 int
}

var templates = []template{
	{"webinar_confirmation", "UTILITY",
		"Hi {{1}}, you're registered for {{2}} on {{3}}. I'll send a reminder before we start.", 3},
	{"webinar_reminder", "UTILITY",
		"Hi {{1}}, {{2}} starts {{3}}. Your join link is in your email — see you there!", 3},
	{"replay_ready", "UTILITY",
		"Hi {{1}}, the recording of {{2}} is ready: {{3}}", 3},
	{"thanks_for_attending", "MARKETING",
		"Hi {{1}}, thank you for spending {{2}} with me at {{3}}. Reply YES and I'll send you the workbook.", 3},
	{"missed_you", "MARKETING",
		"Hi {{1}}, sorry we missed you at {{2}}. The replay is up for 48 hours — shall I send you the link?", 2},
}

// reminderTemplates wires the automatic messages to templates, as Setup would.
var reminderTemplates = []struct{ kind, name, params string }{
	{"wa_registration_confirmed", "webinar_confirmation", `["first_name","topic","when"]`},
	{"wa_reminder", "webinar_reminder", `["first_name","topic","starts_in"]`},
	{"wa_replay", "replay_ready", `["first_name","topic","replay"]`},
}

// person is one registrant. Consent: most opted in on the form; one later sent STOP,
// one never ticked the box, one left no number.
type person struct {
	first, last, company, phone string
	optIn, optedOut             bool
}

var people = []person{
	{"Priya", "Sharma", "Freelance designer", "+919810023401", true, false},
	{"Rahul", "Verma", "Infosys", "+919820034512", true, false},
	{"Ananya", "Iyer", "", "+919845045623", true, false},
	{"Vikram", "Nair", "Nair Traders", "+919876056734", true, false},
	{"Sneha", "Kulkarni", "Teacher", "+919822067845", true, false},
	{"Arjun", "Reddy", "", "+919849078956", true, false},
	{"Kavya", "Menon", "", "+919847089067", true, true},
	{"Rohit", "Gupta", "Deloitte", "+919811090178", false, false},
	{"Meera", "Pillai", "", "", false, false},
	{"Siddharth", "Rao", "Startup founder", "+919880001289", true, false},
	{"Neha", "Joshi", "", "+919823012390", true, false},
	{"Aditya", "Singh", "HDFC Bank", "+919818023401", true, false},
	{"Divya", "Krishnan", "", "+919841034512", true, false},
	{"Farhan", "Sheikh", "Photographer", "+919819045623", true, false},
}

// A webinar and who came. watch maps a person's index to minutes watched; a registrant
// missing from it never joined (a no-show). Past webinars ended `ago` before now; the
// upcoming one starts `ago` from now (negative).
type webinar struct {
	slug, topic, summary string
	ago                  time.Duration
	duration             int
	reminders            []int
	registered           []int
	watch                map[int]int
}

var webinars = []webinar{
	{
		slug: "morning-routines-that-stick", topic: "Morning Routines That Stick",
		summary: "Build a 20-minute morning you'll still be doing in six months.",
		ago:     50 * time.Hour, duration: 60, reminders: []int{1440, 60},
		registered: []int{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12},
		watch:      map[int]int{0: 58, 1: 55, 2: 52, 3: 47, 4: 41, 5: 33, 7: 24, 8: 12, 9: 6},
	},
	{
		slug: "beat-procrastination-21-days", topic: "Beat Procrastination in 21 Days",
		summary: "A three-week plan for the tasks you keep moving to tomorrow.",
		ago:     9 * 24 * time.Hour, duration: 45, reminders: []int{1440, 60},
		registered: []int{0, 2, 4, 9, 10, 12, 13, 3},
		watch:      map[int]int{0: 44, 2: 40, 10: 31, 13: 18, 4: 9},
	},
	{
		slug: "mindful-money-budgeting", topic: "Mindful Money: Budgeting Without Guilt",
		summary: "A budget that fits how you actually spend, not how you think you should.",
		ago:     -(3*24*time.Hour + 5*time.Hour), duration: 60, reminders: []int{1440, 60, 10},
		registered: []int{0, 1, 3, 5, 9, 11, 12, 13, 6},
	},
}

// Conversations after the first webinar's follow-ups. `after` is how long after the
// follow-up the message landed; `in` is from the contact, otherwise the coach replied
// (from the inbox, or from her phone — both are manual).
type line struct {
	in    bool
	after time.Duration
	body  string
}

var threads = []struct {
	who   int
	lines []line
	done  bool // marked done in Messages
}{
	{0, []line{
		{true, 40 * time.Minute, "YES please! Loved the habit stacking bit 🙏"},
		{false, 2 * time.Hour, "Sent it to your email, Priya. Start with just one stack this week!"},
		{true, 3 * time.Hour, "Got it, thank you so much"},
	}, true},
	{1, []line{
		{true, 25 * time.Minute, "Yes. Also — do you run a paid program? I want accountability."},
	}, false},
	{3, []line{
		{true, 3 * time.Hour, "YES"},
		{false, 5 * time.Hour, "Here you go Vikram: webinarliv.com/w/morning-routines-that-stick 📘"},
	}, false},
	{12, []line{
		{true, 1 * time.Hour, "Can you send the link? I had a work call 😞"},
	}, false},
	{10, []line{
		{true, 6 * time.Hour, "Please send the replay, I missed it."},
		{false, 7 * time.Hour, "Of course Neha, sending it now."},
		{true, 20 * time.Hour, "Watched it! Is the budgeting one also free?"},
	}, false},
}
