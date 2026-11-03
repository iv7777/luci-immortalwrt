'use strict';
'require fs';
'require poll';
'require ui';
'require view';

return view.extend({
	async retrieveLog() {
		// Do not fs.stat() the binary first: that needs a "list" ACL grant on
		// the path (and on the symlink target when logread is provided as an
		// alternative, e.g. /sbin/logread -> /usr/libexec/logread-ubox).
		// Run the ACL-granted paths directly and fall back on failure.
		let logdata;
		try {
			logdata = await fs.exec_direct('/sbin/logread', ['-e', 'tailscale']);
		} catch (err) {
			logdata = await fs.exec_direct('/usr/sbin/logread', ['-e', 'tailscale']);
		}
		const statusMappings = {
			'daemon.err': { status: 'StdErr', startIndex: 9 },
			'daemon.notice': { status: 'Info', startIndex: 10 }
		};
		const loglines = logdata.trim().split(/\n/).map(function(log) {
			const logParts = log.split(' ').filter(Boolean);
			if (logParts.length >= 6) {
				const formattedTime = `${logParts[1]} ${logParts[2]} - ${logParts[3]}`;
				const status = logParts[5];
				const mapping = statusMappings[status] || { status: status, startIndex: 9 };
				const newStatus = mapping.status;
				const startIndex = mapping.startIndex;
				const message = logParts.slice(startIndex).join(' ');
				return `${formattedTime} [ ${newStatus} ] - ${message}`;
			} else {
				return 'Log is empty.';
			}
		}).filter(Boolean);
		return { value: loglines.join('\n'), rows: loglines.length + 1 };
	},

	async pollLog() {
		const element = document.getElementById('syslog');
		if (element) {
			try {
				const log = await this.retrieveLog();
				element.value = log.value;
				element.rows = log.rows;
			} catch (err) {
				ui.addNotification(null, E('p', {}, _('Unable to load log data: ' + err.message)));
			}
		}
	},

	load() {
		poll.add(this.pollLog.bind(this));
		return this.retrieveLog();
	},

	render(loglines) {
		const scrollDownButton = E('button', { 
				id: 'scrollDownButton',
				class: 'cbi-button cbi-button-neutral'
			}, _('Scroll to tail', 'scroll to bottom (the tail) of the log file')
		);
		scrollDownButton.addEventListener('click', function() {
			scrollUpButton.scrollIntoView();
		});

		const scrollUpButton = E('button', { 
				id : 'scrollUpButton',
				class: 'cbi-button cbi-button-neutral'
			}, _('Scroll to head', 'scroll to top (the head) of the log file')
		);
		scrollUpButton.addEventListener('click', function() {
			scrollDownButton.scrollIntoView();
		});

		return E([], [
			E('div', { id: 'content_syslog' }, [
				E('div', { style: 'padding-bottom: 20px' }, [scrollDownButton]),
				E('textarea', {
					id: 'syslog',
					style: 'font-size:12px',
					readonly: 'readonly',
					wrap: 'off',
					rows: loglines.rows,
				}, [ loglines.value ]),
				E('div', { style: 'padding-bottom: 20px' }, [scrollUpButton])
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
