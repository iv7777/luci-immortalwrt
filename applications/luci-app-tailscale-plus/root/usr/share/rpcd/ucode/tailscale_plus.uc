#!/usr/bin/env ucode

// SPDX-License-Identifier: GPL-3.0-only
//
// rpcd backend of luci-app-tailscale-plus (ubus object "tailscale_plus").
//
// Design notes:
//  - rpcd is single threaded, so nothing in here may block for long. Slow
//    Tailscale CLI calls (login, netcheck, ping) are started in the
//    background through /usr/libexec/tailscale-plus-helper and polled.
//  - Secrets (auth keys) are never stored in UCI and are handed to the CLI
//    through a 0600 file ("--auth-key file:...") instead of the command line.

'use strict';

import { access, popen, readfile, writefile, unlink, open, mkdir } from 'fs';
import { cursor } from 'uci';

const RUN_DIR = '/var/run/tailscale-plus';
const HELPER = '/usr/libexec/tailscale-plus-helper';
const LOG_LINES = 300;
const DIAG_MAX_BYTES = 16384;

let timeout_available = null;

function shell_quote(s) {
	if (s == null || s == '')
		return "''";

	return "'" + replace(s, "'", "'\\''") + "'";
}

function has_timeout() {
	if (timeout_available == null)
		timeout_available = (access('/usr/bin/timeout') == true || access('/bin/timeout') == true);

	return timeout_available;
}

function ts_bin() {
	if (access('/usr/sbin/tailscale') == true)
		return '/usr/sbin/tailscale';

	if (access('/usr/bin/tailscale') == true)
		return '/usr/bin/tailscale';

	return null;
}

// Run a command and return its exit code and output. With merge_stderr unset
// stderr is discarded, which keeps JSON output parsable.
function run(cmd, secs, merge_stderr) {
	let full = cmd;

	if (secs && has_timeout())
		full = 'timeout ' + secs + ' ' + cmd;

	full += merge_stderr ? ' 2>&1' : ' 2>/dev/null';

	let p = popen(full, 'r');
	if (p == null)
		return { code: -1, out: '' };

	let out = p.read('all') || '';
	let code = p.close();

	return { code: code, out: out };
}

function run_detached(cmd) {
	system([ '/bin/sh', '-c', '(' + cmd + ') >/dev/null 2>&1 &' ]);
}

function parse_json(s) {
	if (s == null || s == '')
		return null;

	try {
		return json(s);
	}
	catch (e) {
		return null;
	}
}

function as_list(v) {
	if (v == null)
		return [];

	if (type(v) == 'array')
		return v;

	return [ v ];
}

function pid_alive(pidfile) {
	let pid = trim(readfile(pidfile) || '');

	if (pid == '' || !match(pid, /^[0-9]+$/))
		return false;

	return access('/proc/' + pid) == true;
}

// Ask the daemon for its status. Returns { data } on success or
// { error } with one of: not_installed, not_running.
function ts_status() {
	let bin = ts_bin();

	if (!bin)
		return { error: 'not_installed' };

	let r = run(bin + ' status --json', 5, false);
	if (r.code != 0)
		return { error: 'not_running' };

	let d = parse_json(r.out);
	if (d == null)
		return { error: 'not_running' };

	return { data: d };
}

// Regular expressions are POSIX extended ones, and OpenWrt uses musl: no
// backslash escapes inside brackets and no repeat counts above 255 ({n,m}).
// To be safe, none are used at all; lengths are checked separately.
// An exception while this script loads makes rpcd drop the whole plugin
// ("Object not found"), so patterns are compiled defensively. A pattern that
// fails to compile rejects the input instead of breaking everything.
function compile(source) {
	try {
		return regexp(source);
	}
	catch (e) {
		return null;
	}
}

function valid(re, str, min, max) {
	return (re != null && type(str) == 'string' && length(str) >= min &&
	        length(str) <= max && match(str, re) != null);
}

const re_url = compile('^https?://[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$');
const re_authkey = compile('^[A-Za-z0-9_.:=+/-]+$');
const re_target = compile('^[A-Za-z0-9][A-Za-z0-9._:-]*$');
const re_any_url = compile('https?://[^[:space:]]+');

const backend_states = {
	Running: 'running',
	NeedsLogin: 'logout',
	NeedsMachineAuth: 'needs_machine_auth',
	Starting: 'starting',
	Stopped: 'stopped',
	NoState: 'starting'
};

const methods = {};

methods.get_status = {
	call: function() {
		let u = cursor();
		let enabled = false;

		try {
			u.load('tailscale');
			enabled = (u.get('tailscale', 'settings', 'service_enabled') == '1');
		}
		catch (e) { }

		let data = {
			status: '',
			version: '',
			TUNMode: false,
			health: [],
			hostname: '',
			ipv4: '',
			ipv6: '',
			domain_name: '',
			auth_url: '',
			exit_node_ip: '',
			service_enabled: enabled,
			peers: []
		};

		let st = ts_status();
		if (st.error) {
			data.status = st.error;
			return data;
		}

		let d = st.data;

		data.status = backend_states[d.BackendState] || 'unknown';
		data.version = d.Version || '';
		data.TUNMode = (d.TUN == true);
		data.health = as_list(d.Health);
		data.auth_url = d.AuthURL || '';
		data.domain_name = d.CurrentTailnet?.Name || '';
		data.hostname = d.Self?.HostName || '';
		data.exit_node_ip = d.ExitNodeStatus?.TailscaleIPs?.[0] || '';

		for (let ip in as_list(d.Self?.TailscaleIPs)) {
			if (index(ip, ':') != -1) {
				if (data.ipv6 == '')
					data.ipv6 = ip;
			}
			else if (data.ipv4 == '') {
				data.ipv4 = ip;
			}
		}

		if (d.Peer) {
			for (let key in d.Peer) {
				let peer = d.Peer[key];
				let ips = as_list(peer.TailscaleIPs);
				let primary = '';

				for (let ip in ips) {
					if (index(ip, ':') == -1) {
						primary = ip;
						break;
					}
				}

				push(data.peers, {
					id: peer.ID || key,
					hostname: split(peer.DNSName || '', '.')[0] || peer.HostName || '',
					ips: ips,
					ip: primary || ips[0] || '',
					os: peer.OS || '',
					online: (peer.Online == true),
					exit_node: (peer.ExitNode == true),
					exit_node_option: (peer.ExitNodeOption == true),
					cur_addr: peer.CurAddr || '',
					relay: peer.Relay || '',
					rx: peer.RxBytes || 0,
					tx: peer.TxBytes || 0,
					last_seen: peer.LastSeen || ''
				});
			}
		}

		data.peers = sort(data.peers, function(a, b) {
			if (a.online != b.online)
				return a.online ? -1 : 1;

			return (a.hostname < b.hostname) ? -1 : (a.hostname > b.hostname) ? 1 : 0;
		});

		return data;
	}
};

methods.get_subroutes = {
	call: function() {
		let routes = [];
		let r = run('ip -j route', 5, false);

		if (r.code == 0) {
			let list = parse_json(r.out);

			for (let route in as_list(list)) {
				let dst = route?.dst;

				// directly connected IPv4 networks, but not the Tailscale one
				if (dst && index(dst, '/') != -1 && index(dst, '.') != -1 &&
				    route.scope == 'link' && route.dev != 'tailscale0' &&
				    index(routes, dst) == -1)
					push(routes, dst);
			}
		}

		return { routes: routes };
	}
};

methods.get_interface = {
	call: function() {
		const base = '/sys/class/net/tailscale0';

		if (access(base) != true)
			return { present: false };

		let read_str = function(name) {
			let v = readfile(base + '/' + name);
			return v ? trim(v) : '';
		};

		// int() returns NaN (a double) for anything that is not a number
		let to_int = function(v) {
			return (type(v) == 'int') ? v : 0;
		};

		let read_num = function(name) {
			return to_int(int(read_str('statistics/' + name)));
		};

		return {
			present: true,
			operstate: read_str('operstate'),
			mtu: to_int(int(read_str('mtu'))),
			rx_bytes: read_num('rx_bytes'),
			tx_bytes: read_num('tx_bytes'),
			rx_packets: read_num('rx_packets'),
			tx_packets: read_num('tx_packets'),
			rx_errors: read_num('rx_errors'),
			tx_errors: read_num('tx_errors'),
			rx_dropped: read_num('rx_dropped'),
			tx_dropped: read_num('tx_dropped')
		};
	}
};

methods.get_log = {
	call: function() {
		let logread = null;

		for (let p in [ '/sbin/logread', '/usr/sbin/logread' ]) {
			if (access(p) == true) {
				logread = p;
				break;
			}
		}

		if (!logread)
			return { error: 'logread not found', lines: [] };

		let r = run(logread + ' -e tailscale', 10, false);
		if (r.code != 0 && r.out == '')
			return { lines: [] };

		let lines = split(rtrim(r.out), '\n');
		if (length(lines) == 1 && lines[0] == '')
			lines = [];

		if (length(lines) > LOG_LINES)
			lines = slice(lines, length(lines) - LOG_LINES);

		return { lines: map(lines, function(l) { return substr(l, 0, 600); }) };
	}
};

methods.start_login = {
	args: { login_server: '', auth_key: '' },
	call: function(request) {
		let server = trim(request.args.login_server || '');
		let key = trim(request.args.auth_key || '');

		if (server != '' && !valid(re_url, server, 8, 2048))
			return { error: 'Invalid login server URL.' };

		if (key != '' && !valid(re_authkey, key, 4, 300))
			return { error: 'Invalid auth key.' };

		let st = ts_status();
		if (st.error == 'not_installed')
			return { error: 'Tailscale is not installed.' };

		if (st.error)
			return { error: 'The Tailscale service is not running. Enable it first and apply the settings.' };

		if (backend_states[st.data.BackendState] != 'logout')
			return { error: 'This device is already logged in.' };

		mkdir(RUN_DIR, 448);
		unlink(RUN_DIR + '/login.rc');
		unlink(RUN_DIR + '/authkey');

		let keyfile = '';
		if (key != '') {
			keyfile = RUN_DIR + '/authkey';

			let f = open(keyfile, 'w', 384);
			if (f == null)
				return { error: 'Cannot store the auth key temporarily.' };

			f.write(key);
			f.close();
		}

		run_detached(HELPER + ' login ' + shell_quote(server) + ' ' + shell_quote(keyfile));

		return { started: true };
	}
};

methods.get_login_status = {
	call: function() {
		let res = { state: '', auth_url: '', running: false, rc: null, output: '' };

		let st = ts_status();
		if (st.error) {
			res.state = st.error;
			return res;
		}

		res.state = backend_states[st.data.BackendState] || 'unknown';
		res.auth_url = st.data.AuthURL || '';
		res.running = pid_alive(RUN_DIR + '/login.pid');

		let log = readfile(RUN_DIR + '/login.log', 4096) || '';
		res.output = trim(log);

		if (res.auth_url == '') {
			let m = (re_any_url != null) ? match(log, re_any_url) : null;
			if (m)
				res.auth_url = m[0];
		}

		let rc = trim(readfile(RUN_DIR + '/login.rc') || '');
		if (rc != '')
			res.rc = int(rc);

		return res;
	}
};

methods.do_logout = {
	call: function() {
		let st = ts_status();
		if (st.error)
			return { error: 'The Tailscale service is not running.' };

		if (backend_states[st.data.BackendState] == 'logout')
			return { error: 'This device is already logged out.' };

		let r = run(ts_bin() + ' logout', 15, true);
		if (r.code != 0)
			return { error: 'Failed to log out: ' + trim(r.out) };

		return { success: true };
	}
};

methods.start_diag = {
	args: { kind: '', target: '' },
	call: function(request) {
		let kind = request.args.kind || '';
		let target = trim(request.args.target || '');

		if (kind != 'netcheck' && kind != 'ping')
			return { error: 'Unknown diagnostic.' };

		if (kind == 'ping' && !valid(re_target, target, 1, 253))
			return { error: 'Invalid ping target.' };

		if (ts_bin() == null)
			return { error: 'Tailscale is not installed.' };

		if (pid_alive(RUN_DIR + '/diag.pid'))
			return { error: 'Another diagnostic is still running.' };

		mkdir(RUN_DIR, 448);
		unlink(RUN_DIR + '/diag.rc');
		unlink(RUN_DIR + '/diag.out');

		run_detached(HELPER + ' diag ' + kind + ' ' + shell_quote(target));

		return { started: true };
	}
};

methods.get_diag = {
	call: function() {
		let out = readfile(RUN_DIR + '/diag.out', DIAG_MAX_BYTES) || '';
		let rc = trim(readfile(RUN_DIR + '/diag.rc') || '');

		return {
			running: pid_alive(RUN_DIR + '/diag.pid'),
			done: (rc != ''),
			rc: (rc != '') ? int(rc) : null,
			output: out
		};
	}
};

// ---------------------------------------------------------------------
// Firewall: interface "tailscale" (device tailscale0), zone "tailscale"
// and the forwardings between that zone and lan/wan.
// ---------------------------------------------------------------------

function find_section(u, config, stype, field, value) {
	let found = null;

	u.foreach(config, stype, function(s) {
		if (found == null && s[field] == value)
			found = s['.name'];
	});

	return found;
}

function find_forwardings(u, src, dest) {
	let ids = [];

	u.foreach('firewall', 'forwarding', function(s) {
		if (s.src == src && s.dest == dest)
			push(ids, s['.name']);
	});

	return ids;
}

methods.get_firewall = {
	call: function() {
		let u = cursor();
		u.load('network');
		u.load('firewall');

		let zone = find_section(u, 'firewall', 'zone', 'name', 'tailscale');

		return {
			interface: (u.get('network', 'tailscale') != null),
			zone: (zone != null),
			has_lan_zone: (find_section(u, 'firewall', 'zone', 'name', 'lan') != null),
			has_wan_zone: (find_section(u, 'firewall', 'zone', 'name', 'wan') != null),
			router_input: (zone != null) ? (u.get('firewall', zone, 'input') == 'ACCEPT') : true,
			lan_to_ts: length(find_forwardings(u, 'lan', 'tailscale')) > 0,
			ts_to_lan: length(find_forwardings(u, 'tailscale', 'lan')) > 0,
			ts_to_wan: length(find_forwardings(u, 'tailscale', 'wan')) > 0,
			wan_to_ts: length(find_forwardings(u, 'wan', 'tailscale')) > 0
		};
	}
};

methods.setup_firewall = {
	args: { router_input: true, lan_to_ts: false, ts_to_lan: false, ts_to_wan: false, wan_to_ts: false },
	call: function(request) {
		const want = request.args;

		let u = cursor();
		u.load('network');
		u.load('firewall');

		let changed_network = false;
		let changed_firewall = false;

		// every zone we are asked to connect to has to exist
		const peers = { lan: (want.lan_to_ts || want.ts_to_lan), wan: (want.ts_to_wan || want.wan_to_ts) };
		for (let z in [ 'lan', 'wan' ]) {
			if (peers[z] && find_section(u, 'firewall', 'zone', 'name', z) == null)
				return { error: "Firewall zone '" + z + "' does not exist." };
		}

		// 1. network interface
		if (u.get('network', 'tailscale') == null) {
			u.set('network', 'tailscale', 'interface');
			u.set('network', 'tailscale', 'proto', 'none');
			u.set('network', 'tailscale', 'device', 'tailscale0');
			changed_network = true;
		}
		else if (u.get('network', 'tailscale', 'device') != 'tailscale0') {
			u.set('network', 'tailscale', 'device', 'tailscale0');
			changed_network = true;
		}

		// 2. firewall zone
		let zone = find_section(u, 'firewall', 'zone', 'name', 'tailscale');
		let input = want.router_input ? 'ACCEPT' : 'REJECT';

		if (zone == null) {
			zone = u.add('firewall', 'zone');
			u.set('firewall', zone, 'name', 'tailscale');
			u.set('firewall', zone, 'input', input);
			u.set('firewall', zone, 'output', 'ACCEPT');
			u.set('firewall', zone, 'forward', 'ACCEPT');
			u.set('firewall', zone, 'masq', '1');
			u.set('firewall', zone, 'mtu_fix', '1');
			u.set('firewall', zone, 'network', [ 'tailscale' ]);
			changed_firewall = true;
		}
		else {
			if (u.get('firewall', zone, 'input') != input) {
				u.set('firewall', zone, 'input', input);
				changed_firewall = true;
			}

			let nets = as_list(u.get('firewall', zone, 'network'));
			if (index(nets, 'tailscale') == -1) {
				push(nets, 'tailscale');
				u.set('firewall', zone, 'network', nets);
				changed_firewall = true;
			}

			// LAN -> Tailscale needs masquerading, the others benefit from MSS clamping
			if (want.lan_to_ts && u.get('firewall', zone, 'masq') != '1') {
				u.set('firewall', zone, 'masq', '1');
				changed_firewall = true;
			}

			if (u.get('firewall', zone, 'mtu_fix') != '1') {
				u.set('firewall', zone, 'mtu_fix', '1');
				changed_firewall = true;
			}
		}

		// 3. forwardings: create what is wanted, remove what is not
		const rules = [
			[ 'lan', 'tailscale', want.lan_to_ts ],
			[ 'tailscale', 'lan', want.ts_to_lan ],
			[ 'tailscale', 'wan', want.ts_to_wan ],
			[ 'wan', 'tailscale', want.wan_to_ts ]
		];

		for (let rule in rules) {
			let ids = find_forwardings(u, rule[0], rule[1]);

			if (rule[2] && length(ids) == 0) {
				let fid = u.add('firewall', 'forwarding');
				u.set('firewall', fid, 'src', rule[0]);
				u.set('firewall', fid, 'dest', rule[1]);
				changed_firewall = true;
			}
			else if (!rule[2] && length(ids) > 0) {
				for (let id in ids)
					u.delete('firewall', id);
				changed_firewall = true;
			}
		}

		// 4. save and reload in the background
		let reload = [];

		if (changed_network) {
			u.save('network');
			u.commit('network');
			push(reload, '/etc/init.d/network reload');
		}

		if (changed_firewall) {
			u.save('firewall');
			u.commit('firewall');
			push(reload, '/etc/init.d/firewall reload');
		}

		if (length(reload) > 0)
			run_detached(join('; ', reload));

		return {
			success: true,
			changed: (changed_network || changed_firewall)
		};
	}
};

return { 'tailscale_plus': methods };
