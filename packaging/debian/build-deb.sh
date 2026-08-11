#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
version=$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$root/companion/pyproject.toml" | head -n1)
if [ -z "$version" ]; then
  echo "Could not determine companion version" >&2
  exit 1
fi

architecture=${DRAFTSIDE_DEB_ARCH:-amd64}
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-946684800}
export SOURCE_DATE_EPOCH
build_root=$(mktemp -d)
trap 'rm -rf "$build_root"' EXIT INT TERM
package_root="$build_root/draftside-companion_${version}-1_${architecture}"
output_dir="$root/dist"

install -d "$package_root/DEBIAN"
install -d "$package_root/usr/bin"
install -d "$package_root/usr/lib/python3/dist-packages"
install -d "$package_root/usr/lib/systemd/user"
install -d "$package_root/usr/share/applications"
install -d "$package_root/usr/share/doc/draftside-companion"
install -d "$package_root/usr/share/icons/hicolor/scalable/apps"
install -d "$package_root/usr/share/metainfo"

install -m 0755 "$root/packaging/debian/postinst" "$package_root/DEBIAN/postinst"
install -m 0755 "$root/packaging/debian/postrm" "$package_root/DEBIAN/postrm"

cp -a "$root/companion/src/draft_companion" "$package_root/usr/lib/python3/dist-packages/"
find "$package_root/usr/lib/python3/dist-packages" -type d -name __pycache__ -prune -exec rm -rf {} +
find "$package_root/usr/lib/python3/dist-packages" -type f -name '*.py[co]' -delete
find "$package_root/usr/lib/python3/dist-packages" -type d -exec chmod 0755 {} +
find "$package_root/usr/lib/python3/dist-packages" -type f -exec chmod 0644 {} +

for command in draftside-companion draftside-companion-setup draftside-companion-service draftside-companion-desktop draftside-companion-ui; do
  install -m 0755 "$root/packaging/debian/$command" "$package_root/usr/bin/$command"
done
install -m 0644 "$root/packaging/debian/draftside-companion.service" "$package_root/usr/lib/systemd/user/draftside-companion.service"
install -m 0644 "$root/packaging/debian/draftside-companion.desktop" "$package_root/usr/share/applications/draftside-companion.desktop"
install -m 0644 "$root/packaging/debian/draftside-companion.svg" "$package_root/usr/share/icons/hicolor/scalable/apps/draftside-companion.svg"
install -m 0644 "$root/packaging/debian/com.draftside.companion.metainfo.xml" "$package_root/usr/share/metainfo/com.draftside.companion.metainfo.xml"
install -m 0644 "$root/companion/README.md" "$package_root/usr/share/doc/draftside-companion/README.md"
install -m 0644 "$root/LICENSE" "$package_root/usr/share/doc/draftside-companion/copyright"
gzip -n -9 -c "$root/packaging/debian/changelog" > "$package_root/usr/share/doc/draftside-companion/changelog.Debian.gz"
chmod 0644 "$package_root/usr/share/doc/draftside-companion/changelog.Debian.gz"

installed_size=$(du -ks "$package_root/usr" | awk '{print $1}')
sed \
  -e "s/@VERSION@/$version/g" \
  -e "s/@INSTALLED_SIZE@/$installed_size/g" \
  "$root/packaging/debian/control.in" > "$package_root/DEBIAN/control"

find "$package_root" -print0 | xargs -0 touch -h -d "@$SOURCE_DATE_EPOCH"
install -d "$output_dir"
artifact="$output_dir/draftside-companion_${version}-1_${architecture}.deb"
dpkg-deb --build --root-owner-group "$package_root" "$artifact" >/dev/null
(cd "$output_dir" && sha256sum "$(basename "$artifact")" > "$(basename "$artifact").sha256")
printf '%s\n' "$artifact"
