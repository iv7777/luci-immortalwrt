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
const callGetAccounts = rpc.declare({ object: 'tailscale_plus', method: 'get_accounts' });
const callRemoveProfile = rpc.declare({ object: 'tailscale_plus', method: 'remove_profile', params: [ 'id' ] });
const callGetProfileOp = rpc.declare({ object: 'tailscale_plus', method: 'get_profile_op' });

const STATUS_ID = 'tailscale_plus_status';
const DEVICES_ID = 'tailscale_plus_devices';
const ACCOUNTS_ID = 'tailscale_plus_accounts';
const REMOVE_ID = 'tailscale_plus_profile_remove';

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
// Tables are a CSS grid of plain divs inside a box that scrolls sideways
// (portrait and landscape). They deliberately avoid table/.table/.tr/.td/.th:
// themes such as Argon restyle those below 1152px (cells become inline-block
// with a 10% flex basis, header rows are hidden), which made the text of
// neighbouring cells overlap.
const CELL = 'padding:0.5em 0.75em; white-space:nowrap; text-align:left; border-bottom:1px solid rgba(128,128,128,0.3);';

function scrollBox(content) {
	return E('div', { 'style': 'overflow-x:auto; -webkit-overflow-scrolling:touch; max-width:100%;' }, [ content ]);
}

// headers: array of texts, rows: array of arrays; a cell is a text, a node or
// an array of both (dynamic text must not be passed as a lone HTML string)
function gridTable(headers, rows) {
	const head = E('div', { 'role': 'row', 'style': 'display:contents;' }, headers.map(function(h) {
		return E('div', { 'role': 'columnheader', 'style': CELL + 'font-weight:600;' }, [ h ]);
	}));

	const body = rows.map(function(cells) {
		return E('div', { 'role': 'row', 'style': 'display:contents;' }, cells.map(function(c) {
			return E('div', { 'role': 'cell', 'style': CELL }, Array.isArray(c) ? c : [ c ]);
		}));
	});

	return scrollBox(E('div', {
		'role': 'table',
		'style': 'display:grid; grid-template-columns:repeat(' + headers.length + ', auto); width:max-content; min-width:100%;'
	}, [ head ].concat(body)));
}

function formatDate(value) {
	if (!value || value.indexOf('0001-01-01') === 0)
		return '-';

	const t = new Date(value);

	return isNaN(t.getTime()) ? '-' : t.toLocaleDateString();
}

// Label and value side by side, also on a phone (themes stack them there,
// which makes the status block very tall).
function statusGrid(rows) {
	const cells = [];

	rows.forEach(function(r) {
		cells.push(E('div', { 'style': 'font-weight:600;' }, [ r[0] ]));
		cells.push(E('div', { 'style': 'min-width:0; overflow-wrap:anywhere;' }, Array.isArray(r[1]) ? r[1] : [ r[1] ]));
	});

	return E('div', {
		'style': 'display:grid; grid-template-columns:max-content minmax(0, 1fr); column-gap:1.2em; row-gap:0.5em; align-items:start;'
	}, cells);
}

function statusRow(label, value) {
	return statusGrid([ [ label, value ] ]);
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
		[ _('Account'), (status.account_name && status.account) ? status.account_name + ' (' + status.account + ')' : (status.account || status.account_name || '-') ],
		[ _('TUN Mode'), status.TUNMode ? _('Enabled') : _('Disabled') ]
	];

	if (status.key_expiry && status.key_expiry.indexOf('0001-01-01') !== 0) {
		const expired = (new Date(status.key_expiry).getTime() < Date.now());

		rows.push([ _('Key Expires'), E('span', { 'style': expired ? 'color:red;' : '' }, [ formatDate(status.key_expiry) ]) ]);
	}

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

	return statusGrid(rows);
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

	return gridTable(headers, peers.map(function(peer) {
		const ips = [];

		(peer.ips || []).forEach(function(ip, i) {
			if (i > 0)
				ips.push(E('br'));
			ips.push(ip);
		});

		return [
			E('span', {
				'style': 'color:' + (peer.exit_node ? 'blue' : (peer.online ? 'green' : 'gray')) + ';',
				'title': (peer.exit_node ? _('Exit Node') + ', ' : '') + (peer.online ? _('Online') : _('Offline'))
			}, peer.online ? '●' : '○'),
			E('strong', {}, [ peer.hostname + (peer.exit_node_option ? ' (' + _('Exit Node') + ')' : '') ]),
			ips,
			peer.os || '-',
			renderConnection(peer),
			formatBytes(peer.rx),
			formatBytes(peer.tx),
			peer.online ? _('Now') : formatLastSeen(peer.last_seen)
		];
	}));
}

// ---------------------------------------------------------------- accounts

function serverName(url) {
	if (!url || /^https:\/\/controlplane\.tailscale\.com\/?$/.test(url))
		return _('Tailscale (default)');

	return url;
}

function accountLabel(p) {
	if (p.display_name && p.account)
		return p.display_name + ' (' + p.account + ')';

	return p.account || p.display_name || _('(login not completed)');
}

function renderAccounts(acc) {
	if (!acc)
		return E('em', {}, _('Account information is not available.'));

	if (acc.error)
		return E('em', {}, _('The state file could not be read.'));

	const profiles = acc.profiles || [];

	if (profiles.length === 0) {
		return E('div', {}, [
			E('p', {}, _('No account is stored on this router yet.')),
			E('p', {}, [ _('The next login will use: %s').format(serverName(acc.login_server)) ])
		]);
	}

	const table = gridTable([ _('Account'), _('Tailnet'), _('Server'), _('Added'), _('Status') ], profiles.map(function(p) {
		return [
			E('strong', {}, [ accountLabel(p) ]),
			p.tailnet || '-',
			serverName(p.server),
			formatDate(p.created),
			p.current ? _('Current') : _('Saved')
		];
	}));

	const nodes = [ table, E('p', { 'class': 'cbi-value-description' }, _('The current account is the one used when the service starts.')) ];

	if (!acc.service_enabled)
		nodes.push(E('p', { 'class': 'cbi-value-description' }, _('Tailscale is switched off. The current account is used when you enable it.')));

	return E('div', {}, nodes);
}

function waitProfileOp(tries) {
	return L.resolveDefault(callGetProfileOp(), null).then(function(res) {
		if (res && res.done)
			return res;

		if (tries >= 80)
			throw new Error(_('Timed out while removing the profile.'));

		return new Promise(function(resolve) {
			window.setTimeout(resolve, 1500);
		}).then(function() {
			return waitProfileOp(tries + 1);
		});
	});
}

function refreshAccounts() {
	return Promise.all([
		L.resolveDefault(callGetAccounts(), null),
		L.resolveDefault(callGetStatus(), null)
	]).then(function(res) {
		const accNode = document.getElementById(ACCOUNTS_ID);
		const rmNode = document.getElementById(REMOVE_ID);
		const stNode = document.getElementById(STATUS_ID);
		const devNode = document.getElementById(DEVICES_ID);

		if (accNode && res[0])
			accNode.replaceChildren(renderAccounts(res[0]));

		if (rmNode && res[0])
			rmNode.replaceChildren(renderProfileRemoval(res[0]));

		if (res[1] && stNode)
			stNode.replaceChildren(renderStatus(res[1]));

		if (res[1] && devNode)
			devNode.replaceChildren(renderDevices(res[1]));
	});
}

function doRemoveProfile(id) {
	ui.showModal(_('Removing profile ...'), [
		E('p', { 'class': 'spinning' }, _('Please wait. The Tailscale service is stopped briefly.'))
	]);

	return callRemoveProfile(id).then(function(res) {
		if (!res || res.error)
			throw new Error((res && res.error) || _('Unknown error'));

		return waitProfileOp(0);
	}).then(function(op) {
		ui.hideModal();

		if (op.rc !== 0)
			throw new Error(op.output || _('Unknown error'));

		notify(_('Profile removed.'), 'info');
		return refreshAccounts();
	}).catch(function(err) {
		ui.hideModal();
		notify(_('Removing the profile failed: %s').format(err.message || err), 'error', 12000);
		return refreshAccounts();
	});
}

function confirmRemoveProfile(profile, path) {
	ui.showModal(_('Remove Profile'), [
		E('p', {}, [ _('Remove the profile of %s from this router? This only deletes the login information stored here. Nothing is changed at Tailscale: the device stays in your admin console and its key stays valid. The Tailscale service is stopped and started again briefly. A backup copy of the state file is kept as %s.').format(accountLabel(profile), path + '.bak') ]),
		E('div', { 'class': 'right' }, [
			E('button', { 'class': 'cbi-button', 'click': ui.hideModal }, _('Cancel')),
			' ',
			E('button', {
				'class': 'cbi-button cbi-button-negative',
				'click': function() {
					ui.hideModal();
					return doRemoveProfile(profile.id);
				}
			}, _('Remove', 'Tailscale profile removal'))
		])
	]);
}

function renderProfileRemoval(acc) {
	if (!acc || acc.error)
		return E('em', {}, _('Account information is not available.'));

	const profiles = acc.profiles || [];

	if (profiles.length === 0)
		return E('p', {}, _('There is no profile stored on this router.'));

	const select = E('select', { 'class': 'cbi-input-select' }, profiles.map(function(p) {
		return E('option', { 'value': p.id }, [ accountLabel(p) + (p.current ? ' - ' + _('Current') : '') ]);
	}));

	const current = profiles.filter(function(p) { return p.current; })[0];
	if (current)
		select.value = current.id;

	const button = E('button', {
		'class': 'cbi-button cbi-button-negative',
		'click': function(ev) {
			ev.preventDefault();

			const chosen = profiles.filter(function(p) { return p.id === select.value; })[0];
			if (chosen)
				confirmRemoveProfile(chosen, acc.path || '/etc/tailscale/tailscaled.state');
		}
	}, _('Remove Profile from this Router'));

	return E('div', {}, [
		E('p', { 'class': 'cbi-value-description' }, [ _('Forgets a login profile on this router. This only deletes the login information stored here. Nothing is sent to Tailscale: the device stays listed in your Tailscale admin console and its key stays valid. Use "Logout" in the Account tab to leave an account properly.') ]),
		E('p', {}, [ select, ' ', button ])
	]);
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
			return refreshAccounts();
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

						return refreshAccounts();
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
			uci.load('tailscale'),
			L.resolveDefault(callGetAccounts(), null)
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
		const accounts = data[4];

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
		o = s.taboption('account', form.DummyValue, '_accounts');
		o.render = function() {
			return E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, [ _('Accounts on this Router') ]),
				E('div', { 'class': 'cbi-value-field', 'id': ACCOUNTS_ID }, renderAccounts(accounts))
			]);
		};

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
		o.inputtitle = _('Logout');
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

		o = s.taboption('advanced', form.DummyValue, '_profile_remove');
		o.render = function() {
			return E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, [ _('Local Profile') ]),
				E('div', { 'class': 'cbi-value-field', 'id': REMOVE_ID }, renderProfileRemoval(accounts))
			]);
		};

		return map.render().then(function(formNode) {
			poll.add(function() {
				return refreshAccounts();
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
