/* SPDX-License-Identifier: GPL-3.0-only
 *
 * Copyright (C) 2022 ImmortalWrt.org
 * Copyright (C) 2024 asvow
 */

'use strict';
'require dom';
'require fs';
'require poll';
'require ui';
'require view';

return view.extend({
	async load() {
		// Fetch IP command results first
		const ipRes = await fs.exec('/sbin/ip', ['-s', '-j', 'ad']).catch(err => ({
			code: 1,
			message: err.message || 'Failed to execute ip command'
		}));

		// Handle ip command results
		let interfaces = [];
		if (ipRes.code !== 0 || !ipRes.stdout || ipRes.stdout.trim() === '') {
			ui.addNotification(null, E('p', {}, _('Unable to get interface info: %s.').format(ipRes.message || 'Unknown error')));
		} else {
			try {
				interfaces = JSON.parse(ipRes.stdout);
			} catch (e) {
				ui.addNotification(null, E('p', {}, _('Error parsing interface info: %s.').format(e.message)));
			}
		}

		const tailscaleInterfaces = interfaces.filter(iface => iface.ifname.match(/tailscale[0-9]+/));
		let tailscaleStatusRows = [];

		// Skip tailscale status command if no Tailscale interfaces are found
		if (tailscaleInterfaces.length === 0) {
			tailscaleStatusRows = [E('div', {}, _('No peers found'))];
		} else {
			// Run tailscale status command only if interfaces are found
			const statusRes = await fs.exec('tailscale', ['status', '--json']).catch(err => ({
				code: 1,
				message: err.message || 'Permission denied or command failed'
			}));

			// Handle tailscale status results
			if (statusRes.code !== 0) {
				const message = typeof statusRes.message === 'string' ? statusRes.message : 'Command failed';
				const errorMsg = message.includes('Permission') 
					? _('Permission denied: Ensure the user running LuCI has access to run "tailscale status --json". Try configuring sudo or checking Tailscale service permissions.')
					: message.includes('not running') || message.includes('stopped') 
						? _('Tailscale service is not running. Please start Tailscale and try again.')
						: _('Unable to get Tailscale status: %s.').format(message);
				ui.addNotification(null, E('p', {}, errorMsg));
				tailscaleStatusRows = [E('div', {}, _('Error retrieving status'))];
			} else if (!statusRes.stdout || statusRes.stdout.trim() === '') {
				ui.addNotification(null, E('p', {}, _('Tailscale status command returned empty output. Ensure Tailscale is running.')));
				tailscaleStatusRows = [E('div', {}, _('No status output'))];
			} else {
				try {
					const statusJson = JSON.parse(statusRes.stdout);
					const self = statusJson.Self || {};
					const peers = statusJson.Peer || {};

					// Generate table rows for peers only
					tailscaleStatusRows = [];
					for (const peer of Object.values(peers)) {
						const ip = peer.TailscaleIPs?.[0] || 'N/A';
						const hostname = peer.HostName || 'N/A';
						const status = peer.Online ? 'online' : 'offline';
						const relay = peer.Relay || 'N/A';
						const connection = peer.CurAddr ? 'direct' : 'relayed';
						const rxBytes = peer.RxBytes ? '%1024mB'.format(peer.RxBytes) : '0 MB';
						const txBytes = peer.TxBytes ? '%1024mB'.format(peer.TxBytes) : '0 MB';

						tailscaleStatusRows.push(
							E('tr', { class: 'tr' }, [
								E('td', { class: 'td left', style: 'padding-left: 10px' }, ip),
								E('td', { class: 'td left', style: 'padding-left: 10px' }, hostname),
								E('td', { class: 'td left', style: 'padding-left: 10px' }, status),
								E('td', { class: 'td left', style: 'padding-left: 10px' }, relay),
								E('td', { class: 'td left', style: 'padding-left: 10px' }, connection),
								E('td', { class: 'td left', style: 'padding-left: 10px' }, rxBytes),
								E('td', { class: 'td left', style: 'padding-left: 10px' }, txBytes)
							])
						);
					}

					if (tailscaleStatusRows.length === 0) {
						tailscaleStatusRows = [E('div', {}, _('No peers found'))];
					}
				} catch (e) {
					ui.addNotification(null, E('p', {}, _('Error parsing Tailscale status JSON: %s.').format(e.message)));
					tailscaleStatusRows = [E('div', {}, _('Error parsing status'))];
				}
			}
		}

		return { interfaces: tailscaleInterfaces, statusRows: tailscaleStatusRows };
	},

	pollData(container) {
		poll.add(async () => {
			const data = await this.load();
			dom.content(container, this.renderContent(data));
		});
	},

	renderContent(data) {
		const interfaceRows = [];
		if (!Array.isArray(data.interfaces) || data.interfaces.length === 0) {
			interfaceRows.push(E('div', {}, _('No interface online.')));
		} else {
			interfaceRows.push(E('th', { class: 'th left', style: 'padding-left: 10px', colspan: '2' }, _('Network Interface Information')));
			data.interfaces.forEach(iface => {
				const parsedInfo = {
					name: iface.ifname,
					ipv4: null,
					ipv6: null,
					mtu: iface.mtu,
					rxBytes: '%1024mB'.format(iface.stats64.rx.bytes),
					txBytes: '%1024mB'.format(iface.stats64.tx.bytes)
				};

				const addr_info = iface.addr_info || [];
				addr_info.forEach(addr => {
					if (addr.family === 'inet' && !parsedInfo.ipv4) {
						parsedInfo.ipv4 = addr.local;
					} else if (addr.family === 'inet6' && !parsedInfo.ipv6) {
						parsedInfo.ipv6 = addr.local;
					}
				});

				interfaceRows.push(
					E('tr', { class: 'tr' }, [
						E('td', { class: 'td left', width: '25%' }, _('Interface Name')),
						E('td', { class: 'td left', width: '25%' }, parsedInfo.name)
					]),
					E('tr', { class: 'tr' }, [
						E('td', { class: 'td left', width: '25%' }, _('IPv4 Address')),
						E('td', { class: 'td left', width: '25%' }, parsedInfo.ipv4 || 'N/A')
					]),
					E('tr', { class: 'tr' }, [
						E('td', { class: 'td left', width: '25%' }, _('IPv6 Address')),
						E('td', { class: 'td left', width: '25%' }, parsedInfo.ipv6 || 'N/A')
					]),
					E('tr', { class: 'tr' }, [
						E('td', { class: 'td left', width: '25%' }, _('MTU')),
						E('td', { class: 'td left', width: '25%' }, parsedInfo.mtu || 'N/A')
					]),
					E('tr', { class: 'tr' }, [
						E('td', { class: 'td left', width: '25%' }, _('Total Download')),
						E('td', { class: 'td left', width: '25%' }, parsedInfo.rxBytes || 'N/A')
					]),
					E('tr', { class: 'tr' }, [
						E('td', { class: 'td left', width: '25%' }, _('Total Upload')),
						E('td', { class: 'td left', width: '25%' }, parsedInfo.txBytes || 'N/A')
					])
				);
			});
		}

		const statusContent = [
			E('div', { style: 'margin-bottom: 20px' }, ''),
			E('table', { class: 'table', style: 'border-collapse: collapse; width: 100%;' }, [
				E('tr', { class: 'tr' }, [
					E('th', { class: 'th left', style: 'padding-left: 10px', colspan: '7' }, _('Peer Status'))
				]),
				E('tr', { class: 'tr' }, [
					E('td', { class: 'td left', style: 'padding-left: 10px', colspan: '7' }, [
						E('div', { class: 'cbi-map-descr' }, _('Current status of Tailscale nodes and connections.'))
					])
				]),
				E('tr', { class: 'tr' }, [
					E('th', { class: 'th left', style: 'padding-left: 10px' }, _('IP')),
					E('th', { class: 'th left', style: 'padding-left: 10px' }, _('Hostname')),
					E('th', { class: 'th left', style: 'padding-left: 10px' }, _('Status')),
					E('th', { class: 'th left', style: 'padding-left: 10px' }, _('Relay')),
					E('th', { class: 'th left', style: 'padding-left: 10px' }, _('Connection')),
					E('th', { class: 'th left', style: 'padding-left: 10px' }, _('Rx Bytes')),
					E('th', { class: 'th left', style: 'padding-left: 10px' }, _('Tx Bytes'))
				]),
				...data.statusRows
			])
		];

		return E('div', {}, [
			E('table', { class: 'table' }, interfaceRows),
			E('div', { style: 'margin-top: 20px' }, statusContent)
		]);
	},

	render(data) {
		const content = E('div', {}, [
			E('h2', { class: 'content' }, _('Tailscale')),
			E('div', { class: 'cbi-map-descr' }, _('Tailscale is a cross-platform and easy to use virtual LAN.')),
			E('div')
		]);
		const container = content.lastElementChild;

		dom.content(container, this.renderContent(data));
		this.pollData(container);

		return content;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});