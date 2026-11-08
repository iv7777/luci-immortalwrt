# luci-app-tailscale-plus

LuCI app for Tailscale on OpenWrt/ImmortalWrt. It starts from
`luci-app-tailscale-community` and adds the useful parts of `luci-app-tailscale`.

Menu: **VPN → Tailscale** (Settings, Diagnostics, Logs).
`menuconfig`: **LuCI → 3. Applications → luci-app-tailscale-plus**.

## Features

- Status header and device list (direct/relay path, traffic, last seen)
- Settings: accept routes, advertise routes / exit node, use an exit node,
  Tailscale SSH, Shields Up, web client, DNS mode, peer relay, stateful
  filtering, device name
- Login in the browser, with an auth key, or against a custom (Headscale)
  server; the auth key is never stored
- Firewall helper: creates the `tailscale` interface/zone and only the
  forwardings you tick (LAN↔Tailscale, Tailscale→WAN, WAN→Tailscale, router access)
- Diagnostics: interface counters, `tailscale netcheck`, `tailscale ping`
- Logs page (`logread -e tailscale`) with scroll-to-end / scroll-to-top buttons
- Account tab: shows the account(s) stored on this router (also while the
  service is disabled), the current account and which server the next login uses
- Advanced → Local Profile: removes a login profile from this router only
  (see below)
- Advanced: daemon port, state file, firewall backend, log switches

## Disabled by default

The service is **off until you enable it** in the Settings page.
On first install, `/etc/uci-defaults/90_luci-tailscale-plus` sets
`tailscale.settings.service_enabled=0` and disables the stock
`/etc/init.d/tailscale`. If a node already exists (state file present) it is
kept running and its own settings are left alone until you save once from LuCI.

## How it works

- `/etc/config/tailscale` (shipped by the `tailscale` package) holds the options.
- `/etc/init.d/tailscale-plus` reacts to config changes, (re)starts the stock
  Tailscale service if needed and applies the options with `tailscale set`.
  An exit node is cleared first and set last, because Tailscale refuses to
  advertise and use an exit node at the same time.
- The rpcd plugin `tailscale_plus.uc` provides status, login, firewall,
  logs and diagnostics through ubus only; no command `exec` ACLs are needed.
  Slow commands (login, netcheck, ping) run through
  `/usr/libexec/tailscale-plus-helper` so rpcd never blocks.

## Local profile removal

*Advanced → Local Profile* forgets a login profile on this router. It is purely
local: nothing is sent to Tailscale, the device stays listed in the Tailscale
admin console and its key stays valid. (*Logout* in the Account tab is the
proper way to leave an account: it tells Tailscale and expires the device key.)

Removing a profile edits the Tailscale state file, exactly what tailscaled does
itself when it deletes a profile: the daemon is stopped, `<state file>.bak` is
written, the profile entry (and the current-profile pointer if needed) is
removed, and the daemon is started again if the service is enabled. If no
profile is left the legacy `_daemon` entry is removed too, because tailscaled
would otherwise migrate the old login back. Nothing is changed unless the file
parses and looks as expected (`/usr/libexec/tailscale-plus-profile.uc`).

## Notes

- Do not install together with `luci-app-tailscale` or
  `luci-app-tailscale-community`. They also manage `/etc/config/tailscale`.
- Needs the stock `tailscale` package init script and default config
  (i.e. without the old "work with luci-app-tailscale" patch).
- Auto-update and Taildrop are not offered: the package build omits them.

Derived from luci-app-tailscale-community (Tokisaki-Galaxy) and
luci-app-tailscale (asvow). License: GPL-3.0-only.
