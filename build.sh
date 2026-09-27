#!/bin/bash
set -euo pipefail
cd /build

if [ ! -d config ]; then
    echo "config/ not found (expected the infinityOS-lb-config tree mounted at /build/config)" >&2
    exit 1
fi

lb config \
    --distribution trixie \
    --archive-areas "main contrib non-free non-free-firmware" \
    --architectures amd64 \
    --binary-images iso-hybrid \
    --bootloaders "syslinux,grub-efi" \
    --debian-installer live \
    --bootappend-live "boot=live components quiet splash" \
    --mirror-bootstrap http://deb.debian.org/debian/ \
    --mirror-binary http://deb.debian.org/debian/

lb build
