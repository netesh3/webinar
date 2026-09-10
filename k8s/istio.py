#!/usr/bin/env python3
"""Istio inspection and surgery for the temporary Webcast deployment.

All of this lives in one file rather than inline in deploy.sh for two reasons: the
`add`/`remove` pair edits an object another team owns and deserves tests, and
Python embedded in single-quoted shell cannot use both quote styles or a backslash
inside an f-string without breaking on some interpreters.

Every subcommand reads Kubernetes JSON on stdin.

  find <host>   VirtualServiceList  -> "namespace name" per line, most specific first
  show          VirtualService      -> a readable route table, plus a GitOps warning
  mtls          DestinationRuleList -> wildcard rules that would force mTLS on us
  add <file>    VirtualService      -> the same object with our routes prepended
  remove        VirtualService      -> the same object with our routes taken out

`add` and `remove` are built to be boring, because the failure mode is not a broken
Webcast — it is a broken login page in somebody else's environment:

  * Idempotent. Every route added is named `webcast-*`, and both operations begin by
    dropping every `webcast-*` route already present.
  * Surgical. Nothing outside `spec.http` is touched, and the only routes removed are
    ones matching our own name prefix.
  * Reversible without this script, from the backup deploy.sh writes first.
"""

import json
import sys

try:
    import yaml
except ImportError:  # pragma: no cover - deploy.sh checks before calling
    sys.exit("istio.py needs PyYAML: pip3 install pyyaml")

PREFIX = "webcast-"


def ours(route):
    """True for a route this script owns. We always set a name, so unnamed is theirs."""
    return str(route.get("name", "")).startswith(PREFIX)


def load(kind):
    obj = json.load(sys.stdin)
    if kind and obj.get("kind") != kind:
        sys.exit(f"expected a {kind} on stdin, got {obj.get('kind')!r}")
    return obj


# ---------------------------------------------------------------- inspection


def claims(host, declared):
    """Does a VirtualService host pattern cover the hostname we want?"""
    if declared in (host, "*"):
        return True
    return declared.startswith("*.") and host.endswith(declared[1:])


def cmd_find(host):
    items = load(None).get("items", [])
    hits = []
    for it in items:
        hosts = it.get("spec", {}).get("hosts", [])
        if any(claims(host, h) for h in hosts):
            # Fewer hosts is a better-targeted object; an exact name beats a wildcard.
            exact = 0 if host in hosts else 1
            hits.append((exact, len(hosts), it["metadata"]["namespace"], it["metadata"]["name"]))
    hits.sort()
    for _, _, ns, name in hits:
        print(ns, name)


def cmd_show():
    vs = load("VirtualService")
    http = vs.get("spec", {}).get("http", [])
    print(f"     {len(http)} http routes")
    for r in http:
        name = r.get("name") or "(unnamed)"
        uris = []
        for m in r.get("match", []):
            uri = m.get("uri", {})
            for how, val in uri.items():
                uris.append(f"{how}:{val}")
        dst = ",".join(x.get("destination", {}).get("host", "?") for x in r.get("route", []))
        rw = r.get("rewrite", {}).get("uri")
        arrow = f"-> {dst}" + (f"  rewrite {rw}" if rw else "")
        print(f"       {name:18} {' '.join(uris) or '(any)':44} {arrow}")

    meta = vs.get("metadata", {})
    ann = meta.get("annotations", {})
    labels = meta.get("labels", {})
    owner = labels.get("app.kubernetes.io/managed-by", "")
    gitops = sorted(k for k in list(ann) + list(labels)
                    if "argocd" in k.lower() or "flux" in k.lower() or "helm" in k.lower())
    if owner or gitops:
        print(f"     MANAGED BY: {owner or ', '.join(gitops)}")
        print("     A GitOps controller owns this object and will revert our routes on its")
        print("     next sync. Pause the app or expect the deployment to stop answering.")


def cmd_mtls():
    found = False
    for it in load(None).get("items", []):
        spec = it.get("spec", {})
        host = spec.get("host", "")
        mode = spec.get("trafficPolicy", {}).get("tls", {}).get("mode", "")
        if "*" in host and mode:
            found = True
            m = it["metadata"]
            print(f"   {m['namespace']}/{m['name']}  host={host}  tls={mode}")
    if not found:
        print("   no wildcard DestinationRule forcing mTLS")


# ---------------------------------------------------------------- surgery


def cmd_edit(op, routes_file=None):
    vs = load("VirtualService")
    spec = vs.setdefault("spec", {})
    existing = spec.get("http") or []
    kept = [r for r in existing if not ours(r)]
    dropped = len(existing) - len(kept)

    if op == "add":
        with open(routes_file) as fh:
            new = yaml.safe_load(fh)
        if not isinstance(new, list) or not new:
            sys.exit(f"{routes_file} should be a non-empty YAML list of routes")
        unnamed = [r for r in new if not ours(r)]
        if unnamed:
            # Otherwise `remove` could not find them again and the edit would be
            # permanent — the one outcome that is not acceptable here.
            sys.exit(f"every route must be named {PREFIX}*: {unnamed}")
        spec["http"] = new + kept
        print(f"added {len(new)} webcast routes ahead of {len(kept)} existing "
              f"({dropped} stale webcast routes replaced)", file=sys.stderr)
    else:
        spec["http"] = kept
        if dropped:
            print(f"removed {dropped} webcast routes, left {len(kept)}", file=sys.stderr)
        else:
            print("no webcast routes were present; nothing to remove", file=sys.stderr)

    # Server-set fields a PUT either rejects or does not want back. resourceVersion
    # is deliberately kept: it is the optimistic-concurrency check that makes this
    # safe against a concurrent edit by whoever owns the object.
    vs.get("metadata", {}).pop("managedFields", None)
    vs.pop("status", None)

    json.dump(vs, sys.stdout, indent=2)
    sys.stdout.write("\n")


def main():
    argv = sys.argv[1:]
    if not argv:
        sys.exit(__doc__)
    op, rest = argv[0], argv[1:]
    if op == "find" and len(rest) == 1:
        cmd_find(rest[0])
    elif op == "show" and not rest:
        cmd_show()
    elif op == "mtls" and not rest:
        cmd_mtls()
    elif op == "add" and len(rest) == 1:
        cmd_edit("add", rest[0])
    elif op == "remove" and not rest:
        cmd_edit("remove")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
