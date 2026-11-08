# SPDX-License-Identifier: GPL-3.0-only
#
# Derived from luci-app-tailscale-community (Tokisaki-Galaxy) and
# luci-app-tailscale (asvow).

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI support for Tailscale (Plus)
LUCI_DESCRIPTION:=Manage Tailscale from LuCI: status, settings, login, firewall setup, devices, diagnostics and logs. Disabled by default. Replaces luci-app-tailscale and luci-app-tailscale-community (do not install them together).
LUCI_DEPENDS:=+tailscale +luci-base
LUCI_PKGARCH:=all

PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-3.0-only

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
