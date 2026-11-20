#!/usr/bin/env python3
"""Print Lakeside Ops TestFlight builds and their processing and beta state.
Prints build numbers and states only: no tester names, emails or team ids."""
import importlib.util
import os
import sys
import time
import urllib.parse
from pathlib import Path

spec = importlib.util.spec_from_file_location("apple", Path(__file__).with_name("apple.py"))
apple = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apple)

BUNDLE = "net.lakesidegames.ops"


def main():
    wait = int(float(os.environ.get("WAIT_MINUTES", "0")) * 60)
    apps = apple.api("apps?" + urllib.parse.urlencode({"filter[bundleId]": BUNDLE}))["data"]
    if len(apps) != 1:
        sys.exit(f"{BUNDLE}: app record missing or ambiguous")
    app_id = apps[0]["id"]
    expected = os.environ.get("EXPECTED_BUILD", "").strip()
    marketing_version = os.environ.get("EXPECTED_VERSION", "").strip()
    deadline = time.time() + wait
    while True:
        builds = apple.api("builds?" + urllib.parse.urlencode({"filter[app]": app_id, "sort": "-uploadedDate", "limit": 5, "include": "preReleaseVersion"}))
        versions = {v["id"]: v["attributes"]["version"] for v in builds.get("included", []) if v["type"] == "preReleaseVersions"}
        rows = []
        for b in builds["data"]:
            detail = apple.api(f"builds/{b['id']}/buildBetaDetail")["data"]["attributes"]
            marketing = versions.get(b["relationships"]["preReleaseVersion"]["data"]["id"], "?") if b.get("relationships", {}).get("preReleaseVersion", {}).get("data") else "?"
            rows.append((marketing, b["attributes"]["version"], b["attributes"]["processingState"], detail.get("internalBuildState"), b["attributes"].get("uploadedDate", "")))
        if expected:
            for build, row in zip(builds["data"], rows):
                marketing, number, state, internal, _ = row
                if number != expected or marketing_version and marketing != marketing_version:
                    continue
                if state in ("INVALID", "FAILED"):
                    sys.exit(f"Build {number} failed processing ({state})")
                if state == "VALID" and internal == "IN_BETA_TESTING":
                    group_filter = {"filter[app]": app_id, "filter[builds]": build["id"], "filter[isInternalGroup]": "true", "limit": 200}
                    groups = apple.api("betaGroups?" + urllib.parse.urlencode(group_filter))["data"]
                    for group in groups:
                        if not group["attributes"].get("isInternalGroup"):
                            continue
                        testers = apple.api(f"betaGroups/{group['id']}/betaTesters?limit=1")["data"]
                        if testers:
                            print(f"Lakeside Ops {marketing} build {number}: VALID, IN_BETA_TESTING, assigned to an internal group with testers.")
                            return
            if time.time() >= deadline:
                sys.exit(f"Apple has not confirmed internal availability of {marketing_version} build {expected} yet.")
            time.sleep(30)
            continue
        pending = any(r[2] == "PROCESSING" for r in rows[:2])
        if not pending or time.time() >= deadline:
            break
        time.sleep(30)
    for marketing, build, state, internal, uploaded in rows:
        print(f"Lakeside Ops {marketing} build {build}: {state}, internal testing {internal}, uploaded {uploaded}")


if __name__ == "__main__":
    main()
