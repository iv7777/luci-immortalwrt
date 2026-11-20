'use strict';
'require view';
'require rpc';
'require ui';
'require poll';

// SPDX-License-Identifier: GPL-3.0-only
//
// Diagnostics page of luci-app-tailscale-plus: interface counters, a network
// check (tailscale netcheck) and ping. Slow commands run in the background
// (see /usr/libexec/tailscale-plus-helper) and are polled from here.

const callGetStatus = rpc.declare({ object: 'tailscale_plus', method: 'get_status' });
const callGetInterface = rpc.declare({ object: 'tailscale_plus', method: 'get_interface' });
const callStartDiag = rpc.declare({
	object: 'tailscale_plus',
	method: 'start_diag',
	params: [ 'kind', 'target' ]
});
const callGetDiag = rpc.declare({ object: 'tailscale_plus', method: 'get_diag' });

const IFACE_ID = 'tailscale_plus_iface';
const POLL_MS = 1500;
const MAX_TRIES = 40;

function formatBytes(bytes) {
	const n = parseInt(bytes, 10);

	if (isNaN(n) || n <= 0)
		return '0 B';

	const units = [ 'B', 'KB', 'MB', 'GB', 'TB' ];
	const i = Math.min(Math.floor(Math.log(n) / Math.log(1000)), units.length - 1);

	return parseFloat((n / Math.pow(1000, i)).toFixed(2)) + ' ' + units[i];
}

// E() treats a lone string child as HTML; text goes in as a one-element array.
function row(label, value) {
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'width': '33%' }, [ label ]),
		E('td', { 'class': 'td left' }, [ value ])
	]);
}

// TUN devices have no carrier detection: the kernel reports operstate
// "unknown" for them, so the administrative up flag decides.
function stateLabel(iface) {
	if (iface.operstate === 'up' || (iface.operstate === 'unknown' && iface.up))
		return _('Up', 'Tailscale interface state');

	if (iface.operstate === 'down' || iface.up === false)
		return _('Down', 'Tailscale interface state');

	return iface.operstate || '-';
}

function renderInterface(iface, status) {
	if (!iface || !iface.present) {
		return E('em', {}, _('The interface tailscale0 does not exist. Tailscale is not running.'));
	}

	const addrs = [ status && status.ipv4, status && status.ipv6 ].filter(Boolean).join(', ');

	return E('table', { 'class': 'table' }, [
		row(_('Interface'), 'tailscale0'),
		row(_('State'), stateLabel(iface)),
		row(_('Addresses'), addrs || '-'),
		row(_('MTU'), String(iface.mtu || '-')),
		row(_('Received'), formatBytes(iface.rx_bytes) + ' (' + iface.rx_packets + ' ' + _('packets') + ', ' +
			iface.rx_errors + ' ' + _('errors') + ', ' + iface.rx_dropped + ' ' + _('dropped') + ')'),
		row(_('Transmitted'), formatBytes(iface.tx_bytes) + ' (' + iface.tx_packets + ' ' + _('packets') + ', ' +
			iface.tx_errors + ' ' + _('errors') + ', ' + iface.tx_dropped + ' ' + _('dropped') + ')')
	]);
}

function waitDiag(out, tries) {
	return L.resolveDefault(callGetDiag(), null).then(function(res) {
		if (res && res.done) {
			out.textContent = (res.output || '').trim() || _('(no output)');
			if (res.rc !== 0)
				out.textContent += '\n\n' + _('Exit code: %d').format(res.rc);
			return;
		}

		if (res && res.output)
			out.textContent = res.output;

		if (tries >= MAX_TRIES) {
			out.textContent += '\n\n' + _('Timed out while waiting for the result.');
			return;
		}

		return new Promise(function(resolve) {
			window.setTimeout(resolve, POLL_MS);
		}).then(function() {
			return waitDiag(out, tries + 1);
		});
	});
}

function runDiag(kind, target, out, buttons) {
	const busy = function(state) {
		buttons.forEach(function(b) { b.disabled = state; });
	};

	busy(true);
	out.textContent = _('Running ...');

	return callStartDiag(kind, target).then(function(res) {
		if (!res || res.error)
			throw new Error((res && res.error) || _('Unknown error'));

		return waitDiag(out, 0);
	}).then(function() {
		busy(false);
	}, function(err) {
		out.textContent = _('Error: %s').format(err.message || err);
		busy(false);
	});
}

return view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(callGetStatus(), { status: 'not_running', peers: [] }),
			L.resolveDefault(callGetInterface(), { present: false })
		]);
	},

	render: function(data) {
		const status = data[0] || {};
		const peers = (status.peers || []).filter(function(p) { return p.ip; });
		const buttons = [];

		const netcheckOut = E('pre', { 'style': 'min-height:6em;' });
		const pingOut = E('pre', { 'style': 'min-height:6em;' });

		const netcheckBtn = E('button', {
			'class': 'cbi-button cbi-button-action',
			'click': function() {
				return runDiag('netcheck', '', netcheckOut, buttons);
			}
		}, _('Run Network Check'));

		const peerSelect = E('select', { 'class': 'cbi-input-select' },
			[ E('option', { 'value': '' }, [ '-- ' + _('choose a device') + ' --' ]) ].concat(peers.map(function(p) {
				return E('option', { 'value': p.ip }, [ p.hostname + ' (' + p.ip + ')' + (p.online ? '' : ' - ' + _('offline')) ]);
			})));

		const pingInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'placeholder': _('or enter a Tailscale IP / device name'),
			'style': 'width:20em;'
		});

		const pingBtn = E('button', {
			'class': 'cbi-button cbi-button-action',
			'click': function() {
				const target = (pingInput.value || '').trim() || peerSelect.value;

				if (!target) {
					ui.addTimeLimitedNotification(null, [ E('p', {}, [ _('Choose a device or enter a target first.') ]) ], 5000, 'error');
					return;
				}

				return runDiag('ping', target, pingOut, buttons);
			}
		}, _('Ping'));

		buttons.push(netcheckBtn, pingBtn);

		poll.add(function() {
			return Promise.all([
				L.resolveDefault(callGetInterface(), { present: false }),
				L.resolveDefault(callGetStatus(), null)
			]).then(function(res) {
				const node = document.getElementById(IFACE_ID);

				if (node)
					node.replaceChildren(renderInterface(res[0], res[1]));
			});
		}, 5);

		return E([], [
			E('h2', {}, _('Tailscale Diagnostics')),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Interface')),
				E('div', { 'id': IFACE_ID }, renderInterface(data[1], status))
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Network Check')),
				E('p', {}, _('Tests UDP connectivity, NAT behaviour and the latency to the Tailscale relay servers. It takes a few seconds. A direct connection between devices needs working UDP.')),
				E('p', {}, netcheckBtn),
				netcheckOut
			]),

			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Ping')),
				E('p', {}, _('Pings a device through Tailscale and shows whether the path is direct or goes through a relay.')),
				E('p', {}, [ peerSelect, ' ', pingInput, ' ', pingBtn ]),
				pingOut
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
