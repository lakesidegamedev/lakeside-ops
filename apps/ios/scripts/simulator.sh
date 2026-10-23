#!/bin/bash
set -euo pipefail
scheme="${1:?scheme required}"
case "$scheme" in LakesideOps) ;; *) exit 2 ;; esac
simulator_id=$(xcrun simctl list devices available -j | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(v["udid"] for k,vs in sorted(d["devices"].items(), reverse=True) if "iOS" in k for v in vs if v["name"].startswith("iPhone")))')
# Simulator-only ad hoc entitlements let the sign-in test exercise real Keychain storage.
test_args=(test)
case "${OPS_TEST_SCOPE:-full}" in
  full) ;;
  computer) test_args+=(-only-testing:OpsSessionTests -only-testing:OpsUITests/LaunchTests/testComputerInputUncertaintyInspectionAndClose -only-testing:OpsUITests/LaunchTests/testCancelledComputerInspectionAndExplicitDiscard -only-testing:OpsUITests/LaunchTests/testChoicesModelSwitchAndConcurrentWork -only-testing:OpsUITests/LaunchTests/testKeirThreadDecisionAndReply -only-testing:OpsUITests/LaunchTests/testWatchesMemoryAndThreads) ;;
  connection) test_args+=(-only-testing:OpsSessionTests -only-testing:OpsUITests/LaunchTests/testKeirUnavailableKeepsDraftAndRetriesConnection -only-testing:OpsUITests/LaunchTests/testKeirThreadDecisionAndReply) ;;
  metrics) test_args+=(-only-testing:OpsSessionTests -only-testing:OpsUITests/LaunchTests/testKeirDashboardMetricsAndMonitoring -only-testing:OpsUITests/LaunchTests/testKeirDashboardDoesNotInventMissingMetrics) ;;
  redesign) test_args+=(-only-testing:OpsSessionTests -only-testing:OpsUITests/LaunchTests/testFeedWithBriefIdeasAndUpcoming -only-testing:OpsUITests/LaunchTests/testKeirThreadDecisionAndReply -only-testing:OpsUITests/LaunchTests/testWorkingNowBarAndProgressUpdates -only-testing:OpsUITests/LaunchTests/testAttentionCountsMatchAcrossScreens -only-testing:OpsUITests/LaunchTests/testKeirToolsMenuDoesNotDuplicateOps -only-testing:OpsUITests/LaunchTests/testBrokenStatusTextNeverBecomesAStatus -only-testing:OpsUITests/LaunchTests/testOpsSystemsDrillDowns -only-testing:OpsUITests/LaunchTests/testIdeasSwipeTriage -only-testing:OpsUITests/LaunchTests/testRedesignEvidenceScreens -only-testing:OpsUITests/LaunchTests/testAccessibilityTextSizeKeepsPrimaryActionsReachable) ;;
  *) exit 2 ;;
esac
xcodebuild "${test_args[@]}" -project LakesideOps.xcodeproj -scheme "$scheme" \
  -destination "platform=iOS Simulator,id=$simulator_id" \
  -derivedDataPath "build/$scheme" -resultBundlePath "build/$scheme.xcresult" \
  -parallel-testing-enabled NO -retry-tests-on-failure -test-iterations 3 CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-
python3 scripts/verify-native.py "build/$scheme/Build/Products/Debug-iphonesimulator/$scheme.app"
