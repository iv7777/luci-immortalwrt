#!/usr/bin/env ucode

// SPDX-License-Identifier: GPL-3.0-only
//
// Removes one login profile from the Tailscale state file. This is a purely
// local operation, exactly what tailscaled itself does when a profile is
// deleted: nothing is sent to the Tailscale servers.
//
// Usage: tailscale-plus-profile.uc remove <state file> <profile id>
//
// The state file is a JSON object whose values are base64 strings:
//   _profiles         JSON object {profile id: profile}
//   _current-profile  key of the profile used at start ("profile-<id>")
//   profile-<id>      preferences and keys of that profile
//   _daemon           legacy preferences, used to migrate when no profile exists
//
// The daemon has to be stopped; the caller (tailscale-plus-helper) does that.
// A backup copy is written to "<state file>.bak". Nothing is changed unless the
// file looks exactly as expected, and the result is verified before it
// replaces the original.

'use strict';

import { readfile, open, rename, unlink } from 'fs';

function fail(msg) {
	warn('tailscale-plus-profile: ' + msg + '\n');
	exit(1);
}

function parse(s) {
	try {
		return json(s);
	}
	catch (e) {
		return null;
	}
}

function write_private(path, data) {
	let f = open(path, 'w', 384);   // 0600

	if (f == null)
		return false;

	f.write(data);
	f.close();

	return true;
}

const action = ARGV[0];
const state_file = ARGV[1];
const id = ARGV[2];

if (action != 'remove' || !state_file || !id)
	fail('usage: remove <state file> <profile id>');

const re_id = regexp('^[A-Za-z0-9]+$');
if (length(id) > 32 || match(id, re_id) == null)
	fail('invalid profile id');

const raw = readfile(state_file);
if (raw == null)
	fail('cannot read ' + state_file);

let state = parse(raw);
if (type(state) != 'object')
	fail('state file is not a JSON object, not touching it');

if (type(state['_profiles']) != 'string')
	fail('state file has no profile list, not touching it');

let profiles = parse(b64dec(state['_profiles']));
if (type(profiles) != 'object')
	fail('profile list is not readable, not touching it');

if (type(profiles[id]) != 'object')
	fail('no such profile: ' + id);

let key = profiles[id].Key;
if (type(key) != 'string' || substr(key, 0, 8) != 'profile-')
	key = 'profile-' + id;

let current = (type(state['_current-profile']) == 'string') ? b64dec(state['_current-profile']) : null;

// remove the profile, its stored data and, if it was the current one, the pointer
delete profiles[id];
delete state[key];

if (current == key)
	delete state['_current-profile'];

// Without any profile left tailscaled migrates from the legacy "_daemon" entry,
// which would bring the old login back, so that goes too.
if (length(keys(profiles)) == 0)
	delete state['_daemon'];

state['_profiles'] = b64enc(sprintf('%J', profiles));

const out = sprintf('%J', state);

// verify what we are about to write
let check = parse(out);
let check_profiles = (type(check) == 'object' && type(check['_profiles']) == 'string')
	? parse(b64dec(check['_profiles'])) : null;

if (type(check_profiles) != 'object' || check_profiles[id] != null || check[key] != null)
	fail('verification failed, state file left unchanged');

if (!write_private(state_file + '.bak', raw))
	fail('cannot write the backup, state file left unchanged');

const tmp = state_file + '.tmp';
if (!write_private(tmp, out)) {
	unlink(tmp);
	fail('cannot write the new state file, state file left unchanged');
}

if (!rename(tmp, state_file)) {
	unlink(tmp);
	fail('cannot replace the state file, state file left unchanged');
}

printf('removed profile %s (backup: %s.bak)\n', id, state_file);
