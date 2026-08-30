#!/usr/bin/env bash

set -euo pipefail

extension_uuid="OriginUICC@quandz24.extension"
patched_shell_source="${PATCHED_SHELL_SOURCE:-/home/quandz24/Desktop/originuicc-gnome-shell-patch/gnome-shell-48.7}"
patched_shell_js="${GNOME_SHELL_JS:-$patched_shell_source/js}"
patched_shell_binary="${PATCHED_GNOME_SHELL_BINARY:-}"
wayland_name="${ORIGINUICC_NESTED_DISPLAY:-originuicc-test}"
host_runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
host_wayland_display="${WAYLAND_DISPLAY:-}"
tmp_config="$(mktemp -d "$host_runtime_dir/originuicc-nested-config.XXXXXX")"
tmp_runtime="$(mktemp -d "$host_runtime_dir/originuicc-nested-runtime.XXXXXX")"
resource_overlay="/org/gnome/shell=$patched_shell_js"
shell_args=(--nested --wayland --no-x11 --wayland-display="$wayland_name")

find_patched_shell_binary() {
  if [[ -n "$patched_shell_binary" ]]; then
    printf '%s\n' "$patched_shell_binary"
    return
  fi

  for candidate in \
    "$patched_shell_source/build/src/gnome-shell" \
    "$patched_shell_source/_build/src/gnome-shell" \
    "$patched_shell_source/builddir/src/gnome-shell"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
}

join_by_colon() {
  local IFS=:
  printf '%s' "$*"
}

if [[ -n "$host_wayland_display" ]]; then
  if [[ "$host_wayland_display" = /* ]]; then
    parent_wayland_socket="$host_wayland_display"
  else
    parent_wayland_socket="$host_runtime_dir/$host_wayland_display"
  fi
else
  parent_wayland_socket=""
fi

cleanup() {
  rm -rf "$tmp_config"
  rm -rf "$tmp_runtime"
}
trap cleanup EXIT

if [[ ! -d "$patched_shell_js/ui" ]]; then
  echo "Patched GNOME Shell JS directory not found: $patched_shell_js" >&2
  exit 1
fi

patched_shell_binary="$(find_patched_shell_binary)"
if [[ -z "$patched_shell_binary" || ! -x "$patched_shell_binary" ]]; then
  cat >&2 <<EOF
Patched GNOME Shell binary not found.

This test now needs a built binary because backdrop-blur is handled in C/St,
not by JS resource overlay.

Expected one of:
  $patched_shell_source/build/src/gnome-shell
  $patched_shell_source/_build/src/gnome-shell
  $patched_shell_source/builddir/src/gnome-shell

Or set:
  PATCHED_GNOME_SHELL_BINARY=/path/to/build/src/gnome-shell ./run-nested-shell.sh
EOF
  exit 1
fi

patched_shell_build_dir="$(cd "$(dirname "$patched_shell_binary")/.." && pwd)"
typelib_path="$(join_by_colon \
  "$patched_shell_build_dir/src" \
  "$patched_shell_build_dir/src/st" \
  "$patched_shell_build_dir/subprojects/gvc" \
  "$patched_shell_build_dir/subprojects/shew/src")"
library_path="$(join_by_colon \
  "$patched_shell_build_dir/src" \
  "$patched_shell_build_dir/src/st" \
  "$patched_shell_build_dir/subprojects/gvc" \
  "$patched_shell_build_dir/subprojects/shew/src")"

if pgrep -f "$patched_shell_binary --nested --wayland --no-x11 --wayland-display=$wayland_name" >/dev/null; then
  echo "Nested GNOME Shell is already running on Wayland display: $wayland_name" >&2
  exit 1
fi

if [[ -n "$parent_wayland_socket" && ! -S "$parent_wayland_socket" ]]; then
  echo "Parent Wayland socket not found: $parent_wayland_socket" >&2
  exit 1
fi

chmod 700 "$tmp_runtime"

export GSETTINGS_BACKEND=keyfile
export XDG_CONFIG_HOME="$tmp_config"

gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell disable-extension-version-validation true
gsettings set org.gnome.shell enabled-extensions "['$extension_uuid']"

echo "Starting nested GNOME Shell with patched binary:"
echo "  binary=$patched_shell_binary"
echo "  build=$patched_shell_build_dir"
echo "  GI_TYPELIB_PATH=$typelib_path"
echo "  LD_LIBRARY_PATH=$library_path"
echo "  GNOME_SHELL_JS=$patched_shell_js"
echo "  G_RESOURCE_OVERLAYS=$resource_overlay"
echo "  XDG_RUNTIME_DIR=$tmp_runtime"
echo "  Wayland display=$wayland_name"
echo "Close the nested shell window to stop the test."

dbus-run-session -- env \
  GSETTINGS_BACKEND="$GSETTINGS_BACKEND" \
  XDG_CONFIG_HOME="$XDG_CONFIG_HOME" \
  XDG_RUNTIME_DIR="$tmp_runtime" \
  WAYLAND_DISPLAY="$parent_wayland_socket" \
  GI_TYPELIB_PATH="${GI_TYPELIB_PATH:+$GI_TYPELIB_PATH:}$typelib_path" \
  LD_LIBRARY_PATH="${LD_LIBRARY_PATH:+$LD_LIBRARY_PATH:}$library_path" \
  GNOME_SHELL_JS="$patched_shell_js" \
  G_RESOURCE_OVERLAYS="${G_RESOURCE_OVERLAYS:+$G_RESOURCE_OVERLAYS:}$resource_overlay" \
  GNOME_SHELL_DATADIR="${GNOME_SHELL_DATADIR:-/usr/share/gnome-shell}" \
  XDG_CURRENT_DESKTOP=GNOME \
  "$patched_shell_binary" "${shell_args[@]}"
