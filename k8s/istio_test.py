#!/usr/bin/env python3
"""Tests for istio.py.  Run: python3 k8s/istio_test.py

Deployment glue is not usually worth testing. This is, because `add` rewrites a
VirtualService that serves another team's login page, and the properties that keep
that safe are exactly the ones that are easy to break by accident: the catch-all has
to keep its place at the end, unnamed routes must never be touched, and `remove` has
to be an exact inverse of `add`.
"""

import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
SCRIPT = HERE / "istio.py"
ROUTES = HERE / "20-routes.yaml"
HOST = "dev.agentfabric.platformbmc.com"

# Shaped like the real thing: somebody else's routes, catch-all last, unnamed.
ORIGINAL = {
    "apiVersion": "networking.istio.io/v1",
    "kind": "VirtualService",
    "metadata": {
        "name": "platform-ui",
        "namespace": "platform",
        "resourceVersion": "12345",
        "managedFields": [{"manager": "helm"}],
    },
    "spec": {
        "hosts": [HOST],
        "gateways": ["istio-system/agent-fabric-gw"],
        "http": [
            {"name": "identity", "match": [{"uri": {"prefix": "/identity"}}],
             "route": [{"destination": {"host": "identity-dev"}}]},
            {"match": [{"uri": {"prefix": "/"}}],
             "route": [{"destination": {"host": "platform-ui"}}]},
        ],
    },
    "status": {"observedGeneration": 3},
}

failures = []


def check(label, cond, detail=""):
    print(f"  {'ok  ' if cond else 'FAIL'}  {label}" + (f"   {detail}" if not cond else ""))
    if not cond:
        failures.append(label)


def run(args, payload, expect_ok=True):
    p = subprocess.run([sys.executable, str(SCRIPT), *args],
                       input=json.dumps(payload), capture_output=True, text=True)
    if expect_ok and p.returncode != 0:
        check(f"istio.py {' '.join(args)} exits 0", False, p.stderr.strip()[:120])
        return None
    return p


def run_json(args, payload):
    p = run(args, payload)
    return json.loads(p.stdout) if p else None


def rendered_routes(tmp):
    """20-routes.yaml with its placeholders filled, exactly as deploy.sh does."""
    tmp.write_text(ROUTES.read_text()
                   .replace("__BASE_PATH__", "/platform/webcast")
                   .replace("__NS__", "platform"))
    return str(tmp)


def main():
    tmp = HERE / ".routes-test.yaml"
    routes_file = rendered_routes(tmp)
    try:
        print("add")
        added = run_json(["add", routes_file], ORIGINAL)
        if added is None:
            return
        http = added["spec"]["http"]
        names = [r.get("name") for r in http]
        check("webcast routes come first",
              names[:5] == ["webcast-sfu-root", "webcast-sfu", "webcast-api",
                            "webcast-web", "webcast-misspelled-prefix"], names)
        check("the catch-all is still last", http[-1]["match"][0]["uri"]["prefix"] == "/", names)
        check("the other team's named route survives", names[5] == "identity", names)
        check("nothing was lost", len(http) == 7, len(http))
        check("managedFields stripped", "managedFields" not in added["metadata"])
        check("status stripped", "status" not in added)
        check("resourceVersion kept for concurrency",
              added["metadata"]["resourceVersion"] == "12345")
        check("hosts and gateways untouched",
              added["spec"]["hosts"] == ORIGINAL["spec"]["hosts"]
              and added["spec"]["gateways"] == ORIGINAL["spec"]["gateways"])

        # The ordering that actually matters. /platform/webcast is a prefix of the
        # other two, so if it ever came first it would swallow the API and the SFU,
        # and the symptom would be a page that loads and a call that never connects.
        prefixes = [r["match"][0]["uri"].get("prefix", "") for r in http[1:4]]
        check("the bare mount prefix comes after its children",
              prefixes.index("/platform/webcast") == 2, prefixes)

        # Envoy swaps the matched prefix for the rewrite value, so a trailing slash
        # on one side and not the other is the difference between /rtc/v1 and //rtc/v1.
        sfu, api, web = http[1], http[2], http[3]
        check("the SFU rewrite cannot double the slash",
              sfu["match"][0]["uri"]["prefix"].endswith("/") and sfu["rewrite"]["uri"] == "/",
              (sfu["match"][0]["uri"]["prefix"], sfu["rewrite"]["uri"]))
        check("the API rewrite cannot double the slash",
              not api["match"][0]["uri"]["prefix"].endswith("/") and api["rewrite"]["uri"] == "/api",
              (api["match"][0]["uri"]["prefix"], api["rewrite"]["uri"]))
        check("the frontend is not rewritten", "rewrite" not in web)
        check("destinations are fully qualified",
              all(r["route"][0]["destination"]["host"].endswith(".platform.svc.cluster.local")
                  for r in http[1:4]))
        # The typo path is the one route that redirects instead of proxying. 302, not
        # 301: a permanent redirect outlives this temporary deployment in browser caches.
        typo = http[4]
        # The bare /sfu path must reach the SFU too, or prepareConnection 404s and
        # the pre-warm silently does nothing.
        root = http[0]
        check("the bare /sfu path is routed to the SFU",
              root["match"][0]["uri"].get("exact") == "/platform/webcast/sfu"
              and root["rewrite"]["uri"] == "/",
              root["match"][0]["uri"])
        check("the misspelled prefix redirects to the real one",
              typo["redirect"]["uri"] == "/platform/webcast"
              and typo["match"][0]["uri"]["prefix"] == "/platfrom/webcast",
              typo.get("redirect"))
        check("the redirect is temporary", typo["redirect"]["redirectCode"] == 302,
              typo["redirect"].get("redirectCode"))
        # Explicit, and long. An unset timeout does NOT mean no timeout — it inherits
        # Envoy's 15-second default, which closed the signalling WebSocket every 15
        # seconds until this was set. Istio rejects "0s", so the only way to express
        # "longer than any webinar" is a large finite value.
        check("signalling outlives a webinar",
              sfu.get("timeout") == "86400s", sfu.get("timeout"))
        check("the API tolerates a recording transfer",
              api.get("timeout") == "3600s", api.get("timeout"))
        # An empty camera/microphone allowlist on this hostname would deny
        # getUserMedia outright, so the override has to actually be there.
        pp = web["headers"]["response"]["set"]["permissions-policy"]
        check("camera and microphone are re-enabled for our document",
              "camera=(self)" in pp and "microphone=(self)" in pp, pp)
        csp = web["headers"]["response"]["set"]["content-security-policy"]
        check("the CSP allows Next's inline hydration scripts",
              "'unsafe-inline'" in csp.split("script-src")[1].split(";")[0], csp)
        check("the CSP allows the signalling socket", "wss:" in csp, csp)

        print("add is idempotent")
        twice = run_json(["add", routes_file], added)
        check("running it again changes nothing", twice["spec"]["http"] == http)

        print("remove")
        removed = run_json(["remove"], twice)
        check("exactly the original routes remain",
              removed["spec"]["http"] == ORIGINAL["spec"]["http"], removed["spec"]["http"])
        clean = run_json(["remove"], ORIGINAL)
        check("remove on an untouched object is a no-op",
              clean["spec"]["http"] == ORIGINAL["spec"]["http"])

        print("find")
        lst = {"kind": "List", "items": [
            {"metadata": {"namespace": "istio-system", "name": "wildcard"},
             "spec": {"hosts": ["*.agentfabric.platformbmc.com", "other.example"]}},
            {"metadata": {"namespace": "platform", "name": "platform-ui"},
             "spec": {"hosts": [HOST]}},
            {"metadata": {"namespace": "other", "name": "unrelated"},
             "spec": {"hosts": ["nope.example.com"]}},
        ]}
        p = run(["find", HOST], lst)
        lines = p.stdout.split()
        check("the exact-host object is preferred over the wildcard",
              p.stdout.splitlines()[0] == "platform platform-ui", p.stdout)
        check("the wildcard object is still reported", "wildcard" in lines, p.stdout)
        check("unrelated hosts are excluded", "unrelated" not in lines, p.stdout)

        print("refusals")
        p = run(["add", routes_file], {"kind": "Service"}, expect_ok=False)
        check("a non-VirtualService is refused", p.returncode != 0, p.stdout[:80])

        bad = HERE / ".routes-bad.yaml"
        bad.write_text("- name: not-ours\n  route: []\n")
        p = run(["add", str(bad)], ORIGINAL, expect_ok=False)
        check("a route we could not later find is refused", p.returncode != 0)
        bad.unlink()
    finally:
        tmp.unlink(missing_ok=True)

    print()
    if failures:
        print(f"{len(failures)} failed: {failures}")
        sys.exit(1)
    print("all checks passed")


if __name__ == "__main__":
    main()
