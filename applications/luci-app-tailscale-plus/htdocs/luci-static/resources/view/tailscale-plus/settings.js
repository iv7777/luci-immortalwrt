'use strict';
'require view';
'require form';
'require rpc';
'require ui';
'require uci';
'require poll';

// SPDX-License-Identifier: GPL-3.0-only
//
// Settings page of luci-app-tailscale-plus. The status header, the login
// flow, the firewall helper and the device list talk to the "tailscale_plus"
// ubus object; everything else is plain UCI (/etc/config/tailscale) that
// /etc/init.d/tailscale-plus applies with "tailscale set".

const callGetStatus = rpc.declare({ object: 'tailscale_plus', method: 'get_status' });
const callGetSubroutes = rpc.declare({ object: 'tailscale_plus', method: 'get_subroutes' });
const callGetFirewall = rpc.declare({ object: 'tailscale_plus', method: 'get_firewall' });
const callSetupFirewall = rpc.declare({
	object: 'tailscale_plus',
	method: 'setup_firewall',
	params: [ 'router_input', 'lan_to_ts', 'ts_to_lan', 'ts_to_wan', 'wan_to_ts' ]
});
const callStartLogin = rpc.declare({
	object: 'tailscale_plus',
	method: 'start_login',
	params: [ 'login_server', 'auth_key' ]
});
const callGetLoginStatus = rpc.declare({ object: 'tailscale_plus', method: 'get_login_status' });
const callLogout = rpc.declare({ object: 'tailscale_plus', method: 'do_logout' });

const STATUS_ID = 'tailscale_plus_status';
const DEVICES_ID = 'tailscale_plus_devices';

let map = null;

function formatBytes(bytes) {
	const n = parseInt(bytes, 10);

	if (isNaN(n) || n <= 0)
		return '-';

	const units = [ 'B', 'KB', 'MB', 'GB', 'TB' ];
	const i = Math.min(Math.floor(Math.log(n) / Math.log(1000)), units.length - 1);

	return parseFloat((n / Math.pow(1000, i)).toFixed(2)) + ' ' + units[i];
}

function formatLastSeen(value) {
	if (!value || value.indexOf('0001-01-01') === 0)
		return '-';

	const t = new Date(value);
	if (isNaN(t.getTime()))
		return '-';

	const diff = (Date.now() - t.getTime()) / 1000;
	if (diff < 60)
		return _('Just now');

	const mins = Math.floor(diff / 60);
	if (mins < 60)
		return _('%d min ago').format(mins);

	const hrs = Math.floor(mins / 60);
	if (hrs < 24)
		return _('%d h ago').format(hrs);

	return t.toLocaleDateString();
}

// E() treats a lone string child as HTML, an array child as text. All dynamic
// values (device names, OS, health messages ...) therefore go in as arrays.
function statusRow(label, value) {
	return E('dl', { 'class': 'cbi-value' }, [
		E('dt', {}, [ label ]),
		E('dd', {}, Array.isArray(value) ? value : [ value ])
	]);
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, function(c) {
		return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
	});
}

function colored(text, color) {
	return E('strong', { 'style': 'color:' + color + ';' }, [ text ]);
}

function renderStatus(status) {
	if (!status || !status.hasOwnProperty('status'))
		return E('em', {}, _('Collecting data ...'));

	switch (status.status) {
	case 'backend_error':
		return statusRow(_('Service Status'), [
			colored(_('BACKEND NOT AVAILABLE'), 'red'), E('br'),
			_('The "tailscale_plus" service of rpcd is missing. Check "logread -e rpcd" for errors and run "/etc/init.d/rpcd restart".')
		]);

	case 'not_installed':
		return statusRow(_('Service Status'), colored(_('TAILSCALE NOT FOUND'), 'red'));

	case 'not_running':
		if (!status.service_enabled) {
			return statusRow(_('Service Status'), [
				colored(_('DISABLED'), 'gray'), E('br'),
				_('Tailscale is switched off. Enable it in the settings below, then click "Save & Apply".')
			]);
		}

		return statusRow(_('Service Status'), colored(_('NOT RUNNING'), 'red'));

	case 'starting':
		return statusRow(_('Service Status'), colored(_('STARTING'), 'orange'));

	case 'stopped':
		return statusRow(_('Service Status'), [
			colored(_('STOPPED'), 'orange'), E('br'),
			_('Tailscale is installed but turned down ("tailscale down").')
		]);

	case 'logout':
		return statusRow(_('Service Status'), [
			colored(_('LOGGED OUT'), 'orange'), E('br'),
			_('Use the Login button in the "Account" tab to authenticate this device.')
		]);

	case 'needs_machine_auth':
		return statusRow(_('Service Status'), [
			colored(_('WAITING FOR APPROVAL'), 'orange'), E('br'),
			_('An administrator has to approve this device in the Tailscale admin console.')
		]);

	case 'running':
		break;

	default:
		return statusRow(_('Service Status'), colored(_('UNKNOWN'), 'gray'));
	}

	const rows = [
		[ _('Service Status'), colored(_('RUNNING'), 'green') ],
		[ _('Version'), status.version || '-' ],
		[ _('Device Name'), status.hostname || '-' ],
		[ _('Tailscale IPv4'), status.ipv4 || '-' ],
		[ _('Tailscale IPv6'), status.ipv6 || '-' ],
		[ _('Tailnet Name'), status.domain_name || '-' ],
		[ _('TUN Mode'), status.TUNMode ? _('Enabled') : _('Disabled') ]
	];

	if (status.exit_node_ip)
		rows.push([ _('Using Exit Node'), status.exit_node_ip ]);

	if (status.health && status.health.length > 0) {
		const lines = [];

		status.health.forEach(function(msg, i) {
			if (i > 0)
				lines.push(E('br'));
			lines.push(msg);
		});

		rows.push([ _('Health Check'), E('span', { 'style': 'color:orange;' }, lines) ]);
	}

	return E('div', {}, rows.map(function(r) {
		return statusRow(r[0], r[1]);
	}));
}

function renderConnection(peer) {
	if (peer.cur_addr)
		return _('Direct') + ' (' + peer.cur_addr + ')';

	if (peer.relay)
		return _('Relay') + ' (' + peer.relay + ')';

	return '-';
}

function renderDevices(status) {
	if (!status || !status.hasOwnProperty('status'))
		return E('em', {}, _('Collecting data ...'));

	if (status.status !== 'running')
		return E('em', {}, _('Tailscale is not running.'));

	const peers = status.peers || [];
	if (peers.length === 0)
		return E('p', {}, _('No peer devices found.'));

	const headers = [ _('Status'), _('Hostname'), _('Tailscale IP'), _('OS'), _('Connection'), _('RX'), _('TX'), _('Last Seen') ];

	return E('table', { 'class': 'table' }, [
		E('tr', { 'class': 'tr table-titles' }, headers.map(function(h) {
			return E('th', { 'class': 'th' }, h);
		}))
	].concat(peers.map(function(peer) {
		const ips = [];

		(peer.ips || []).forEach(function(ip, i) {
			if (i > 0)
				ips.push(E('br'));
			ips.push(ip);
		});

		return E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td' }, E('span', {
				'style': 'color:' + (peer.exit_node ? 'blue' : (peer.online ? 'green' : 'gray')) + ';',
				'title': (peer.exit_node ? _('Exit Node') + ', ' : '') + (peer.online ? _('Online') : _('Offline'))
			}, peer.online ? '●' : '○')),
			E('td', { 'class': 'td' }, [ E('strong', {}, [ peer.hostname + (peer.exit_node_option ? ' (' + _('Exit Node') + ')' : '') ]) ]),
			E('td', { 'class': 'td' }, ips),
			E('td', { 'class': 'td' }, [ peer.os || '-' ]),
			E('td', { 'class': 'td' }, [ renderConnection(peer) ]),
			E('td', { 'class': 'td' }, [ formatBytes(peer.rx) ]),
			E('td', { 'class': 'td' }, [ formatBytes(peer.tx) ]),
			E('td', { 'class': 'td' }, [ peer.online ? _('Now') : formatLastSeen(peer.last_seen) ])
		]);
	})));
}

function notify(message, level, timeout) {
	ui.addTimeLimitedNotification(null, [ E('p', {}, [ message ]) ], timeout || 7000, level || 'info');
}

function pollLogin(win, useKey, tries) {
	return L.resolveDefault(callGetLoginStatus(), null).then(function(res) {
		if (res && res.state === 'running') {
			ui.hideModal();
			if (win)
				win.close();
			notify(_('Logged in to Tailscale.'), 'info');
			return;
		}

		if (res && res.state === 'needs_machine_auth') {
			ui.hideModal();
			if (win)
				win.close();
			notify(_('Logged in. An administrator has to approve this device in the Tailscale admin console.'), 'info', 15000);
			return;
		}

		if (res && !useKey && win && /^https?:\/\//.test(res.auth_url || '')) {
			win.location.href = res.auth_url;
			ui.hideModal();
			notify(_('Complete the login in the new browser tab. This page updates automatically afterwards.'), 'info', 15000);
			return;
		}

		if (res && res.rc != null && res.rc !== 0 && !res.running) {
			ui.hideModal();
			if (win)
				win.close();
			notify(_('Login failed: %s').format(res.output || _('Unknown error')), 'error', 12000);
			return;
		}

		if (tries >= 30) {
			ui.hideModal();
			if (win)
				win.close();
			notify(_('Timed out while waiting for the login. Check the log and try again.'), 'error', 12000);
			return;
		}

		return new Promise(function(resolve) {
			window.setTimeout(resolve, 2000);
		}).then(function() {
			return pollLogin(win, useKey, tries + 1);
		});
	});
}

function doLogin(server, authKey) {
	const useKey = (authKey !== '');
	let win = null;

	// The tab has to be opened from the click handler, or pop-up blockers refuse it.
	if (!useKey) {
		win = window.open('', '_blank');
		if (!win) {
			notify(_('Could not open a new tab. Please allow pop-ups for this site.'), 'error', 10000);
			return Promise.resolve();
		}

		win.document.body.textContent = _('Requesting the Tailscale login URL ... please wait.');
	}

	ui.showModal(_('Tailscale Login'), [
		E('p', { 'class': 'spinning' }, useKey ? _('Logging in with the auth key ...') : _('Requesting the login URL ...'))
	]);

	return callStartLogin(server, authKey).then(function(res) {
		if (!res || res.error)
			throw new Error((res && res.error) || _('Unknown error'));

		return pollLogin(win, useKey, 0);
	}).catch(function(err) {
		ui.hideModal();
		if (win)
			win.close();
		notify(_('Login failed: %s').format(err.message || err), 'error', 10000);
	});
}

function doLogout() {
	ui.showModal(_('Confirm Logout'), [
		E('p', {}, _('Are you sure you want to log out? This disconnects this device from your tailnet and you have to authenticate again.')),
		E('div', { 'class': 'right' }, [
			E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Cancel')),
			' ',
			E('button', {
				'class': 'cbi-button cbi-button-negative',
				'click': function() {
					ui.showModal(_('Logging out ...'), [ E('p', { 'class': 'spinning' }, _('Please wait.')) ]);

					return callLogout().then(function(res) {
						ui.hideModal();
						if (res && res.error)
							notify(_('Logout failed: %s').format(res.error), 'error');
						else
							notify(_('Logged out.'), 'info');
					}).catch(function(err) {
						ui.hideModal();
						notify(_('Logout failed: %s').format(err.message || err), 'error');
					});
				}
			}, _('Logout'))
		])
	]);
}

function renderFirewall(fw) {
	fw = fw || {};

	const boxes = [
		{ key: 'router_input', label: _('Tailnet devices may access this router'), hint: _('Zone input policy. Needed for Tailscale SSH, the web interface or LuCI over the tailnet.'), zones: [] },
		{ key: 'lan_to_ts', label: _('LAN devices may access the tailnet'), hint: _('Lets LAN clients reach other tailnet devices and subnets, and use an exit node through this router.'), zones: [ 'lan' ] },
		{ key: 'ts_to_lan', label: _('Tailnet devices may access the LAN'), hint: _('Required for Subnet Routing: remote devices reaching the subnets advertised by this router.'), zones: [ 'lan' ] },
		{ key: 'ts_to_wan', label: _('Tailnet devices may access the internet through this router'), hint: _('Required when this router is advertised as an exit node.'), zones: [ 'wan' ] },
		{ key: 'wan_to_ts', label: _('WAN may access the tailnet'), hint: _('Rarely needed. Leave this off unless you know you need it.'), zones: [ 'wan' ] }
	];

	const inputs = {};

	const rows = boxes.map(function(box) {
		const missing = box.zones.some(function(z) {
			return (z === 'lan' && fw.has_lan_zone === false) || (z === 'wan' && fw.has_wan_zone === false);
		});

		const input = E('input', {
			'type': 'checkbox',
			'id': 'tsfw_' + box.key,
			'checked': fw[box.key] ? 'checked' : null,
			'disabled': missing ? 'disabled' : null
		});
		inputs[box.key] = input;

		return E('div', { 'style': 'margin-bottom:0.6em;' }, [
			E('label', {}, [ input, ' ', E('strong', {}, box.label) ]),
			E('div', { 'class': 'cbi-value-description' }, box.hint + (missing ? ' ' + _('(The required firewall zone does not exist.)') : ''))
		]);
	});

	const button = E('button', {
		'class': 'cbi-button cbi-button-action',
		'click': function(ev) {
			ev.preventDefault();

			return callSetupFirewall(
				inputs.router_input.checked, inputs.lan_to_ts.checked, inputs.ts_to_lan.checked,
				inputs.ts_to_wan.checked, inputs.wan_to_ts.checked
			).then(function(res) {
				if (res && res.error)
					notify(_('Failed to configure the firewall: %s').format(res.error), 'error');
				else if (res && res.changed)
					notify(_('Firewall configuration applied. The firewall is reloading in the background.'), 'info');
				else
					notify(_('The firewall was already configured like this.'), 'info');
			}).catch(function(err) {
				notify(_('Failed to configure the firewall: %s').format(err.message || err), 'error');
			});
		}
	}, _('Apply Firewall Settings'));

	return E('div', { 'class': 'cbi-value' }, [
		E('p', {}, _('Creates the "tailscale" interface and firewall zone if needed, then allows exactly the traffic you tick below. Nothing is allowed that is not ticked. These settings are applied immediately and independently of "Save & Apply".')),
		E('div', {}, rows),
		button
	]);
}

return view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(callGetStatus(), { status: 'backend_error', peers: [] }),
			L.resolveDefault(callGetSubroutes(), { routes: [] }),
			L.resolveDefault(callGetFirewall(), null),
			uci.load('tailscale')
		]).then(function(data) {
			// make sure the section exists, even if the package default config is gone
			if (uci.get('tailscale', 'settings') === null)
				uci.add('tailscale', 'settings', 'settings');

			return data;
		});
	},

	render: function(data) {
		const status = data[0] || {};
		const subroutes = (data[1] && data[1].routes) || [];
		const firewall = data[2];

		let s, o;

		map = new form.Map('tailscale', _('Tailscale'),
			_('Tailscale is a mesh VPN that connects your devices securely. Everything is off until you enable the service below.'));

		s = map.section(form.NamedSection, 'settings', 'settings');
		s.anonymous = true;
		s.addremove = false;
		s.tab('general', _('General'));
		s.tab('account', _('Account'));
		s.tab('firewall', _('Firewall'));
		s.tab('devices', _('Devices'));
		s.tab('advanced', _('Advanced'));

		// ---------------------------------------------------------- General
		o = s.taboption('general', form.Flag, 'service_enabled', _('Enable Tailscale'),
			_('Turns the Tailscale service on or off. When off, the daemon is stopped and does not start at boot.'));
		o.rmempty = false;
		o.default = o.disabled;

		o = s.taboption('general', form.Value, 'hostname', _('Device Name'),
			_('Name of this device in your tailnet. Leave empty to use the system hostname.'));
		o.datatype = 'hostname';
		o.placeholder = status.hostname || '';
		o.rmempty = true;

		o = s.taboption('general', form.Flag, 'accept_routes', _('Accept Routes'),
			_('Accept subnet routes advertised by other devices in your tailnet.'));
		o.rmempty = false;
		o.default = o.disabled;

		o = s.taboption('general', form.DynamicList, 'advertise_routes', _('Advertise Routes'),
			_('Subnets behind this router that other tailnet devices may reach (subnet router). Pick a detected subnet or enter your own in CIDR notation. The routes still have to be approved in the Tailscale admin console.'));
		o.datatype = 'cidr';
		o.rmempty = true;
		subroutes.forEach(function(subnet) {
			o.value(subnet, subnet);
		});

		o = s.taboption('general', form.Flag, 'advertise_exit_node', _('Advertise Exit Node'),
			_('Offer this device as an exit node for internet traffic. Ignored while an exit node is selected below. Allow "Tailnet devices may access the internet" in the Firewall tab.'));
		o.rmempty = false;
		o.default = o.disabled;

		o = s.taboption('general', form.ListValue, 'exit_node', _('Use Exit Node'),
			_('Route this router\'s internet traffic through another device. For LAN clients to use it, allow "LAN devices may access the tailnet" in the Firewall tab. If you pick a device here, "Advertise Exit Node" is switched off.'));
		o.value('', _('None'));
		(status.peers || []).forEach(function(peer) {
			if (peer.exit_node_option && peer.ip)
				o.value(peer.ip, escapeHtml(peer.hostname + ' (' + peer.ip + ')') + (peer.online ? '' : ' - ' + _('offline')));
		});
		const savedExit = uci.get('tailscale', 'settings', 'exit_node');
		if (savedExit && !(status.peers || []).some(function(p) { return p.exit_node_option && p.ip === savedExit; }))
			o.value(savedExit, escapeHtml(savedExit) + ' (' + _('not in the current device list') + ')');
		o.rmempty = true;

		o = s.taboption('general', form.Flag, 'exit_node_allow_lan_access', _('Allow LAN Access'),
			_('While using an exit node, keep direct access to the local network. Recommended on a router, otherwise LAN traffic is sent through the exit node.'));
		o.rmempty = false;
		o.default = o.enabled;

		o = s.taboption('general', form.Flag, 'ssh', _('Tailscale SSH'),
			_('Let Tailscale run an SSH server for this device, with access controlled by your tailnet policy.'));
		o.rmempty = false;
		o.default = o.disabled;

		o = s.taboption('general', form.Flag, 'shields_up', _('Shields Up'),
			_('Block all incoming connections from the tailnet.'));
		o.rmempty = false;
		o.default = o.disabled;

		o = s.taboption('general', form.Flag, 'runwebclient', _('Web Interface'),
			_('Expose the Tailscale web interface on port 5252, reachable over the tailnet only.'));
		o.rmempty = false;
		o.default = o.disabled;

		o = s.taboption('general', form.Flag, 'nosnat', _('Disable SNAT for Subnet Routes'),
			_('Keep the original source address for traffic to advertised subnets. Most users should leave this off. It also breaks exit node traffic.'));
		o.rmempty = false;
		o.default = o.disabled;

		o = s.taboption('general', form.Flag, 'stateful_filtering', _('Stateful Filtering'),
			_('Only forward reply traffic for subnet routers and exit nodes. Extra protection for forwarded packets.'));
		o.rmempty = false;
		o.default = o.disabled;

		o = s.taboption('general', form.ListValue, 'dns_mode', _('DNS Mode'),
			_('Disabled: system DNS only.') + '<br />' +
			_('MagicDNS: Tailscale manages DNS settings of this device.') + '<br />' +
			_('OpenWrt Forward: dnsmasq forwards ts.net names to Tailscale (ts.net only).'));
		o.value('disabled', _('Disabled'));
		o.value('magicdns', 'MagicDNS');
		o.value('openwrt_forward', _('OpenWrt Forward'));
		o.default = 'disabled';
		o.rmempty = false;

		o = s.taboption('general', form.Flag, 'enable_relay', _('Peer Relay'),
			_('Act as a Peer Relay server for other devices. Needs a public IP address and an open UDP port.'));
		o.rmempty = false;
		o.default = o.disabled;

		o = s.taboption('general', form.Value, 'relay_server_port', _('Peer Relay Port'),
			_('UDP port of the Peer Relay. Open it in your firewall and NAT.'));
		o.datatype = 'port';
		o.placeholder = '40000';
		o.rmempty = true;
		o.depends('enable_relay', '1');

		// ---------------------------------------------------------- Account
		const loginServer = s.taboption('account', form.Value, 'login_server', _('Custom Login Server'),
			_('Optional: URL of a custom control server such as Headscale, for example %s. Leave empty for the default Tailscale service.').format('https://headscale.example.com'));
		loginServer.datatype = 'string';
		loginServer.placeholder = 'https://';
		loginServer.rmempty = true;
		loginServer.validate = function(section_id, value) {
			if (value === '' || /^https?:\/\/[^\s'"]+$/.test(value))
				return true;

			return _('Enter a valid http:// or https:// URL.');
		};

		// Never stored: it is only used for the login request.
		const authKey = s.taboption('account', form.Value, 'auth_key', _('Auth Key'),
			_('Optional: log in with an auth key instead of the browser. The key is used once and is not saved anywhere.'));
		authKey.password = true;
		authKey.rmempty = true;
		authKey.cfgvalue = function() { return ''; };
		authKey.write = function() {};
		authKey.remove = function() {};

		o = s.taboption('account', form.Button, '_login', _('Login'),
			_('Logs this device in. With an auth key it logs in directly, otherwise a login page opens in a new tab.'));
		o.inputtitle = _('Log in');
		o.inputstyle = 'apply';
		o.onclick = function(ev, section_id) {
			const server = (loginServer.formvalue(section_id) || '').trim();
			const key = (authKey.formvalue(section_id) || '').trim();

			if (server !== '' && !/^https?:\/\/[^\s'"]+$/.test(server)) {
				notify(_('Enter a valid http:// or https:// URL.'), 'error');
				return;
			}

			return doLogin(server, key);
		};

		o = s.taboption('account', form.Button, '_logout', _('Logout'),
			_('Disconnects this device from the tailnet and expires its node key.'));
		o.inputtitle = _('Log out');
		o.inputstyle = 'negative';
		o.onclick = function() {
			return doLogout();
		};

		// --------------------------------------------------------- Firewall
		o = s.taboption('firewall', form.DummyValue, '_firewall');
		o.render = function() {
			return renderFirewall(firewall);
		};

		// ---------------------------------------------------------- Devices
		o = s.taboption('devices', form.DummyValue, '_devices');
		o.render = function() {
			return E('div', { 'id': DEVICES_ID }, renderDevices(status));
		};

		// --------------------------------------------------------- Advanced
		o = s.taboption('advanced', form.ListValue, 'fw_mode', _('Firewall Backend'),
			_('Firewall backend used by the Tailscale daemon. Applying a change restarts the daemon.'));
		o.value('nftables', 'nftables');
		o.value('iptables', 'iptables');
		o.default = 'nftables';
		o.rmempty = false;

		o = s.taboption('advanced', form.Value, 'port', _('Listen Port'),
			_('UDP port of the daemon (default 41641). Useful when you forward a port for direct connections. Applying a change restarts the daemon.'));
		o.datatype = 'port';
		o.placeholder = '41641';
		o.rmempty = true;

		o = s.taboption('advanced', form.Value, 'state_file', _('State File'),
			_('Where the daemon keeps its identity. A different path creates a new device and requires a new login. Never use a path in /tmp or /var, it is lost on reboot. Applying a change restarts the daemon.'));
		o.placeholder = '/etc/tailscale/tailscaled.state';
		o.rmempty = true;
		o.validate = function(section_id, value) {
			if (value === '' || /^\/[^\s'"]+$/.test(value))
				return true;

			return _('Enter an absolute path without spaces.');
		};

		o = s.taboption('advanced', form.Flag, 'log_stdout', _('Log Standard Output'),
			_('Send the daemon\'s regular messages to the system log.'));
		o.rmempty = false;
		o.default = o.enabled;

		o = s.taboption('advanced', form.Flag, 'log_stderr', _('Log Errors'),
			_('Send the daemon\'s error messages to the system log.'));
		o.rmempty = false;
		o.default = o.enabled;

		return map.render().then(function(formNode) {
			poll.add(function() {
				return L.resolveDefault(callGetStatus(), null).then(function(res) {
					if (!res)
						return;

					const statusNode = document.getElementById(STATUS_ID);
					if (statusNode)
						statusNode.replaceChildren(renderStatus(res));

					const devicesNode = document.getElementById(DEVICES_ID);
					if (devicesNode)
						devicesNode.replaceChildren(renderDevices(res));
				});
			}, 10);

			return E([], [
				E('div', { 'id': STATUS_ID, 'class': 'cbi-section' }, renderStatus(status)),
				formNode
			]);
		});
	},

	handleSave: function(ev) {
		// From now on the init script applies these settings to the node.
		uci.set('tailscale', 'settings', 'plus_configured', '1');

		return map.save();
	},

	handleSaveApply: function(ev, mode) {
		return this.handleSave(ev).then(function() {
			return ui.changes.apply(mode == '0');
		});
	},

	handleReset: null
});
