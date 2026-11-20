'use strict';
'require view';
'require rpc';
'require poll';

// SPDX-License-Identifier: GPL-3.0-only
//
// Log page of luci-app-tailscale-plus: the Tailscale related lines of the
// system log. The backend runs "logread -e tailscale" and returns the most
// recent lines, so no file or command access is needed in the browser.
//
// Like LuCI's own system log, the whole log is shown and the page scrolls:
// "Scroll to end" sits above the log and jumps to the button below it, and
// "Scroll to top" sits below the log and jumps back up.

const callGetLog = rpc.declare({ object: 'tailscale_plus', method: 'get_log' });

const LOG_ID = 'tailscale_plus_log';
const MIN_ROWS = 10;
const MAX_ROWS = 400;

function fill(textarea, res) {
	const lines = (res && res.lines) || [];

	// set .value, never innerHTML: log lines are not trusted
	textarea.value = lines.length ? lines.join('\n') : (res && res.error) || _('No Tailscale log entries yet.');
	textarea.rows = Math.max(MIN_ROWS, Math.min(lines.length + 1, MAX_ROWS));
}

return view.extend({
	load: function() {
		return L.resolveDefault(callGetLog(), {
			lines: [],
			error: _('The "tailscale_plus" service of rpcd is missing. Check "logread -e rpcd" for errors and run "/etc/init.d/rpcd restart".')
		});
	},

	render: function(res) {
		const textarea = E('textarea', {
			'id': LOG_ID,
			'readonly': 'readonly',
			'wrap': 'off',
			'style': 'width:100%; font-size:12px; font-family:monospace;'
		});

		fill(textarea, res);

		const scrollDownButton = E('button', {
			'class': 'cbi-button cbi-button-neutral',
			'click': function() {
				scrollUpButton.scrollIntoView();
			}
		}, _('Scroll to end'));

		const scrollUpButton = E('button', {
			'class': 'cbi-button cbi-button-neutral',
			'click': function() {
				scrollDownButton.scrollIntoView();
			}
		}, _('Scroll to top'));

		poll.add(function() {
			return L.resolveDefault(callGetLog(), null).then(function(r) {
				const el = document.getElementById(LOG_ID);

				if (r && el)
					fill(el, r);
			});
		}, 5);

		return E([], [
			E('h2', {}, _('Tailscale Logs')),
			E('p', {}, _('The most recent Tailscale messages from the system log. This page refreshes automatically.')),
			E('div', { 'class': 'cbi-section' }, [
				E('div', { 'style': 'padding-bottom:20px;' }, [ scrollDownButton ]),
				textarea,
				E('div', { 'style': 'padding-top:20px;' }, [ scrollUpButton ])
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
