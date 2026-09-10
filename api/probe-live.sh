#!/usr/bin/env bash
# Live check of the four behaviours, against the deployed instance.
#
# Creates its own host account and two webinars, then deletes both and reports what it left
# behind. Every assertion prints PASS or FAIL with the value it saw, so a green run is
# evidence rather than an absence of errors.
set -uo pipefail

BASE="${BASE:-https://3.82.201.244.sslip.io}"
JAR=$(mktemp)
STAMP=$(date +%s)
HOST_EMAIL="probe-$STAMP@example.invalid"
PASS="probe-Passw0rd-$STAMP"
fails=0

ok()   { printf '  PASS  %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fails=$((fails+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1 = $2"; else bad "$1 = $2, want $3"; fi; }
# Created-or-OK: the API answers 201 on creates and 200 on reads, and which one a given
# endpoint uses is not what any of these checks are about.
created(){ case "$2" in 200|201) ok "$1 = $2";; *) bad "$1 = $2, want 200 or 201";; esac; }

api() { # method path [body]
  local m=$1 p=$2 b=${3:-}
  if [ -n "$b" ]; then
    curl -sS -o /tmp/probe.out -w '%{http_code}' -X "$m" -b "$JAR" -c "$JAR" \
      -H 'content-type: application/json' -d "$b" "$BASE$p"
  else
    curl -sS -o /tmp/probe.out -w '%{http_code}' -X "$m" -b "$JAR" -c "$JAR" "$BASE$p"
  fi
}
body() { cat /tmp/probe.out; }
jqf()  { python3 -c "import json,sys;d=json.load(open('/tmp/probe.out'));print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null; }

iso() { # minutes from now, UTC ISO-8601
  python3 -c "import datetime,sys;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=int(sys.argv[1]))).strftime('%Y-%m-%dT%H:%M:%SZ'))" "$1"
}

echo "== host account"
# Hosting is an ADMIN GRANT now: `wantsHost` is accepted and ignored, because a public signup
# form cannot hand out the ability to create webinars and collect strangers' contact details.
# So this signs up as an ordinary account and then has an admin grant the capability.
#
# ADMIN_EMAIL / ADMIN_PASSWORD must be an account listed in the server's ADMIN_EMAILS.
code=$(api POST /api/auth/signup "{\"name\":\"Probe Host\",\"email\":\"$HOST_EMAIL\",\"password\":\"$PASS\"}")
created "signup" "$code"
case "$code" in 200|201) ;; *) body; exit 1;; esac

echo
echo "== task 2: UTC in the database, IST as the default zone"
START_SOON=$(iso 10)      # inside the 15-minute door
START_LATER=$(iso 60)     # an hour out
code=$(api POST /api/host/webinars "{\"topic\":\"Probe Soon $STAMP\",\"startsAt\":\"$START_SOON\",\"durationMin\":30,\"status\":\"scheduled\",\"registrationRequired\":true}")
created "create (no timeZone sent)" "$code"
SOON_SLUG=$(jqf "['id']"); SOON_ID=$SOON_SLUG
check "default timeZone" "$(jqf "['timeZone']")" "Asia/Kolkata"
returned=$(jqf "['startsAt']")
printf '  sent %s  stored/returned %s\n' "$START_SOON" "$returned"
case "$returned" in *Z) ok "startsAt returned as UTC (Z)";; *) bad "startsAt not UTC: $returned";; esac

code=$(api POST /api/host/webinars "{\"topic\":\"Probe Later $STAMP\",\"startsAt\":\"$START_LATER\",\"durationMin\":30,\"status\":\"scheduled\",\"registrationRequired\":true,\"timeZone\":\"America/New_York\"}")
LATER_SLUG=$(jqf "['id']"); LATER_ID=$LATER_SLUG
check "explicit timeZone survives" "$(jqf "['timeZone']")" "America/New_York"

echo
echo "== task 1: phone number with country code"
# Each negative asserts the 400 AND that the complaint is about the phone field. A plain
# "is it 400" check passes for a typo in the payload too, which is exactly how the first
# run of this probe reported three passes against an endpoint that was rejecting everything.
regphone() { # label json-phone-fragment
  local label=$1 frag=$2
  [ -n "$LATER_SLUG" ] || { bad "$label: no webinar slug"; return; }
  code=$(api POST "/api/webinars/$LATER_SLUG/register" \
    "{\"firstName\":\"Probe\",\"lastName\":\"Guest\",\"email\":\"$3-$STAMP@example.invalid\",\"consent\":true$frag}")
  local msg
  msg=$(jqf "['fields']['phone']")
  if [ "$code" = 422 ] && [ -n "$msg" ] && [ "$msg" != "None" ]; then
    ok "$label rejected on the phone field: $msg"
  else
    bad "$label = $code, phone message $(jqf "['message']") $msg"
  fi
}
regphone "no phone"        ""                              nophone
regphone "too-short"       ',"phone":"+1 234"'                short
regphone "over-15-digit"   ',"phone":"+91 9876543210987654"'    long

code=$(api POST "/api/webinars/$LATER_SLUG/register" "{\"firstName\":\"Later\",\"lastName\":\"Guest\",\"email\":\"later-$STAMP@example.invalid\",\"consent\":true,\"phone\":\"+91 98765 43210\"}")
created "spaced +91 number accepted" "$code"
LATER_KEY=$(jqf "['joinKey']")

code=$(api GET "/api/host/webinars/$LATER_ID/registrants")
stored=$(python3 -c "
import json
d=json.load(open('/tmp/probe.out'))
rows=d if isinstance(d,list) else d.get('registrants',d.get('items',[]))
print(next((r.get('phone','') for r in rows if 'later-' in r.get('email','')),'MISSING'))")
check "host sees E.164" "$stored" "+919876543210"

echo
echo "== task 4: doors open 15 minutes before, shut an hour before"
code=$(api POST "/api/webinars/$LATER_SLUG/join" "{\"joinKey\":\"$LATER_KEY\"}")
msg=$(jqf "['message']")
# 409 rather than 403: the request is well-formed and the caller is who they say they are —
# it is the webinar's state that says no, and the UI needs to tell "come back later" apart
# from "you are not allowed".
case "$code" in
  409) ok "join 60 min early refused = 409";;
  *)   bad "join 60 min early = $code $msg";;
esac
printf '  message: %s\n' "$msg"
# And the time in it is the webinar's own clock. This one was scheduled in America/New_York,
# so a message quoting UTC or IST would be quoting somebody else's hour at the moment the
# reader most needs their own.
case "$msg" in
  *EDT*|*EST*) ok "the refusal quotes New York's clock";;
  *UTC*)       bad "the refusal quotes UTC";;
  *)           bad "the refusal names no zone: $msg";;
esac
code=$(api POST "/api/webinars/$SOON_SLUG/register" "{\"firstName\":\"Soon\",\"lastName\":\"Guest\",\"email\":\"soon-$STAMP@example.invalid\",\"consent\":true,\"phone\":\"+1 415 555 0132\"}")
created "register for the soon webinar" "$code"
SOON_KEY=$(jqf "['joinKey']")
code=$(api POST "/api/webinars/$SOON_SLUG/join" "{\"joinKey\":\"$SOON_KEY\"}")
created "join 10 min before allowed" "$code"
tok=$(jqf "['token']"); printf '  token length %s\n' "${#tok}"

echo
echo "== public payload carries what the join gate needs"
code=$(api GET "/api/webinars/$LATER_SLUG")
python3 -c "
import json
d=json.load(open('/tmp/probe.out'))
for f in ('startsAt','timeZone','durationMin','status'):
    v=d.get(f)
    print(('  PASS  public.%s = %s' % (f,v)) if v not in (None,'') else '  FAIL  public.%s missing' % f)
" 
leak=$(jqf "['passcode']"); [ -z "$leak" ] || [ "$leak" = "None" ] && ok "no passcode in public payload" || bad "passcode leaked: $leak"

echo
echo "== cleanup"
for id in "$SOON_ID" "$LATER_ID"; do
  code=$(api DELETE "/api/host/webinars/$id")
  case "$code" in 200|204) ok "delete $id = $code";; *) bad "delete $id = $code";; esac
done
code=$(api GET /api/host/webinars)
left=$(python3 -c "
import json
d=json.load(open('/tmp/probe.out'))
rows=d if isinstance(d,list) else d.get('webinars',d.get('items',[]))
print(len(rows))")
check "host webinars remaining" "$left" 0
rm -f "$JAR" /tmp/probe.out

echo
if [ "$fails" = 0 ]; then echo "ALL CHECKS PASSED"; else echo "$fails CHECK(S) FAILED"; fi
echo "NOTE: host account $HOST_EMAIL still exists; remove it with the account cleanup step."
exit "$fails"
