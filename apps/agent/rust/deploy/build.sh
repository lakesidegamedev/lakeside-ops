#!/usr/bin/env bash
# Build the Rust harness binaries from this checkout and install them as a
# pinned release under /opt/keir/bin, the same discipline as deploy/release.sh:
# nothing live changes until a unit restarts onto the new symlink.
#   rust/deploy/build.sh            build, test, install /opt/keir/bin/lakeside.<sha12>, repoint lakeside
#   rust/deploy/build.sh --no-test  skip cargo test
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
root=${KEIR_RELEASE_ROOT:-/opt/keir}
sha=$(git -C "$here" rev-parse --short=12 HEAD)
cd "$here"
if [[ ${1:-} != --no-test ]]; then cargo test --release -j 8 --quiet; fi
cargo build --release -j 8 --quiet
mkdir -p "$root/bin"
for bin in lakeside; do
  install -m 0755 "target/release/$bin" "$root/bin/$bin.$sha"
  ln -sfn "$root/bin/$bin.$sha" "$root/bin/$bin.new" && mv -Tf "$root/bin/$bin.new" "$root/bin/$bin"
  echo "installed $root/bin/$bin -> $bin.$sha"
done
# The CLI is for operators and agents on this box; keep one stable path.
# Preserve the public monorepo CLI; install the raw harness under its own name.
ln -sfn "$root/bin/lakeside" /usr/local/bin/lakeside-agent
