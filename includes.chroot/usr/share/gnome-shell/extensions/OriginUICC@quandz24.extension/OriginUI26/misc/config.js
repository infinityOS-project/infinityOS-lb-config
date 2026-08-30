const pkg = imports.package;

/* The name of this package (not localized) */
export const PACKAGE_NAME = 'gnome-shell';
/* The version of this package */
export const PACKAGE_VERSION = '48.7';
/* 1 if networkmanager is available, 0 otherwise */
export const HAVE_NETWORKMANAGER = 1;
/* 1 if portal helper is enabled, 0 otherwise */
export const HAVE_PORTAL_HELPER = 0;
/* gettext package */
export const GETTEXT_PACKAGE = 'gnome-shell';
/* locale dir */
export const LOCALEDIR = '/usr/share/locale';
/* other standard directories */
export const LIBEXECDIR = '/usr/libexec';
export const PKGDATADIR = '/usr/share/gnome-shell';
/* g-i package versions */
export const LIBMUTTER_API_VERSION = '16';

export const HAVE_BLUETOOTH = pkg.checkSymbol('GnomeBluetooth', '3.0',
    'Client.default_adapter_state');

export const UTILITIES_FOLDER_APPS = [
  'org.gnome.Decibels.desktop',
  'org.gnome.Connections.desktop',
  'org.gnome.Evince.desktop',
  'org.gnome.FileRoller.desktop',
  'org.gnome.font-viewer.desktop',
  'org.gnome.Loupe.desktop',
  'org.gnome.seahorse.Application.desktop'
]
;
export const SYSTEM_FOLDER_APPS = [
  'nm-connection-editor.desktop',
  'org.gnome.DejaDup.desktop',
  'org.gnome.baobab.desktop',
  'org.gnome.DiskUtility.desktop',
  'im-config.desktop',
  'org.gnome.Logs.desktop',
  'org.freedesktop.MalcontentControl.desktop',
  'org.freedesktop.GnomeAbrt.desktop',
  'org.gnome.tweaks.desktop',
  'org.gnome.Sysprof.desktop',
  'org.gnome.SystemMonitor.desktop'
]
;
