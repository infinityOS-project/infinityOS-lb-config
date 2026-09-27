# Debian 13 (trixie) live-build environment for ester infinityOS.
# Must be run with --privileged (live-build needs to bind-mount /proc, /sys,
# /dev and use loop devices to assemble the squashfs + hybrid ISO).
FROM debian:trixie

RUN apt-get update && apt-get install -y --no-install-recommends \
    live-build \
    debootstrap \
    debian-archive-keyring \
    xorriso \
    syslinux-common \
    isolinux \
    grub-efi-amd64-bin \
    grub-pc-bin \
    mtools \
    dosfstools \
    squashfs-tools \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY build.sh /usr/local/bin/build.sh
RUN chmod +x /usr/local/bin/build.sh

WORKDIR /build

# This image only bundles the build tooling. The live-build config tree
# (this repo) is bind-mounted in as /build/config at `docker run` time, e.g.:
#   docker build -t infinityos-build .
#   docker run --privileged -v "$(pwd):/build/config" infinityos-build

CMD ["/usr/local/bin/build.sh"]
