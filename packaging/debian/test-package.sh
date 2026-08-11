#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
version=$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$root/companion/pyproject.toml" | head -n1)
artifact="$root/dist/draftside-companion_${version}-1_amd64.deb"

"$root/packaging/debian/build-deb.sh" >/dev/null
first=$(sha256sum "$artifact" | cut -d' ' -f1)
"$root/packaging/debian/build-deb.sh" >/dev/null
second=$(sha256sum "$artifact" | cut -d' ' -f1)
test "$first" = "$second"
! grep -q '/' "$artifact.sha256"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM
mkdir "$work/download"
cp "$artifact" "$artifact.sha256" "$work/download/"
(cd "$work/download" && sha256sum -c "$(basename "$artifact.sha256")")
dpkg-deb -x "$artifact" "$work/root"
dpkg-deb -e "$artifact" "$work/control"

test -x "$work/root/usr/bin/draftside-companion"
test -x "$work/root/usr/bin/draftside-companion-setup"
test -x "$work/root/usr/bin/draftside-companion-ui"
test -f "$work/root/usr/lib/systemd/user/draftside-companion.service"
test -f "$work/root/usr/share/applications/draftside-companion.desktop"
test -f "$work/root/usr/share/icons/hicolor/scalable/apps/draftside-companion.svg"
test -f "$work/root/usr/share/metainfo/com.draftside.companion.metainfo.xml"
test ! -e "$work/root/usr/share/draftside-companion"
test -f "$work/root/usr/share/doc/draftside-companion/changelog.Debian.gz"
test ! -d "$work/root/usr/lib/python3/dist-packages/draft_companion/__pycache__"

grep -q '^Architecture: amd64$' "$work/control/control"
grep -Eq '^Installed-Size: [1-9][0-9]*$' "$work/control/control"
grep -q '^Depends: .*python3-keyring' "$work/control/control"
! rg -n 'DRAFTSIDE_DASHBOARD_URL|@DASHBOARD_URL@|draftside\.example\.com' "$work/root"
! grep -q '^PrivateTmp=' "$work/root/usr/lib/systemd/user/draftside-companion.service"
grep -q 'draftside-companion-ui' "$work/root/usr/bin/draftside-companion-desktop"
grep -q '^Terminal=false$' "$work/root/usr/share/applications/draftside-companion.desktop"
grep -q '<project_license>MIT</project_license>' "$work/root/usr/share/metainfo/com.draftside.companion.metainfo.xml"
grep -q '<content_rating type="oars-1.1"/>' "$work/root/usr/share/metainfo/com.draftside.companion.metainfo.xml"
grep -q '<release version="0.2.0"' "$work/root/usr/share/metainfo/com.draftside.companion.metainfo.xml"
appstreamcli validate --no-net --strict "$work/root/usr/share/metainfo/com.draftside.companion.metainfo.xml"

if rg -n --hidden --glob '!*.svg' '(gh[pousr]_|cfat_|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|espn_s2|SWID=)' "$work/root"; then
  echo "Packaged payload contains a secret-like value" >&2
  exit 1
fi

for script in "$root"/packaging/debian/*.sh "$root"/packaging/debian/postinst "$root"/packaging/debian/postrm "$root"/packaging/debian/draftside-companion*; do
  case "$script" in
    *.desktop|*.service|*.svg) continue ;;
  esac
  sh -n "$script"
done

echo "Debian package checks passed"
